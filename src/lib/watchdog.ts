/**
 * Container-mode watchdog logic.
 *
 * The legacy host-OS watchdog is a bash script (see `src/lib/services.ts`)
 * fired by systemd .timer / launchd interval job. Container deployments
 * have neither, so the same shape lives here as a long-running Node
 * process: probe the relay, write a heartbeat file, sleep, repeat.
 *
 * The heartbeat file is the signal `gatherStatus()` reads in container
 * mode to decide whether the watchdog row paints green. Mtime within
 * 10 minutes (HEARTBEAT_FRESH_MS in Status.tsx) = healthy.
 *
 * NOT in this module yet: DM-on-relay-down. The host bash script publishes
 * a kind-4 event via `nak event` when the relay is unreachable. Bringing
 * that into JS requires NIP-04 encryption (kind-4 expects encrypted
 * content) and a relay-publish path. Worth doing once the compose stack
 * is in place — left as a TODO for PR 2b.
 */

import fs from 'fs';
import path from 'path';
import net from 'net';

export interface WatchdogOnceOptions {
  relayHost:     string;
  relayPort:     number;
  heartbeatPath: string;
  // checkPort is injected for tests — production callers pass the real
  // implementation from this module's default export.
  checkPort?:    (host: string, port: number, timeoutMs?: number) => Promise<boolean>;
  logger?:       (line: string) => void;
  // Inject Date.now for deterministic test assertions on heartbeat ts.
  now?:          () => number;
}

export interface WatchdogResult {
  relayUp:    boolean;
  heartbeat:  string;
  ts:         number;
}

// TCP port reachability probe. Replaces `nc -z` from the host watchdog —
// no shell, no PATH dependency, fixed timeout. Resolves false on connect
// errors AND on the timeout (we don't care which — both mean "not up").
export function checkPort(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const settle = (ok: boolean) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => settle(true));
    sock.once('error',   () => settle(false));
    sock.once('timeout', () => settle(false));
    sock.connect(port, host);
  });
}

export async function runWatchdogOnce(opts: WatchdogOnceOptions): Promise<WatchdogResult> {
  const probe   = opts.checkPort ?? checkPort;
  const now     = opts.now ?? Date.now;
  const ts      = now();
  const relayUp = await probe(opts.relayHost, opts.relayPort);

  // Write heartbeat first — even if the logger throws, monitoring sees
  // that this iteration ran. Mode 0o644 because compose may run the
  // watchdog and station containers as different uids; the station
  // dashboard needs to read it via gatherStatus.
  fs.mkdirSync(path.dirname(opts.heartbeatPath), { recursive: true });
  fs.writeFileSync(
    opts.heartbeatPath,
    JSON.stringify({ ts, relayUp }) + '\n',
    { mode: 0o644 },
  );

  safeLog(opts.logger,
    `${new Date(ts).toISOString()} relay=${relayUp ? 'up' : 'DOWN'} ` +
    `(${opts.relayHost}:${opts.relayPort})`,
  );
  return { relayUp, heartbeat: opts.heartbeatPath, ts };
}

// Logger is for observability. A buggy logger (e.g., write to a path the
// process can't see) must not crash the watchdog or trigger unhandled
// rejections in the loop.
function safeLog(logger: ((line: string) => void) | undefined, line: string): void {
  if (!logger) return;
  try { logger(line); } catch {}
}

export interface WatchdogLoopOptions extends WatchdogOnceOptions {
  intervalMs: number;
  signal?:    AbortSignal;
}

// Long-lived loop. Runs runWatchdogOnce, sleeps, repeats. Honors AbortSignal
// at both points so SIGTERM (docker stop) interrupts mid-sleep cleanly
// without waiting out the full interval.
export async function runWatchdogLoop(opts: WatchdogLoopOptions): Promise<void> {
  while (!opts.signal?.aborted) {
    try {
      await runWatchdogOnce(opts);
    } catch (e) {
      safeLog(opts.logger, `watchdog iteration failed: ${(e as Error).message}`);
    }
    if (opts.signal?.aborted) return;
    await sleep(opts.intervalMs, opts.signal);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
