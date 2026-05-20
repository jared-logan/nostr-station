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
import dgram from 'dgram';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import os from 'os';
import readline from 'readline';
import { findBin } from './detect.js';
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
    // collapse both to a short single-line string for the UI. NB: a probe
    // failure leaves `running: false` because we never saw a daemon.running
    // payload — but consumers must NOT read that as "daemon stopped" on its
    // own. A wedged or slow socket on a healthy daemon hits this same
    // branch; the banner code in web-server.ts cross-checks
    // probeNvpnServiceStatus() before flipping the user-facing pill.
    error = (e?.shortMessage || e?.message || String(e)).slice(0, 240);
  }
  const running  = !!raw?.daemon?.running;
  const tunnelIp = (raw?.tunnel_ip as string) ?? null;
  return { installed: true, binPath, running, tunnelIp, raw, error, fetchedAt };
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

export async function startNvpn(): Promise<ControlResult> {
  const binPath = findBin('nvpn');
  if (!binPath) return { ok: false, detail: 'nvpn binary not installed' };
  try {
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
    await execa(binPath, ['stop'], { timeout: CONTROL_TIMEOUT_MS, stdio: 'pipe' });
    return { ok: true, detail: 'nvpn daemon stopped' };
  } catch (e: any) {
    return { ok: false, detail: summarizeError(e) };
  } finally {
    nvpnEvents.emit('state-changed');
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

async function probeNvpnServiceStatusUncached(): Promise<NvpnServiceStatus> {
  const binPath = findBin('nvpn');
  if (!binPath) {
    return {
      supported: false, installed: false, disabled: false, loaded: false, running: false,
      pid: null, label: null, plistPath: null, binaryPath: null, binaryVersion: null,
      raw: null, error: 'nvpn binary not installed',
    };
  }
  try {
    const { stdout } = await execa(binPath, ['service', 'status', '--json'], {
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
  // For `install` (initial + Reinstall button): lay down our systemd
  // drop-in BEFORE upstream's `nvpn service install` writes its unit
  // and starts the daemon. systemd merges drop-ins with the base unit
  // on daemon-reload, so the very first start picks up our caps —
  // critical for a clean first-run log (no "Cannot open route/flush"
  // red lines). Best-effort: if sudo fails here, install proceeds
  // anyway and we surface the skip reason in the result detail.
  let capsNote = '';
  if (op === 'install') {
    const caps = await applyLinuxCapsDropIn();
    capsNote = caps.ok
      ? (caps.detail ? ` (${caps.detail})` : '')
      : ` (caps drop-in skipped: ${caps.detail})`;
  }
  try {
    await execa('sudo', ['-n', binPath, 'service', op], {
      timeout: SERVICE_OP_TIMEOUT_MS, stdio: 'pipe',
    });
    return { ok: true, detail: `service ${op} ok${capsNote}` };
  } catch (e: any) {
    const stderr = (e?.stderr?.toString?.() || '').trim();
    const needsPassword = /password is required|sudo:.*required/i.test(stderr);
    if (needsPassword) {
      return {
        ok: false,
        detail: `sudo cred cache empty — run \`sudo ${binPath} service ${op}\` manually, ` +
                `then refresh the dashboard.`,
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
export async function uninstallNvpnCli(): Promise<ControlResult> {
  const binPath = findBin('nvpn');
  if (!binPath) return { ok: false, detail: 'nvpn binary not installed' };
  // Try without sudo first — most setups have nvpn in ~/.cargo/bin
  // (user-writable) which doesn't need root.
  try {
    await execa(binPath, ['uninstall-cli'], { timeout: 15_000, stdio: 'pipe' });
    return { ok: true, detail: 'cli removed from PATH' };
  } catch { /* try with sudo */ }
  try {
    await execa('sudo', ['-n', binPath, 'uninstall-cli'], { timeout: 15_000, stdio: 'pipe' });
    return { ok: true, detail: 'cli removed from PATH (via sudo)' };
  } catch (e: any) {
    return { ok: false, detail: summarizeError(e) };
  }
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

export function extractTomlList(section: string, key: string): string[] {
  const re = new RegExp(`^\\s*${key}\\s*=\\s*\\[([\\s\\S]*?)\\]`, 'm');
  const m = section.match(re);
  if (!m) return [];
  const out: string[] = [];
  for (const sm of m[1].matchAll(/"([^"]+)"/g)) out.push(sm[1]);
  return out;
}

export function extractTomlString(section: string, key: string): string | null {
  const re = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]+)"`, 'm');
  const m = section.match(re);
  return m ? m[1] : null;
}

export function readNvpnRoster(): NvpnRoster {
  const configPath = findNvpnConfigPath();
  if (!configPath) {
    return { found: false, configPath: null, networkId: null, participants: [], admins: [], aliases: {} };
  }
  let toml = '';
  try { toml = fs.readFileSync(configPath, 'utf8'); }
  catch {
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
  const configPath = findNvpnConfigPath();
  if (!configPath) return [];
  let toml = '';
  try { toml = fs.readFileSync(configPath, 'utf8'); }
  catch { return []; }
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
  const configPath = findNvpnConfigPath();
  if (!configPath) return { found: false, configPath: null, relays: [] };
  let toml = '';
  try { toml = fs.readFileSync(configPath, 'utf8'); }
  catch { return { found: false, configPath, relays: [] }; }
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

// Replace the entire relay list. Single `nvpn set` invocation; the
// daemon picks up the new set on the next reload (we follow with
// `nvpn reload` best-effort, mirroring the alias mutation path).
//
// Refuses empty input — clearing the relay set would strand the
// node (presence won't publish, peers won't be discovered). The
// caller wanting to reset should remove relays one at a time and
// stop before the last.
const RELAY_MUTATION_REMOVED_DETAIL =
  'relay management was removed from `nvpn set` in 4.x — the native app is the supported surface; '
  + 'read-only `/api/nvpn/relays` still works against config.toml';

export async function setNvpnRelays(_relays: string[]): Promise<NvpnRelaysResult> {
  return { ok: false, detail: RELAY_MUTATION_REMOVED_DETAIL };
}

export async function addNvpnRelay(_url: string): Promise<NvpnRelaysResult> {
  return { ok: false, detail: RELAY_MUTATION_REMOVED_DETAIL };
}

export async function removeNvpnRelay(_url: string): Promise<NvpnRelaysResult> {
  return { ok: false, detail: RELAY_MUTATION_REMOVED_DETAIL };
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
  const configPath = findNvpnConfigPath();
  if (!configPath) return { ok: false, detail: 'no nvpn config.toml found — run `nvpn init` first' };
  let toml = '';
  try { toml = fs.readFileSync(configPath, 'utf8'); }
  catch (e: any) { return { ok: false, detail: `read failed: ${(e?.message || '').slice(0, 160)}` }; }
  const current = extractAliasMap(extractPeerAliasesSection(toml));
  const next    = mutator({ ...current });
  if (JSON.stringify(next) === JSON.stringify(current)) {
    return { ok: true, detail: 'no change', aliases: current };
  }
  const updated = rebuildTomlWithAliases(toml, next);
  // Atomic write: tmp file in the same dir → rename. Same dir matters
  // because rename across filesystems isn't atomic.
  const tmp = `${configPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, updated, { mode: 0o600 });
    fs.renameSync(tmp, configPath);
  } catch (e: any) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    return { ok: false, detail: `write failed: ${(e?.message || '').slice(0, 160)}` };
  }
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
    const { stdout } = await execa(binPath, args, {
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
  raw?: Record<string, unknown> | null;
}
export async function publishRoster(): Promise<PublishRosterResult> {
  // Removed in nvpn 4.x. Each roster mutation now broadcasts inline
  // via its own `--publish` flag (already the default in our
  // routes/nvpn.ts handler), so a standalone "republish" verb has no
  // upstream backing. UI button still works via add/remove paths.
  return {
    ok: false,
    detail: 'publish-roster removed in nvpn 4.x — mutations auto-publish with --publish',
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
    const { stdout } = await execa(binPath, ['create-invite', '--json'], {
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
    const { stdout } = await execa(binPath, ['import-invite', trimmed, '--json'], {
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
      binPath, ['whois', trimmed, '--discover-secs', '0', '--json'],
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
    await execa(binPath, ['pause'], { timeout: CONTROL_TIMEOUT_MS, stdio: 'pipe' });
    return { ok: true, detail: 'nvpn paused' };
  } catch (e: any) { return { ok: false, detail: summarizeError(e) }; }
}

export async function resumeNvpn(): Promise<ControlResult> {
  const binPath = findBin('nvpn');
  if (!binPath) return { ok: false, detail: 'nvpn binary not installed' };
  try {
    await execa(binPath, ['resume'], { timeout: CONTROL_TIMEOUT_MS, stdio: 'pipe' });
    return { ok: true, detail: 'nvpn resumed' };
  } catch (e: any) { return { ok: false, detail: summarizeError(e) }; }
}

export async function reloadNvpn(): Promise<ControlResult> {
  const binPath = findBin('nvpn');
  if (!binPath) return { ok: false, detail: 'nvpn binary not installed' };
  try {
    await execa(binPath, ['reload'], { timeout: CONTROL_TIMEOUT_MS, stdio: 'pipe' });
    return { ok: true, detail: 'nvpn config reloaded' };
  } catch (e: any) { return { ok: false, detail: summarizeError(e) }; }
}

export async function repairNvpnNetwork(): Promise<ControlResult> {
  const binPath = findBin('nvpn');
  if (!binPath) return { ok: false, detail: 'nvpn binary not installed' };
  try {
    await execa(binPath, ['repair-network'], { timeout: CONTROL_TIMEOUT_MS, stdio: 'pipe' });
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
      ['ping', trimmed, '--count', String(count), '--timeout-secs', String(timeoutSecs)],
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
    const { stdout } = await execa(binPath, args, {
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
    const { stdout } = await execa(binPath, args, { timeout: 10_000, stdio: 'pipe' });
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
