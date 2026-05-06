import test from 'node:test';
import assert from 'node:assert/strict';
import { nvpnRowStateFor } from '../src/lib/nvpn.ts';

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
