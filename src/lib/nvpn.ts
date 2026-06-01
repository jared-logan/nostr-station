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
import { spawnSync } from 'node:child_process';
import dgram from 'dgram';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import os from 'os';
import readline from 'readline';
import { findBin } from './detect.js';
import { runAdminVerb, isAdminHelperInstalled } from './nvpn-sudo.js';
import { canonicalNetworkId, computeNvpnTunnelIp } from './nvpn-diagnostics.js';
import type { LogBuffer } from './log-buffer.js';

// ── Lifecycle pub/sub ────────────────────────────────────────────────────
//
// Action helpers (startNvpn / stopNvpn / restartNvpn) emit `state-changed`
// after the daemon transitions, so the Logs-panel SSE can push a fresh
// status frame without forcing the user to refresh. Without this, a
// successful Stop button click left "Running" + tunnel IP visible until
// the next page load. Listeners must tolerate bursts (restart fires twice
// — once for stop, once for start) and slow consequences (probeNvpnStatus
// can take a couple of seconds; the daemon may still be tearing down).
export const nvpnEvents = new EventEmitter();

// ── Probe cache primitive ───────────────────────────────────────────────
//
// Every API surface that needs nvpn state used to spawn its own
// `nvpn status --json` (or `nvpn service status --json`) subprocess —
// /api/status, /api/nvpn/status, the SSE banner-frame, gatherStatus,
// loadVpnDetail, etc. A single Config-panel open could fan out to 4–5
// concurrent probes, each bounded at 4s. On a slow daemon this stacked
// up enough to make the dashboard feel sluggish.
//
// memoizeWithTtl wraps an async fn with a TTL cache that ALSO dedupes
// in-flight calls — concurrent callers within the window share one
// promise, so we spawn at most one subprocess per TTL slice. State
// hardly moves second-to-second; 2s is short enough that nothing
// surprising goes stale, long enough to absorb the typical burst of
// concurrent calls a single panel render emits.
//
// On error we drop the cache so the next caller retries (a wedged
// daemon shouldn't sticky-cache its own failure for the full TTL).
// Action helpers also call .invalidate() via the state-changed event
// below, so a Stop/Start round-trip never sees pre-action cached data.

export type Memoized<T> = (() => Promise<T>) & { invalidate: () => void };

export function memoizeWithTtl<T>(fn: () => Promise<T>, ttlMs: number): Memoized<T> {
  let cache: { fetchedAt: number; promise: Promise<T> } | null = null;
  const wrapped = (() => {
    const now = Date.now();
    if (cache && now - cache.fetchedAt < ttlMs) return cache.promise;
    const promise = fn();
    cache = { fetchedAt: now, promise };
    // Drop the cached entry on rejection so the next caller retries.
    // Guard with identity check in case .invalidate() (or another fresh
    // call) replaced the cache slot while we were awaiting.
    promise.catch(() => { if (cache && cache.promise === promise) cache = null; });
    return promise;
  }) as Memoized<T>;
  wrapped.invalidate = () => { cache = null; };
  return wrapped;
}

// Stale-while-revalidate variant. Same dedupe + per-fetch semantics as
// memoizeWithTtl on the first-ever call (block until the underlying fn
// resolves), but after the TTL elapses the cached value is returned
// IMMEDIATELY and a background refresh fires. Subsequent callers during
// the refresh continue to get the previously-cached value; once the
// refresh resolves, the cache updates and the new value is served from
// then on.
//
// Why this exists: nvpn status --json can take 4 s when the daemon
// socket is wedged (the CLI doesn't fast-fail), and the dashboard pays
// that cost on every cache miss with the plain TTL cache. SWR turns
// the first call into a one-time cost — every call afterwards is
// instant from cache, even past the TTL.
//
// Trade-off: state transitions show up to ~TTL of staleness in the UI
// (a freshly-stopped daemon still reports "running" briefly). For nvpn
// probes that's invisible on a healthy daemon and net-better than the
// 4 s freeze on a wedged one.
//
// On refresh rejection: the cached value is intentionally preserved (a
// transient probe failure shouldn't drop the last-known-good state).
// The next caller still triggers a fresh background refresh on the
// stale path; the only escape hatch from a permanently-broken upstream
// is .invalidate() (called from action helpers after Start/Stop).
//
// On first-call rejection: nothing cached yet, the caller's promise
// rejects; the next call retries (the firstFetch slot clears via the
// .finally hook).
export function memoizeWithSwr<T>(fn: () => Promise<T>, ttlMs: number): Memoized<T> {
  let cache: { fetchedAt: number; value: T } | null = null;
  let firstFetch:        Promise<T> | null = null;
  let backgroundRefresh: Promise<unknown> | null = null;
  // Bumps on every invalidate() so an in-flight refresh whose result
  // arrives after a state-changed event doesn't clobber the fresh
  // cleared state.
  let epoch = 0;

  const fetchAndStore = async (): Promise<T> => {
    const myEpoch = epoch;
    const value = await fn();
    if (myEpoch === epoch) {
      cache = { fetchedAt: Date.now(), value };
    }
    return value;
  };

  const wrapped = (() => {
    if (cache) {
      const stale = Date.now() - cache.fetchedAt >= ttlMs;
      if (stale && !backgroundRefresh) {
        backgroundRefresh = fetchAndStore()
          // Swallow refresh errors — we'd rather keep the stale value
          // than crash the .then chain of whoever started the refresh
          // (no one awaits backgroundRefresh; it's fire-and-forget).
          .catch(() => undefined)
          .finally(() => { backgroundRefresh = null; });
      }
      return Promise.resolve(cache.value);
    }
    // No cache → first call ever, or post-error retry. Block on a
    // real fetch, dedupe concurrent callers onto the same promise.
    if (!firstFetch) {
      firstFetch = fetchAndStore().finally(() => { firstFetch = null; });
    }
    return firstFetch;
  }) as Memoized<T>;

  wrapped.invalidate = () => {
    cache = null;
    backgroundRefresh = null;
    epoch++;
  };
  return wrapped;
}

const PROBE_CACHE_TTL_MS = 2_000;

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
  // 4.x: "daemon" | "config" | other strings; absent on 0.3.x.
  status_source?: string;
  [k: string]:   unknown;
}

// Insert `--config <path>` into a base argv at the position the nvpn
// CLI expects it: after the subcommand name(s) but before any --flag
// option. So `['status', '--json']` becomes `['status', '--config',
// PATH, '--json']`; `['service', 'status', '--json']` becomes
// `['service', 'status', '--config', PATH, '--json']`; positional
// args like `['import-invite', '<str>', '--json']` get the flag
// inserted between the positional and `--json`. Walking until the
// first `--` token covers all the shapes the CLI accepts without us
// hard-coding subcommand depth.
//
// Threading --config everywhere is mostly defensive — the
// nostr-station process runs as the same user who installed nvpn so
// the default lookup works — but anything that ever invokes nvpn
// under sudo (or with a mismatched $HOME) would otherwise drop into
// 4.x's silent config-snapshot fallback. Preempting that.
function buildNvpnArgs(base: string[]): string[] {
  const cfg = resolveCanonicalConfig().path;
  if (!cfg) return base;
  const out: string[] = [];
  let inserted = false;
  for (const arg of base) {
    if (!inserted && arg.startsWith('--')) {
      out.push('--config', cfg);
      inserted = true;
    }
    out.push(arg);
  }
  if (!inserted) out.push('--config', cfg);
  return out;
}

export interface NvpnStatus {
  installed:    boolean;
  binPath:      string | null;
  running:      boolean;
  tunnelIp:     string | null;
  // 4.x adds a `status_source` field that distinguishes live-daemon
  // data from a config snapshot: when the CLI can't reach the daemon
  // (typically because --config and $HOME resolve to different config
  // dirs) it silently falls back to printing config.toml-derived static
  // info with every live field nulled. Surface this so the route layer
  // can flag stale data to the dashboard instead of rendering
  // "everything zero" without warning.
  statusSource: string | null;
  raw:          NvpnStatusJson | null;
  error:        string | null;
  fetchedAt:    number;
}

// `nvpn status --json` walks the relay set + collects session state, so a
// healthy daemon under modest load can take a couple of seconds. Tighter
// budgets (we ran with 1.5s previously) caused the dashboard to flap the
// "stopped" banner whenever the probe stalled briefly, even with the
// daemon clearly running per systemd. 4s gives the daemon room and stays
// well under the 5s status tick.
const STATUS_TIMEOUT_MS = 4_000;
const CONTROL_TIMEOUT_MS = 20_000;

async function probeNvpnStatusUncached(): Promise<NvpnStatus> {
  const binPath = findBin('nvpn');
  const fetchedAt = Date.now();
  if (!binPath) {
    return {
      installed: false, binPath: null, running: false,
      tunnelIp: null, statusSource: null, raw: null, error: null, fetchedAt,
    };
  }
  // First pass — user-mode probe. Works on macOS and on Linux when the
  // user is running the daemon directly.
  let { raw, error } = await runStatusProbe(binPath, /* asRoot */ false);

  let statusSource = typeof raw?.status_source === 'string'
    ? (raw.status_source as string) : null;

  // Second pass — when the user-mode probe returned the static
  // config-snapshot path AND a systemd / launchd service is installed
  // and running, the live daemon is the root-owned service one. The
  // user-mode CLI can't see its socket; re-probe via sudo so the
  // dashboard reflects truth instead of the user-side phantom.
  //
  // Sidesteps the "Start button works, UI still says stopped" UX bug
  // that came out of the post-pentest VM smoke. probeNvpnServiceStatus
  // is SWR-cached so the extra hop is at most one subprocess per cache
  // window, and only fires when status_source already told us we're
  // looking at the wrong identity.
  if (statusSource !== 'daemon') {
    try {
      const svc = await probeNvpnServiceStatusUncached();
      if (svc.installed && svc.running) {
        const sudoProbe = await runStatusProbe(binPath, /* asRoot */ true);
        if (sudoProbe.raw) {
          raw = sudoProbe.raw;
          error = sudoProbe.error;
          statusSource = typeof raw?.status_source === 'string'
            ? (raw.status_source as string) : null;
        }
      }
    } catch { /* best-effort — fall through with the user-mode result */ }
  }

  // In 4.x, when status_source !== "daemon" every "live" field (running,
  // endpoint, peer state, …) is nulled and what's returned is a static
  // config snapshot. Treating daemon.running as authoritative in that
  // mode would tell the dashboard "everything is down" while the daemon
  // is actually fine — force-flip running to false so the UI banner code
  // doesn't paint a green pill on top of a stale snapshot. The route
  // layer adds a top-level `stale` warning so the user sees *why*.
  const liveStatus = statusSource === null || statusSource === 'daemon';
  const running  = liveStatus && !!raw?.daemon?.running;
  const tunnelIp = (raw?.tunnel_ip as string) ?? null;
  return { installed: true, binPath, running, tunnelIp, statusSource, raw, error, fetchedAt };
}

// Single-call probe used by both passes above. Returns the parsed JSON
// (or null + error) without interpreting status_source — the caller
// decides whether to re-probe via sudo based on what came back.
async function runStatusProbe(
  binPath: string, asRoot: boolean,
): Promise<{ raw: NvpnStatusJson | null; error: string | null }> {
  let cmdBin: string;
  let cmdArgs: string[];
  if (asRoot) {
    // -H is the load-bearing flag here. Without it `sudo` preserves
    // the dashboard user's $HOME, and nvpn reads the user-side config
    // at /home/<dashboard-user>/.config/nvpn/ — the phantom that the
    // PR-#162 installer fix removes for new installs, but which
    // existing VMs still have on disk. -H flips $HOME to root's
    // (/root) so nvpn finds /root/.config/nvpn/ where the
    // service-installed daemon actually lives.
    //
    // We also DON'T pass --config here. buildNvpnArgs injects a
    // --config /home/<user>/.config/nvpn/config.toml derived from
    // os.homedir() on the dashboard process — which on the root
    // re-probe is wrong by construction. Let nvpn auto-detect from
    // the post-`sudo -H` $HOME instead.
    cmdBin  = 'sudo';
    cmdArgs = ['-H', '-n', binPath, 'status', '--json'];
  } else {
    // User-mode probe: --config pins the lookup against $HOME drift,
    // covering edge cases where $XDG_CONFIG_HOME is set or HOME got
    // re-rooted via a launcher script.
    cmdBin  = binPath;
    cmdArgs = buildNvpnArgs(['status', '--json']);
  }
  try {
    const { stdout } = await execa(cmdBin, cmdArgs, {
      timeout: STATUS_TIMEOUT_MS, stdio: 'pipe',
    });
    try { return { raw: JSON.parse(stdout), error: null }; }
    catch (e: any) {
      return { raw: null, error: `unparseable status JSON: ${(e?.message || '').slice(0, 120)}` };
    }
  } catch (e: any) {
    // execa surfaces both timeout and non-zero exit via thrown errors. We
    // collapse both to a short single-line string for the UI. NB: a probe
    // failure leaves `running: false` because we never saw a daemon.running
    // payload — but consumers must NOT read that as "daemon stopped" on its
    // own. A wedged or slow socket on a healthy daemon hits this same
    // branch; the banner code in web-server.ts cross-checks
    // probeNvpnServiceStatus() before flipping the user-facing pill.
    return {
      raw: null,
      error: (e?.shortMessage || e?.message || String(e)).slice(0, 240),
    };
  }
}

// Public probe — TTL-cached + concurrent-call deduped (see memoizeWithTtl
// rationale above). Routes / SSE / gatherStatus all call this; it spawns
// at most one nvpn subprocess per PROBE_CACHE_TTL_MS slice.
export const probeNvpnStatus: Memoized<NvpnStatus> =
  memoizeWithSwr(probeNvpnStatusUncached, PROBE_CACHE_TTL_MS);

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

// systemctl wrapper for the service-installed daemon lifecycle on
// Linux. nvpn's CLI does NOT expose `nvpn service start/stop/restart`
// — `service` only has install/uninstall/enable/disable/status. The
// daemon's runtime lifecycle is controlled via systemctl directly,
// which is what `applyLinuxCapsDropIn` already does for its
// try-restart at the end of the caps drop-in flow.
//
// macOS is out of scope here: the equivalent would be `launchctl
// bootstrap/bootout system <plist-path>`, but no macOS users have
// reported the Start-button issue (macOS doesn't have Linux's
// CAP_NET_ADMIN gating, so user-mode `nvpn start --daemon` works
// there). Tracking macOS launchctl routing as a follow-up.
async function systemctlControl(
  op: 'start' | 'stop' | 'restart',
): Promise<ControlResult> {
  // Helper-primary: when the root-owned helper is provisioned, go through
  // it (sudo -n nvpn-admin <op>) — passwordless, scoped. Otherwise fall
  // back to the direct command so an un-provisioned box (e.g. right after
  // upgrading) can still Start/Stop/Restart with the user's own sudo. The
  // fallback creates NO persistent grant — it only works with a warm cache
  // / existing NOPASSWD, same as before the helper existed.
  if (isAdminHelperInstalled()) return runAdminVerb(op);
  try {
    await execa('sudo', ['-n', 'systemctl', op, 'nvpn.service'], {
      timeout: SERVICE_OP_TIMEOUT_MS, stdio: 'pipe',
    });
    return { ok: true, detail: `systemctl ${op} nvpn.service` };
  } catch (e: any) {
    const stderr = (e?.stderr?.toString?.() || '').trim();
    if (/password is required|sudo:.*required/i.test(stderr)) {
      return {
        ok: false,
        detail: `needs admin access — set it up once in the Service tab ("Set up admin access"), ` +
                `or run \`sudo systemctl ${op} nvpn.service\` in a terminal.`,
      };
    }
    return { ok: false, detail: summarizeError(e) };
  }
}

export async function startNvpn(): Promise<ControlResult> {
  const binPath = findBin('nvpn');
  if (!binPath) return { ok: false, detail: 'nvpn binary not installed' };
  try {
    // Prefer the systemd service when one is installed (Linux). Running
    // `nvpn start --daemon` as the dashboard user fails on Linux without
    // CAP_NET_ADMIN — the daemon dies in <2s on the first `ip address
    // replace` RTNETLINK call with "Operation not permitted." The
    // service-installed daemon has the right caps via the drop-in at
    // /etc/systemd/system/nvpn.service.d/10-nostr-station-caps.conf
    // and is the only working path on most Linux installs.
    //
    // probeUncached (not the SWR-cached export) so a fresh button click
    // doesn't race against a stale "service: not installed" snapshot.
    if (process.platform === 'linux') {
      const svc = await probeNvpnServiceStatusUncached();
      if (svc.installed) return await systemctlControl('start');
    }
    // Fallback: user-mode daemon. macOS, or Linux without the systemd
    // unit. On Linux without caps this still fails — but that matches
    // the pre-fix behavior; granting file caps or installing the
    // systemd service is the way through.
    await execa(binPath, ['start', '--daemon'], { timeout: CONTROL_TIMEOUT_MS, stdio: 'pipe' });
    return { ok: true, detail: 'nvpn daemon started' };
  } catch (e: any) {
    return { ok: false, detail: summarizeError(e) };
  } finally {
    // Emit even on failure — the daemon may have partially transitioned
    // (e.g. socket bound but config rejected) and the SSE consumer wants
    // to see the new probe result regardless.
    nvpnEvents.emit('state-changed');
  }
}

export async function stopNvpn(): Promise<ControlResult> {
  const binPath = findBin('nvpn');
  if (!binPath) return { ok: false, detail: 'nvpn binary not installed' };
  try {
    if (process.platform === 'linux') {
      const svc = await probeNvpnServiceStatusUncached();
      if (svc.installed) return await systemctlControl('stop');
    }
    await execa(binPath, buildNvpnArgs(['stop']), { timeout: CONTROL_TIMEOUT_MS, stdio: 'pipe' });
    return { ok: true, detail: 'nvpn daemon stopped' };
  } catch (e: any) {
    return { ok: false, detail: summarizeError(e) };
  } finally {
    nvpnEvents.emit('state-changed');
  }
}

export async function restartNvpn(): Promise<ControlResult> {
  const binPath = findBin('nvpn');
  if (!binPath) return { ok: false, detail: 'nvpn binary not installed' };
  // Prefer the atomic `systemctl restart` verb over stop-then-start —
  // systemd handles the transition in one syscall set, avoiding the
  // brief "stopped" window during which a status probe would paint
  // the meta strip red.
  if (process.platform === 'linux') {
    const svc = await probeNvpnServiceStatusUncached();
    if (svc.installed) {
      const r = await systemctlControl('restart');
      nvpnEvents.emit('state-changed');
      return r;
    }
  }
  // User-mode fallback — best-effort stop, then start.
  const stop = await stopNvpn();
  const start = await startNvpn();
  if (!start.ok) return { ok: false, detail: start.detail };
  return { ok: true, detail: stop.ok ? 'restarted' : `started (stop hint: ${stop.detail})` };
}

// ── Discovered-peer state reset (recover from runaway discovery) ──────────
//
// The daemon caches discovered peers in `daemon.recent-peers.json` next to
// its config. A rogue/looping daemon can fill it with stale peers and hit
// the daemon's hard link ceiling ("max links exceeded: 256"), which blocks
// the mesh until the file is cleared — until now only doable from a shell.
// resetNvpnPeerState() stops the daemon, clears the cache (sudo when
// root-owned), and starts it fresh.

// The daemon's hard peer-link ceiling. Used to warn before the mesh wedges.
export const NVPN_LINK_CEILING = 256;

// Candidate paths for the daemon's recent-peers cache, most-likely first:
// next to the config the daemon actually reads (canonical), then the common
// user + root config dirs. Pure-ish (one resolve), exported for tests.
export function recentPeersCandidatePaths(): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (dir: string | null | undefined) => {
    if (!dir) return;
    const p = path.join(dir, 'daemon.recent-peers.json');
    if (!seen.has(p)) { seen.add(p); out.push(p); }
  };
  const canon = resolveCanonicalConfig().path;
  if (canon) add(path.dirname(canon));
  add(path.join(os.homedir(), '.config', 'nvpn'));
  add('/root/.config/nvpn');
  return out;
}


export async function resetNvpnPeerState(): Promise<ControlResult> {
  // Helper-primary: the helper stops the daemon, clears the recent-peers
  // cache (path derived from SUDO_USER inside the helper), and restarts.
  if (isAdminHelperInstalled()) {
    const r = await runAdminVerb('reset-peers');
    return r.ok ? { ok: true, detail: 'cleared discovered-peer cache and restarted the daemon' } : r;
  }
  // Fallback for un-provisioned boxes: stop (own fallback), clear the
  // user-owned cache best-effort, start. Can't clear a root-owned cache
  // without the helper — that's noted.
  const stop = await stopNvpn();
  let cleared = 0;
  for (const p of recentPeersCandidatePaths()) {
    try { if (fs.existsSync(p)) { fs.rmSync(p, { force: true }); cleared++; } } catch { /* root-owned — needs the helper */ }
  }
  const start = await startNvpn();
  if (!start.ok) return { ok: false, detail: `cleared ${cleared} cache file(s) but daemon failed to restart: ${start.detail}` };
  return { ok: true, detail: `cleared ${cleared} peer-cache file(s) and restarted the daemon${stop.ok ? '' : ` (stop hint: ${stop.detail})`}` };
}

// ── System service lifecycle ─────────────────────────────────────────────
//
// `nvpn service install` writes a systemd unit (linux) or launchd plist
// (darwin) so the daemon survives reboot. install / enable / disable /
// uninstall all need root for the system paths involved (/etc/systemd/
// system, /Library/LaunchDaemons), so each shells through `sudo -n`.
// Empty cred cache → fails fast with a clear stderr we surface in the
// toast hint, mirroring the install pattern.
//
// `service status --json` is unprivileged — the dashboard polls it as
// the source of truth for the meta strip's four-pill display
// (installed / enabled at boot / loaded / running).

const SERVICE_STATUS_TIMEOUT_MS = 4_000;
const SERVICE_OP_TIMEOUT_MS     = 30_000;

export interface NvpnServiceStatus {
  supported:     boolean;
  installed:     boolean;
  // `disabled` is a system-supervisor concept: the unit is installed
  // but won't auto-start at boot. Inverse of "enabled at boot."
  disabled:      boolean;
  loaded:        boolean;
  running:       boolean;
  pid:           number | null;
  label:         string | null;
  plistPath:     string | null;
  binaryPath:    string | null;
  binaryVersion: string | null;
  raw:           Record<string, unknown> | null;
  error:         string | null;
}

export async function probeNvpnServiceStatusUncached(): Promise<NvpnServiceStatus> {
  const binPath = findBin('nvpn');
  if (!binPath) {
    return {
      supported: false, installed: false, disabled: false, loaded: false, running: false,
      pid: null, label: null, plistPath: null, binaryPath: null, binaryVersion: null,
      raw: null, error: 'nvpn binary not installed',
    };
  }
  try {
    const { stdout } = await execa(binPath, buildNvpnArgs(['service', 'status', '--json']), {
      timeout: SERVICE_STATUS_TIMEOUT_MS, stdio: 'pipe',
    });
    let raw: Record<string, unknown> | null = null;
    try { raw = JSON.parse(stdout); }
    catch { return svcErrorResponse('unparseable service status JSON'); }
    return {
      supported:     !!raw?.supported,
      installed:     !!raw?.installed,
      disabled:      !!raw?.disabled,
      loaded:        !!raw?.loaded,
      running:       !!raw?.running,
      pid:           typeof raw?.pid === 'number' ? raw.pid : null,
      label:         typeof raw?.label === 'string' ? raw.label : null,
      plistPath:     typeof raw?.plist_path === 'string' ? raw.plist_path : null,
      binaryPath:    typeof raw?.binary_path === 'string' ? raw.binary_path : null,
      binaryVersion: typeof raw?.binary_version === 'string' ? raw.binary_version : null,
      raw,
      error:         null,
    };
  } catch (e: any) {
    return svcErrorResponse(summarizeError(e));
  }
}

function svcErrorResponse(error: string): NvpnServiceStatus {
  return {
    supported: false, installed: false, disabled: false, loaded: false, running: false,
    pid: null, label: null, plistPath: null, binaryPath: null, binaryVersion: null,
    raw: null, error,
  };
}

// Public service-status probe — same cache treatment as probeNvpnStatus
// above. Used by the SSE banner's running fallback, the Logs-panel meta
// strip, and the renderServiceBlock UI.
export const probeNvpnServiceStatus: Memoized<NvpnServiceStatus> =
  memoizeWithSwr(probeNvpnServiceStatusUncached, PROBE_CACHE_TTL_MS);

// ── Cache invalidation on lifecycle events ────────────────────────────
//
// Listener registers at module load, before any per-connection SSE
// listener — EventEmitter dispatches in registration order so the cache
// busts before the SSE handler awaits a fresh probe. Without this, a
// Stop click would emit state-changed → SSE handler probes → cache
// returns the pre-stop value still inside its 2s window, the meta strip
// renders "running" for a beat before the next user-driven probe.
nvpnEvents.on('state-changed', () => {
  probeNvpnStatus.invalidate();
  probeNvpnServiceStatus.invalidate();
});

// `sudo -n` so it fails fast on an empty cred cache. The dashboard runs
// without a TTY for prompting; the user has to have run a sudo command
// in the same shell session shortly beforehand for this to succeed.
async function runServiceOp(
  op: 'install' | 'enable' | 'disable' | 'uninstall',
): Promise<ControlResult> {
  const binPath = findBin('nvpn');
  if (!binPath) return { ok: false, detail: 'nvpn binary not installed' };
  // Helper-primary for enable/disable/uninstall (they map 1:1 to helper
  // verbs). `install` here is the Service-tab "register/refresh the unit"
  // button — the binary already exists, so it uses `nvpn service install`
  // directly (the helper's `install` verb is the full download flow, driven
  // by the Install wizard). Fall back to direct sudo when un-provisioned.
  if (op !== 'install' && isAdminHelperInstalled()) return runAdminVerb(op);
  try {
    await execa('sudo', ['-n', binPath, 'service', op], {
      timeout: SERVICE_OP_TIMEOUT_MS, stdio: 'pipe',
    });
    return { ok: true, detail: `service ${op} ok` };
  } catch (e: any) {
    const stderr = (e?.stderr?.toString?.() || '').trim();
    if (/password is required|sudo:.*required/i.test(stderr)) {
      return {
        ok: false,
        detail: `needs admin access — set it up once in the Service tab ("Set up admin access"), ` +
                `or run \`sudo ${binPath} service ${op}\` in a terminal.`,
      };
    }
    return { ok: false, detail: summarizeError(e) };
  }
}

// ── Linux capabilities drop-in ─────────────────────────────────────────
//
// nvpn's upstream systemd unit doesn't request CAP_DAC_OVERRIDE, which
// the daemon needs to open `/proc/sys/net/ipv4/route/flush` (mode 0200
// root:root) when re-routing on tunnel changes. We layer a drop-in at
// /etc/systemd/system/nvpn.service.d/10-nostr-station-caps.conf — the
// systemd-idiomatic way to augment a unit without touching the
// upstream-written template. Survives upstream re-installs as long as
// the unit is still named nvpn.service.

const CAPS_DROP_IN_DIR  = '/etc/systemd/system/nvpn.service.d';
const CAPS_DROP_IN_PATH = `${CAPS_DROP_IN_DIR}/10-nostr-station-caps.conf`;

// Pure renderer — exported for unit tests. Keeps the cap list in one
// place so a future "add CAP_X" change has a single edit site.
export function renderLinuxCapsDropIn(): string {
  return [
    '# Managed by nostr-station — grants nvpn the caps it needs to flush',
    '# the kernel route cache and configure the local resolver. Safe to',
    '# remove if you prefer to run the daemon under fewer privileges.',
    '[Service]',
    'AmbientCapabilities=CAP_NET_ADMIN CAP_DAC_OVERRIDE CAP_NET_RAW',
    'CapabilityBoundingSet=CAP_NET_ADMIN CAP_DAC_OVERRIDE CAP_NET_RAW',
    '',
  ].join('\n');
}

async function applyLinuxCapsDropIn(): Promise<ControlResult> {
  if (process.platform !== 'linux') {
    return { ok: true, detail: 'non-linux — skipped' };
  }
  const content = renderLinuxCapsDropIn();
  try {
    // `install -d` is idempotent and handles the mkdir + mode in one
    // sudo call. `tee` writes via stdin so we don't have to round-trip
    // the content through a shell-escaped string.
    await execa('sudo', ['-n', 'install', '-d', '-m', '0755', CAPS_DROP_IN_DIR], {
      timeout: SERVICE_OP_TIMEOUT_MS, stdio: 'pipe',
    });
    await execa('sudo', ['-n', 'tee', CAPS_DROP_IN_PATH], {
      timeout: SERVICE_OP_TIMEOUT_MS, stdio: 'pipe', input: content,
    });
    await execa('sudo', ['-n', 'systemctl', 'daemon-reload'], {
      timeout: SERVICE_OP_TIMEOUT_MS, stdio: 'pipe',
    });
    // try-restart instead of restart: if the user has the service
    // stopped deliberately, don't start it back up behind their back.
    // When the service is running this picks up the new caps cleanly.
    await execa('sudo', ['-n', 'systemctl', 'try-restart', 'nvpn.service'], {
      timeout: SERVICE_OP_TIMEOUT_MS, stdio: 'pipe',
    });
    return { ok: true, detail: 'caps drop-in applied' };
  } catch (e: any) {
    const stderr = (e?.stderr?.toString?.() || '').trim();
    if (/password is required|sudo:.*required/i.test(stderr)) {
      return { ok: false, detail: 'sudo cred cache empty' };
    }
    return { ok: false, detail: summarizeError(e) };
  }
}

export { applyLinuxCapsDropIn };

// ── Canonical-config ExecStart drop-in (b2 stage 4) ─────────────────────
//
// The load-bearing step of b2: make the root daemon read the SAME config
// the dashboard reads/writes — the canonical user-side config — instead of
// its own auto-minted root config. We do it the systemd-idiomatic way: a
// drop-in that overrides ExecStart to add `--config <canonical path>`,
// layered over upstream's unit exactly like the caps drop-in. With the
// daemon pointed at the canonical config there is one identity and the
// create-then-heal reconcile/adopt copy becomes a no-op (kept as a dormant
// safety net for now).
//
// Safety: applyNvpnConfigDropIn() has a rollback guard — if the daemon was
// running and does NOT come back up after the repoint+restart, we remove
// the drop-in and reload so it returns to its working config. Worst case is
// the prior behavior, never a dead daemon.

const CONFIG_DROP_IN_PATH = `${CAPS_DROP_IN_DIR}/20-nostr-station-config.conf`;

// The deterministic canonical config path for installs — the dashboard
// user's `~/.config/nvpn/config.toml`. Unlike resolveCanonicalConfig(),
// this does NOT gate on existence (the installer seeds it), so the drop-in
// can name a stable target. Mirrors nvpnConfigCandidates()[0].
export function canonicalConfigInstallPath(): string {
  return path.join(os.homedir(), '.config', 'nvpn', 'config.toml');
}

// Pull the BASE unit's ExecStart out of `systemctl cat nvpn.service`
// output. cat prints each fragment under a `# <path>` header; the base unit
// is the fragment whose path ends in `/nvpn.service` (drop-ins live under
// `/nvpn.service.d/`). Returns the last ExecStart= in that fragment, or
// null. Pure — exported for unit tests.
export function extractBaseExecStart(catOutput: string): string | null {
  let inBase = false;
  let exec: string | null = null;
  for (const line of catOutput.split(/\r?\n/)) {
    const h = line.match(/^#\s+(\/\S+)\s*$/);
    if (h) { inBase = /\/nvpn\.service$/.test(h[1]); continue; }
    if (inBase) {
      const m = line.match(/^\s*ExecStart=(.*)$/);
      if (m && m[1].trim()) exec = m[1].trim();
    }
  }
  return exec;
}

// Rewrite an ExecStart command to read `configPath`: strip any existing
// `--config <x>` / `--config=<x>` first (so re-applying is idempotent and
// we never end up with two --config flags), then append the canonical one.
// Pure — exported for unit tests.
export function rewriteExecStartWithConfig(execStart: string, configPath: string): string {
  const stripped = execStart.replace(/\s*--config(?:=|\s+)\S+/g, '').trim();
  return `${stripped} --config ${configPath}`;
}

// Render the override drop-in. The empty `ExecStart=` resets the inherited
// value before we set ours — required by systemd for single-value
// directives. Pure — exported for unit tests.
export function renderNvpnConfigDropIn(rewrittenExecStart: string): string {
  return [
    '# Managed by nostr-station — points the nvpn daemon at the canonical',
    '# config the dashboard reads/writes, so the daemon and dashboard share',
    '# a single identity (no create-then-heal copy). Safe to remove to',
    '# revert the daemon to its own config path.',
    '[Service]',
    'ExecStart=',
    `ExecStart=${rewrittenExecStart}`,
    '',
  ].join('\n');
}

// Is nvpn.service currently active? Best-effort; false on any error.
async function nvpnServiceActive(): Promise<boolean> {
  try {
    const r = await execa('systemctl', ['is-active', 'nvpn.service'], { timeout: 5000, stdio: 'pipe', reject: false });
    return (r.stdout || '').trim() === 'active';
  } catch { return false; }
}

// Apply (or refresh) the canonical-config ExecStart drop-in. Reads the base
// ExecStart, rewrites it to add `--config <configPath>`, writes the drop-in,
// reloads + restarts, then verifies the daemon came back up — rolling the
// drop-in back if it didn't. Linux-only; best-effort (the caller logs and
// continues, with reconcile as the fallback).
export async function applyNvpnConfigDropIn(configPath: string): Promise<ControlResult> {
  if (process.platform !== 'linux') return { ok: true, detail: 'non-linux — skipped' };
  if (!configPath) return { ok: false, detail: 'no canonical config path' };

  let baseExec: string | null = null;
  try {
    const { stdout } = await execa('systemctl', ['cat', 'nvpn.service'], { timeout: SERVICE_OP_TIMEOUT_MS, stdio: 'pipe' });
    baseExec = extractBaseExecStart(stdout);
  } catch (e: any) {
    return { ok: false, detail: `systemctl cat failed: ${summarizeError(e)}` };
  }
  if (!baseExec) return { ok: false, detail: 'could not find base ExecStart in nvpn.service' };

  const content = renderNvpnConfigDropIn(rewriteExecStartWithConfig(baseExec, configPath));
  const wasActive = await nvpnServiceActive();
  try {
    await execa('sudo', ['-n', 'install', '-d', '-m', '0755', CAPS_DROP_IN_DIR], { timeout: SERVICE_OP_TIMEOUT_MS, stdio: 'pipe' });
    await execa('sudo', ['-n', 'tee', CONFIG_DROP_IN_PATH], { timeout: SERVICE_OP_TIMEOUT_MS, stdio: 'pipe', input: content });
    await execa('sudo', ['-n', 'systemctl', 'daemon-reload'], { timeout: SERVICE_OP_TIMEOUT_MS, stdio: 'pipe' });
    await execa('sudo', ['-n', 'systemctl', 'try-restart', 'nvpn.service'], { timeout: SERVICE_OP_TIMEOUT_MS, stdio: 'pipe' });
  } catch (e: any) {
    const stderr = (e?.stderr?.toString?.() || '').trim();
    if (/password is required|sudo:.*required/i.test(stderr)) return { ok: false, detail: 'sudo cred cache empty' };
    return { ok: false, detail: summarizeError(e) };
  }

  // Rollback guard: only meaningful if the daemon was up before we touched
  // it. If it was running and isn't now, the --config repoint broke its
  // start — revert so the box is left in a working state.
  if (wasActive && !(await nvpnServiceActive())) {
    try {
      await execa('sudo', ['-n', 'rm', '-f', CONFIG_DROP_IN_PATH], { timeout: SERVICE_OP_TIMEOUT_MS, stdio: 'pipe' });
      await execa('sudo', ['-n', 'systemctl', 'daemon-reload'], { timeout: SERVICE_OP_TIMEOUT_MS, stdio: 'pipe' });
      await execa('sudo', ['-n', 'systemctl', 'try-restart', 'nvpn.service'], { timeout: SERVICE_OP_TIMEOUT_MS, stdio: 'pipe' });
    } catch { /* best-effort revert */ }
    return { ok: false, detail: 'daemon did not come up with --config repoint — reverted drop-in' };
  }
  return { ok: true, detail: 'config drop-in applied' };
}

// ── Magic-DNS port seed ────────────────────────────────────────────────
//
// nvpn's default magic-dns port is 1053. On Ubuntu desktop and anywhere
// else running systemd-resolved's stub resolver, that port is already
// bound — so on first start the daemon logs
//   magicdns: preferred port 1053 unavailable
//   ... trying random local port
// which functionally works but looks like a failure in the log panel
// and re-rolls on every restart (breaking anything pinned to the prior
// port). We probe 1053 ourselves before the daemon's first start; if
// it's taken, we pre-pick a stable free port from a small candidate
// set and write it via `nvpn set --magic-dns-port`. Idempotent: a
// second call sees the existing value in status JSON and skips.

// Candidate ports tried in order. 1053 first so we keep the upstream
// default when nothing's stealing it (the common case on servers /
// dev VMs without systemd-resolved). The high-port fallbacks avoid
// the well-known service ports (5353 mDNS, 5355 LLMNR, 5354 reserved)
// that would just shift the collision to a different daemon.
const MAGIC_DNS_PORT_CANDIDATES = [1053, 5453, 11053, 15353, 15453];

// True iff a UDP socket can be exclusively bound on 127.0.0.1:port. nvpn
// listens on UDP for magic-dns; TCP isn't probed because the daemon
// doesn't bind it on this port. `exclusive: true` rejects ports that
// SO_REUSEADDR/REUSEPORT siblings might tolerate — we want a port no
// one else is touching.
export function isUdpPortFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: false });
    const cleanup = (ok: boolean): void => {
      try { sock.close(); } catch { /* already closed */ }
      resolve(ok);
    };
    sock.once('error', () => cleanup(false));
    try {
      sock.bind({ port, address: host, exclusive: true }, () => cleanup(true));
    } catch {
      cleanup(false);
    }
  });
}

// Probe candidates in order, return the first free one. Returns null
// if every candidate is taken — in which case we let nvpn do its
// random-port fallback rather than guessing.
export async function pickFreeMagicDnsPort(
  candidates: readonly number[] = MAGIC_DNS_PORT_CANDIDATES,
): Promise<number | null> {
  for (const p of candidates) {
    if (await isUdpPortFree(p)) return p;
  }
  return null;
}

// No-op in nvpn 4.x. The `--magic-dns-port` flag was removed from
// `nvpn set` between 0.3.x and 4.0.x — the daemon picks a free port
// on its own and the explicit-port hint has no settings entry to
// land in. Keeping the exported shape so the installer's call site
// doesn't need a conditional; the log line just changes from
// "magic-dns-port → 5453" to a one-line "skipped". If a future
// upstream re-introduces the setting, restore the previous body
// from git history.
export async function seedFreeMagicDnsPort(): Promise<ControlResult> {
  return {
    ok: true,
    detail: 'skipped (nvpn 4.x picks magic-dns-port automatically)',
  };
}

export const installNvpnService = (): Promise<ControlResult> => runServiceOp('install');
export const enableNvpnService  = (): Promise<ControlResult> => runServiceOp('enable');
export const disableNvpnService = (): Promise<ControlResult> => runServiceOp('disable');
export const uninstallNvpnService = (): Promise<ControlResult> => runServiceOp('uninstall');

// `nvpn uninstall-cli` removes the binary itself from PATH (mirror of
// nvpn install-cli, which the installer runs to drop nvpn into
// /usr/local/bin or /opt/homebrew/bin). May or may not need sudo
// depending on the install location; we try sudo -n first and fall
// back to a non-sudo invocation when the path is user-writable.
// Remove the ~/.cargo/bin/nvpn "shadow" copy the installer leaves behind.
// MUST run as part of uninstall: upstream `uninstall-cli` removes the PATH
// copy (e.g. /usr/local/bin/nvpn) but NOT the cargo-bin copy. Left behind,
// it makes the installer's "already installed" short-circuit think nvpn is
// installed and silently no-op a re-install — the exact path that left a
// box unrecoverable from the dashboard. User-writable, so no sudo needed.
// Best-effort + idempotent (missing file is success).
function removeCargoBinShadow(): string | null {
  const shadow = path.join(os.homedir(), '.cargo', 'bin', 'nvpn');
  try {
    if (fs.existsSync(shadow)) { fs.rmSync(shadow, { force: true }); return shadow; }
  } catch { /* best-effort */ }
  return null;
}

export async function uninstallNvpnCli(): Promise<ControlResult> {
  // Helper-primary: the `uninstall` verb does service uninstall + removes
  // the root-owned /usr/local/bin/nvpn + our drop-ins.
  let r: ControlResult;
  if (isAdminHelperInstalled()) {
    r = await runAdminVerb('uninstall');
  } else {
    // Fallback for un-provisioned boxes: direct service uninstall +
    // uninstall-cli (needs the user's own sudo for the root copy).
    const binPath = findBin('nvpn');
    if (binPath) {
      try { await execa('sudo', ['-n', binPath, 'service', 'uninstall'], { timeout: SERVICE_OP_TIMEOUT_MS, stdio: 'pipe' }); } catch { /* best-effort */ }
      try { await execa('sudo', ['-n', binPath, 'uninstall-cli'], { timeout: 15_000, stdio: 'pipe' }); }
      catch { try { await execa(binPath, ['uninstall-cli'], { timeout: 15_000, stdio: 'pipe' }); } catch { /* best-effort */ } }
    }
    r = { ok: true, detail: 'nvpn removed (direct)' };
  }
  // ALWAYS sweep the user-writable cargo-bin shadow too (no sudo needed) —
  // a leftover cargo-bin binary would make a later install short-circuit
  // as "already installed".
  const swept = removeCargoBinShadow();
  if (!r.ok) return { ok: false, detail: `${r.detail}${swept ? ` (removed stale ${swept})` : ''}` };
  return { ok: true, detail: swept ? `nvpn removed; cleared stale ${swept}` : 'nvpn removed' };
}

// ── Configured roster (config.toml) ──────────────────────────────────────
//
// `nvpn status --json` reports LIVE peer state (connected, latency, etc.)
// but not the configured roster — the user-managed list of npubs that
// belong to the network. The roster lives in nvpn's config file as a
// TOML `[[networks]]` block. We read it directly so the dashboard can
// render "configured but disconnected" peers (the common case during
// onboarding) instead of waiting for everyone to come online.
//
// We avoid a TOML dep — the keys we care about (`network_id`,
// `participants`, `admins`) are flat string + array-of-strings entries
// inside a single section; a tight regex over the first `[[networks]]`
// section is sufficient and resilient to TOML field reordering.

export interface NvpnRoster {
  found:        boolean;
  configPath:   string | null;
  networkId:    string | null;
  participants: string[];
  admins:       string[];
  // Per-node `[peer_aliases]` table — local metadata, not synced over
  // the mesh. Keys are npubs (or hex), values are user-chosen labels
  // ("alice", "laptop", "vps-frankfurt"). Each station owner manages
  // their own; one user's "giraffe" might be another's "alice."
  aliases:      Record<string, string>;
}

function nvpnConfigCandidates(): string[] {
  const home = os.homedir();
  return [
    path.join(home, '.config', 'nvpn', 'config.toml'),
    path.join(home, 'Library', 'Application Support', 'nvpn', 'config.toml'),
  ];
}

function findNvpnConfigPath(): string | null {
  for (const p of nvpnConfigCandidates()) {
    try { fs.accessSync(p, fs.constants.R_OK); return p; }
    catch { /* try next */ }
  }
  return null;
}

// ── Canonical config (b2 foundation) ─────────────────────────────────────
//
// The end state (b2): there is ONE authoritative nvpn config — the one the
// running daemon reads — and the dashboard does all reads/writes against it,
// using sudo when it's root-owned. No second identity, no key copying.
//
// This stage introduces the machinery WITHOUT flipping behavior yet:
//   * resolveCanonicalConfig() decides which path is authoritative.
//   * readConfigText() / writeConfigText() are ownership-aware primitives
//     (direct fs when we can, sudo -n when root-owned) that later stages
//     route every read/write through.
// Stage 1 keeps the resolver defaulting to the user-side path (current
// behavior); later stages prefer the daemon's path + switch call sites.

export interface CanonicalConfig {
  /** Authoritative config path, or null when none exists yet. */
  path:    string | null;
  /** True when the path is root-owned (writes/reads need sudo -n). */
  rootOwned: boolean;
  /** How the path was chosen — for diagnostics / "where from?" display. */
  source:  'daemon' | 'user' | 'none';
}

// Is a path owned by someone other than this process's uid? Best-effort;
// on stat failure we assume not-foreign (caller falls back to a direct read
// attempt, which fails safe).
export function pathIsForeignOwned(p: string): boolean {
  try {
    const st = fs.statSync(p);
    return typeof process.getuid === 'function' ? st.uid !== process.getuid() : false;
  } catch { return false; }
}

// Decide the authoritative config. `daemonPath` comes from
// resolveDaemonConfigPath() (the daemon's live --config). Pure: takes the
// candidate paths + existence/ownership predicates so it's unit-testable
// without fs. Prefer the daemon's path when it exists (that's what actually
// runs); else the user-side path; else none.
export function chooseCanonicalConfigPath(in_: {
  daemonPath:   string | null;
  userPath:     string | null;
  exists:       (p: string) => boolean;
  foreignOwned: (p: string) => boolean;
}): CanonicalConfig {
  if (in_.daemonPath && in_.exists(in_.daemonPath)) {
    return { path: in_.daemonPath, rootOwned: in_.foreignOwned(in_.daemonPath), source: 'daemon' };
  }
  if (in_.userPath && in_.exists(in_.userPath)) {
    return { path: in_.userPath, rootOwned: in_.foreignOwned(in_.userPath), source: 'user' };
  }
  return { path: null, rootOwned: false, source: 'none' };
}

// Stage-1 resolver. IMPORTANT: behavior-preserving for now — it returns the
// user-side path exactly like findNvpnConfigPath(), wrapped in the
// CanonicalConfig shape with ownership detected. Later stages pass a
// daemonPath to prefer the daemon's config.
export function resolveCanonicalConfig(daemonPath?: string | null): CanonicalConfig {
  return chooseCanonicalConfigPath({
    daemonPath: daemonPath ?? null,
    userPath:   findNvpnConfigPath(),
    exists:     (p) => { try { fs.accessSync(p, fs.constants.F_OK); return true; } catch { return false; } },
    foreignOwned: pathIsForeignOwned,
  });
}

// Ownership-aware read: direct fs first, `sudo -n cat` fallback when the
// file is root-owned / unreadable. Returns null when unreadable (e.g. empty
// sudo cred cache) so callers degrade rather than throw. Callers handling
// secret-bearing files must still only extract public fields.
export async function readConfigText(configPath: string): Promise<string | null> {
  if (!configPath) return null;
  try { return fs.readFileSync(configPath, 'utf8'); }
  catch {
    try {
      const { stdout } = await execa('sudo', ['-n', 'cat', configPath], { timeout: 5000, stdio: 'pipe' });
      return stdout;
    } catch { return null; }
  }
}

// Synchronous sibling of readConfigText, for the many sync read helpers
// (readNvpnRoster/Networks/Relays/Identity/Fips/repair) that aren't worth
// turning async. Same discipline: direct fs first, `sudo -n cat` fallback
// (via spawnSync) when root-owned/unreadable; null when we still can't read
// (e.g. empty sudo cred cache) so callers degrade rather than throw. The
// returned body may carry secret key material — callers must extract only
// public fields, exactly as with the async variant.
export function readConfigTextSync(configPath: string): string | null {
  if (!configPath) return null;
  try { return fs.readFileSync(configPath, 'utf8'); }
  catch {
    try {
      const r = spawnSync('sudo', ['-n', 'cat', configPath], { timeout: 5000, encoding: 'utf8' });
      if (r.status === 0 && typeof r.stdout === 'string') return r.stdout;
      return null;
    } catch { return null; }
  }
}

export interface ConfigWriteResult {
  ok:         boolean;
  detail:     string;
  backedUpTo?: string;
}

// Ownership-aware atomic write with backup. When we own the file: temp +
// rename (mode 0600). When root-owned: `sudo -n cp -p` backup, then
// `sudo -n install -o root -g root -m 600 /dev/stdin <path>` with the body
// piped via stdin (never through a shell string). `rootOwned` is passed in
// (from resolveCanonicalConfig) so the caller controls the path. Mirrors
// the adopt/repair write discipline exactly. The body may contain secret
// key material — it's only ever used as fs/stdin input, never returned.
export async function writeConfigText(
  configPath: string, body: string, opts: { rootOwned: boolean },
): Promise<ConfigWriteResult> {
  if (!configPath) return { ok: false, detail: 'no config path' };
  const backupPath = `${configPath}.bak-${Date.now()}`;
  if (!opts.rootOwned) {
    // We own it — back up + atomic temp-rename, all direct.
    try { if (fs.existsSync(configPath)) fs.copyFileSync(configPath, backupPath); }
    catch (e: any) { return { ok: false, detail: `backup failed: ${(e?.message || '').slice(0, 160)}` }; }
    const tmp = `${configPath}.tmp-${process.pid}-${Date.now()}`;
    try {
      fs.writeFileSync(tmp, body, { mode: 0o600 });
      fs.renameSync(tmp, configPath);
    } catch (e: any) {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      return { ok: false, detail: `write failed: ${(e?.message || '').slice(0, 160)}` };
    }
    return { ok: true, detail: 'config written', backedUpTo: fs.existsSync(backupPath) ? backupPath : undefined };
  }
  // Root-owned — sudo backup then sudo atomic install from stdin.
  try {
    await execa('sudo', ['-n', 'cp', '-p', configPath, backupPath], { timeout: SERVICE_OP_TIMEOUT_MS, stdio: 'pipe' });
  } catch (e: any) {
    const stderr = (e?.stderr?.toString?.() || '').trim();
    if (/password is required|sudo:.*required/i.test(stderr)) {
      return { ok: false, detail: 'sudo cred cache empty — run `sudo -v` then retry. (Nothing changed.)' };
    }
    return { ok: false, detail: `backup failed (refusing to write): ${summarizeError(e)}` };
  }
  try {
    await execa('sudo', ['-n', 'install', '-o', 'root', '-g', 'root', '-m', '600', '/dev/stdin', configPath], {
      timeout: SERVICE_OP_TIMEOUT_MS, stdio: 'pipe', input: body,
    });
  } catch (e: any) {
    const stderr = (e?.stderr?.toString?.() || '').trim();
    if (/password is required|sudo:.*required/i.test(stderr)) {
      return { ok: false, detail: `sudo cred cache empty — run \`sudo -v\` then retry. Backup at ${backupPath}; no overwrite.`, backedUpTo: backupPath };
    }
    return { ok: false, detail: `write failed: ${summarizeError(e)} (backup at ${backupPath})`, backedUpTo: backupPath };
  }
  return { ok: true, detail: 'config written (sudo)', backedUpTo: backupPath };
}

// Synchronous sibling of writeConfigText, for the sync config mutators
// (network-id setter, repair, relay/alias mutators) that aren't worth
// turning async. Same ownership-aware discipline: when we own the file,
// optional copy backup + atomic temp-rename (mode 0600); when root-owned,
// optional `sudo -n cp -p` backup then `sudo -n install -o root -g root
// -m 600 /dev/stdin` with the body piped via stdin (never a shell string),
// all via spawnSync. `backup` defaults to true; callers that historically
// didn't back up (relay/alias/network-id edits) pass false to stay
// behavior-preserving. The body may carry secret key material — it's only
// ever used as fs/stdin input, never returned.
export function writeConfigTextSync(
  configPath: string, body: string, opts: { rootOwned: boolean; backup?: boolean },
): ConfigWriteResult {
  if (!configPath) return { ok: false, detail: 'no config path' };
  const wantBackup = opts.backup !== false;
  const backupPath = `${configPath}.bak-${Date.now()}`;
  if (!opts.rootOwned) {
    // We own it — optional backup + atomic temp-rename, all direct.
    if (wantBackup) {
      try { if (fs.existsSync(configPath)) fs.copyFileSync(configPath, backupPath); }
      catch (e: any) { return { ok: false, detail: `backup failed (refusing to write): ${(e?.message || '').slice(0, 160)}` }; }
    }
    const tmp = `${configPath}.tmp-${process.pid}-${Date.now()}`;
    try {
      fs.writeFileSync(tmp, body, { mode: 0o600 });
      fs.renameSync(tmp, configPath);
    } catch (e: any) {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      return { ok: false, detail: `write failed: ${(e?.message || '').slice(0, 160)}` };
    }
    return { ok: true, detail: 'config written', backedUpTo: (wantBackup && fs.existsSync(backupPath)) ? backupPath : undefined };
  }
  // Root-owned — optional sudo backup then sudo atomic install from stdin.
  const sudoCredEmpty = (r: { stderr?: string | null }) =>
    /password is required|sudo:.*required/i.test((r.stderr || '').toString().trim());
  if (wantBackup) {
    const b = spawnSync('sudo', ['-n', 'cp', '-p', configPath, backupPath], { timeout: SERVICE_OP_TIMEOUT_MS, encoding: 'utf8' });
    if (b.status !== 0) {
      if (sudoCredEmpty(b)) return { ok: false, detail: 'sudo cred cache empty — run `sudo -v` then retry. (Nothing changed.)' };
      return { ok: false, detail: `backup failed (refusing to write): ${(b.stderr || b.error?.message || 'sudo cp failed').toString().slice(0, 160)}` };
    }
  }
  const w = spawnSync('sudo', ['-n', 'install', '-o', 'root', '-g', 'root', '-m', '600', '/dev/stdin', configPath], {
    timeout: SERVICE_OP_TIMEOUT_MS, encoding: 'utf8', input: body,
  });
  if (w.status !== 0) {
    const bk = wantBackup ? backupPath : undefined;
    if (sudoCredEmpty(w)) {
      return { ok: false, detail: `sudo cred cache empty — run \`sudo -v\` then retry.${bk ? ` Backup at ${bk}; no overwrite.` : ''}`, backedUpTo: bk };
    }
    return { ok: false, detail: `write failed: ${(w.stderr || w.error?.message || 'sudo install failed').toString().slice(0, 160)}${bk ? ` (backup at ${bk})` : ''}`, backedUpTo: bk };
  }
  return { ok: true, detail: 'config written (sudo)', backedUpTo: wantBackup ? backupPath : undefined };
}

// Extract the first `[[networks]]` block — the active network for our
// purposes. nvpn supports multi-network configs; we surface the first
// for the dashboard, which is what `nvpn add-participant` (no flag)
// also targets.
export function extractFirstNetworksSection(toml: string): string {
  const idx = toml.indexOf('[[networks]]');
  if (idx < 0) return toml;
  const after = toml.slice(idx + '[[networks]]'.length);
  // Stop at the next top-level table heading so we don't bleed into
  // [peer_aliases], [nat], [nostr], etc.
  const m = after.search(/^\s*\[(?:\[)?/m);
  return m >= 0 ? after.slice(0, m) : after;
}

// Extract the `[peer_aliases]` table (key/value pairs of npub → label).
// Returns the section body (without the header) so the caller can
// parse keys with `extractAliasMap`. Empty string when the section
// isn't present.
//
// Implemented as two-step search instead of a single regex because the
// /m flag makes `$` match end-of-LINE, which cuts the body too short
// for multi-line tables. The single-character search bounds at the
// next `[` at line start (next section header), or end of file.
export function extractPeerAliasesSection(toml: string): string {
  const header = toml.match(/^\s*\[peer_aliases\][^\S\r\n]*\r?\n?/m);
  if (!header || header.index === undefined) return '';
  const rest = toml.slice(header.index + header[0].length);
  const nextHeader = rest.search(/^\s*\[(?:\[)?/m);
  return nextHeader >= 0 ? rest.slice(0, nextHeader) : rest;
}

// Parse a `[peer_aliases]` body into a Record. nvpn's TOML uses bare
// keys (npubs are valid bare-key chars per TOML spec) and quoted
// string values, so a per-line `<key> = "<value>"` regex is enough.
// Lines that don't match (comments, blanks, future fields) are
// skipped silently.
export function extractAliasMap(sectionBody: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /^\s*([A-Za-z0-9_\-]+)\s*=\s*"((?:[^"\\]|\\.)*)"\s*$/gm;
  for (const m of sectionBody.matchAll(re)) {
    const key   = m[1];
    const value = m[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    if (key && value) out[key] = value;
  }
  return out;
}

// Generic `[table]` section-body extractor (mirrors
// extractPeerAliasesSection but parameterized by table name). Returns the
// body between the header and the next top-level table heading, or '' when
// the table is absent. Used by the FIPS-endpoint reader below.
export function extractNamedTableSection(toml: string, table: string): string {
  const esc = table.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const header = toml.match(new RegExp(`^\\s*\\[${esc}\\][^\\S\\r\\n]*\\r?\\n?`, 'm'));
  if (!header || header.index === undefined) return '';
  const rest = toml.slice(header.index + header[0].length);
  const next = rest.search(/^\s*\[(?:\[)?/m);
  return next >= 0 ? rest.slice(0, next) : rest;
}

// Statically-configured FIPS relay peers — `[fips_peer_endpoints]` maps an
// npub to a reachable `host:port`. nvpn relays packets through a reachable
// FIPS neighbour when direct UDP is blocked, so for a NATed node "are any
// of these configured?" is the difference between "can bootstrap" and
// "unreachable." Stored like [peer_aliases] (npub = "host:port"), so we
// reuse extractAliasMap. Read-only; the dashboard surfaces the count in
// the connectivity diagnosis.
export interface NvpnFipsPeerEndpoints {
  found:      boolean;
  configPath: string | null;
  endpoints:  Record<string, string>;
}
export function readNvpnFipsPeerEndpoints(): NvpnFipsPeerEndpoints {
  const configPath = resolveCanonicalConfig().path;
  if (!configPath) return { found: false, configPath: null, endpoints: {} };
  const toml = readConfigTextSync(configPath);
  if (toml == null) return { found: false, configPath, endpoints: {} };
  return { found: true, configPath, endpoints: extractAliasMap(extractNamedTableSection(toml, 'fips_peer_endpoints')) };
}

export function extractTomlList(section: string, key: string): string[] {
  const re = new RegExp(`^\\s*${key}\\s*=\\s*\\[([\\s\\S]*?)\\]`, 'm');
  const m = section.match(re);
  if (!m) return [];
  const out: string[] = [];
  for (const sm of m[1].matchAll(/"([^"]+)"/g)) out.push(sm[1]);
  return out;
}

// ── Node identity (`[nostr] public_key` in config.toml) ─────────────────
//
// In nvpn 4.x the local node's pubkey/npub is no longer surfaced via
// `nvpn status --json` (both `npub` and `pubkey` are null in live output).
// The pubkey only lives on disk in config.toml's `[nostr]` block:
//
//   [nostr]
//   secret_key = "nsec1..."   ← MUST NEVER LEAK
//   public_key = "npub1..."   ← what we surface
//
// This helper is the one supported path for reading it. It MUST NOT
// return or log any other field from `[nostr]` or `[node]` (both
// sections contain private key material). The unit test
// `tests/nvpn-identity.test.ts` pins the leak-safe shape.

export interface NvpnNodeIdentity {
  /** npub1... bech32-encoded Nostr pubkey, or null if config.toml is missing
   *  or doesn't have an `[nostr] public_key` field. */
  npub:       string | null;
  /** Source file the npub was extracted from — useful for "where is this
   *  coming from?" debugging in the dashboard. */
  configPath: string | null;
}

function extractNostrPublicKey(toml: string): string | null {
  // Match only the [nostr] section's public_key field, not [node]'s
  // (which is the WireGuard pubkey, base64, not an npub).
  //
  // Two-step: find the [nostr] section header, slice until the next
  // top-level table heading, then pluck `public_key = "..."` from
  // inside. Mirrors the extractPeerAliasesSection pattern.
  const header = toml.match(/^\s*\[nostr\][^\S\r\n]*\r?\n?/m);
  if (!header || header.index === undefined) return null;
  const rest = toml.slice(header.index + header[0].length);
  const next = rest.search(/^\s*\[(?:\[)?/m);
  const body = next >= 0 ? rest.slice(0, next) : rest;
  // The npub format is bech32; the regex is strict on shape so we don't
  // accidentally surface arbitrary garbage from a malformed TOML.
  const m = body.match(/^\s*public_key\s*=\s*"(npub1[023456789acdefghjklmnpqrstuvwxyz]{58})"\s*$/m);
  return m ? m[1] : null;
}

export function readNvpnNodeIdentity(): NvpnNodeIdentity {
  const configPath = resolveCanonicalConfig().path;
  if (!configPath) return { npub: null, configPath: null };
  const toml = readConfigTextSync(configPath);
  if (toml == null) return { npub: null, configPath };
  // CRITICAL: only call extractNostrPublicKey on the file contents.
  // Never destructure or pass the whole file body to the caller — the
  // file also contains [nostr] secret_key and [node] private_key, both
  // of which would compromise the user if echoed back through the API.
  return { npub: extractNostrPublicKey(toml), configPath };
}

// ── Daemon config-path + identity resolution ─────────────────────────────
//
// The dashboard runs as the user; the system service runs the daemon as
// root off /root/.config/nvpn/config.toml. So the daemon can be a
// *different node* (different [nostr] identity) than the one the dashboard
// manages — the root cause behind "dashboard changes never reach the
// daemon." To tell the truth, we resolve the daemon's REAL config path and
// read its identity. Nothing is hardcoded: the path comes from the live
// daemon's own `--config` argument (or the service unit).

// Pure: pull the value of `--config <path>` (or `--config=<path>`) out of a
// process command line. Accepts NUL-joined (/proc/<pid>/cmdline) or
// space-joined (`ps -o args=`) input. Exported for tests.
export function parseConfigPathFromCmdline(cmdline: string): string | null {
  if (!cmdline) return null;
  // Normalize NUL separators to spaces, then tokenize on whitespace.
  const tokens = cmdline.replace(/\0/g, ' ').trim().split(/\s+/);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '--config' && i + 1 < tokens.length) return tokens[i + 1];
    if (t.startsWith('--config=')) return t.slice('--config='.length);
  }
  return null;
}

export interface DaemonConfigPath {
  /** Resolved path the running daemon actually reads, or null. */
  path:   string | null;
  /** How we found it — for "where is this coming from?" display. */
  source: 'cmdline' | 'unit' | null;
}

// Resolve the config path the running daemon reads, from live evidence
// only. Tries the daemon process's own cmdline first (authoritative), then
// the systemd unit's ExecStart. Best-effort + quiet — returns null when it
// can't tell, and the caller falls back to the user-side config.
export async function resolveDaemonConfigPath(pid?: number | null): Promise<DaemonConfigPath> {
  // 1) The daemon process's own command line.
  if (typeof pid === 'number' && pid > 0) {
    // Linux: /proc/<pid>/cmdline is world-readable even for root procs.
    try {
      const raw = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      const p = parseConfigPathFromCmdline(raw);
      if (p) return { path: p, source: 'cmdline' };
    } catch { /* not Linux / no procfs — fall through to ps */ }
    // Cross-platform: ps args for the pid.
    try {
      const { stdout } = await execa('ps', ['-o', 'args=', '-p', String(pid)], { timeout: 4000, stdio: 'pipe' });
      const p = parseConfigPathFromCmdline(stdout);
      if (p) return { path: p, source: 'cmdline' };
    } catch { /* ps unavailable / pid gone */ }
  }
  // 2) The systemd unit's ExecStart (Linux service installs).
  try {
    const { stdout } = await execa('systemctl', ['cat', 'nvpn.service'], { timeout: 4000, stdio: 'pipe' });
    const execLine = stdout.split(/\r?\n/).find(l => /^\s*ExecStart=/.test(l)) || '';
    const p = parseConfigPathFromCmdline(execLine.replace(/^\s*ExecStart=/, ''));
    if (p) return { path: p, source: 'unit' };
  } catch { /* no systemd / no unit */ }
  return { path: null, source: null };
}

// Read ONLY the [nostr] public_key (npub) from a config path that may be
// root-owned. Tries a direct read first; on permission failure falls back
// to `sudo -n cat`. LEAK-SAFE by construction: the file body (which holds
// secret_key / private_key) is fed only to extractNostrPublicKey and never
// returned or logged. Returns null when unreadable (e.g. empty sudo cred
// cache) — callers degrade rather than error.
export async function readNodeNpubFromPath(configPath: string): Promise<string | null> {
  if (!configPath) return null;
  let toml: string | null = null;
  try { toml = fs.readFileSync(configPath, 'utf8'); }
  catch {
    try {
      const { stdout } = await execa('sudo', ['-n', 'cat', configPath], { timeout: 5000, stdio: 'pipe' });
      toml = stdout;
    } catch { return null; }
  }
  return toml ? extractNostrPublicKey(toml) : null;
}

// ── Adopt identity (make the daemon run the managed identity+config) ──────
//
// The load-bearing fix for the dashboard/daemon identity split. The daemon
// runs a root --service off its own config (often a different auto-minted
// identity); the dashboard manages the user-side config. "Adopt" makes the
// daemon run the MANAGED identity by copying the user-side config onto the
// daemon's resolved --config path, then restarting the service.
//
// Security posture (this copies a file containing the [nostr] secret_key
// and [node] private_key into a root-owned location):
//   * Preview-first. plan() reads both identities + paths and returns what
//     would change, with NO write.
//   * The managed config's body is never returned through the API or logged
//     — we only ever surface the two npubs (public) and the paths.
//   * Backs up the daemon's current config (sudo cp) before overwriting, so
//     the prior identity is recoverable.
//   * Writes via `sudo -n install -o root -g root -m 600` (atomic, correct
//     owner+mode for a secret-bearing file). Empty cred cache → clear hint.
//   * Restart goes through the existing sudo systemctl path.

export interface AdoptIdentityPlan {
  /** True when an adopt would change the daemon's identity/config. */
  needed:           boolean;
  managedNpub:      string | null;
  daemonNpub:       string | null;
  managedConfigPath: string | null;
  daemonConfigPath: string | null;
  /** Why an adopt isn't possible/needed, when applicable. */
  blocker:          string | null;
  summary:          string[];
}

// Pure decision core for the adopt plan — given the two resolved
// (path, npub) pairs, decide whether an adopt is needed / blocked and build
// the preview summary. Separated from the fs/proc I/O so the branching is
// unit-testable. Exported for tests.
export function decideAdoptIdentity(in_: {
  managedConfigPath: string | null;
  managedNpub:       string | null;
  daemonConfigPath:  string | null;
  daemonNpub:        string | null;
}): AdoptIdentityPlan {
  const base: AdoptIdentityPlan = {
    needed: false,
    managedNpub: in_.managedNpub,
    daemonNpub: in_.daemonNpub,
    managedConfigPath: in_.managedConfigPath,
    daemonConfigPath: in_.daemonConfigPath,
    blocker: null,
    summary: [],
  };
  if (!in_.managedConfigPath) {
    return { ...base, blocker: 'no user-side nvpn config found — run `nvpn init` first' };
  }
  if (!in_.daemonConfigPath) {
    return { ...base, blocker: 'could not resolve the daemon\'s config path (daemon not running, or not a managed service)' };
  }
  if (in_.daemonConfigPath === in_.managedConfigPath) {
    return { ...base, blocker: 'the daemon already reads the managed config — nothing to adopt' };
  }
  if (in_.daemonNpub && in_.managedNpub && in_.daemonNpub === in_.managedNpub) {
    return { ...base, blocker: 'the daemon already runs the managed identity — nothing to adopt' };
  }
  base.needed = true;
  base.summary = [
    `Back up the daemon config ${in_.daemonConfigPath}`,
    `Copy your managed identity${in_.managedNpub ? ` (${in_.managedNpub.slice(0, 12)}…${in_.managedNpub.slice(-4)})` : ''} + config onto ${in_.daemonConfigPath}`,
    `Restart nvpn so the daemon runs your identity`,
  ];
  return base;
}

// Resolve the inputs an adopt needs: the managed (user-side) config path +
// identity, and the daemon's real config path + identity. Pure-ish (reads
// files / proc), no writes. `daemonPid` comes from the status probe.
export async function planAdoptIdentity(daemonPid?: number | null): Promise<AdoptIdentityPlan> {
  const managed = readNvpnNodeIdentity(); // { npub, configPath } — user side
  const daemonCfg = await resolveDaemonConfigPath(daemonPid);
  // Only read the daemon's identity when it's a distinct file worth
  // comparing — avoids a redundant (possibly sudo) read otherwise.
  const daemonNpub = (daemonCfg.path && daemonCfg.path !== managed.configPath)
    ? await readNodeNpubFromPath(daemonCfg.path)
    : null;
  return decideAdoptIdentity({
    managedConfigPath: managed.configPath,
    managedNpub:       managed.npub,
    daemonConfigPath:  daemonCfg.path,
    daemonNpub,
  });
}

export interface AdoptIdentityResult extends ControlResult {
  plan:        AdoptIdentityPlan;
  applied:     boolean;
  backedUpTo?: string;
}

// Apply the adoption: backup → sudo-copy managed config onto the daemon's
// path → restart. apply=false returns the plan only.
export async function adoptIdentity(opts: { apply: boolean; daemonPid?: number | null }): Promise<AdoptIdentityResult> {
  const plan = await planAdoptIdentity(opts.daemonPid);
  if (!plan.needed) {
    return { ok: !plan.blocker || plan.blocker.includes('already'), detail: plan.blocker || 'nothing to adopt', plan, applied: false };
  }
  if (!opts.apply) {
    return { ok: true, detail: 'adopt plan ready (preview)', plan, applied: false };
  }
  // Helper-primary (b2): instead of copying the managed config onto the
  // daemon's root path, repoint the daemon's ExecStart at the canonical
  // user config — single identity, no copy, no root-owned duplicate. The
  // helper self-reverts if the daemon doesn't come back up.
  if (isAdminHelperInstalled()) {
    const r = await runAdminVerb('repoint');
    if (!r.ok) return { ok: false, detail: r.detail, plan, applied: false };
    return { ok: true, detail: 'daemon now reads your managed config (ExecStart repointed)', plan, applied: true };
  }
  // Fallback for un-provisioned boxes: the original copy-to-root approach
  // (needs the user's own sudo). Kept so adopt still works pre-provisioning.
  const src = plan.managedConfigPath!;
  const dst = plan.daemonConfigPath!;
  const backupPath = `${dst}.bak-${Date.now()}`;
  try {
    // Back up the daemon's current config (root-owned) before overwriting.
    await execa('sudo', ['-n', 'cp', '-p', dst, backupPath], { timeout: SERVICE_OP_TIMEOUT_MS, stdio: 'pipe' });
  } catch (e: any) {
    const stderr = (e?.stderr?.toString?.() || '').trim();
    if (/password is required|sudo:.*required/i.test(stderr)) {
      return { ok: false, detail: 'sudo cred cache empty — run `sudo -v` in your terminal, then retry. (Nothing was changed.)', plan, applied: false };
    }
    return { ok: false, detail: `backup failed (refusing to write): ${summarizeError(e)}`, plan, applied: false };
  }
  // Read the managed config locally (we own it) and pipe it to a
  // root-owned install via stdin — never round-trips through a shell
  // string, and lands with the correct secret-file owner+mode in one
  // atomic op. The body is used ONLY as install's stdin; never returned.
  let body: string;
  try { body = fs.readFileSync(src, 'utf8'); }
  catch (e: any) { return { ok: false, detail: `could not read managed config: ${summarizeError(e)}`, plan, applied: false, backedUpTo: backupPath }; }
  try {
    await execa('sudo', ['-n', 'install', '-o', 'root', '-g', 'root', '-m', '600', '/dev/stdin', dst], {
      timeout: SERVICE_OP_TIMEOUT_MS, stdio: 'pipe', input: body,
    });
  } catch (e: any) {
    const stderr = (e?.stderr?.toString?.() || '').trim();
    if (/password is required|sudo:.*required/i.test(stderr)) {
      return { ok: false, detail: 'sudo cred cache empty — run `sudo -v` then retry. The backup was written; no overwrite happened.', plan, applied: false, backedUpTo: backupPath };
    }
    return { ok: false, detail: `write failed: ${summarizeError(e)} (daemon config unchanged; backup at ${backupPath})`, plan, applied: false, backedUpTo: backupPath };
  }
  // Restart so the daemon picks up the adopted identity. Best-effort —
  // the copy already succeeded; surface a restart hint if it fails.
  const restart = await restartNvpn();
  const detail = restart.ok
    ? 'identity adopted — daemon restarted with your identity'
    : `identity adopted; restart nvpn manually (${restart.detail})`;
  return { ok: true, detail, plan, applied: true, backedUpTo: backupPath };
}

// Post-install reconcile: right after `service install` runs `nvpn init` as
// root (minting a separate root identity at /root/.config/nvpn/), make the
// freshly-installed daemon run the SINGLE managed identity instead — so the
// dashboard's config and the daemon's config never diverge in the first
// place. This is the prevention half of the identity-split fix (the adopt
// flow is the cure for already-split boxes). Best-effort and quiet: the
// install succeeded regardless; if there's no managed identity yet, or no
// split, or sudo isn't warm, we just skip. Runs inside the install flow
// where the sudo cred cache is already warm from `service install`.
//
// `daemonPid` is optional — when null we still resolve via the service
// unit's ExecStart (the daemon may not be probed yet mid-install).
//
// NOTE: the post-install create-then-heal layer
// (reconcileDaemonIdentityAfterInstall / shouldReconcileAfterInstall) was
// RETIRED here. Under b2 the helper's install seeds the canonical user
// config and repoints the daemon's ExecStart --config at it, so the daemon
// and dashboard share a single identity from first start — there's nothing
// to "heal." The MANUAL "Make daemon use this identity" button
// (planAdoptIdentity + adoptIdentity, now helper-repoint based) remains for
// the rare drift case.

export function extractTomlString(section: string, key: string): string | null {
  const re = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]+)"`, 'm');
  const m = section.match(re);
  return m ? m[1] : null;
}

export function readNvpnRoster(): NvpnRoster {
  const configPath = resolveCanonicalConfig().path;
  if (!configPath) {
    return { found: false, configPath: null, networkId: null, participants: [], admins: [], aliases: {} };
  }
  const toml = readConfigTextSync(configPath);
  if (toml == null) {
    return { found: false, configPath, networkId: null, participants: [], admins: [], aliases: {} };
  }
  const section = extractFirstNetworksSection(toml);
  const aliasBody = extractPeerAliasesSection(toml);
  return {
    found:        true,
    configPath,
    networkId:    extractTomlString(section, 'network_id'),
    participants: extractTomlList(section, 'participants'),
    admins:       extractTomlList(section, 'admins'),
    aliases:      extractAliasMap(aliasBody),
  };
}

// Multi-network summary. nvpn supports a `[[networks]]` array in
// config.toml where only the first entry is active at runtime; the rest
// stay saved for later activation. The dashboard's Network sub-tab uses
// this to show "you have other networks configured" so a user with
// multiple saved networks isn't surprised that adding a peer to the
// roster only affects the active one.
//
// Each summary returns the network's stable id, optional name, and
// participant/admin counts — enough to render a sidebar/list without
// reading the full roster of every inactive network.
export interface NvpnNetworkSummary {
  networkId:        string | null;
  name:             string | null;
  participantCount: number;
  adminCount:       number;
  active:           boolean;
}

// Walk all `[[networks]]` blocks. Mirrors extractFirstNetworksSection's
// regex-only approach (no TOML dep) — bounds each block at the next
// top-level table heading so we don't bleed into [peer_aliases]/[nat]/
// [nostr] etc.
export function extractAllNetworksSections(toml: string): string[] {
  const out: string[] = [];
  const re = /^\s*\[\[networks\]\][^\S\r\n]*\r?\n?/gm;
  const matches: Array<{ start: number; end: number }> = [];
  for (const m of toml.matchAll(re)) {
    if (m.index === undefined) continue;
    matches.push({ start: m.index + m[0].length, end: -1 });
  }
  for (let i = 0; i < matches.length; i++) {
    const after = toml.slice(matches[i].start);
    const next = after.search(/^\s*\[(?:\[)?/m);
    out.push(next >= 0 ? after.slice(0, next) : after);
  }
  return out;
}

// All configured networks, with the first marked active. Returns an
// empty list when the config file is missing or unreadable — callers
// render an empty-state in that case rather than blocking.
export function readNvpnNetworks(): NvpnNetworkSummary[] {
  const configPath = resolveCanonicalConfig().path;
  if (!configPath) return [];
  const toml = readConfigTextSync(configPath);
  if (toml == null) return [];
  const sections = extractAllNetworksSections(toml);
  return sections.map((section, idx) => ({
    networkId:        extractTomlString(section, 'network_id'),
    // `name` is the user-facing label. Older configs may omit it; the
    // UI falls back to the network_id when null.
    name:             extractTomlString(section, 'name'),
    participantCount: extractTomlList(section, 'participants').length,
    adminCount:       extractTomlList(section, 'admins').length,
    active:           idx === 0,
  }));
}

// ── Join a network by id (no invite) ──────────────────────────────────
//
// The native nvpn app lets you join a network you already run elsewhere
// by entering its network_id directly — no invite round-trip. It does
// this by adding a `[[networks]]` block for that id and making it the
// active network; the daemon then converges on the admin-signed roster
// over FIPS control events. We reproduce that by editing config.toml:
// prepend a new `[[networks]]` block (active = first block) seeded with
// the current active network's discovery relays (or the recommended set),
// then the route layer kicks `nvpn reload`.
//
// network_id format is opaque to us (nvpn has used a few shapes across
// releases), so validation is conservative-but-permissive: printable,
// no quote / backslash / control chars (which would break the quoted
// TOML string), bounded length.
const NETWORK_ID_MAX = 200;
export function isValidNetworkId(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  const v = s.trim();
  return v.length > 0
    && v.length <= NETWORK_ID_MAX
    && !/["\\]/.test(v)
    // eslint-disable-next-line no-control-regex
    && !/[\x00-\x1f\x7f]/.test(v);
}

// Pure: render a minimal `[[networks]]` block for a joined network.
// participants/admins start empty — the daemon fills the roster from the
// admin's signed control events once it connects. Exported for tests.
export function buildNvpnNetworkBlock(networkId: string, relays: string[]): string {
  const relayLiteral = relays.length
    ? `[${relays.map(r => `"${r}"`).join(', ')}]`
    : '[]';
  return `[[networks]]\nnetwork_id = "${networkId}"\nparticipants = []\nadmins = []\nrelays = ${relayLiteral}\n`;
}

// Pure: insert `block` as the FIRST [[networks]] block so it becomes the
// active network. When the config has no networks block yet, append at
// EOF. Exported for tests.
export function insertNetworkBlockFirst(toml: string, block: string): string {
  const m = toml.match(/^[^\S\r\n]*\[\[networks\]\]/m);
  if (m && m.index !== undefined) {
    return toml.slice(0, m.index) + block + '\n' + toml.slice(m.index);
  }
  const sep = toml.length === 0 ? '' : (toml.endsWith('\n') ? '\n' : '\n\n');
  return toml + sep + block;
}

export interface NvpnJoinResult extends ControlResult {
  networkId?: string;
  relays?:    string[];
}

// Join (or activate) a network by id. Idempotent-ish: if the id is
// already the active network we report no-op; if it's configured but
// inactive we decline rather than silently reordering blocks (the user
// can activate it from the native app), since reordering arbitrary TOML
// is riskier than the additive insert.
export function joinNvpnNetwork(networkId: string): NvpnJoinResult {
  const raw = String(networkId || '').trim();
  if (!isValidNetworkId(raw)) {
    return { ok: false, detail: 'invalid network id' };
  }
  // Prevention: always store the CANONICAL (separator-free) id. The daemon
  // hashes the id literally, so writing a hyphenated id would derive the
  // wrong mesh IP and create the exact forked-network bug the diagnosis
  // exists to catch. Canonicalizing on write makes new forks impossible.
  const id = canonicalNetworkId(raw);
  if (!id) return { ok: false, detail: 'invalid network id' };
  const canon = resolveCanonicalConfig();
  const configPath = canon.path;
  if (!configPath) return { ok: false, detail: 'no nvpn config.toml found — run `nvpn init` first' };
  const toml = readConfigTextSync(configPath);
  if (toml == null) return { ok: false, detail: 'config unreadable (permission or missing) — try `sudo -v` then retry' };

  const sections = extractAllNetworksSections(toml);
  const ids = sections.map(s => extractTomlString(s, 'network_id'));
  // Compare on the canonical form so we never create a duplicate of a
  // network that's already configured under a non-canonical id.
  const canonIds = ids.map(x => (x ? canonicalNetworkId(x) : null));
  if (canonIds[0] === id) {
    return { ok: true, detail: 'already the active network', networkId: id };
  }
  if (canonIds.includes(id)) {
    return {
      ok: false,
      detail: 'this network is already configured (possibly under a non-canonical id) — use Repair on the Diagnostics tab to consolidate the duplicate and make it active',
    };
  }

  // Seed the joined network's discovery relays from the current active
  // network so it can actually reach the relays the admin publishes on;
  // fall back to the curated set when there's no active network yet.
  const seed = sections[0] ? extractTomlList(sections[0], 'relays') : [];
  const relays = seed.length > 0 ? seed : [...RECOMMENDED_NVPN_RELAYS];
  const block = buildNvpnNetworkBlock(id, relays);
  const updated = insertNetworkBlockFirst(toml, block);

  const w = writeConfigTextSync(configPath, updated, { rootOwned: canon.rootOwned, backup: false });
  if (!w.ok) return { ok: false, detail: w.detail };
  return { ok: true, detail: 'joined network', networkId: id, relays };
}

// ── De-fork + re-pin repair (config.toml surgery) ─────────────────────
//
// The forked-network bug, made fixable. When config.toml has two
// [[networks]] records that canonicalize to the same id (e.g. "abcd-1234"
// shadowing "abcd1234"), the daemon hashes each literally → different mesh
// IPs → the node never converges. Repair collapses each forked group to a
// single canonical survivor, makes the active network's survivor first,
// and re-pins a stale explicit tunnel_ip override to the deterministic
// value. It is preview-first (dry-run returns the plan without writing),
// backs up config.toml before any write, and writes atomically. It never
// reloads/restarts — a network-identity change needs a full restart with a
// brief interface drop, which the caller prompts for explicitly.

interface NetBlockSpan {
  start: number; end: number; text: string;
  id: string | null; participants: number;
}

// Split config.toml into its [[networks]] blocks (full text incl. header),
// each bounded at the next top-level table heading. Pure.
function findNetworkBlocks(toml: string): NetBlockSpan[] {
  const out: NetBlockSpan[] = [];
  const re = /^[^\S\r\n]*\[\[networks\]\][^\S\r\n]*\r?\n?/gm;
  const heads: Array<{ start: number; bodyStart: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(toml)) !== null) heads.push({ start: m.index, bodyStart: m.index + m[0].length });
  for (const h of heads) {
    const after = toml.slice(h.bodyStart);
    const nextRel = after.search(/^[^\S\r\n]*\[(?:\[)?/m);
    const end = nextRel >= 0 ? h.bodyStart + nextRel : toml.length;
    const body = toml.slice(h.bodyStart, end);
    out.push({
      start: h.start, end,
      text: toml.slice(h.start, end),
      id: extractTomlString(body, 'network_id'),
      participants: extractTomlList(body, 'participants').length,
    });
  }
  return out;
}

function rewriteBlockNetworkId(text: string, newId: string): string {
  return text.replace(/^([^\S\r\n]*network_id[^\S\r\n]*=[^\S\r\n]*")[^"]*(")/m, `$1${newId}$2`);
}
function blockTunnelIp(text: string): string | null {
  const m = text.match(/^[^\S\r\n]*tunnel_ip[^\S\r\n]*=[^\S\r\n]*"([^"]*)"/m);
  return m ? m[1] : null;
}
function rewriteBlockTunnelIp(text: string, ip: string): string {
  return text.replace(/^([^\S\r\n]*tunnel_ip[^\S\r\n]*=[^\S\r\n]*")[^"]*(")/m, `$1${ip}$2`);
}

// Re-pin a stale `tunnel_ip` inside the `[node]` table — verified on real
// hardware to be where nvpn persists the node's mesh IP (the [[networks]]
// blocks carry only network_id). This is config HYGIENE: the daemon
// re-derives the live interface IP from the canonical network_id on
// restart and ignores this stored value, so fixing it doesn't move the
// interface — it just stops config.toml from showing a wrong IP. Scoped to
// the [node] section and rewrites ONLY the tunnel_ip line; the section's
// private_key and every other field are left byte-identical. Returns the
// rewritten toml + the stale value found (null when absent / already
// correct). Pure.
function repinNodeTunnelIp(toml: string, correctIp: string): { toml: string; from: string | null } {
  const header = toml.match(/^[^\S\r\n]*\[node\][^\S\r\n]*\r?\n/m);
  if (!header || header.index === undefined) return { toml, from: null };
  const bodyStart = header.index + header[0].length;
  const after = toml.slice(bodyStart);
  const nextRel = after.search(/^[^\S\r\n]*\[(?:\[)?/m);
  const sectionEnd = nextRel >= 0 ? bodyStart + nextRel : toml.length;
  const section = toml.slice(bodyStart, sectionEnd);
  const m = section.match(/^[^\S\r\n]*tunnel_ip[^\S\r\n]*=[^\S\r\n]*"([^"]*)"/m);
  if (!m) return { toml, from: null };
  if (m[1] === correctIp) return { toml, from: null };
  const newSection = section.replace(/^([^\S\r\n]*tunnel_ip[^\S\r\n]*=[^\S\r\n]*")[^"]*(")/m, `$1${correctIp}$2`);
  return { toml: toml.slice(0, bodyStart) + newSection + toml.slice(sectionEnd), from: m[1] };
}

export interface NvpnRepairPlan {
  needed:            boolean;
  activeNetworkId:   string | null;
  canonicalActiveId: string | null;
  /** Forked/duplicate network ids that will be dropped. */
  removedNetworkIds: string[];
  /** Active network id rewrite (non-canonical → canonical), if any. */
  renamedActiveId:   { from: string; to: string } | null;
  /** Stale explicit tunnel_ip override fix, if any. */
  ipRepin:           { from: string; to: string } | null;
  /** Human-readable preview lines. */
  summary:           string[];
  /** Rewritten config (null when nothing to do). */
  newToml:           string | null;
}

// Pure planner — computes the repair without touching disk. Exported for
// unit tests (fed synthetic forked configs).
export function planNvpnRepair(toml: string, pubkeyHex: string | null): NvpnRepairPlan {
  const empty: NvpnRepairPlan = {
    needed: false, activeNetworkId: null, canonicalActiveId: null,
    removedNetworkIds: [], renamedActiveId: null, ipRepin: null, summary: [], newToml: null,
  };
  const blocks = findNetworkBlocks(toml);
  if (blocks.length === 0) return empty;
  const active = blocks[0];
  if (!active.id) return empty; // can't reason without an active id
  const canonActive = canonicalNetworkId(active.id);

  const groups = new Map<string, NetBlockSpan[]>();
  for (const b of blocks) {
    if (!b.id) continue;
    const c = canonicalNetworkId(b.id);
    const arr = groups.get(c);
    if (arr) arr.push(b); else groups.set(c, [b]);
  }
  // Survivor: prefer an already-canonical block, else the most-populated.
  const survivorOf = (group: NetBlockSpan[]): NetBlockSpan =>
    group.find(b => b.id === canonicalNetworkId(b.id!)) ||
    [...group].sort((a, b) => b.participants - a.participants)[0];

  const removedIds: string[] = [];
  const orderedSurvivors: string[] = [];
  const seenCanon = new Set<string>();

  // Active group's survivor goes first.
  const activeGroup = groups.get(canonActive)!;
  const activeSurvivor = survivorOf(activeGroup);
  for (const b of activeGroup) if (b !== activeSurvivor && b.id) removedIds.push(b.id);
  seenCanon.add(canonActive);

  let activeText = activeSurvivor.text;
  let renamedActiveId: { from: string; to: string } | null = null;
  if (activeSurvivor.id !== canonActive) {
    renamedActiveId = { from: activeSurvivor.id!, to: canonActive };
    activeText = rewriteBlockNetworkId(activeText, canonActive);
  }
  // The correct deterministic IP for this node on the (canonical) active
  // network — used to re-pin any stale stored value.
  const correctIp = pubkeyHex ? computeNvpnTunnelIp(canonActive, pubkeyHex) : null;
  // Rare: a stale tunnel_ip override *inside* the active [[networks]] block.
  let ipRepin: { from: string; to: string; where: string } | null = null;
  if (correctIp) {
    const inBlock = blockTunnelIp(activeText);
    if (inBlock && inBlock !== correctIp) {
      ipRepin = { from: inBlock, to: correctIp, where: 'active network block' };
      activeText = rewriteBlockTunnelIp(activeText, correctIp);
    }
  }
  orderedSurvivors.push(activeText);

  // Remaining groups in original order; id-less blocks kept verbatim.
  for (const b of blocks) {
    if (!b.id) { orderedSurvivors.push(b.text); continue; }
    const c = canonicalNetworkId(b.id);
    if (seenCanon.has(c)) continue;
    seenCanon.add(c);
    const grp = groups.get(c)!;
    const surv = survivorOf(grp);
    for (const x of grp) if (x !== surv && x.id) removedIds.push(x.id);
    orderedSurvivors.push(surv.id !== c ? rewriteBlockNetworkId(surv.text, c) : surv.text);
  }

  const needsReorder = activeSurvivor !== active;
  // De-fork changes that require rebuilding the networks section.
  const rebuildNeeded = removedIds.length > 0 || renamedActiveId !== null || needsReorder || ipRepin !== null;

  // Assemble the de-forked config (or start from the original when the only
  // change is the [node] IP hygiene fix below).
  let result = toml;
  if (rebuildNeeded) {
    const firstStart = blocks[0].start;
    let stripped = '';
    let cursor = 0;
    for (const b of blocks) { stripped += toml.slice(cursor, b.start); cursor = b.end; }
    stripped += toml.slice(cursor);
    result = stripped.slice(0, firstStart) + orderedSurvivors.join('') + stripped.slice(firstStart);
  }

  // Hygiene: re-pin the stale `[node].tunnel_ip` (where nvpn actually
  // stores it). Cosmetic — the Restart re-derive is what moves the
  // interface — but it stops config.toml from showing a wrong IP.
  if (correctIp) {
    const node = repinNodeTunnelIp(result, correctIp);
    if (node.from !== null) {
      result = node.toml;
      // Prefer reporting the [node] location since that's the real one.
      ipRepin = { from: node.from, to: correctIp, where: '[node].tunnel_ip' };
    }
  }

  const needed = rebuildNeeded || ipRepin !== null;
  if (!needed) return { ...empty, activeNetworkId: active.id, canonicalActiveId: canonActive };

  const summary: string[] = [];
  if (removedIds.length) summary.push(`Remove ${removedIds.length} forked/duplicate network block${removedIds.length === 1 ? '' : 's'} (${removedIds.join(', ')})`);
  if (renamedActiveId) summary.push(`Rewrite active network id "${renamedActiveId.from}" → canonical "${renamedActiveId.to}"`);
  if (needsReorder) summary.push(`Make "${canonActive}" the active network`);
  if (ipRepin) summary.push(`Re-pin stale ${ipRepin.where} ${ipRepin.from} → ${ipRepin.to} (config hygiene; the Restart re-derives the live interface)`);

  return {
    needed: true, activeNetworkId: active.id, canonicalActiveId: canonActive,
    removedNetworkIds: removedIds,
    renamedActiveId,
    ipRepin: ipRepin ? { from: ipRepin.from, to: ipRepin.to } : null,
    summary,
    newToml: result,
  };
}

export interface NvpnRepairResult extends ControlResult {
  plan:             NvpnRepairPlan;
  applied:          boolean;
  backedUpTo?:      string;
  restartRequired?: boolean;
}

// Read config, compute the plan, and (only when apply=true) back up +
// write it atomically. Preview-first: apply=false returns the plan with
// no write. Never reloads/restarts — the caller prompts for the restart.
export function repairNvpnNetworkConfig(opts: { apply: boolean; pubkeyHex: string | null }): NvpnRepairResult {
  const emptyPlan: NvpnRepairPlan = {
    needed: false, activeNetworkId: null, canonicalActiveId: null,
    removedNetworkIds: [], renamedActiveId: null, ipRepin: null, summary: [], newToml: null,
  };
  const canon = resolveCanonicalConfig();
  const configPath = canon.path;
  if (!configPath) return { ok: false, detail: 'no nvpn config.toml found — run `nvpn init` first', plan: emptyPlan, applied: false };
  const toml = readConfigTextSync(configPath);
  if (toml == null) return { ok: false, detail: 'config unreadable (permission or missing) — try `sudo -v` then retry', plan: emptyPlan, applied: false };

  const plan = planNvpnRepair(toml, opts.pubkeyHex);
  if (!plan.needed) {
    return { ok: true, detail: 'nothing to repair — no forked or non-canonical networks found', plan, applied: false };
  }
  if (!opts.apply || !plan.newToml) {
    return { ok: true, detail: 'repair plan ready (preview)', plan, applied: false, restartRequired: true };
  }
  // Back up before writing; refuse the write if the backup fails.
  const w = writeConfigTextSync(configPath, plan.newToml, { rootOwned: canon.rootOwned, backup: true });
  if (!w.ok) return { ok: false, detail: w.detail, plan, applied: false, backedUpTo: w.backedUpTo };
  return { ok: true, detail: 'config repaired', plan, applied: true, backedUpTo: w.backedUpTo, restartRequired: true };
}

// ── Discovery relays (Nostr presence/signaling) ──────────────────────
//
// nvpn discovers peers by publishing/subscribing to presence events on a
// configured set of Nostr relays. Out-of-the-box defaults
// (relay.snort.social, temp.iris.to, …) flake intermittently with 504
// Gateway Timeouts and the dashboard had no surface for swapping them
// without hand-editing TOML. This block pairs read-from-disk + write-via-
// CLI: we parse the current list straight out of config.toml so the UI
// can render even when the daemon is down, and we mutate via
// `nvpn set --relay <url>` so persistence + reload semantics match
// every other settings change.
//
// Storage location is the `[[networks]]` block's `relays = […]` entry —
// same scoping as participants/admins. We try [nostr] as a fallback for
// older configs that put the relay set at the top level; if neither
// matches we return [] and let the user populate via the UI (the very
// first `nvpn set --relay` call will create the entry correctly).

export interface NvpnRelays {
  found:      boolean;
  configPath: string | null;
  relays:     string[];
}

// Curated "good defaults" the dashboard offers via the Config panel's
// "Use recommended" button. Deliberately separate from whatever nvpn
// itself ships as init defaults — those have flaked in the field
// (snort.social / temp.iris.to returning 504s, damus.io rate-limiting
// presence publishers with "you are noting too much"). We keep this
// list short and only include relays measured as healthy for nvpn
// publish traffic. Update here when relay quality changes; the UI
// button surfaces the new list on the next dashboard load.
//
// Excluded after field measurement: relay.damus.io (publish rate-limit),
// relay.snort.social (504), relay.nostr.band (connect timeouts),
// nostr.wine (paid / 403), offchain.pub (WoT publish rejection).
export const RECOMMENDED_NVPN_RELAYS: readonly string[] = Object.freeze([
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://purplerelay.com',
  'wss://nostr.mom',
]);

// Pure helper — extract the relay list from the parsed sections of a
// config.toml. Tries the [[networks]] section first (current schema),
// then a [nostr] section (legacy). Exported for unit tests.
export function extractNvpnRelays(toml: string): string[] {
  const networksSection = extractFirstNetworksSection(toml);
  const fromNetworks = extractTomlList(networksSection, 'relays');
  if (fromNetworks.length > 0) return fromNetworks;
  // Legacy fallback — older configs put `relays = [...]` directly under
  // a top-level `[nostr]` table. Slice that section out the same way
  // extractPeerAliasesSection does, then run extractTomlList against it.
  const nostrHdr = toml.match(/^\s*\[nostr\][^\S\r\n]*\r?\n?/m);
  if (!nostrHdr || nostrHdr.index === undefined) return [];
  const rest = toml.slice(nostrHdr.index + nostrHdr[0].length);
  const next = rest.search(/^\s*\[(?:\[)?/m);
  const body = next >= 0 ? rest.slice(0, next) : rest;
  return extractTomlList(body, 'relays');
}

export function readNvpnRelays(): NvpnRelays {
  const configPath = resolveCanonicalConfig().path;
  if (!configPath) return { found: false, configPath: null, relays: [] };
  const toml = readConfigTextSync(configPath);
  if (toml == null) return { found: false, configPath, relays: [] };
  return { found: true, configPath, relays: extractNvpnRelays(toml) };
}

// Validation: wss://… or ws://… up to a reasonable max length. We keep
// the regex tight on protocol and host shape but defer the deeper
// "is this a real relay" question to nvpn itself — a bad URL gets
// surfaced on the next netcheck/probe rather than blocked client-side.
const RELAY_URL_RE = /^wss?:\/\/[A-Za-z0-9.\-_:[\]/?&=%~+]+$/;
const RELAY_URL_MAX = 256;
export function isValidRelayUrl(s: unknown): s is string {
  return typeof s === 'string'
    && s.length > 0
    && s.length <= RELAY_URL_MAX
    && RELAY_URL_RE.test(s);
}

// Build the argv for `nvpn set` given a desired full relay list.
// Pure + exported so tests can pin the shape without a binary on PATH.
// `nvpn set --relay <url>` is repeatable (same shape as --participant
// in add-participant), and a single `nvpn set` call rewrites the
// list to exactly the args provided. Empty list → caller should not
// invoke (nvpn would refuse / the user would lose connectivity); we
// guard that at the route layer with a clear error.
export function buildSetRelaysArgs(relays: string[]): string[] {
  const args: string[] = ['set'];
  for (const r of relays) { args.push('--relay', r); }
  args.push('--json');
  return args;
}

export interface NvpnRelaysResult extends ControlResult {
  relays?: string[];
  raw?:    Record<string, unknown> | null;
}

// ── Relay mutation (config.toml [[networks]] relays = […]) ─────────────
//
// nvpn 4.x removed the bulk `nvpn set --relay` CLI verb and never shipped
// a replacement — upstream's own answer is "edit config.toml or use the
// native app." The native app edits the file directly, so we do the same:
// rewrite the `relays = […]` array inside the active (first) `[[networks]]`
// block, atomically, then the route layer kicks `nvpn reload` so the
// running daemon re-reads it. Same write discipline as the alias path
// (temp file + rename, 0o600). Pure rebuild is factored out + exported so
// the regex surgery is unit-tested without touching disk.

// Canonicalize for comparison — config.toml may store "wss://x/" while a
// removal request arrives as "wss://x" (or vice versa). Used only for
// equality in remove/dedupe; the stored string is left untouched.
function normalizeRelayForCompare(s: string): string {
  return s.replace(/\/+$/, '').toLowerCase();
}

// Rebuild a TOML doc with the active [[networks]] block's relay list
// replaced by `relays`. Pure for testability. When the first networks
// block already has a `relays = […]` entry it's replaced in place;
// otherwise the entry is inserted at the top of that block. Returns the
// input unchanged when there is no [[networks]] block at all (caller
// guards that case with a clear error).
export function rebuildTomlWithRelays(toml: string, relays: string[]): string {
  const literal = `relays = [${relays.map(r => `"${r}"`).join(', ')}]`;
  const header = toml.match(/^[^\S\r\n]*\[\[networks\]\][^\S\r\n]*\r?\n?/m);
  if (!header || header.index === undefined) return toml;
  const bodyStart = header.index + header[0].length;
  const after = toml.slice(bodyStart);
  // Bound the block at the next top-level table heading (or EOF).
  const nextRel = after.search(/^[^\S\r\n]*\[(?:\[)?/m);
  const sectionEnd = nextRel >= 0 ? bodyStart + nextRel : toml.length;
  const before  = toml.slice(0, bodyStart);
  let   section = toml.slice(bodyStart, sectionEnd);
  const tail    = toml.slice(sectionEnd);
  // Match an existing (possibly multi-line) relays array within the block.
  const relaysRe = /^[^\S\r\n]*relays[^\S\r\n]*=[^\S\r\n]*\[[\s\S]*?\][^\S\r\n]*$/m;
  if (relaysRe.test(section)) {
    section = section.replace(relaysRe, literal);
  } else {
    section = `${literal}\n${section}`;
  }
  return before + section + tail;
}

// Apply a mutation to the active network's relay list and write it back.
// Validates the resulting set (every entry must be a well-formed relay
// URL) and refuses to leave the node with zero relays — an empty set
// strands presence/discovery. Atomic write mirrors mutateAliases.
function mutateRelays(
  mutator: (current: string[]) => string[],
): NvpnRelaysResult {
  const canon = resolveCanonicalConfig();
  const configPath = canon.path;
  if (!configPath) return { ok: false, detail: 'no nvpn config.toml found — run `nvpn init` first' };
  const toml = readConfigTextSync(configPath);
  if (toml == null) return { ok: false, detail: 'config unreadable (permission or missing) — try `sudo -v` then retry' };
  if (!/^[^\S\r\n]*\[\[networks\]\]/m.test(toml)) {
    return { ok: false, detail: 'no [[networks]] block in config.toml — join or create a network first' };
  }
  const current = extractNvpnRelays(toml);
  // Dedupe the mutator output on the canonical form while keeping the
  // first-seen original string (preserves the user's preferred casing /
  // trailing slash).
  const seen = new Set<string>();
  const next: string[] = [];
  for (const r of mutator([...current])) {
    if (typeof r !== 'string') continue;
    const key = normalizeRelayForCompare(r);
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(r);
  }
  for (const r of next) {
    if (!isValidRelayUrl(r)) return { ok: false, detail: `invalid relay url: ${String(r).slice(0, 120)}` };
  }
  if (next.length === 0) {
    return { ok: false, detail: 'refusing to clear the relay list — the node needs at least one discovery relay' };
  }
  if (JSON.stringify(next) === JSON.stringify(current)) {
    return { ok: true, detail: 'no change', relays: current };
  }
  const updated = rebuildTomlWithRelays(toml, next);
  const w = writeConfigTextSync(configPath, updated, { rootOwned: canon.rootOwned, backup: false });
  if (!w.ok) return { ok: false, detail: w.detail };
  return { ok: true, detail: 'relays updated', relays: next };
}

// Replace the entire relay list. Refuses empty input (see mutateRelays).
export async function setNvpnRelays(relays: string[]): Promise<NvpnRelaysResult> {
  if (!Array.isArray(relays)) return { ok: false, detail: 'relays must be an array' };
  return mutateRelays(() => relays.map(r => String(r).trim()).filter(Boolean));
}

export async function addNvpnRelay(url: string): Promise<NvpnRelaysResult> {
  const u = String(url || '').trim();
  if (!isValidRelayUrl(u)) return { ok: false, detail: 'invalid relay url — must be ws:// or wss://' };
  return mutateRelays(cur => [...cur, u]);
}

export async function removeNvpnRelay(url: string): Promise<NvpnRelaysResult> {
  const target = normalizeRelayForCompare(String(url || '').trim());
  if (!target) return { ok: false, detail: 'no relay url provided' };
  return mutateRelays(cur => cur.filter(r => normalizeRelayForCompare(r) !== target));
}

// ── Alias mutation (config.toml [peer_aliases] table) ──────────────
//
// nvpn has no CLI command for aliases — the `[peer_aliases]` table is
// edited directly. We do the safest thing we can without a TOML lib:
//   1. Read current contents.
//   2. Rebuild the [peer_aliases] section line by line from the current
//      alias map plus the requested mutation. Other sections of the file
//      are preserved verbatim.
//   3. Write atomically (temp file + rename) so a crash mid-write can't
//      truncate the user's config.
//   4. Caller (route handler) follows up with `nvpn reload` so the
//      daemon picks up the new label without a restart.
//
// Validation contract: alias values are restricted to printable ASCII
// (letters, digits, dash, underscore, space, dot) up to 64 chars.
// That covers the realistic naming use cases without opening surface
// for confusable Unicode or TOML-escape exploits.

const ALIAS_MAX_LEN = 64;
const ALIAS_VALUE_RE = /^[A-Za-z0-9 _\-.]{1,64}$/;

export function isValidAliasValue(v: string): boolean {
  return typeof v === 'string' && ALIAS_VALUE_RE.test(v);
}

// Rebuild a TOML doc with an updated [peer_aliases] table. Pure for
// testability — caller handles the actual fs read/write. `next` is
// the desired complete alias map (the route handler computes this
// by merging the current state with the requested mutation).
export function rebuildTomlWithAliases(
  toml: string,
  next: Record<string, string>,
): string {
  // Build the replacement section body. Empty map → keep the header
  // but write zero entries; we'd rather have an empty `[peer_aliases]`
  // table than special-case header insertion later.
  const bodyLines: string[] = [];
  const keys = Object.keys(next).sort();
  for (const k of keys) {
    const v = next[k];
    // Defensive escape for backslash + quote even though our validator
    // rules these out — config.toml may have been hand-edited.
    const escaped = v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    bodyLines.push(`${k} = "${escaped}"`);
  }
  const newBody = bodyLines.length > 0 ? bodyLines.join('\n') + '\n' : '';
  const newSection = `[peer_aliases]\n${newBody}`;

  // Replace existing section if present, otherwise append at end of
  // file (prefix with a blank line for readability).
  const sectionRe = /^\s*\[peer_aliases\][\s\S]*?(?=^\s*\[(?:\[)?|$(?![\r\n]))/m;
  if (sectionRe.test(toml)) {
    return toml.replace(sectionRe, newSection);
  }
  // Ensure trailing newline before appending.
  const sep = toml.endsWith('\n') ? '\n' : '\n\n';
  return toml + sep + newSection;
}

interface AliasWriteResult {
  ok:       boolean;
  detail:   string;
  aliases?: Record<string, string>;
}

// Apply a mutation (set or remove one alias) to the current config.
// Returns the new alias map. Atomic write — temp file + rename — so a
// concurrent reader never sees a half-rewritten file.
function mutateAliases(
  mutator: (current: Record<string, string>) => Record<string, string>,
): AliasWriteResult {
  const canon = resolveCanonicalConfig();
  const configPath = canon.path;
  if (!configPath) return { ok: false, detail: 'no nvpn config.toml found — run `nvpn init` first' };
  const toml = readConfigTextSync(configPath);
  if (toml == null) return { ok: false, detail: 'config unreadable (permission or missing) — try `sudo -v` then retry' };
  const current = extractAliasMap(extractPeerAliasesSection(toml));
  const next    = mutator({ ...current });
  if (JSON.stringify(next) === JSON.stringify(current)) {
    return { ok: true, detail: 'no change', aliases: current };
  }
  const updated = rebuildTomlWithAliases(toml, next);
  const w = writeConfigTextSync(configPath, updated, { rootOwned: canon.rootOwned, backup: false });
  if (!w.ok) return { ok: false, detail: w.detail };
  return { ok: true, detail: 'aliases updated', aliases: next };
}

export function setNvpnAlias(participant: string, alias: string): AliasWriteResult {
  if (!isValidParticipant(participant)) {
    return { ok: false, detail: 'invalid participant pubkey' };
  }
  if (!isValidAliasValue(alias)) {
    return {
      ok: false,
      detail: `alias must be 1–${ALIAS_MAX_LEN} chars, letters/digits/space/-_./ only`,
    };
  }
  return mutateAliases(map => ({ ...map, [participant]: alias }));
}

export function removeNvpnAlias(participant: string): AliasWriteResult {
  if (!isValidParticipant(participant)) {
    return { ok: false, detail: 'invalid participant pubkey' };
  }
  return mutateAliases(map => {
    const out = { ...map };
    delete out[participant];
    return out;
  });
}

// ── Roster + invites + whois ─────────────────────────────────────────────
//
// nvpn 0.3.x organises peers into a network roster: a set of `participants`
// (regular peers) plus a subset marked `admins`. Roster mutations are local
// until you pass `--publish`, which broadcasts the admin-signed roster
// over Nostr. The dashboard treats `publish` as a per-call flag — the UI
// defaults to publish-on-add (matches expected mental model: "I added a
// peer, of course they should now see me") but exposes it as a checkbox
// for power users staging changes locally.

const ROSTER_TIMEOUT_MS = 20_000;
const INVITE_TIMEOUT_MS = 10_000;
// whois may walk Nostr relays for peer metadata when --discover-secs is
// non-zero. We cap aggressively because the dashboard's a synchronous
// click; users can re-run if the daemon needs more time.
const WHOIS_TIMEOUT_MS = 6_000;

// Accepts both bech32 (npub1…) and lowercase hex (64 chars). nvpn itself
// is more forgiving (accepts mixed-case hex too) but the dashboard
// validates strictly so we never ship "Invalid public key" stack traces
// from the binary into the toast UI.
const NPUB_RE = /^npub1[023456789acdefghjklmnpqrstuvwxyz]{58}$/;
const HEX_RE  = /^[0-9a-f]{64}$/i;
export function isValidParticipant(s: string): boolean {
  if (!s || typeof s !== 'string') return false;
  return NPUB_RE.test(s) || HEX_RE.test(s);
}

// Schema-flexible parser for `--json` output. Most roster commands emit
// `{ network_id, participants[], admins[], changed[], published_recipients,
// published, relays[] }`. Surface the whole thing back to the UI; only
// the `published` flag drives our toast wording.
export interface RosterMutationResult extends ControlResult {
  raw?:                   Record<string, unknown> | null;
  published?:             boolean;
  publishedRecipients?:   number;
  changed?:               string[];
}

async function runRosterCommand(
  cmd: 'add-participant' | 'remove-participant' | 'add-admin' | 'remove-admin',
  participants: string[],
  publish: boolean,
): Promise<RosterMutationResult> {
  const binPath = findBin('nvpn');
  if (!binPath) return { ok: false, detail: 'nvpn binary not installed' };
  const cleaned = participants.map(s => String(s).trim()).filter(Boolean);
  if (cleaned.length === 0) return { ok: false, detail: 'no participants provided' };
  const bad = cleaned.filter(p => !isValidParticipant(p));
  if (bad.length > 0) {
    return {
      ok: false,
      detail: `invalid participant${bad.length > 1 ? 's' : ''}: ${bad.slice(0, 3).join(', ')}` +
              (bad.length > 3 ? ` (+${bad.length - 3} more)` : ''),
    };
  }
  // Argv shape: nvpn <cmd> --participant <p1> --participant <p2> [--publish] --json
  const args: string[] = [cmd];
  for (const p of cleaned) { args.push('--participant', p); }
  if (publish) args.push('--publish');
  args.push('--json');

  try {
    const { stdout } = await execa(binPath, buildNvpnArgs(args), {
      timeout: ROSTER_TIMEOUT_MS, stdio: 'pipe',
    });
    let raw: Record<string, unknown> | null = null;
    try { raw = JSON.parse(stdout); } catch { /* keep raw=null, surface ok with no metadata */ }
    const published          = !!(raw?.published);
    const publishedRecipients = typeof raw?.published_recipients === 'number'
      ? raw.published_recipients : undefined;
    const changed = Array.isArray(raw?.changed)
      ? (raw.changed as unknown[]).filter(x => typeof x === 'string') as string[]
      : undefined;
    const detail = published
      ? `roster updated and published${publishedRecipients ? ` to ${publishedRecipients} recipient${publishedRecipients === 1 ? '' : 's'}` : ''}`
      : 'roster updated locally (not published)';
    return { ok: true, detail, raw, published, publishedRecipients, changed };
  } catch (e: any) {
    return { ok: false, detail: summarizeError(e) };
  }
}

export function addParticipants(participants: string[], publish: boolean): Promise<RosterMutationResult> {
  return runRosterCommand('add-participant', participants, publish);
}
export function removeParticipants(participants: string[], publish: boolean): Promise<RosterMutationResult> {
  return runRosterCommand('remove-participant', participants, publish);
}
export function addAdmins(participants: string[], publish: boolean): Promise<RosterMutationResult> {
  return runRosterCommand('add-admin', participants, publish);
}
export function removeAdmins(participants: string[], publish: boolean): Promise<RosterMutationResult> {
  return runRosterCommand('remove-admin', participants, publish);
}

export interface PublishRosterResult extends ControlResult {
  raw?:                 Record<string, unknown> | null;
  published?:           boolean;
  publishedRecipients?: number;
}

// Trigger a roster broadcast without changing the roster itself.
//
// 4.x removed the standalone `nvpn publish-roster` verb (it was folded
// into each mutation's `--publish` flag). The PR #154 fence assumed
// that was enough — but in practice `--publish` regularly reports
// `published_recipients: 0` when relays are flaky / WoT-gated / POW-
// gated, and users had no separate "retry publish" affordance to
// recover. Now they do: this helper re-adds an existing admin (or
// participant, if no admins exist) with `--publish`, which is
// idempotent on a member already in the roster and triggers the
// publish path. Same `published_recipients` field on the response, so
// the dashboard can show "saved locally, X relays reached" honestly.
//
// Picks an admin first (admins should always be in the roster), with
// a fallback to the first participant. If the roster is empty we
// can't trigger this verb at all — caller gets a clear error.
export async function publishRoster(): Promise<PublishRosterResult> {
  const binPath = findBin('nvpn');
  if (!binPath) return { ok: false, detail: 'nvpn binary not installed' };
  const roster = readNvpnRoster();
  if (!roster.found) {
    return {
      ok: false,
      detail: 'no nvpn config found — initialize the daemon first',
    };
  }
  // Prefer admins because in 4.x only admins can publish a signed
  // roster — re-adding a non-admin participant won't actually trigger
  // the publish path even with --publish. Fall back to a participant
  // only as a last resort (covers the rare case of a no-admin network).
  const target = roster.admins[0] ?? roster.participants[0];
  if (!target) {
    return {
      ok: false,
      detail: 'roster is empty — add a peer first',
    };
  }
  const cmd = roster.admins.includes(target) ? 'add-admin' : 'add-participant';
  const result = await runRosterCommand(cmd, [target], /* publish */ true);
  if (!result.ok) return { ok: false, detail: `republish via ${cmd} failed: ${result.detail}` };
  return {
    ok:                  true,
    detail:              result.detail.replace('roster updated', 'roster published'),
    raw:                 result.raw,
    published:           result.published,
    publishedRecipients: result.publishedRecipients,
  };
}

export interface InviteResult extends ControlResult {
  invite?:    string;
  networkId?: string;
  raw?:       Record<string, unknown> | null;
}
export async function createInvite(): Promise<InviteResult> {
  const binPath = findBin('nvpn');
  if (!binPath) return { ok: false, detail: 'nvpn binary not installed' };
  try {
    const { stdout } = await execa(binPath, buildNvpnArgs(['create-invite', '--json']), {
      timeout: INVITE_TIMEOUT_MS, stdio: 'pipe',
    });
    let raw: Record<string, unknown> | null = null;
    try { raw = JSON.parse(stdout); } catch { /* nothing */ }
    const invite    = typeof raw?.invite === 'string' ? (raw.invite as string) : undefined;
    const networkId = typeof raw?.network_id === 'string' ? (raw.network_id as string) : undefined;
    if (!invite) return { ok: false, detail: 'create-invite returned no invite string', raw };
    return { ok: true, detail: 'invite created', invite, networkId, raw };
  } catch (e: any) {
    return { ok: false, detail: summarizeError(e) };
  }
}

export async function importInvite(invite: string): Promise<InviteResult> {
  const binPath = findBin('nvpn');
  if (!binPath) return { ok: false, detail: 'nvpn binary not installed' };
  const trimmed = String(invite || '').trim();
  // Light client-side validation. nvpn will reject malformed strings, but
  // we'd rather fail fast with a sensible toast than render a Rust panic
  // backtrace from the binary.
  if (!/^nvpn:\/\/invite\//.test(trimmed)) {
    return { ok: false, detail: 'invite must start with nvpn://invite/' };
  }
  try {
    const { stdout } = await execa(binPath, buildNvpnArgs(['import-invite', trimmed, '--json']), {
      timeout: INVITE_TIMEOUT_MS, stdio: 'pipe',
    });
    let raw: Record<string, unknown> | null = null;
    try { raw = JSON.parse(stdout); } catch { /* nothing */ }
    const networkId = typeof raw?.network_id === 'string' ? (raw.network_id as string) : undefined;
    return { ok: true, detail: 'invite imported', networkId, raw };
  } catch (e: any) {
    return { ok: false, detail: summarizeError(e) };
  }
}

export interface WhoisResult extends ControlResult {
  raw?: Record<string, unknown> | null;
}
export async function whoisPeer(query: string): Promise<WhoisResult> {
  const binPath = findBin('nvpn');
  if (!binPath) return { ok: false, detail: 'nvpn binary not installed' };
  const trimmed = String(query || '').trim();
  if (!trimmed) return { ok: false, detail: 'empty query' };
  // discover-secs 0 keeps the call snappy when run from a click; the
  // local roster + cached peer state is usually enough to resolve.
  try {
    const { stdout } = await execa(
      binPath, buildNvpnArgs(['whois', trimmed, '--discover-secs', '0', '--json']),
      { timeout: WHOIS_TIMEOUT_MS, stdio: 'pipe' },
    );
    let raw: Record<string, unknown> | null = null;
    try { raw = JSON.parse(stdout); } catch { /* nothing */ }
    return { ok: true, detail: 'whois ok', raw };
  } catch (e: any) {
    return { ok: false, detail: summarizeError(e) };
  }
}

// ── Lifecycle: pause / resume / reload (Feature 3) ───────────────────────
//
// Less destructive than stop. `pause` flips the data plane off without
// killing the daemon (faster resume; daemon stays in the relay's
// presence list). `reload` re-reads config + roster after an out-of-band
// edit. All three are unprivileged.

export async function pauseNvpn(): Promise<ControlResult> {
  const binPath = findBin('nvpn');
  if (!binPath) return { ok: false, detail: 'nvpn binary not installed' };
  try {
    await execa(binPath, buildNvpnArgs(['pause']), { timeout: CONTROL_TIMEOUT_MS, stdio: 'pipe' });
    return { ok: true, detail: 'nvpn paused' };
  } catch (e: any) { return { ok: false, detail: summarizeError(e) }; }
}

export async function resumeNvpn(): Promise<ControlResult> {
  const binPath = findBin('nvpn');
  if (!binPath) return { ok: false, detail: 'nvpn binary not installed' };
  try {
    await execa(binPath, buildNvpnArgs(['resume']), { timeout: CONTROL_TIMEOUT_MS, stdio: 'pipe' });
    return { ok: true, detail: 'nvpn resumed' };
  } catch (e: any) { return { ok: false, detail: summarizeError(e) }; }
}

export async function reloadNvpn(): Promise<ControlResult> {
  const binPath = findBin('nvpn');
  if (!binPath) return { ok: false, detail: 'nvpn binary not installed' };
  try {
    await execa(binPath, buildNvpnArgs(['reload']), { timeout: CONTROL_TIMEOUT_MS, stdio: 'pipe' });
    return { ok: true, detail: 'nvpn config reloaded' };
  } catch (e: any) { return { ok: false, detail: summarizeError(e) }; }
}

export async function repairNvpnNetwork(): Promise<ControlResult> {
  const binPath = findBin('nvpn');
  if (!binPath) return { ok: false, detail: 'nvpn binary not installed' };
  try {
    await execa(binPath, buildNvpnArgs(['repair-network']), { timeout: CONTROL_TIMEOUT_MS, stdio: 'pipe' });
    return { ok: true, detail: 'network state repaired' };
  } catch (e: any) { return { ok: false, detail: summarizeError(e) }; }
}

// ── Diagnostics: ping / netcheck / doctor / nat-discover ─────────────────

export interface PingOptions {
  count?:       number;
  timeoutSecs?: number;
}
export interface PingResult extends ControlResult {
  output?: string;
}
export async function pingNvpnPeer(target: string, opts: PingOptions = {}): Promise<PingResult> {
  const binPath = findBin('nvpn');
  if (!binPath) return { ok: false, detail: 'nvpn binary not installed' };
  const trimmed = String(target || '').trim();
  if (!trimmed) return { ok: false, detail: 'empty ping target' };
  // ping is plain text output (not JSON) — mirror the binary's wire
  // format and return it verbatim. Caller renders inline.
  const count       = clampInt(opts.count, 1, 10, 3);
  const timeoutSecs = clampInt(opts.timeoutSecs, 1, 30, 2);
  // Total cap = (count * timeoutSecs) + 2s slack. nvpn's ping respects
  // its --timeout-secs per-attempt; we add a hard ceiling so a wedged
  // socket doesn't block the dashboard click.
  const totalCap = (count * timeoutSecs * 1000) + 2_000;
  try {
    const { stdout, stderr } = await execa(
      binPath,
      buildNvpnArgs(['ping', trimmed, '--count', String(count), '--timeout-secs', String(timeoutSecs)]),
      { timeout: totalCap, stdio: 'pipe' },
    );
    return { ok: true, detail: 'ping ok', output: (stdout || stderr || '').slice(0, 4000) };
  } catch (e: any) {
    return { ok: false, detail: summarizeError(e), output: (e?.stdout || '').slice(0, 4000) };
  }
}

export interface DiagResult extends ControlResult {
  raw?: Record<string, unknown> | null;
}

const NETCHECK_TIMEOUT_MS = 8_000;
const DOCTOR_TIMEOUT_MS   = 30_000;

export async function netcheckNvpn(): Promise<DiagResult> {
  // `nvpn netcheck` was removed in 4.x. Coverage folded into
  // `nvpn doctor --json` — use /api/nvpn/doctor instead.
  return {
    ok: false,
    detail: 'netcheck removed in nvpn 4.x — use doctor (POST /api/nvpn/doctor) for the same coverage',
  };
}

export interface DoctorOptions {
  writeBundle?: boolean;
}
export interface DoctorResult extends DiagResult {
  bundlePath?: string;
}
export async function doctorNvpn(opts: DoctorOptions = {}): Promise<DoctorResult> {
  const binPath = findBin('nvpn');
  if (!binPath) return { ok: false, detail: 'nvpn binary not installed' };
  const args = ['doctor', '--json'];
  let bundlePath: string | undefined;
  if (opts.writeBundle) {
    // Drop the bundle alongside the install log so post-mortems have
    // one place to look. Stamp + extension match nvpn's expected output.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    bundlePath = path.join(os.homedir(), 'logs', `nvpn-doctor-${stamp}.tgz`);
    try { fs.mkdirSync(path.dirname(bundlePath), { recursive: true }); } catch { /* fine */ }
    args.push('--write-bundle', bundlePath);
  }
  try {
    const { stdout } = await execa(binPath, buildNvpnArgs(args), {
      timeout: DOCTOR_TIMEOUT_MS, stdio: 'pipe',
    });
    let raw: Record<string, unknown> | null = null;
    try { raw = JSON.parse(stdout); } catch { /* keep null */ }
    return { ok: true, detail: 'doctor ok', raw, bundlePath };
  } catch (e: any) {
    return { ok: false, detail: summarizeError(e), bundlePath };
  }
}

export async function natDiscoverNvpn(_reflector: string, _listenPort?: number): Promise<DiagResult> {
  // `nvpn nat-discover` was removed in 4.x — replaced by the daemon's
  // built-in periodic STUN discovery (visible via status JSON's
  // `public_endpoint` / `nat.public_endpoint`). One-shot probe verb
  // has no upstream replacement.
  return {
    ok: false,
    detail: 'nat-discover removed in nvpn 4.x — daemon runs STUN discovery automatically; see status JSON',
  };
}

// ── Settings (`nvpn set`) ────────────────────────────────────────────────
//
// `nvpn set` accepts a wide range of `--<key> <value>` pairs. The
// dashboard exposes a curated subset matching what users routinely tune
// (node name, listen port, autoconnect, advertise-exit-node, advertised
// routes). Unknown keys pass through unchanged so an upstream addition
// doesn't require a code change here.

const SETTABLE_KEYS = new Set([
  'node-name',
  'listen-port',
  'tunnel-ip',
  'endpoint',
  'magic-dns-suffix',
  'exit-node',
  // New in 4.0.1: when true, the daemon blocks all internet traffic
  // while the configured exit-node is unreachable. Settable as boolean
  // ("true"/"false"); UI exposure is a follow-up.
  'exit-node-leak-protection',
  'advertise-exit-node',
  'advertise-routes',
  'autoconnect',
  'network-id',
  // Removed in nvpn 4.0.x: `magic-dns-port` (daemon picks automatically),
  // `relay-for-others`, `provide-nat-assist`. Bulk `--relay` was also
  // removed — relay list management moved into config.toml / the native
  // app; the API surface returns a clear "removed in 4.x" message.
]);

export interface SetResult extends ControlResult {
  raw?: Record<string, unknown> | null;
}
export async function setNvpnSettings(input: Record<string, unknown>): Promise<SetResult> {
  const binPath = findBin('nvpn');
  if (!binPath) return { ok: false, detail: 'nvpn binary not installed' };
  const args: string[] = ['set'];
  let added = 0;
  for (const [key, value] of Object.entries(input || {})) {
    if (!SETTABLE_KEYS.has(key)) continue;
    if (value === undefined || value === null || value === '') continue;
    args.push(`--${key}`, String(value));
    added++;
  }
  if (added === 0) return { ok: false, detail: 'no settable fields in payload' };
  args.push('--json');
  try {
    const { stdout } = await execa(binPath, buildNvpnArgs(args), { timeout: 10_000, stdio: 'pipe' });
    let raw: Record<string, unknown> | null = null;
    try { raw = JSON.parse(stdout); } catch { /* keep null */ }
    return { ok: true, detail: `${added} field${added === 1 ? '' : 's'} updated`, raw };
  } catch (e: any) {
    return { ok: false, detail: summarizeError(e) };
  }
}

// ── Stats (`nvpn stats`) ─────────────────────────────────────────────────
// Surfaces relay-operator counters from the local state file. Useful
// for users who flip on `relay-for-others` and want to see traffic
// they're forwarding.
export async function statsNvpn(): Promise<DiagResult> {
  // `nvpn stats` was removed in 4.x along with `relay-for-others`
  // (the setting whose counters this exposed). The whole relay-operator
  // feature class is gone from upstream as of the FIPS mesh redesign.
  return {
    ok: false,
    detail: 'stats removed in nvpn 4.x (relay-for-others mode dropped in the FIPS mesh redesign)',
  };
}

// ── Pure helpers (testable) ─────────────────────────────────────────────

export function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  // null + undefined coerce to 0 / NaN respectively under `Number()`, but
  // semantically they're "no value" — treat as fallback so callers don't
  // accidentally write a clamped 0/lo when the input was missing entirely.
  if (v === null || v === undefined) return fallback;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

// True iff `key` is on the curated `nvpn set` allowlist. Exported for
// route-handler validation: callers sanitize their request body before
// calling setNvpnSettings so the rejection happens at the API boundary.
export function isSettableNvpnKey(key: string): boolean {
  return SETTABLE_KEYS.has(key);
}

// Known-benign upstream log lines that contain words like "fail" or
// "err" but are recoverable / informational from the daemon's POV.
// Without this allowlist they get colored red by the generic keyword
// heuristic below, which turns a healthy first-run log into a wall of
// red and trains users to ignore real errors.
//
// Each entry must be specific — a vague `/fail/` would hide bugs. Add
// here only after confirming the daemon prints the line at INFO level
// and continues normally. Order doesn't matter; first match wins.
const NVPN_RECOVERABLE_PATTERNS: readonly RegExp[] = [
  // Port collision on the magic-dns port — daemon falls back to a
  // random port and keeps running. Our installer pre-seeds a free
  // port to avoid this, but legacy log files still contain the line.
  /magicdns: preferred port \d+ unavailable/i,
  // systemd-resolved isn't on the host (common on minimal servers,
  // containers, anything without the resolved unit). nvpn keeps its
  // local resolver on 127.0.0.1:<port>; the user's resolv.conf is
  // unchanged but the daemon itself answers queries for the magic
  // suffix as expected.
  /magicdns: system resolver install failed.*resolve1\.service not found/i,
  // Route-cache flush sysctl needs CAP_DAC_OVERRIDE. Our caps drop-in
  // grants it for new installs, but the legacy line stays in the log
  // file. Both the wrapper and the bare permission-denied form show
  // up depending on nvpn version.
  /tunnel: failed to flush linux route cache/i,
  /Cannot open ["']?\/proc\/sys\/net\/ipv4\/route\/flush["']?: Permission denied/i,
];

// nvpn doesn't emit a level prefix consistently. Heuristic match
// mirrors LogsPanel.classify() so the dashboard's coloring works
// without a wire-protocol change. Recoverable patterns demote to
// info before the generic error/warn rules run.
export function classifyNvpnLogLine(line: string): 'info' | 'warn' | 'error' {
  for (const re of NVPN_RECOVERABLE_PATTERNS) {
    if (re.test(line)) return 'info';
  }
  if (/\b(error|err|panic|fail)\b/i.test(line))   return 'error';
  if (/\b(warn|warning)\b/i.test(line))           return 'warn';
  return 'info';
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
  // When the resolved path isn't readable by the running user but `sudo -n`
  // can reach it (typical for the systemd daemon's /root/.config/nvpn/
  // daemon.log on Linux), switch reads to a sudo-spawned `tail`. Stat is
  // still done via sudo when this flag is set.
  let currentPathNeedsSudo = false;
  let offset = 0;
  let pollTimer: NodeJS.Timeout | null = null;
  let pathTimer: NodeJS.Timeout | null = null;

  // Best-effort: probe whether a path is readable directly, or via
  // passwordless sudo. Returns 'direct' / 'sudo' / null.
  const probeReadability = async (p: string): Promise<'direct' | 'sudo' | null> => {
    try {
      fs.accessSync(p, fs.constants.R_OK);
      return 'direct';
    } catch { /* fall through */ }
    try {
      await execa('sudo', ['-n', 'test', '-r', p], { timeout: 2000 });
      return 'sudo';
    } catch { /* sudo not available or file not readable as root */ }
    return null;
  };

  const resolveLogPath = async (): Promise<{ path: string; needsSudo: boolean } | null> => {
    const s = await probeNvpnStatus();
    const fromStatus = s.installed ? s.raw?.daemon?.log_file : null;
    // Candidate paths in priority order. We probe each one (directly or
    // via sudo) and return the first readable hit. The root-daemon path
    // comes after the user-mode path because most installs run nvpn as
    // the same user as nostr-station; the root path matters for systemd
    // deployments where nostr-station can't directly stat /root.
    const home = os.homedir();
    const candidates: string[] = [];
    if (typeof fromStatus === 'string' && fromStatus.length > 0) candidates.push(fromStatus);
    candidates.push(path.join(home, '.config', 'nvpn', 'daemon.log'));
    candidates.push(path.join(home, 'Library', 'Application Support', 'nvpn', 'daemon.log'));
    candidates.push('/root/.config/nvpn/daemon.log');
    candidates.push('/var/log/nvpn.log');

    for (const c of candidates) {
      const r = await probeReadability(c);
      if (r === 'direct') return { path: c, needsSudo: false };
      if (r === 'sudo')   return { path: c, needsSudo: true  };
    }
    return null;
  };

  const onLines = (chunk: string): void => {
    const lines = chunk.split('\n');
    for (const raw of lines) {
      const line = raw.replace(/\r$/, '');
      if (!line) continue;
      buffer.push(classifyNvpnLogLine(line), line);
    }
  };

  // Read the current size of the log file, transparently going through
  // sudo if direct stat is denied. Returns null on any failure (file
  // disappeared, sudo timed out, etc.) — caller treats that as "no
  // change this tick."
  const statSize = async (p: string, useSudo: boolean): Promise<number | null> => {
    if (!useSudo) {
      try { return fs.statSync(p).size; } catch { return null; }
    }
    try {
      const r = await execa('sudo', ['-n', 'stat', '-c', '%s', p], { timeout: 2000 });
      const n = parseInt(String(r.stdout).trim(), 10);
      return Number.isFinite(n) ? n : null;
    } catch { return null; }
  };

  const readRange = async (
    p: string, useSudo: boolean, start: number, end: number,
  ): Promise<string> => {
    if (!useSudo) {
      const stream = fs.createReadStream(p, { start, end: end - 1, encoding: 'utf8' });
      let buf = '';
      await new Promise<void>((resolve) => {
        stream.on('data', (d: string | Buffer) => {
          buf += typeof d === 'string' ? d : d.toString('utf8');
        });
        stream.on('end',   () => resolve());
        stream.on('error', () => resolve());
      });
      return buf;
    }
    // sudo path: `dd` with byte offsets is the most portable way to slice
    // a file without slurping the whole thing. `count=` is bytes to read.
    try {
      const r = await execa('sudo', [
        '-n', 'dd', `if=${p}`, 'bs=1', `skip=${start}`, `count=${end - start}`, 'status=none',
      ], { timeout: 5000 });
      return String(r.stdout);
    } catch { return ''; }
  };

  const poll = async (): Promise<void> => {
    if (stopped) return;
    if (!currentPath) {
      schedulePoll();
      return;
    }
    const size = await statSize(currentPath, currentPathNeedsSudo);
    if (size !== null) {
      // File rotated / truncated — start over from byte 0.
      if (size < offset) offset = 0;
      if (size > offset) {
        const buf = await readRange(currentPath, currentPathNeedsSudo, offset, size);
        offset = size;
        // Only emit complete lines — keep the trailing partial for the
        // next poll. (Most real log writes end in \n, so this is a
        // correctness-against-pathological-streams measure.)
        const idx = buf.lastIndexOf('\n');
        const complete = idx >= 0 ? buf.slice(0, idx + 1) : '';
        if (complete) onLines(complete);
      }
    }
    schedulePoll();
  };

  const schedulePoll = (): void => {
    if (stopped) return;
    pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
  };

  const refreshPath = async (): Promise<void> => {
    if (stopped) return;
    const r = await resolveLogPath();
    if (r && r.path !== currentPath) {
      currentPath = r.path;
      currentPathNeedsSudo = r.needsSudo;
      // Seek to end so the user doesn't get a flood of historical lines
      // every time the daemon's log path changes.
      const sz = await statSize(r.path, r.needsSudo);
      offset = sz ?? 0;
      buffer.info(`tailing ${r.path}${r.needsSudo ? ' (via sudo)' : ''}`);
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

// ── Health summary (reality check) ───────────────────────────────────────
//
// Daemon-claimed status is necessary but not sufficient. nvpn can report
// itself "running" with a tunnel IP while STUN never succeeded, no public
// endpoint was discovered, and presence publishes are being rate-limited
// into the void. The dashboard's row indicator can light up green in that
// state, which is exactly when the user most needs to know it's broken.
//
// nvpnHealthSummary inspects the raw status payload (the same JSON shape
// nvpn ships) plus the optional Relays-tab aggregator snapshot, and rolls
// it up into a small set of UI-grade signals:
//
//   * state — 'ok' / 'degraded' / 'down' / 'unknown'
//   * publicEndpoint — STUN-discovered ip:port (when present), so the UI
//     can show "I'm reachable at X" prominently instead of burying it
//     three levels deep in raw JSON
//   * issues[] — short human-readable strings the UI can list as a hint
//     ("STUN did not complete", "3 publish errors in last 5min", etc.)
//
// Pure + exported for tests. Inputs are deliberately the wire shape so
// the route handler can pass the JSON it already has.

export interface NvpnHealthSummaryInput {
  // Subset of the NvpnStatus shape this function actually cares about.
  installed:     boolean;
  running:       boolean;
  tunnelIp:      string | null;
  raw:           Record<string, unknown> | null;
  // Optional roll-up from the per-relay publish aggregator (PR 57).
  // Caller passes the totals across all relays; we don't peek at
  // individual URLs here so the helper stays pure.
  publishErrors?:   { count: number; lastKind?: string | null } | null;
  publishSuccesses?: number | null;
}

export interface NvpnHealthSummary {
  state:           'ok' | 'degraded' | 'down' | 'unknown';
  publicEndpoint:  string | null;
  issues:          string[];
}

export function nvpnHealthSummary(in_: NvpnHealthSummaryInput): NvpnHealthSummary {
  if (!in_.installed) {
    return { state: 'down', publicEndpoint: null, issues: ['nvpn not installed'] };
  }
  if (!in_.running) {
    return { state: 'down', publicEndpoint: null, issues: ['daemon not running'] };
  }
  const issues: string[] = [];
  const r = in_.raw ?? {};

  // STUN-discovered public endpoint. nvpn has shipped this under a few
  // names across releases — try the obvious shapes; ignore failures
  // (raw can be a deeply nested struct we don't fully model).
  let publicEndpoint: string | null = null;
  const candidates = [
    (r as any).public_endpoint,
    (r as any).external_endpoint,
    (r as any).nat?.public_endpoint,
    (r as any).nat?.discovered_endpoint,
    (r as any).endpoint,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0 && /:\d+/.test(c)) {
      publicEndpoint = c;
      break;
    }
  }
  if (!publicEndpoint) {
    issues.push('no public endpoint discovered (STUN may not have succeeded)');
  }

  // health[] is upstream nvpn's first-class reporting surface. Anything
  // error-severity rolls into degraded; info entries we ignore (NAT
  // info, "running" pings, etc).
  const health = Array.isArray((r as any).health) ? (r as any).health as Array<{ code?: string; severity?: string; summary?: string }> : [];
  for (const h of health) {
    if (h && (h.severity === 'error' || h.severity === 'warn' || h.severity === 'warning')) {
      issues.push(h.summary ? `${h.code || 'health'}: ${h.summary}` : (h.code || 'health entry'));
    }
  }

  // Recent publish failures from the per-relay aggregator — surface when
  // we have data. No data is not "ok" or "broken" — it's "we don't
  // know" — and we keep silent rather than overclaim.
  if (in_.publishErrors && in_.publishErrors.count > 0) {
    const kind = in_.publishErrors.lastKind ? ` (${in_.publishErrors.lastKind})` : '';
    issues.push(`${in_.publishErrors.count} recent publish error${in_.publishErrors.count === 1 ? '' : 's'}${kind}`);
  }

  // Daemon claims a tunnel IP but the publish channel is failing — this
  // is the canonical "lying status" we're trying to surface.
  if (in_.tunnelIp && in_.publishErrors && in_.publishErrors.count > 0 && (!in_.publishSuccesses || in_.publishSuccesses === 0)) {
    issues.push('daemon reports running but no successful publishes recently');
  }

  return {
    state:          issues.length === 0 ? 'ok' : 'degraded',
    publicEndpoint,
    issues,
  };
}

// ── Banner running decision ─────────────────────────────────────────────
//
// The Logs panel banner needs a single boolean — "should we tell the user
// the daemon is stopped and offer them a Start button?" — but a brief
// stall on `nvpn status --json` is not enough evidence to claim the
// daemon is down. Systemd / launchd already know whether the process is
// running; we cross-check against that signal whenever the direct probe
// errored out (timeout, broken socket, transient nvpn crash mid-call).
//
// Decision table (D = direct probe, S = service probe):
//   D.running:true                       → running:true   (happy path)
//   D.running:false, no D.error          → running:false  (daemon really stopped)
//   D.running:false, D.error, S.running  → running:true   (probe stalled, process alive)
//   D.running:false, D.error, !S.running → running:false  (process down)
//
// Pure + exported for tests. Caller passes the same NvpnStatus shape
// probeNvpnStatus emits and (optionally) a NvpnServiceStatus from
// probeNvpnServiceStatus; passing `null` for the service skips the
// fallback and is equivalent to "no second opinion available."
export function vpnBannerRunningFor(
  direct: Pick<NvpnStatus, 'installed' | 'running' | 'error'>,
  service: Pick<NvpnServiceStatus, 'running'> | null,
): boolean {
  if (!direct.installed) return false;
  if (direct.running)    return true;
  // direct probe says not-running. If it errored, the answer is unknown
  // until we consult the service supervisor.
  if (direct.error && service && service.running) return true;
  return false;
}
