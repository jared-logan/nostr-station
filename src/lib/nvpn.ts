// nvpn (nostr-vpn) runtime control + log tail.
//
// Companion to nvpn-installer.ts, which only handles the one-time install.
// Everything here is about driving an already-installed binary from the
// dashboard so the user never has to drop into a terminal:
//
//   probeNvpnStatus()   — single source of truth for the Status panel,
//                         the Logs banner, and any /api/nvpn/* read.
//   startNvpn() / stopNvpn() / restartNvpn() — control surface for the
//                         Status row buttons.
//   installNvpnService() — best-effort `sudo -n nvpn service install`
//                         retry from the UI; mirrors the installer's
//                         optional last step.
//   startNvpnLogTail()  — singleton tailer that pumps the daemon log
//                         file into a LogBuffer so /api/logs/vpn shows
//                         live lines instead of the static "tail it
//                         yourself" hint.
//
// Every shell-out uses execa with a fixed argv array — no string
// concatenation into /bin/sh -c — and a tight timeout. The Status panel
// hits this on a 5s tick; a wedged nvpn daemon socket must not block the
// dashboard event loop.

import { execa } from 'execa';
import fs from 'fs';
import path from 'path';
import os from 'os';
import readline from 'readline';
import { findBin } from './detect.js';
import type { LogBuffer } from './log-buffer.js';

// ── Status ────────────────────────────────────────────────────────────────

// Schema-flexible — upstream `nvpn status --json` shape has shifted across
// releases. We only depend on `daemon.running` (bool) and `daemon.log_file`
// (string) for control flow; everything else is passed through to the UI
// untouched so a forward-compatible field doesn't require a code change.
export interface NvpnStatusJson {
  daemon?: {
    running?:    boolean;
    log_file?:   string | null;
    pid?:        number | null;
    started_at?: string | null;
    [k: string]: unknown;
  };
  tunnel_ip?:    string | null;
  npub?:         string | null;
  pubkey?:       string | null;
  peers?:        unknown;
  [k: string]:   unknown;
}

export interface NvpnStatus {
  installed:    boolean;
  binPath:      string | null;
  running:      boolean;
  tunnelIp:     string | null;
  raw:          NvpnStatusJson | null;
  error:        string | null;
  fetchedAt:    number;
}

const STATUS_TIMEOUT_MS = 1500;
const CONTROL_TIMEOUT_MS = 20_000;

export async function probeNvpnStatus(): Promise<NvpnStatus> {
  const binPath = findBin('nvpn');
  const fetchedAt = Date.now();
  if (!binPath) {
    return {
      installed: false, binPath: null, running: false,
      tunnelIp: null, raw: null, error: null, fetchedAt,
    };
  }
  let raw: NvpnStatusJson | null = null;
  let error: string | null = null;
  try {
    const { stdout } = await execa(binPath, ['status', '--json'], {
      timeout: STATUS_TIMEOUT_MS, stdio: 'pipe',
    });
    try { raw = JSON.parse(stdout); }
    catch (e: any) { error = `unparseable status JSON: ${(e?.message || '').slice(0, 120)}`; }
  } catch (e: any) {
    // execa surfaces both timeout and non-zero exit via thrown errors. We
    // collapse both to a short single-line string for the UI; the binary
    // not responding within 1.5s means the daemon socket is wedged or
    // not listening — which we represent as `running: false`.
    error = (e?.shortMessage || e?.message || String(e)).slice(0, 240);
  }
  const running  = !!raw?.daemon?.running;
  const tunnelIp = (raw?.tunnel_ip as string) ?? null;
  return { installed: true, binPath, running, tunnelIp, raw, error, fetchedAt };
}

// ── Control ───────────────────────────────────────────────────────────────

export interface ControlResult {
  ok:     boolean;
  detail: string;
}

function summarizeError(e: any): string {
  const stderr = e?.stderr?.toString?.() || '';
  const msg    = e?.shortMessage || e?.message || String(e);
  return (stderr.trim() || msg).slice(0, 240);
}

export async function startNvpn(): Promise<ControlResult> {
  const binPath = findBin('nvpn');
  if (!binPath) return { ok: false, detail: 'nvpn binary not installed' };
  try {
    await execa(binPath, ['start', '--daemon'], { timeout: CONTROL_TIMEOUT_MS, stdio: 'pipe' });
    return { ok: true, detail: 'nvpn daemon started' };
  } catch (e: any) {
    return { ok: false, detail: summarizeError(e) };
  }
}

export async function stopNvpn(): Promise<ControlResult> {
  const binPath = findBin('nvpn');
  if (!binPath) return { ok: false, detail: 'nvpn binary not installed' };
  try {
    await execa(binPath, ['stop'], { timeout: CONTROL_TIMEOUT_MS, stdio: 'pipe' });
    return { ok: true, detail: 'nvpn daemon stopped' };
  } catch (e: any) {
    return { ok: false, detail: summarizeError(e) };
  }
}

export async function restartNvpn(): Promise<ControlResult> {
  const stop = await stopNvpn();
  // Best-effort stop — proceed to start either way. If the daemon was
  // already down `nvpn stop` exits non-zero, but a fresh start is still
  // the right outcome from a UI button labelled "restart."
  const start = await startNvpn();
  if (!start.ok) return { ok: false, detail: start.detail };
  return { ok: true, detail: stop.ok ? 'restarted' : `started (stop hint: ${stop.detail})` };
}

// `sudo -n` so it fails fast on an empty cred cache. The dashboard runs
// without a TTY for prompting; the user has to have run a sudo command
// in the same shell session shortly beforehand for this to succeed.
export async function installNvpnService(): Promise<ControlResult> {
  const binPath = findBin('nvpn');
  if (!binPath) return { ok: false, detail: 'nvpn binary not installed' };
  try {
    await execa('sudo', ['-n', binPath, 'service', 'install'], {
      timeout: 30_000, stdio: 'pipe',
    });
    return { ok: true, detail: 'service installed' };
  } catch (e: any) {
    return { ok: false, detail: summarizeError(e) };
  }
}

// ── Log tail ─────────────────────────────────────────────────────────────
//
// The log file path comes from `nvpn status --json` (`daemon.log_file`).
// Across releases nvpn has logged to multiple locations (~/.config/nvpn/,
// ~/Library/Application Support/nvpn/, /var/log/...), so we never hardcode
// a path — the daemon tells us where it's writing.
//
// Implementation: poll-based incremental read. fs.watch is unreliable on
// macOS for files on certain filesystems, and on Linux it can miss writes
// when the inode is rotated. A 1s poll that compares size and reads the
// delta is simpler, matches the existing watchdog probe cadence, and
// degrades gracefully when the file rotates (we re-open from offset 0).

interface TailerHandle {
  stop: () => void;
}

const POLL_INTERVAL_MS = 1000;
const LOG_PATH_RECHECK_MS = 15_000;

export function startNvpnLogTail(buffer: LogBuffer): TailerHandle {
  let stopped = false;
  let currentPath: string | null = null;
  let offset = 0;
  let pollTimer: NodeJS.Timeout | null = null;
  let pathTimer: NodeJS.Timeout | null = null;

  const resolveLogPath = async (): Promise<string | null> => {
    const s = await probeNvpnStatus();
    if (!s.installed) return null;
    const fromStatus = s.raw?.daemon?.log_file;
    if (typeof fromStatus === 'string' && fromStatus.length > 0) return fromStatus;
    // Common fallbacks if the daemon doesn't report a path. Read order
    // matches what we see in practice across macOS / Linux installs.
    const home = os.homedir();
    const candidates = [
      path.join(home, '.config', 'nvpn', 'daemon.log'),
      path.join(home, 'Library', 'Application Support', 'nvpn', 'daemon.log'),
      '/var/log/nvpn.log',
    ];
    for (const c of candidates) {
      try { fs.accessSync(c, fs.constants.R_OK); return c; }
      catch { /* try next */ }
    }
    return null;
  };

  const onLines = (chunk: string): void => {
    const lines = chunk.split('\n');
    for (const raw of lines) {
      const line = raw.replace(/\r$/, '');
      if (!line) continue;
      // nvpn doesn't emit a level prefix consistently. Heuristic match
      // mirrors LogsPanel.classify() so the dashboard's coloring works
      // without a wire-protocol change.
      const level: 'info' | 'warn' | 'error' =
        /\b(error|err|panic|fail)\b/i.test(line) ? 'error'
      : /\b(warn|warning)\b/i.test(line)         ? 'warn'
      :                                            'info';
      buffer.push(level, line);
    }
  };

  const poll = async (): Promise<void> => {
    if (stopped) return;
    if (!currentPath) {
      schedulePoll();
      return;
    }
    try {
      const st = fs.statSync(currentPath);
      // File rotated / truncated — start over from byte 0.
      if (st.size < offset) offset = 0;
      if (st.size > offset) {
        const stream = fs.createReadStream(currentPath, {
          start: offset, end: st.size - 1, encoding: 'utf8',
        });
        let buf = '';
        await new Promise<void>((resolve) => {
          stream.on('data', (d: string | Buffer) => {
            buf += typeof d === 'string' ? d : d.toString('utf8');
          });
          stream.on('end',   () => resolve());
          stream.on('error', () => resolve());
        });
        offset = st.size;
        // Only emit complete lines — keep the trailing partial for the
        // next poll. (Most real log writes end in \n, so this is a
        // correctness-against-pathological-streams measure.)
        const idx = buf.lastIndexOf('\n');
        const complete = idx >= 0 ? buf.slice(0, idx + 1) : '';
        if (complete) onLines(complete);
      }
    } catch { /* file disappeared — try again next tick */ }
    schedulePoll();
  };

  const schedulePoll = (): void => {
    if (stopped) return;
    pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
  };

  const refreshPath = async (): Promise<void> => {
    if (stopped) return;
    const p = await resolveLogPath();
    if (p && p !== currentPath) {
      currentPath = p;
      // Seek to end so the user doesn't get a flood of historical lines
      // every time the daemon's log path changes.
      try { offset = fs.statSync(p).size; } catch { offset = 0; }
      buffer.info(`tailing ${p}`);
    }
    pathTimer = setTimeout(refreshPath, LOG_PATH_RECHECK_MS);
  };

  refreshPath();
  schedulePoll();

  return {
    stop() {
      stopped = true;
      if (pollTimer) clearTimeout(pollTimer);
      if (pathTimer) clearTimeout(pathTimer);
    },
  };
}

// ── Pure helpers (testable) ──────────────────────────────────────────────

export interface NvpnRowProbe {
  installed:    boolean;
  running:      boolean;
  tunnelIp:     string | null;
  serviceLoaded?: boolean | null;
}

export interface NvpnRowState {
  state:  'ok' | 'warn' | 'err';
  value:  string;
  ok:     boolean;
}

// Maps the runtime probe to the Status row display string. Mirrors
// nvpnStateFor in commands/Status.tsx but takes the richer probe shape
// the new control surface produces. Pure + exported for unit tests so
// every branch can be pinned without spawning processes.
export function nvpnRowStateFor(p: NvpnRowProbe): NvpnRowState {
  if (!p.installed)   return { state: 'err',  value: 'not installed', ok: false };
  if (!p.running)     return { state: 'warn', value: 'not connected', ok: false };
  if (p.tunnelIp)     return { state: 'ok',   value: p.tunnelIp,      ok: true  };
  return { state: 'warn', value: 'running, no tunnel ip',             ok: false };
}
