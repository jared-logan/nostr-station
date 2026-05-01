import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import net from 'net';

// No HOME isolation needed — this module is pure aside from the heartbeat
// path, which we control per-test via tmpdir.
// @ts-expect-error — runtime import of .ts; tsx handles the resolution
const { runWatchdogOnce, runWatchdogLoop, checkPort } = await import('../src/lib/watchdog.ts');

function tmpHeartbeat(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nostr-station-watchdog-'));
  return path.join(dir, 'heartbeat');
}

test('runWatchdogOnce: writes heartbeat and reports relay up', async () => {
  const heartbeatPath = tmpHeartbeat();
  const result = await runWatchdogOnce({
    relayHost:     'relay',
    relayPort:     8080,
    heartbeatPath,
    checkPort:     async () => true,
    now:           () => 1_700_000_000_000,
  });
  assert.equal(result.relayUp,   true);
  assert.equal(result.heartbeat, heartbeatPath);
  assert.equal(result.ts,        1_700_000_000_000);

  const body = JSON.parse(fs.readFileSync(heartbeatPath, 'utf8'));
  assert.equal(body.relayUp, true);
  assert.equal(body.ts,      1_700_000_000_000);
});

test('runWatchdogOnce: writes heartbeat even when relay down', async () => {
  const heartbeatPath = tmpHeartbeat();
  const result = await runWatchdogOnce({
    relayHost:     'relay',
    relayPort:     8080,
    heartbeatPath,
    checkPort:     async () => false,
  });
  assert.equal(result.relayUp, false);
  // Heartbeat must land regardless — gatherStatus uses it to know the
  // watchdog itself is alive, separate from whether the relay is.
  assert.equal(fs.existsSync(heartbeatPath), true);
});

test('runWatchdogOnce: creates the heartbeat directory if missing', async () => {
  const dir  = fs.mkdtempSync(path.join(os.tmpdir(), 'nostr-station-watchdog-'));
  const heartbeatPath = path.join(dir, 'nested', 'a', 'b', 'heartbeat');
  await runWatchdogOnce({
    relayHost: 'relay',
    relayPort: 8080,
    heartbeatPath,
    checkPort: async () => true,
  });
  assert.equal(fs.existsSync(heartbeatPath), true);
});

test('runWatchdogOnce: logger receives a single-line summary', async () => {
  const lines: string[] = [];
  await runWatchdogOnce({
    relayHost:     'r',
    relayPort:     8080,
    heartbeatPath: tmpHeartbeat(),
    checkPort:     async () => true,
    logger:        (s) => lines.push(s),
    now:           () => 1_700_000_000_000,
  });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /relay=up/);
  assert.match(lines[0], /r:8080/);
  // Verify the timestamp is emitted in ISO-8601 (durable for log scraping).
  assert.match(lines[0], /^\d{4}-\d{2}-\d{2}T/);
});

test('runWatchdogLoop: aborts mid-sleep on signal', async () => {
  const heartbeatPath = tmpHeartbeat();
  const ac = new AbortController();
  let iterations = 0;
  // 60s interval — only fires once before we abort. Without AbortSignal-aware
  // sleep, the loop would block here for 60s and the test would time out.
  const loopPromise = runWatchdogLoop({
    relayHost:     'r',
    relayPort:     8080,
    heartbeatPath,
    intervalMs:    60_000,
    signal:        ac.signal,
    checkPort:     async () => { iterations++; return true; },
  });
  // Yield once so the first iteration runs, then abort.
  await new Promise((r) => setTimeout(r, 50));
  ac.abort();
  await loopPromise;
  assert.equal(iterations, 1, 'should have completed exactly one iteration before abort');
});

test('runWatchdogLoop: resumes after a logger throw', async () => {
  const heartbeatPath = tmpHeartbeat();
  const ac = new AbortController();
  let iterations = 0;
  // Tiny interval so we get multiple iterations within the test window.
  const loopPromise = runWatchdogLoop({
    relayHost:     'r',
    relayPort:     8080,
    heartbeatPath,
    intervalMs:    10,
    signal:        ac.signal,
    checkPort:     async () => { iterations++; return true; },
    logger:        () => { if (iterations === 1) throw new Error('oops'); },
  });
  await new Promise((r) => setTimeout(r, 100));
  ac.abort();
  await loopPromise;
  // The first iteration's logger throws — the loop should have caught it
  // and continued. We expect more than 1 iteration to have run.
  assert.ok(iterations > 1, `expected loop to continue past throw; got ${iterations}`);
});

test('checkPort: reports up when a TCP listener is bound', async () => {
  const server = net.createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as net.AddressInfo).port;
  try {
    const up = await checkPort('127.0.0.1', port, 1000);
    assert.equal(up, true);
  } finally {
    server.close();
  }
});

test('checkPort: reports down on a port nothing is listening on', async () => {
  // Pick a port unlikely to be in use. Worst case false-positive (something
  // happens to be listening) is benign for this assertion's intent.
  const up = await checkPort('127.0.0.1', 1, 500);
  assert.equal(up, false);
});
