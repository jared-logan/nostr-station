/**
 * `nostr-station watchdog` — thin CLI wrapper over src/lib/watchdog.ts.
 *
 * Two modes:
 *   - One-shot (default):     runs a single probe + heartbeat, exits.
 *   - Loop (--loop):          long-lived, runs forever on --interval seconds,
 *                             intended to be the foreground process of the
 *                             watchdog container in the compose stack.
 *
 * Plain stdout — no Ink. A long-lived daemon's logs go to docker logs;
 * Ink frames in container logs are noise.
 */

import { runWatchdogOnce, runWatchdogLoop } from '../lib/watchdog.js';

export interface WatchdogCliOpts {
  loop:           boolean;
  intervalSec:    number;
  heartbeatPath:  string;
  relayHost:      string;
  relayPort:      number;
}

export async function runWatchdogCli(opts: WatchdogCliOpts): Promise<void> {
  const logger = (line: string) => process.stdout.write(line + '\n');

  if (!opts.loop) {
    await runWatchdogOnce({
      relayHost:     opts.relayHost,
      relayPort:     opts.relayPort,
      heartbeatPath: opts.heartbeatPath,
      logger,
    });
    return;
  }

  // Long-lived: SIGTERM is what `docker stop` sends after its grace period;
  // SIGINT is Ctrl-C. We abort the in-flight sleep so the loop returns
  // promptly and Node exits 0 instead of being SIGKILL'd at the timeout.
  const ac = new AbortController();
  process.once('SIGTERM', () => ac.abort());
  process.once('SIGINT',  () => ac.abort());

  logger(`watchdog: looping every ${opts.intervalSec}s, heartbeat=${opts.heartbeatPath}`);
  await runWatchdogLoop({
    relayHost:     opts.relayHost,
    relayPort:     opts.relayPort,
    heartbeatPath: opts.heartbeatPath,
    intervalMs:    opts.intervalSec * 1000,
    signal:        ac.signal,
    logger,
  });
}
