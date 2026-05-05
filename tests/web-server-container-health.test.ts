import { test } from 'node:test';
import assert from 'node:assert/strict';

// web-server.ts has top-level imports that resolve homedir-relative paths
// at load time (e.g. log-path defaults). Tests for the pure helper still
// work because we only call serviceHealthForContainer() with injected
// inputs — no I/O happens inside the helper.
// @ts-expect-error — runtime import of .ts; tsx handles the resolution
import { serviceHealthForContainer } from '../src/lib/web-server.ts';

const NOW = 1_700_000_000_000;

const baseInputs = {
  service:        'relay' as 'relay' | 'watchdog' | 'vpn',
  relayUp:        false,
  heartbeatMtime: null as number | null,
  now:            NOW,
  logPath:        '/var/log/nostr-station/relay.log',
  logExists:      false,
  logMtimeMs:     null as number | null,
};

test('relay: installed=true unconditionally; running mirrors relayUp', () => {
  const up   = serviceHealthForContainer({ ...baseInputs, relayUp: true });
  const down = serviceHealthForContainer({ ...baseInputs, relayUp: false });
  assert.equal(up.installed,   true);
  assert.equal(up.running,     true);
  assert.equal(down.installed, true);
  assert.equal(down.running,   false);
});

test('watchdog: running follows heartbeat freshness (10-min window)', () => {
  const fresh = serviceHealthForContainer({
    ...baseInputs, service: 'watchdog', heartbeatMtime: NOW - 5 * 60 * 1000,
  });
  const stale = serviceHealthForContainer({
    ...baseInputs, service: 'watchdog', heartbeatMtime: NOW - 11 * 60 * 1000,
  });
  const missing = serviceHealthForContainer({
    ...baseInputs, service: 'watchdog', heartbeatMtime: null,
  });
  assert.equal(fresh.installed,   true);
  assert.equal(fresh.running,     true);
  assert.equal(stale.running,     false);
  assert.equal(missing.running,   false);
});

test('watchdog: 10-min boundary is inclusive (matches Status panel)', () => {
  // status-container-mode.test.ts pins the same boundary; if these drift
  // the dashboard will disagree with itself across surfaces.
  const onBoundary = serviceHealthForContainer({
    ...baseInputs, service: 'watchdog', heartbeatMtime: NOW - 10 * 60 * 1000,
  });
  assert.equal(onBoundary.running, true);
});

test('vpn: collapses to installed=false, running=false (n/a in container)', () => {
  const r = serviceHealthForContainer({ ...baseInputs, service: 'vpn' });
  assert.equal(r.installed, false);
  assert.equal(r.running,   false);
});

test('watchdog: stale flag fires when log mtime is older than threshold', () => {
  // STALE_MS for watchdog is 10 min; relay/vpn have no threshold and
  // should never be marked stale via mtime.
  const oldLog = serviceHealthForContainer({
    ...baseInputs,
    service:        'watchdog',
    heartbeatMtime: NOW - 60 * 1000,        // running
    logExists:      true,
    logMtimeMs:     NOW - 11 * 60 * 1000,   // log silent for >10 min
  });
  assert.equal(oldLog.running, true);
  assert.equal(oldLog.stale,   true);

  const freshLog = serviceHealthForContainer({
    ...baseInputs,
    service:        'watchdog',
    heartbeatMtime: NOW - 60 * 1000,
    logExists:      true,
    logMtimeMs:     NOW - 60 * 1000,
  });
  assert.equal(freshLog.stale, false);
});

test('relay: stale flag is never set (no STALE_MS threshold for relay)', () => {
  const r = serviceHealthForContainer({
    ...baseInputs,
    service:    'relay',
    relayUp:    true,
    logExists:  true,
    logMtimeMs: NOW - 24 * 60 * 60 * 1000,  // a day old
  });
  assert.equal(r.running, true);
  assert.equal(r.stale,   false);
});

test('logPath / logExists / logMtimeMs pass through unchanged', () => {
  const r = serviceHealthForContainer({
    ...baseInputs,
    service:    'relay',
    relayUp:    true,
    logPath:    '/tmp/custom/relay.log',
    logExists:  true,
    logMtimeMs: NOW - 1000,
  });
  assert.equal(r.logPath,    '/tmp/custom/relay.log');
  assert.equal(r.logExists,  true);
  assert.equal(r.logMtimeMs, NOW - 1000);
});

test('service field round-trips on the result', () => {
  for (const service of ['relay', 'watchdog', 'vpn'] as const) {
    const r = serviceHealthForContainer({ ...baseInputs, service });
    assert.equal(r.service, service);
  }
});
