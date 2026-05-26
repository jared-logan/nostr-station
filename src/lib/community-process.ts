/**
 * Community supervisor — one supervised GRAIN child process per
 * community manifest. Owns:
 *
 *   - spawn / stop / restart of each community's `grain` process
 *   - a per-community LogBuffer fed from stdout + stderr
 *   - restart-with-backoff (1/2/4/8/30s ceiling, give up after 5
 *     consecutive failures), with `intendedRunning` so a user-driven
 *     stop never triggers a backoff retry
 *   - a single shared healthcheck loop (every 10s, NIP-11 probe of
 *     each `running` child; two consecutive failures → `unhealthy`)
 *   - dashboard-exit cleanup: every supervised child gets SIGTERM
 *     on the parent's exit signals so we don't leave orphans behind
 *
 * Stays narrow on purpose:
 *
 *   - Orphan reconciliation (cmdline fingerprinting on dashboard
 *     boot for processes that survived a hard-kill) and dependency
 *     preflight (GRAIN binary / nvpn / network missing) live in a
 *     follow-up commit. Both are important; both are independently
 *     testable; both would balloon this file past easy review.
 *
 *   - The supervisor reads the community's `config.yml` from disk
 *     and spawns. It does NOT dynamically rewrite the bind address
 *     based on the live nvpn tunnel IP — that's the wizard's job at
 *     create-time, and a separate `prepareForStart()` helper's job at
 *     start-time. Keeping spawn dumb means tests can drive it with a
 *     plain manifest pointing at loopback.
 *
 * State is module-level (one supervisor per dashboard process), same
 * shape as the existing nvpn / relay singletons.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { LogBuffer } from './log-buffer.js';
import {
  type CommunityManifest, type CommunityStatus,
  readCommunityManifest, updateCommunityManifest,
  communityDir, communityConfigPath, listCommunities,
} from './communities.js';
import {
  readGrainConfig, writeGrainConfig, atomicWriteFileSync,
  coerceGrainPortValue, coerceGrainBackupRelay,
} from './community-yaml.js';
import { grainBinPath } from './grain-installer.js';
import { probeNvpnStatus, readNvpnNetworks, readNvpnRoster } from './nvpn.js';
import { findBin } from './detect.js';

// =====================================================================
// Tunables

const BACKOFF_MS         = [1_000, 2_000, 4_000, 8_000, 30_000];
/** After this many consecutive crashes the community is moved to `error`
 *  and the user must manually click Restart — we don't loop forever. */
const BACKOFF_GIVE_UP_AT = 5;

const HEALTHCHECK_INTERVAL_MS    = 10_000;
const HEALTHCHECK_FAIL_THRESHOLD = 2;
const HEALTHCHECK_TIMEOUT_MS     = 5_000;

/** Per-community log ring capacity. 2000 lines is enough to span
 *  several restart-and-investigate cycles without flushing the
 *  history a moderator might be looking at, and is small enough that
 *  N communities × 2000 lines × ~200 bytes stays well under 10 MB. */
const COMMUNITY_LOG_CAPACITY = 2_000;

// =====================================================================
// Module state

interface Supervision {
  manifest:               CommunityManifest;
  child:                  ChildProcess | null;
  log:                    LogBuffer;
  /** True while the user (or boot-time start) wants this running.
   *  Set false by stopCommunity() so a clean exit doesn't trip the
   *  crash-backoff loop. */
  intendedRunning:        boolean;
  startedAt:              number | null;
  consecutiveFailures:    number;
  backoffTimer:           NodeJS.Timeout | null;
  consecutiveHealthFails: number;
}

const supervisions = new Map<string, Supervision>();
let healthcheckTimer: NodeJS.Timeout | null = null;
let shutdownHandlerRegistered = false;

// =====================================================================
// Public read-side helpers

/**
 * Per-community in-memory log buffer. Lazily allocated; returns the
 * same instance across calls so SSE subscribers stay attached
 * across stop/start cycles (and so a user looking at the Logs panel
 * while a community restarts still sees the historical lines).
 */
export function getCommunityLog(id: string): LogBuffer {
  let s = supervisions.get(id);
  if (!s) {
    const manifest = readCommunityManifest(id);
    if (!manifest) {
      // Allocate an empty, detached buffer so callers don't have to
      // deal with `null` — the SSE drain just returns no lines.
      return new LogBuffer(COMMUNITY_LOG_CAPACITY);
    }
    s = createSupervision(manifest);
    supervisions.set(id, s);
  }
  return s.log;
}

/** Snapshot of the runtime view the UI renders next to a community. */
export interface CommunityRuntimeStatus {
  id:                     string;
  status:                 CommunityStatus;
  pid:                    number | null;
  startedAt:              number | null;
  uptimeMs:               number | null;
  consecutiveFailures:    number;
  consecutiveHealthFails: number;
  lastError?:             string;
}

export function getCommunityRuntimeStatus(id: string): CommunityRuntimeStatus {
  const m = readCommunityManifest(id);
  const s = supervisions.get(id);
  const pid       = s?.child?.pid ?? null;
  const startedAt = s?.startedAt ?? null;
  return {
    id,
    status:               (m?.status as CommunityStatus | undefined) ?? 'stopped',
    pid,
    startedAt,
    uptimeMs:             startedAt ? Date.now() - startedAt : null,
    consecutiveFailures:  s?.consecutiveFailures ?? 0,
    consecutiveHealthFails: s?.consecutiveHealthFails ?? 0,
    lastError:            m?.lastError,
  };
}

// =====================================================================
// Public command-side helpers

/**
 * Start (or re-start) a community. Reads the manifest from disk to
 * pick up any wizard-time edits, spawns GRAIN, wires log piping +
 * exit handling, and updates `status` in the manifest.
 *
 * Idempotent if the child is already running — returns the existing
 * supervision. Resets the backoff counter so a manual start always
 * gets the full 5 retries.
 */
export async function startCommunity(id: string): Promise<CommunityRuntimeStatus> {
  ensureShutdownHandler();
  ensureHealthcheckLoop();

  const manifest = readCommunityManifest(id);
  if (!manifest) throw new Error(`Community not found: ${id}`);

  let s = supervisions.get(id);
  if (!s) {
    s = createSupervision(manifest);
    supervisions.set(id, s);
  } else {
    s.manifest = manifest;  // pick up edits since last start
  }

  // Already running — return the live status. Don't respawn an
  // already-healthy child; that path is for restart() which the user
  // requested explicitly.
  if (s.child && s.child.exitCode === null && s.intendedRunning) {
    return getCommunityRuntimeStatus(id);
  }

  // Preflight: classify dependency state BEFORE we try to spawn so a
  // clearly-missing precondition surfaces with a specific error rather
  // than the generic "spawn failed" / "crashed N times" the runtime
  // path would otherwise emit.
  const pre = await preflightDependencies(manifest);
  if (!pre.ok) {
    updateCommunityManifest(id, { status: 'error', lastError: pre.reason });
    s.log.error(`preflight failed: ${pre.reason}`);
    throw new Error(`preflight failed: ${pre.reason}`);
  }

  s.intendedRunning     = true;
  s.consecutiveFailures = 0;
  s.consecutiveHealthFails = 0;
  if (s.backoffTimer) { clearTimeout(s.backoffTimer); s.backoffTimer = null; }

  await spawnChild(s);
  return getCommunityRuntimeStatus(id);
}

/**
 * Classify the dependencies needed to spawn a particular community.
 * Returns ok+nothing on success, or ok=false with a specific reason
 * that the UI can map to a banner + action button:
 *
 *   - grain-missing       → "Install GRAIN" action
 *   - nvpn-required       → "Install nvpn" action
 *   - nvpn-not-running    → "Start nvpn" action
 *   - network-missing     → "Recreate / rebind network" action
 *
 * GRAIN binary presence is checked here AND again inside spawnChild
 * (race: a user could delete the binary between the two calls). The
 * spawnChild check has the last word, but the preflight check makes
 * the error surface look like a precondition error rather than a
 * crash-loop.
 */
export type PreflightFailure =
  | 'grain-missing'
  | 'nvpn-required'
  | 'nvpn-not-running'
  | 'network-missing';

export interface PreflightResult {
  ok:      boolean;
  reason?: string;
  failure?: PreflightFailure;
}

export async function preflightDependencies(
  manifest: CommunityManifest,
): Promise<PreflightResult> {
  // 1. GRAIN binary. The supervisor always spawns by absolute path, so
  //    fs.access is the right probe — findBin would silently succeed
  //    if some other `grain` shadows ours, which would be confusing.
  const bin = grainBinPath();
  try {
    fs.accessSync(bin, fs.constants.X_OK);
  } catch {
    return {
      ok:       false,
      failure:  'grain-missing',
      reason:   `GRAIN binary not found at ${bin}. Install it from the Communities config.`,
    };
  }

  // 2. Local-only communities have no further dependencies.
  if (manifest.privacyMode === 'local') return { ok: true };

  // 3. Private-network: nvpn binary present?
  if (!findBin('nvpn')) {
    return {
      ok:       false,
      failure:  'nvpn-required',
      reason:   `Private-network communities need nvpn. Install it, then click Retry.`,
    };
  }

  // 4. nvpn daemon up? probeNvpnStatus() is the SWR-cached probe used
  //    elsewhere — we accept its cached result rather than forcing a
  //    fresh probe per community on every start, since this loop runs
  //    once at start-time, not in steady state.
  const st = await probeNvpnStatus();
  if (!st.running) {
    return {
      ok:       false,
      failure:  'nvpn-not-running',
      reason:   `nvpn is installed but its daemon isn't running. Start nvpn, then click Retry.`,
    };
  }

  // 5. The community's bound nvpn network must still exist in the
  //    user's roster. Networks deleted out from under us are the
  //    leading cause of confusing "won't start" reports.
  if (!manifest.nvpnNetworkId) {
    return {
      ok:       false,
      failure:  'network-missing',
      reason:   `This community has no nvpn network bound. Rebind it in Settings.`,
    };
  }
  const networks = readNvpnNetworks();
  const bound = networks.find((n) => n.networkId === manifest.nvpnNetworkId);
  if (!bound) {
    return {
      ok:       false,
      failure:  'network-missing',
      reason:   `nvpn network "${manifest.nvpnNetworkId}" no longer exists. Rebind or recreate.`,
    };
  }

  return { ok: true };
}

/**
 * Resolve the bind host a community should use right now. Runs at
 * every spawn so the bind tracks the live nvpn state — a user who
 * switched meshes since the last start gets the new tunnel IP
 * automatically, not a stale value from disk.
 *
 *   local           → 127.0.0.1 (always)
 *   private-network → the active nvpn tunnel IP, IF the community's
 *                     bound nvpnNetworkId matches the active network.
 *                     Mismatch ⇒ explicit refusal with a reason the
 *                     UI can map to a "switch nvpn network" prompt
 *                     (rather than silently binding to the wrong mesh).
 *
 * Kept distinct from preflightDependencies() because the failure modes
 * are different: preflight catches "your tools / network aren't ready",
 * prepareForStart catches "your current nvpn state doesn't match what
 * this community was bound to". UI surfaces each with a different
 * recovery action.
 */
export type PrepareForStartResult =
  | { ok: true;  bindHost: string }
  | { ok: false; reason:   string };

export async function prepareCommunityForStart(
  manifest: CommunityManifest,
): Promise<PrepareForStartResult> {
  if (manifest.privacyMode === 'local') {
    return { ok: true, bindHost: '127.0.0.1' };
  }

  // private-network: probe nvpn LIVE (no cached SWR result — the user
  // may have just clicked Start from a "network not active" error
  // banner, and we want the freshest answer).
  const st = await probeNvpnStatus();
  if (!st.installed) {
    return { ok: false, reason: 'nvpn is not installed' };
  }
  if (!st.running) {
    return { ok: false, reason: 'nvpn daemon is not running — start it from the nvpn panel and click Retry' };
  }
  if (!st.tunnelIp) {
    return {
      ok: false,
      reason: 'nvpn is running but has no tunnel IP yet — let it finish connecting to peers and click Retry',
    };
  }

  // Cross-check the community's bound network against the active one.
  // Under nvpn's one-active-network-at-a-time model, the "active"
  // network is the first [[networks]] block in config.toml — which
  // readNvpnRoster().networkId reads. Mismatch means the user switched
  // mesh and this community can't run until they switch back (or
  // rebind it to the new mesh).
  if (manifest.nvpnNetworkId) {
    const roster = readNvpnRoster();
    if (roster.networkId && roster.networkId !== manifest.nvpnNetworkId) {
      return {
        ok: false,
        reason:
          `community is bound to nvpn network "${manifest.nvpnNetworkId}" but ` +
          `"${roster.networkId}" is currently active — switch nvpn networks or rebind this community`,
      };
    }
  }

  return { ok: true, bindHost: st.tunnelIp };
}

/**
 * Stop a community. Sends SIGTERM, waits up to 5s for clean exit,
 * SIGKILLs if it ignores. Always updates the manifest's status to
 * 'stopped' (or 'error' on lastError preservation) and clears any
 * pending backoff timer.
 */
export async function stopCommunity(id: string): Promise<void> {
  const s = supervisions.get(id);
  if (!s) {
    // No supervision record means we never started it; just clear
    // any stale 'running' marker on the manifest.
    const m = readCommunityManifest(id);
    if (m) updateCommunityManifest(id, { status: 'stopped' });
    return;
  }

  s.intendedRunning = false;
  if (s.backoffTimer) { clearTimeout(s.backoffTimer); s.backoffTimer = null; }

  if (s.child && s.child.exitCode === null) {
    await terminateChild(s.child, s.log);
  }
  s.child     = null;
  s.startedAt = null;
  updateCommunityManifest(id, { status: 'stopped' });
}

/** SIGTERM-then-SIGKILL helper. Resolves once the child has exited. */
async function terminateChild(child: ChildProcess, log: LogBuffer): Promise<void> {
  if (!child.pid) return;
  return new Promise<void>((resolve) => {
    let resolved = false;
    const done = () => { if (!resolved) { resolved = true; resolve(); } };
    child.once('exit', done);
    try { child.kill('SIGTERM'); } catch {}
    // Hard timeout: 5s after SIGTERM, escalate. GRAIN closes LMDB
    // cleanly on SIGTERM in practice (<1s), but we don't want a
    // stuck child to wedge `nostr-station stop`.
    setTimeout(() => {
      if (!resolved && child.exitCode === null) {
        log.warn('child did not exit within 5s of SIGTERM — sending SIGKILL');
        try { child.kill('SIGKILL'); } catch {}
      }
    }, 5_000);
  });
}

export async function restartCommunity(id: string): Promise<CommunityRuntimeStatus> {
  await stopCommunity(id);
  return startCommunity(id);
}

/**
 * Stop every supervised community. Called from the parent process's
 * exit handlers so we don't leave GRAIN children running after the
 * dashboard exits. Best-effort: any per-child failure logs and
 * continues; we don't abort the shutdown on one slow child.
 */
export async function stopAllCommunities(): Promise<void> {
  const ids = Array.from(supervisions.keys());
  await Promise.allSettled(ids.map((id) => stopCommunity(id)));
}

// =====================================================================
// Internal spawn

function createSupervision(manifest: CommunityManifest): Supervision {
  return {
    manifest,
    child:                  null,
    log:                    new LogBuffer(COMMUNITY_LOG_CAPACITY),
    intendedRunning:        false,
    startedAt:              null,
    consecutiveFailures:    0,
    backoffTimer:           null,
    consecutiveHealthFails: 0,
  };
}

/**
 * Spawn the child process. Wires stdout/stderr → LogBuffer, exit →
 * crash-vs-clean classification, and updates manifest status. Throws
 * if the spawn itself fails (e.g. binary missing); crashes after a
 * successful spawn are handled by the exit listener.
 */
async function spawnChild(s: Supervision): Promise<void> {
  const id   = s.manifest.id;
  const dir  = communityDir(id);
  const bin  = grainBinPath();

  // Run the dependency preflight (nvpn up etc.) — kept here as a
  // dedicated step even though the bind-IP rewrite below no longer
  // depends on its result. Failure surfaces with a specific reason
  // mapping to a UI recovery action.
  const prep = await prepareCommunityForStart(s.manifest);
  if (!prep.ok) {
    s.log.error(`prepare failed: ${prep.reason}`);
    updateCommunityManifest(id, { status: 'error', lastError: prep.reason });
    throw new Error(`prepare failed: ${prep.reason}`);
  }

  // Auto-migrate config.yml's server.port to GRAIN's required
  // port-only form. Older nostr-station versions wrote "host:port"
  // (e.g. "127.0.0.1:7778") which GRAIN's validator REJECTS at
  // startup ("must start with ':'"). Without this migration,
  // community dirs created by older builds are permanently broken.
  // coerceGrainPortValue handles every form we've ever written:
  // bare ":7778" passes through, "host:port" gets the host stripped,
  // numeric ports get prefixed. Atomic write so GRAIN's hot-reload
  // never observes a torn file.
  const targetPort = `:${s.manifest.port}`;
  try {
    const cfg = readGrainConfig(communityConfigPath(dir));
    const coercedPort = coerceGrainPortValue(cfg.server.port) ?? targetPort;
    const portChanged = cfg.server.port !== coercedPort;

    // GRAIN 0.7.0 renamed backup_relay.url (string) → backup_relay.urls
    // (list). Default configs we wrote never set this key, but a user
    // who hand-edited their config.yml to mirror to an upstream relay
    // would see GRAIN refuse to start on the new schema. Migrate the
    // block in-place (see coerceGrainBackupRelay for the accepted
    // shapes and the deliberately conservative fallthrough).
    const coercedBackup = coerceGrainBackupRelay(cfg.backup_relay);
    const backupChanged = coercedBackup !== null;

    if (portChanged || backupChanged) {
      const next: typeof cfg = {
        ...cfg,
        server: { ...cfg.server, port: coercedPort },
      };
      if (backupChanged) next.backup_relay = coercedBackup;
      writeGrainConfig(communityConfigPath(dir), next);
      if (portChanged) {
        s.log.info(`migrated server.port "${cfg.server.port}" → "${coercedPort}" (GRAIN requires port-only form)`);
      }
      if (backupChanged) {
        s.log.info(`migrated backup_relay.url → backup_relay.urls (GRAIN 0.7.0 schema rename)`);
      }
    }
  } catch (e: any) {
    const msg = `failed to rewrite config.yml: ${(e?.message ?? '').slice(0, 200)}`;
    s.log.error(msg);
    updateCommunityManifest(id, { status: 'error', lastError: msg });
    throw new Error(msg);
  }

  // Cache the discovered tunnel IP in the manifest so the UI can show
  // members "this is the address you connect to". Distinct from the
  // bind interface (which GRAIN ignores per its port-only validator;
  // it binds to ALL interfaces unconditionally). The tunnel IP is the
  // mesh-side address members reach via nvpn — same value, different
  // semantic role now.
  if (s.manifest.privacyMode === 'private-network'
      && s.manifest.nvpnTunnelIp !== prep.bindHost) {
    s.manifest = updateCommunityManifest(id, { nvpnTunnelIp: prep.bindHost });
  }

  // GRAIN takes `--data-dir <path>` pointing at the directory that
  // holds config.yml + whitelist.yml + blacklist.yml. CWD doesn't
  // matter; we set it for cleanliness of `ps` output only.
  // Source: https://github.com/0ceanSlim/grain/blob/main/main.go (parseDataDirFlag)
  const args = ['--data-dir', dir];

  // Stat-check the binary before spawning. `child_process.spawn`
  // does NOT throw on ENOENT — it returns a child object that emits
  // 'error' asynchronously, which is awkward for startCommunity()
  // callers that want a single throw at the obvious failure point.
  // Checking up front gives the dashboard / CLI a concrete message
  // ("grain isn't installed") instead of a generic crash-and-backoff.
  try {
    fs.accessSync(bin, fs.constants.X_OK);
  } catch (e: any) {
    const msg = `grain binary not found or not executable at ${bin}`;
    s.log.error(`spawn failed: ${msg}`);
    updateCommunityManifest(id, { status: 'error', lastError: msg });
    throw new Error(`spawn failed: ${msg}`);
  }

  s.log.info(`spawning ${bin} ${args.join(' ')}`);
  let child: ChildProcess;
  try {
    child = spawn(bin, args, {
      cwd:   dir,
      stdio: ['ignore', 'pipe', 'pipe'],
      // detached:false so children get SIGTERM with us if the parent
      // is killed before our own shutdown handler fires. The handler
      // sends SIGTERM explicitly on graceful exits; this is the
      // belt-and-suspenders for SIGKILL of the parent.
    });
  } catch (e: any) {
    // Defensive: spawn() can still throw for some edge cases (invalid
    // argv types, EACCES on the cwd, etc.). Treat the same as ENOENT.
    const msg = (e?.message ?? String(e)).slice(0, 240);
    s.log.error(`spawn failed: ${msg}`);
    updateCommunityManifest(id, { status: 'error', lastError: `spawn failed: ${msg}` });
    throw new Error(`spawn failed: ${msg}`);
  }

  s.child     = child;
  s.startedAt = Date.now();
  updateCommunityManifest(id, { status: 'running', lastError: undefined });
  if (child.pid) writeGrainPidFile(id, child.pid);

  // Line-buffered piping. We don't try to parse log levels from the
  // line text — GRAIN's log format isn't specified contract — so all
  // lines go in as `info`. Lines on stderr come in as `warn` so a
  // moderator skimming the panel sees them stand out.
  pipeStream(child.stdout, (line) => s.log.info (line));
  pipeStream(child.stderr, (line) => s.log.warn (line));

  child.once('exit', (code, signal) => onChildExit(s, code, signal));
  child.once('error', (err) => {
    // Emitted for ENOENT / EACCES / etc. — typically alongside or
    // before 'exit'. We log it but the exit handler does the state
    // update (so we never double-fire the backoff loop).
    s.log.error(`child error: ${(err?.message ?? String(err)).slice(0, 240)}`);
  });
}

/** Newline-delimited piping with a 1 KiB cap on the lookahead buffer
 *  so a pathological binary spitting one unbroken line can't blow up
 *  the heap. Anything past the cap gets emitted as its own line. */
function pipeStream(stream: NodeJS.ReadableStream | null, emit: (line: string) => void): void {
  if (!stream) return;
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    buf += chunk;
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.length > 0) emit(line);
    }
    if (buf.length > 16 * 1024) {
      emit(buf.slice(0, 1024) + '… (line truncated)');
      buf = '';
    }
  });
  stream.on('end', () => {
    if (buf.length > 0) emit(buf);
    buf = '';
  });
}

function onChildExit(
  s: Supervision,
  code: number | null,
  signal: NodeJS.Signals | null,
): void {
  const id = s.manifest.id;
  const wasIntended = s.intendedRunning;
  s.child     = null;
  s.startedAt = null;
  // The pid file is no longer authoritative once the child has
  // exited; remove it eagerly so the next reconcile pass doesn't
  // chase a stale PID. (The orphan walk would also clear it after
  // a /proc miss, but doing it inline keeps the on-disk state
  // honest in the steady-state lifecycle.)
  removeGrainPidFile(id);

  const exitLabel = signal ? `signal ${signal}` : `code ${code ?? '?'}`;
  s.log.warn(`child exited (${exitLabel})`);

  if (!wasIntended) {
    // Clean stop requested by the user — leave status alone (the
    // stopCommunity call already wrote 'stopped').
    return;
  }

  s.consecutiveFailures += 1;
  if (s.consecutiveFailures >= BACKOFF_GIVE_UP_AT) {
    s.log.error(
      `gave up after ${BACKOFF_GIVE_UP_AT} consecutive failures (last: ${exitLabel}). ` +
      `Click Restart in the dashboard to try again.`,
    );
    updateCommunityManifest(id, {
      status:    'error',
      lastError: `crashed ${BACKOFF_GIVE_UP_AT} times in a row; last exit: ${exitLabel}`,
    });
    return;
  }

  const delay = BACKOFF_MS[Math.min(s.consecutiveFailures - 1, BACKOFF_MS.length - 1)];
  s.log.info(`restarting in ${delay} ms (attempt ${s.consecutiveFailures + 1}/${BACKOFF_GIVE_UP_AT})`);
  updateCommunityManifest(id, { status: 'restarting' });
  s.backoffTimer = setTimeout(() => {
    s.backoffTimer = null;
    if (!s.intendedRunning) return;  // user cancelled while we were waiting
    spawnChild(s).catch((e) => {
      s.log.error(`respawn failed: ${(e?.message ?? String(e)).slice(0, 240)}`);
    });
  }, delay);
}

// =====================================================================
// Healthcheck loop

function ensureHealthcheckLoop(): void {
  if (healthcheckTimer !== null) return;
  healthcheckTimer = setInterval(() => {
    runHealthchecks().catch(() => { /* swallow — individual probes log */ });
  }, HEALTHCHECK_INTERVAL_MS);
  // Don't keep the event loop alive for the healthcheck timer alone.
  // Otherwise `nostr-station status --json` would hang for 10s before
  // exiting.
  healthcheckTimer.unref?.();
}

async function runHealthchecks(): Promise<void> {
  for (const s of supervisions.values()) {
    if (!s.child || s.child.exitCode !== null) continue;
    const ok = await probeNip11(s);
    if (ok) {
      s.consecutiveHealthFails = 0;
      const current = readCommunityManifest(s.manifest.id);
      if (current && current.status !== 'running') {
        updateCommunityManifest(s.manifest.id, { status: 'running' });
      }
    } else {
      s.consecutiveHealthFails += 1;
      if (s.consecutiveHealthFails >= HEALTHCHECK_FAIL_THRESHOLD) {
        const current = readCommunityManifest(s.manifest.id);
        if (current && current.status !== 'unhealthy') {
          updateCommunityManifest(s.manifest.id, { status: 'unhealthy' });
          s.log.warn(
            `NIP-11 probe failed ${s.consecutiveHealthFails} times in a row. ` +
            `Process is up but the relay isn't responding — possible causes: ` +
            `LMDB lock, nvpn tunnel down, listening socket closed.`,
          );
        }
      }
    }
  }
}

/**
 * Single NIP-11 probe. Reads the bind address from the community's
 * `config.yml` (the supervisor doesn't keep it cached because the
 * user can rewrite the YAML directly and GRAIN hot-reloads — we
 * never want a stale cached bind to drive a misleading probe).
 */
async function probeNip11(s: Supervision): Promise<boolean> {
  let bindHostPort: string;
  try {
    const cfg = readGrainConfig(communityConfigPath(communityDir(s.manifest.id)));
    bindHostPort = cfg.server.port;
  } catch {
    return false;
  }
  // `server.port` is a Go http.Server.Addr string: either `host:port`
  // or `:port`. For probing we resolve `:port` to loopback because
  // the dashboard always shares the host.
  const { host, port } = parseHostPort(bindHostPort);
  return new Promise<boolean>((resolve) => {
    const req = http.request({
      host:   host || '127.0.0.1',
      port,
      method: 'GET',
      path:   '/',
      headers: { Accept: 'application/nostr+json' },
      timeout: HEALTHCHECK_TIMEOUT_MS,
    }, (res) => {
      // NIP-11 responds with JSON + 200. Even a non-JSON 200 means
      // GRAIN's HTTP server is up; we'd rather not be picky.
      res.resume();
      resolve((res.statusCode ?? 0) < 500);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

/** Parse a Go http.Server.Addr value (`:port`, `host:port`,
 *  `[::1]:port`). Returns host='' for the bare `:port` form. */
export function parseHostPort(s: string): { host: string; port: number } {
  // IPv6 in brackets: [::1]:8080
  const m6 = /^\[([^\]]+)\]:(\d+)$/.exec(s);
  if (m6) return { host: m6[1], port: Number(m6[2]) };
  // Bare colon: :8080
  if (s.startsWith(':')) return { host: '', port: Number(s.slice(1)) };
  // host:port
  const i = s.lastIndexOf(':');
  if (i < 0) throw new Error(`Cannot parse bind address: ${s}`);
  return { host: s.slice(0, i), port: Number(s.slice(i + 1)) };
}

// =====================================================================
// Process-exit cleanup

/**
 * Register parent-process exit handlers exactly once. SIGTERM /
 * SIGINT / 'beforeExit' all converge on stopAllCommunities so we
 * don't leave GRAIN children behind in any normal shutdown path.
 *
 * SIGKILL of the parent we can't help with — those orphans get
 * reaped by the orphan-reconciliation pass on the next boot.
 */
function ensureShutdownHandler(): void {
  if (shutdownHandlerRegistered) return;
  shutdownHandlerRegistered = true;

  const handler = async (signal: string) => {
    try { await stopAllCommunities(); } catch { /* best-effort */ }
    if (signal === 'beforeExit') return;  // Node exits naturally afterwards
    // Re-raise the signal so the parent's exit code reflects it.
    process.kill(process.pid, signal as NodeJS.Signals);
  };

  process.once('SIGTERM', () => { handler('SIGTERM'); });
  process.once('SIGINT',  () => { handler('SIGINT');  });
  process.once('beforeExit', () => { handler('beforeExit'); });
}

// =====================================================================
// grain.pid file — persisted record of the live PID per community

const PID_FILE = 'grain.pid';

function grainPidPath(id: string): string {
  return path.join(communityDir(id), PID_FILE);
}

function writeGrainPidFile(id: string, pid: number): void {
  // Atomic write so a concurrent reconcile pass never reads a torn
  // half-written PID number. `pid.toString()` is always short, but
  // the rename-after-fsync contract is uniform across our file
  // writes which keeps surprise low.
  try {
    atomicWriteFileSync(grainPidPath(id), `${pid}\n`);
  } catch { /* best-effort */ }
}

function removeGrainPidFile(id: string): void {
  try { fs.unlinkSync(grainPidPath(id)); } catch { /* may not exist */ }
}

function readGrainPidFile(id: string): number | null {
  try {
    const raw = fs.readFileSync(grainPidPath(id), 'utf8').trim();
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

// =====================================================================
// Orphan reconciliation

/**
 * Cross-platform "is this PID one of our GRAIN children?" probe.
 *
 *   - On Linux, read /proc/<pid>/cmdline (null-separated argv).
 *   - On macOS, fall back to `ps -p <pid> -o command=`.
 *
 * A match requires BOTH the resolved grain binary path AND the
 * community's directory to appear in the cmdline. That second
 * condition matters: it stops us from accidentally adopting a
 * grain child that belongs to a different community (e.g. a manual
 * `grain --data-dir /elsewhere` someone ran by hand).
 *
 * Returns false if the PID is dead, belongs to anything else, or
 * the probe itself failed — caller treats "unknown" the same as
 * "not ours", because the cost of a false negative (re-spawn a
 * fresh child) is much lower than a false positive (SIGTERM
 * someone else's process).
 */
export function isGrainProcessForCommunity(pid: number, id: string): boolean {
  const bin = grainBinPath();
  const dir = communityDir(id);

  // Cheap liveness check first — a non-existent PID short-circuits
  // before we touch the filesystem / spawn ps.
  try { process.kill(pid, 0); }
  catch { return false; }

  // Linux: /proc/<pid>/cmdline. Argv components are NUL-separated;
  // join with space for substring matching.
  if (process.platform === 'linux') {
    try {
      const raw = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      const cmdline = raw.replace(/\0/g, ' ');
      return cmdline.includes(bin) && cmdline.includes(dir);
    } catch {
      return false;
    }
  }

  // macOS (and any other Unix): synchronous ps. We can't use execa
  // here because it's async; spawnSync is fine for a one-shot at
  // boot. `command=` (empty label) returns the bare cmdline.
  try {
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2_000,
    }).toString();
    return out.includes(bin) && out.includes(dir);
  } catch {
    return false;
  }
}

/**
 * Boot-time reconciliation pass. For every community on disk:
 *
 *   - If `grain.pid` references a live, fingerprint-matching PID:
 *     SIGTERM it (we own it) and respawn under our supervision so
 *     stdout/stderr feed our LogBuffer. The brief blip is bounded
 *     by GRAIN's startup time (sub-second in practice). Critically:
 *     fingerprint mismatches NEVER trigger SIGTERM — we leave
 *     unrelated processes alone.
 *
 *   - If the pid file is stale (no live process, or live but not
 *     ours): clear the file and leave the manifest at 'stopped'.
 *     The dashboard's normal flow (user clicks Start, or autostart
 *     elsewhere) will respawn fresh.
 *
 *   - If status was 'running' on disk but no live process exists:
 *     reset to 'stopped' so the UI doesn't lie about state across
 *     a hard-kill of the dashboard.
 *
 * Returns a per-id summary the dashboard surfaces in its boot logs
 * (and tests assert against).
 */
export interface ReconcileResult {
  id:        string;
  outcome:   'no-pid-file' | 'pid-not-ours' | 'pid-dead' | 'respawned';
  pid?:      number;
  note?:     string;
}

export async function reconcileOrphanedCommunities(): Promise<ReconcileResult[]> {
  ensureShutdownHandler();
  ensureHealthcheckLoop();
  const results: ReconcileResult[] = [];
  for (const manifest of listCommunities()) {
    const id  = manifest.id;
    const pid = readGrainPidFile(id);

    if (pid === null) {
      // No record of a prior spawn. If the manifest still says
      // 'running'/'restarting' (a hard-kill of the dashboard left it
      // there), correct that — the process is definitely dead since
      // we don't have a pid for it.
      if (manifest.status === 'running' || manifest.status === 'restarting') {
        updateCommunityManifest(id, { status: 'stopped' });
      }
      results.push({ id, outcome: 'no-pid-file' });
      continue;
    }

    if (!isGrainProcessForCommunity(pid, id)) {
      // The PID is either dead or recycled by something else. The
      // fingerprint mismatch + "process exists" combination is the
      // one we MUST treat as "not ours" — sending SIGTERM here
      // would risk killing an unrelated process the kernel happened
      // to assign the same PID to.
      removeGrainPidFile(id);
      if (manifest.status === 'running' || manifest.status === 'restarting') {
        updateCommunityManifest(id, { status: 'stopped' });
      }
      // Tell the two cases apart in the result so the boot-log line
      // for a recycled PID looks different from a clean-dead pid.
      let alive = false;
      try { process.kill(pid, 0); alive = true; } catch {}
      results.push({
        id,
        outcome: alive ? 'pid-not-ours' : 'pid-dead',
        pid,
        note: alive
          ? `PID ${pid} is alive but its cmdline doesn't match — leaving it alone`
          : `PID ${pid} is dead; cleared stale pid file`,
      });
      continue;
    }

    // It's our orphan. Take ownership: SIGTERM the old PID, wait for
    // exit (short timeout because GRAIN closes LMDB cleanly in <1s),
    // then respawn under fresh supervision so log piping works.
    const s = supervisions.get(id) ?? createSupervision(manifest);
    supervisions.set(id, s);
    s.log.warn(`reconciling orphan: SIGTERM existing PID ${pid}, respawning`);
    try { process.kill(pid, 'SIGTERM'); } catch {}
    // Poll for actual exit so the respawn doesn't race a still-
    // shutting-down LMDB writer.
    for (let i = 0; i < 50; i++) {
      try { process.kill(pid, 0); }
      catch { break; }  // pid no longer exists
      await sleep(100);
    }
    removeGrainPidFile(id);
    s.intendedRunning     = true;
    s.consecutiveFailures = 0;
    s.consecutiveHealthFails = 0;
    try {
      await spawnChild(s);
      results.push({ id, outcome: 'respawned', pid: s.child?.pid });
    } catch (e: any) {
      const msg = (e?.message ?? String(e)).slice(0, 240);
      results.push({ id, outcome: 'respawned', pid, note: `respawn failed: ${msg}` });
    }
  }
  return results;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// =====================================================================
// Test helper — clear the module-level state between tests

/**
 * Test-only: wipe the supervision map + stop any background timers.
 * Production code never calls this; tests use it so the healthcheck
 * loop doesn't persist across test files.
 */
export function _resetSupervisorForTests(): void {
  for (const s of supervisions.values()) {
    if (s.backoffTimer) clearTimeout(s.backoffTimer);
    if (s.child && s.child.exitCode === null) {
      try { s.child.kill('SIGKILL'); } catch {}
    }
  }
  supervisions.clear();
  if (healthcheckTimer) {
    clearInterval(healthcheckTimer);
    healthcheckTimer = null;
  }
}

