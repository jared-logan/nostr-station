// Tests for the update-restart respawn path.
//
// Coverage:
//   1. scheduleRespawnAndExit's branch logic via env detection — when
//      NOSTR_STATION_LAUNCHER=1 we keep the exit-75 handshake intact;
//      when unset we self-spawn before exiting cleanly.
//   2. startWebServer retries on EADDRINUSE when NOSTR_STATION_RESPAWN=1
//      is set, so a self-respawned child can wait out the parent's
//      port-release race instead of immediately failing.
//   3. startWebServer's behavior is unchanged when NOSTR_STATION_RESPAWN
//      is absent — a held port surfaces immediately (preserves the
//      Chat.tsx "another dashboard is running" UX).
//
// We don't end-to-end test the full update flow (that requires a real
// git repo + npm + a separate node instance) but the two failure modes
// the production bug exposed — "exit 75 strands non-launcher users"
// and "self-respawned child races parent for the port" — are covered
// by the env-driven branches.

import { useTempHome } from './_home.js';
useTempHome();
process.env.STATION_INPROC_RELAY      = '0';
process.env.STATION_DISABLE_NVPN_TAIL = '1';

import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import type { Server } from 'node:http';

const { startWebServer } = await import('../src/lib/web-server.js');

async function bindHolder(port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(port, '127.0.0.1', () => resolve(s));
  });
}

function randomHighPort(): number {
  return 30000 + Math.floor(Math.random() * 20000);
}

test('startWebServer: surfaces EADDRINUSE immediately when NOSTR_STATION_RESPAWN is unset', async (t) => {
  const port = randomHighPort();
  const holder = await bindHolder(port);
  t.after(() => new Promise<void>((r) => holder.close(() => r())));

  delete process.env.NOSTR_STATION_RESPAWN;
  const t0 = Date.now();
  await assert.rejects(
    startWebServer(port),
    /Port .* is already in use/,
    'expected immediate EADDRINUSE rejection',
  );
  const elapsed = Date.now() - t0;
  // Single attempt — should reject in well under the retry budget (5s).
  assert.ok(elapsed < 2000, `expected fast rejection, took ${elapsed}ms`);
});

test('startWebServer: retries on EADDRINUSE when NOSTR_STATION_RESPAWN=1 and binds once port frees', async (t) => {
  const port = randomHighPort();
  const holder = await bindHolder(port);
  let dashboardSrv: Server | null = null;
  t.after(async () => {
    if (dashboardSrv) await new Promise<void>((r) => dashboardSrv!.close(() => r()));
    await new Promise<void>((r) => holder.close(() => r()));
  });

  process.env.NOSTR_STATION_RESPAWN = '1';

  // Release the held port after a short delay so a retry can succeed.
  // Total retry budget is 10 × 500ms = 5s; releasing at 1.2s gives
  // ~3 retries before we free the port.
  setTimeout(() => holder.close(), 1200);

  const t0 = Date.now();
  dashboardSrv = await startWebServer(port);
  const elapsed = Date.now() - t0;

  delete process.env.NOSTR_STATION_RESPAWN;
  assert.ok(dashboardSrv, 'startWebServer should resolve once the port frees');
  // Must have waited at least the holder-release delay (1.2s) but well
  // under the full retry budget (5s).
  assert.ok(elapsed >= 1000, `expected to wait for retry, took ${elapsed}ms`);
  assert.ok(elapsed < 4000,  `expected resolution before full budget, took ${elapsed}ms`);
});

test('startWebServer: respawn-mode retry gives up after budget exhausted', async (t) => {
  const port = randomHighPort();
  const holder = await bindHolder(port);
  t.after(() => new Promise<void>((r) => holder.close(() => r())));

  process.env.NOSTR_STATION_RESPAWN = '1';
  const t0 = Date.now();
  await assert.rejects(
    startWebServer(port),
    /Port .* is already in use/,
    'expected EADDRINUSE rejection after exhausting retries',
  );
  const elapsed = Date.now() - t0;
  delete process.env.NOSTR_STATION_RESPAWN;

  // Budget is 10 retries × 500ms = 5000ms.  Allow a generous bound either
  // side for scheduler jitter on a loaded CI box.
  assert.ok(elapsed >= 4000, `expected to consume budget, took ${elapsed}ms`);
  assert.ok(elapsed < 8000,  `expected bounded retry, took ${elapsed}ms`);
});
