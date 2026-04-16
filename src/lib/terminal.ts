/**
 * PTY session manager for the dashboard terminal panel.
 *
 * Responsibilities:
 *   1. Lazy-load node-pty. The module is an optional dep whose prebuilt may
 *      be missing or incompatible on unusual platforms; we fail soft so the
 *      rest of the dashboard keeps working.
 *   2. Whitelist keyed commands → argv. Clients never send raw shell strings;
 *      they send a key ('shell' | 'claude' | 'ngit-login' | …) and the
 *      server resolves it into a fixed argv.
 *   3. Track live sessions in memory with a scrollback ring buffer. Clients
 *      reconnecting after a WS drop (navigation, refresh, transient network)
 *      rejoin by id within a 5-minute grace window and replay the buffer
 *      before live frames resume.
 *   4. Broadcast PTY output to every attached client so multi-tab / multi-
 *      viewer cases (e.g. split panes in the future) behave predictably.
 *
 * Design choices worth noting:
 *   - Sessions are keyed by a cryptographically random id; the client stores
 *     the id in localStorage and presents it on rejoin. No cross-user isolation
 *     is needed because the web-server is 127.0.0.1 and gated on NIP-98 auth.
 *   - PATH for spawned processes is captured from the user's login shell
 *     on first PTY spawn (cached). launchd / systemd user units can start the
 *     server with a near-empty PATH where `claude`, `ngit`, etc. won't resolve;
 *     the login-shell probe recovers the developer-interactive PATH.
 *   - Ring buffer is fixed-size bytes (~1 MiB) — enough for a Claude Code
 *     session's recent scrollback without letting a chatty command balloon
 *     memory. Clients that want full history should log externally.
 */

import crypto from 'crypto';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';
import { execa } from 'execa';
import type { WebSocket } from 'ws';

// Bridge to require() from within an ESM module — needed to call
// require.resolve('node-pty/package.json') without triggering the native
// load. Cheap, constructed once per module.
const nodeRequire = createRequire(import.meta.url);

// ── node-pty typings (mirrored; we never import from 'node-pty' statically
//    so a missing optional dep doesn't break the rest of the module).
interface IPty {
  pid: number;
  onData(cb: (data: string) => void): { dispose(): void };
  onExit(cb: (ev: { exitCode: number; signal?: number }) => void): { dispose(): void };
  resize(cols: number, rows: number): void;
  write(data: string): void;
  kill(signal?: string): void;
}

interface PtyModule {
  spawn(file: string, args: string[] | string, options: {
    name?: string; cols?: number; rows?: number;
    cwd?: string; env?: Record<string, string>;
  }): IPty;
}

// Defensive chmod on node-pty's spawn-helper binaries. node-pty ships upstream
// prebuilts inside node_modules/node-pty/prebuilds/<platform>-<arch>/, and on
// some npm / tar toolchains (notably npm 10.x on darwin) the Unix execute bit
// is stripped during extraction — posix_spawnp then fails with a cryptic
// "posix_spawnp failed." the first time a user tries to open a terminal.
//
// We don't know which path node-pty's internal loader will pick without
// reading its sources, so we chmod every candidate we can find. Cheap + idempotent.
// Called once at first loadPty() — cached result, so there's no per-spawn cost.
function ensureSpawnHelperExecutable(): void {
  // Only meaningful on Unix — spawn-helper is Windows-less.
  if (process.platform === 'win32') return;

  // Resolve node-pty's install directory without triggering the native load.
  // require.resolve('node-pty/package.json') works regardless of whether the
  // compiled addon is present, because package.json is always shipped.
  let pkgJson: string;
  try { pkgJson = nodeRequire.resolve('node-pty/package.json'); }
  catch { return; }
  const pkgDir = path.dirname(pkgJson);

  // The loader (node-pty/lib/utils.js) checks build/Release, build/Debug, and
  // prebuilds/<platform>-<arch> — cover all three. Scanning prebuilds/* for
  // every subdir catches cross-arch curiosities (npm occasionally installs
  // multiple arches on Linux runners) without hard-coding a list.
  const dirs: string[] = [
    path.join(pkgDir, 'build', 'Release'),
    path.join(pkgDir, 'build', 'Debug'),
  ];
  try {
    const prebuildsRoot = path.join(pkgDir, 'prebuilds');
    if (fs.existsSync(prebuildsRoot)) {
      for (const entry of fs.readdirSync(prebuildsRoot)) {
        dirs.push(path.join(prebuildsRoot, entry));
      }
    }
  } catch {}

  for (const d of dirs) {
    const helper = path.join(d, 'spawn-helper');
    try {
      if (fs.existsSync(helper)) {
        // Only chmod if it's not already executable — keep the syscall
        // count minimal and avoid changing mtime on every boot.
        const mode = fs.statSync(helper).mode;
        if ((mode & 0o111) === 0) fs.chmodSync(helper, 0o755);
      }
    } catch {}
  }
}

let ptyModulePromise: Promise<PtyModule | null> | null = null;
export async function loadPty(): Promise<PtyModule | null> {
  if (!ptyModulePromise) {
    // Wrap in a promise once so repeated callers share the same import.
    ptyModulePromise = (async () => {
      try {
        // Patch the execute bit BEFORE the first spawn — the module-load
        // itself doesn't exec anything, but the first pty.spawn() will.
        ensureSpawnHelperExecutable();

        // Dynamic import so a missing node-pty (optional dep) doesn't crash
        // the web-server at module-load time.
        const mod = await import('node-pty');
        // node-pty 1.x exports spawn as a named export; defensive check.
        if (typeof (mod as any).spawn !== 'function') return null;
        return mod as unknown as PtyModule;
      } catch {
        return null;
      }
    })();
  }
  return ptyModulePromise;
}

// ── Login-shell PATH probe
//
// Services started by launchd / systemd --user inherit a minimal PATH that
// typically doesn't include /opt/homebrew/bin, ~/.cargo/bin, ~/.npm-global/bin,
// ~/.deno/bin, etc. If we spawn `claude` or `ngit` straight from that env
// the child process fails with "command not found" — even though running it
// from the user's iTerm works fine. The fix is to ask the user's login shell
// for its PATH once at startup and splice it into every PTY env.
//
// We only probe once per server boot; if the probe fails (non-interactive
// session, shell too restricted) we fall back to process.env.PATH and let
// the user discover the PATH issue from the PTY's own error output.
let cachedLoginPath: string | null = null;
async function resolveLoginPath(): Promise<string> {
  if (cachedLoginPath !== null) return cachedLoginPath;
  const shell = process.env.SHELL || '/bin/bash';
  try {
    const { stdout } = await execa(shell, ['-lic', 'printf %s "$PATH"'], {
      stdio: 'pipe', timeout: 2500,
    });
    const trimmed = stdout.trim();
    cachedLoginPath = trimmed || (process.env.PATH ?? '');
  } catch {
    cachedLoginPath = process.env.PATH ?? '';
  }
  return cachedLoginPath;
}

// ── Whitelisted command resolver
//
// The client sends a small key; the server owns the argv. NEVER interpolate
// client-supplied strings into argv here — add a new key instead. A `cwd`
// field is optional; projects that need it (Claude, opencode) go through
// cmdSpecFor with a project path.
export interface CmdSpec {
  cmd:   string;
  args:  string[];
  cwd?:  string;
  env?:  Record<string, string>;
  label: string;  // tab title surfaced to the UI
}

export interface CreateOpts {
  key:  string;
  cwd?: string;
}

// How to invoke our own CLI (node dist/cli.js / tsx src/cli.tsx).
// Resolved once in web-server.ts to a valid file + runner pair, passed in
// here so terminal.ts stays agnostic to dev vs. built layout.
export interface CliSpawn {
  bin:    string;   // node | <repo>/node_modules/.bin/tsx
  prefix: string[]; // [cli.js] | [cli.tsx]
}

// Maximum accepted cols/rows for resize — guards against nonsense client
// values without capping sensible future use (ultrawide monitors, font zooms).
const MAX_COLS = 500;
const MAX_ROWS = 300;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

function normalizeCwd(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  // Defence in depth: the only callers should already be passing absolute
  // paths derived server-side (projects.json lookup), but reject traversal
  // patterns anyway. An undefined cwd falls through to node-pty's default
  // (the server's own cwd), which is safe.
  if (raw.includes('..')) return undefined;
  if (!path.isAbsolute(raw)) return undefined;
  try {
    const stat = fs.statSync(raw);
    if (!stat.isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  return raw;
}

export function resolveCmd(opts: CreateOpts, cli: CliSpawn): CmdSpec | null {
  const shell = process.env.SHELL || '/bin/bash';
  const cwd = normalizeCwd(opts.cwd);
  // Intentionally DO NOT set NO_COLOR / TERM=dumb here — the whole point of
  // the terminal panel is that programs run against a real VT: colours,
  // cursor control, full-screen TUIs (Claude Code, ngit prompts) all work.
  // The old streaming-exec endpoints zeroed these out for line-oriented SSE;
  // terminal sessions get the xterm profile by default.

  // Helper: wrap a subcommand as a spawn of our own CLI regardless of
  // whether it's built (node dist/cli.js) or dev (tsx src/cli.tsx).
  const ns = (args: string[], label: string): CmdSpec => ({
    cmd: cli.bin,
    args: [...cli.prefix, ...args],
    cwd,
    label,
  });

  switch (opts.key) {
    case 'shell':
      // Login shell so interactive tooling that relies on ~/.zshrc / ~/.bashrc
      // (cargo, deno, pyenv shims) behaves as the user expects.
      return { cmd: shell, args: ['-l'], cwd, label: path.basename(shell) };

    case 'claude':
      return { cmd: 'claude', args: [], cwd, label: cwd ? `claude · ${path.basename(cwd)}` : 'claude' };

    case 'opencode':
      return { cmd: 'opencode', args: [], cwd, label: cwd ? `opencode · ${path.basename(cwd)}` : 'opencode' };

    // ngit login — the canonical first-wire trigger. --interactive forces
    // the nostrconnect QR flow (vs. the `--nsec` / `--bunker-url` shortcuts),
    // which is what we actually want users doing from the dashboard.
    case 'ngit-login':
      return { cmd: 'ngit', args: ['account', 'login', '--interactive'], cwd, label: 'ngit login' };

    case 'ngit-logout':
      return { cmd: 'ngit', args: ['account', 'logout'], cwd, label: 'ngit logout' };

    // Our own CLI subcommands — Ink mounts against the PTY so the full TUI
    // (selects, spinners, multi-step wizards) renders as it does in a real
    // terminal. ns() picks node+cli.js or tsx+cli.tsx based on layout.
    case 'doctor':         return ns(['doctor'],             'doctor');
    case 'onboard':        return ns(['onboard'],            'onboard');
    case 'update':         return ns(['update'],             'update');
    case 'update-wizard':  return ns(['update', '--wizard'], 'update');
    case 'seed':           return ns(['seed'],               'seed');
    // Follow the relay log in the terminal panel — alternative to the
    // EventSource-based Logs panel for users who want the full TTY (colour,
    // scrollback, search via shell if they pipe, etc.). -f keeps tail open.
    case 'relay-logs':     return ns(['relay', 'logs', '-f'], 'relay logs');

    // Project publish flows. The three keys mirror the server-side
    // capability branch in /api/projects/:id/git/push so the client can
    // pick without duplicating the decision. cwd is project.path (passed
    // via createTerminal's projectId → cwd resolver). --yes stays on the
    // Ink publish because the dashboard already prompts via a confirm
    // dialog; double-confirming isn't useful.
    case 'publish':
      return ns(['publish', '--yes'], cwd ? `publish · ${path.basename(cwd)}` : 'publish');
    case 'git-push':
      return { cmd: 'git', args: ['push', 'origin', 'HEAD'], cwd, label: cwd ? `git push · ${path.basename(cwd)}` : 'git push' };
    case 'ngit-push':
      return { cmd: 'ngit', args: ['push'], cwd, label: cwd ? `ngit push · ${path.basename(cwd)}` : 'ngit push' };

    // NOTE: we intentionally do NOT expose a 'keychain-ai-key' trigger here.
    // node-pty spawns with POSIX_SPAWN_SETSID (required — every PTY is its
    // own session), which detaches the child from the Aqua session bootstrap
    // port that macOS `security` needs. Any `security add-generic-password`
    // inside a PTY child fails with exit 36 ("User interaction is not
    // allowed"). The dashboard's /api/keychain/set endpoint is the canonical
    // paste path — it runs in the web-server process itself, which inherited
    // Aqua from the user's real terminal and can talk to the keychain.
  }

  return null;
}

// ── Session store
//
// One entry per live PTY. Clients attach/detach freely; when the last client
// detaches we start a grace timer and tear down if no one rejoins in time.

interface Session {
  id:        string;
  pty:       IPty;
  spec:      CmdSpec;
  cols:      number;
  rows:      number;
  createdAt: number;
  exited:    boolean;
  exitCode:  number | null;
  // Scrollback ring buffer — capped bytes of raw PTY output. Replayed in one
  // chunk when a client attaches/rejoins. xterm.js parses ANSI escapes fine
  // mid-stream, so we don't need to align boundaries.
  buffer:    string[];
  bufferBytes: number;
  // Live clients receiving frames.
  clients:   Set<WebSocket>;
  // Set when clients.size hits 0; fires kill() unless a client rejoins.
  graceTimer: NodeJS.Timeout | null;
}

const sessions = new Map<string, Session>();

const GRACE_MS = 5 * 60 * 1000;       // 5 min — matches spec
const BUFFER_MAX_BYTES = 1 * 1024 * 1024; // 1 MiB per session

function appendBuffer(sess: Session, chunk: string): void {
  sess.buffer.push(chunk);
  sess.bufferBytes += Buffer.byteLength(chunk, 'utf8');
  while (sess.bufferBytes > BUFFER_MAX_BYTES && sess.buffer.length > 1) {
    const dropped = sess.buffer.shift()!;
    sess.bufferBytes -= Buffer.byteLength(dropped, 'utf8');
  }
}

export async function createSession(
  opts: CreateOpts,
  cli: CliSpawn,
): Promise<{ ok: true; id: string; label: string } | { ok: false; error: string }> {
  const pty = await loadPty();
  if (!pty) {
    return { ok: false, error: 'node-pty not installed — run `nostr-station doctor --fix`' };
  }
  const spec = resolveCmd(opts, cli);
  if (!spec) {
    return { ok: false, error: `unknown command key: ${opts.key}` };
  }

  const loginPath = await resolveLoginPath();
  // Splice login shell PATH in front of process.env.PATH so anything the
  // server had (node, npm) still wins over shell rc overrides when there's
  // a duplicate, but user-installed bins in ~/.cargo/bin etc. are findable.
  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)) as Record<string, string>,
    ...(spec.env || {}),
    PATH: `${loginPath}:${process.env.PATH || ''}`,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    // Some TUIs (including ngit's rust-dialoguer prompts) sniff $LANG for
    // UTF-8 support before enabling unicode box-drawing. Force UTF-8 so QR
    // codes render as █/▀/▄ instead of ASCII fallback.
    LANG: process.env.LANG || 'en_US.UTF-8',
  };

  let child: IPty;
  try {
    child = pty.spawn(spec.cmd, spec.args, {
      name: 'xterm-256color',
      cols: DEFAULT_COLS, rows: DEFAULT_ROWS,
      cwd:  spec.cwd || os.homedir(),
      env,
    });
  } catch (e) {
    return { ok: false, error: `failed to spawn: ${(e as Error).message?.slice(0, 160)}` };
  }

  const id = crypto.randomBytes(12).toString('hex');
  const sess: Session = {
    id, pty: child, spec,
    cols: DEFAULT_COLS, rows: DEFAULT_ROWS,
    createdAt: Date.now(),
    exited: false, exitCode: null,
    buffer: [], bufferBytes: 0,
    clients: new Set(),
    graceTimer: null,
  };
  sessions.set(id, sess);

  child.onData((data) => {
    appendBuffer(sess, data);
    for (const ws of sess.clients) {
      if (ws.readyState === 1 /* OPEN */) {
        // Send raw output as a text frame — the client writes it straight
        // into xterm.js which expects the raw byte stream.
        try { ws.send(data); } catch {}
      }
    }
  });

  child.onExit(({ exitCode, signal }) => {
    sess.exited = true;
    sess.exitCode = exitCode ?? (signal ? -signal : null);
    // Emit a trailing control frame so clients can render "[process exited]".
    const msg = JSON.stringify({ type: 'exit', exitCode: sess.exitCode });
    for (const ws of sess.clients) {
      if (ws.readyState === 1) {
        try { ws.send(`\x00${msg}`); } catch {}
      }
    }
    // Clean up after a short lingering window so a user reading final output
    // doesn't have the tab yanked out from under them. 30s is arbitrary but
    // matches typical "I finished looking at that" dwell time.
    setTimeout(() => destroySession(id, 'exited'), 30_000);
  });

  return { ok: true, id, label: spec.label };
}

export function getSession(id: string): Session | undefined {
  return sessions.get(id);
}

export function attachClient(id: string, ws: WebSocket): Session | null {
  const sess = sessions.get(id);
  if (!sess) return null;

  // Cancel any in-flight kill — the client came back in time.
  if (sess.graceTimer) {
    clearTimeout(sess.graceTimer);
    sess.graceTimer = null;
  }

  sess.clients.add(ws);

  // Replay scrollback so the client renders the session as-was. xterm.js
  // handles ANSI mid-stream, so we can ship the whole buffer in one write.
  if (sess.buffer.length > 0 && ws.readyState === 1) {
    try { ws.send(sess.buffer.join('')); } catch {}
  }

  return sess;
}

export function detachClient(id: string, ws: WebSocket): void {
  const sess = sessions.get(id);
  if (!sess) return;
  sess.clients.delete(ws);
  if (sess.clients.size === 0 && !sess.exited) {
    // Last viewer left — start the grace window. If no one rejoins within
    // GRACE_MS, kill the PTY so we don't leak processes from abandoned tabs.
    sess.graceTimer = setTimeout(() => destroySession(id, 'idle-timeout'), GRACE_MS);
  }
}

export function writeInput(id: string, data: string): boolean {
  const sess = sessions.get(id);
  if (!sess || sess.exited) return false;
  try { sess.pty.write(data); return true; } catch { return false; }
}

export function resizeSession(id: string, cols: number, rows: number): boolean {
  const sess = sessions.get(id);
  if (!sess || sess.exited) return false;
  if (!Number.isInteger(cols) || !Number.isInteger(rows)) return false;
  if (cols < 2 || rows < 2 || cols > MAX_COLS || rows > MAX_ROWS) return false;
  try {
    sess.pty.resize(cols, rows);
    sess.cols = cols; sess.rows = rows;
    return true;
  } catch {
    return false;
  }
}

export function destroySession(id: string, reason: string): boolean {
  const sess = sessions.get(id);
  if (!sess) return false;
  sessions.delete(id);
  if (sess.graceTimer) clearTimeout(sess.graceTimer);
  // Notify any still-attached client with a final control frame before we
  // tear down — some clients see the WS close handler before the onExit
  // event otherwise.
  const msg = JSON.stringify({ type: 'closed', reason });
  for (const ws of sess.clients) {
    try { if (ws.readyState === 1) ws.send(`\x00${msg}`); } catch {}
    try { ws.close(1000, reason); } catch {}
  }
  try { sess.pty.kill(); } catch {}
  return true;
}

export function listSessions(): Array<{ id: string; label: string; exited: boolean; createdAt: number }> {
  return Array.from(sessions.values()).map(s => ({
    id: s.id, label: s.spec.label, exited: s.exited, createdAt: s.createdAt,
  }));
}

// Full teardown — used when the server itself is shutting down.
export function destroyAllSessions(): void {
  for (const id of Array.from(sessions.keys())) destroySession(id, 'server-shutdown');
}
