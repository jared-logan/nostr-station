import test from 'node:test';
import assert from 'node:assert/strict';
import { nvpnRowStateFor, vpnBannerRunningFor } from '../src/lib/nvpn.ts';

test('nvpnRowStateFor: not installed → err', () => {
  const r = nvpnRowStateFor({ installed: false, running: false, tunnelIp: null });
  assert.equal(r.state, 'err');
  assert.equal(r.value, 'not installed');
  assert.equal(r.ok, false);
});

test('nvpnRowStateFor: installed, not running → warn', () => {
  const r = nvpnRowStateFor({ installed: true, running: false, tunnelIp: null });
  assert.equal(r.state, 'warn');
  assert.equal(r.value, 'not connected');
});

test('nvpnRowStateFor: running with tunnel ip → ok', () => {
  const r = nvpnRowStateFor({ installed: true, running: true, tunnelIp: '10.42.0.7' });
  assert.equal(r.state, 'ok');
  assert.equal(r.value, '10.42.0.7');
  assert.equal(r.ok, true);
});

test('nvpnRowStateFor: running but no tunnel ip yet → warn', () => {
  // Daemon up but mesh peers haven't connected — distinct from
  // "not connected" so the user sees that the daemon is alive.
  const r = nvpnRowStateFor({ installed: true, running: true, tunnelIp: null });
  assert.equal(r.state, 'warn');
  assert.match(r.value, /no tunnel ip/);
});

// ── vpnBannerRunningFor ─────────────────────────────────────────────────
// Regression: a brief stall on `nvpn status --json` used to flip the
// Logs panel banner to "is installed but not running" even when systemd
// reported the daemon process as alive. Cross-check with the service
// probe rescues the happy-but-slow case.

test('vpnBannerRunningFor: not installed → false', () => {
  assert.equal(
    vpnBannerRunningFor({ installed: false, running: false, error: null }, null),
    false,
  );
});

test('vpnBannerRunningFor: direct probe says running → true', () => {
  assert.equal(
    vpnBannerRunningFor({ installed: true, running: true, error: null }, null),
    true,
  );
});

test('vpnBannerRunningFor: direct probe clean false → false (daemon really stopped)', () => {
  // Probe returned cleanly with daemon.running:false — no error to suggest
  // the answer is uncertain, so we trust it and offer the Start button.
  assert.equal(
    vpnBannerRunningFor({ installed: true, running: false, error: null }, { running: true }),
    false,
  );
});

test('vpnBannerRunningFor: probe errored, service running → true (the bug fix)', () => {
  // Direct probe timed out; systemd/launchd says the process is alive.
  // Don't tell the user to Start — the daemon is up, the socket is just
  // slow. This is the regression case from the field bug report.
  assert.equal(
    vpnBannerRunningFor(
      { installed: true, running: false, error: 'Command timed out after 4000 milliseconds' },
      { running: true },
    ),
    true,
  );
});

test('vpnBannerRunningFor: probe errored, service stopped → false', () => {
  // Both signals agree the daemon is down.
  assert.equal(
    vpnBannerRunningFor(
      { installed: true, running: false, error: 'connect ECONNREFUSED' },
      { running: false },
    ),
    false,
  );
});

test('vpnBannerRunningFor: probe errored, no service info → false', () => {
  // Caller skipped the service probe (e.g. unsupported platform). With
  // only the failed direct probe to go on, we can't claim the daemon is
  // running — fall back to the conservative answer.
  assert.equal(
    vpnBannerRunningFor(
      { installed: true, running: false, error: 'timeout' },
      null,
    ),
    false,
  );
});
