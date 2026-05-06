import test from 'node:test';
import assert from 'node:assert/strict';
import { nvpnStateFor, watchdogStateFor } from '../src/commands/Status.tsx';

test('nvpnStateFor: binary missing → err / not installed', () => {
  const r = nvpnStateFor({ binPresent: false, meshIp: null });
  assert.equal(r.state, 'err');
  assert.equal(r.ok, false);
  assert.equal(r.value, 'not installed');
});

test('nvpnStateFor: binary present, no mesh → warn / not connected', () => {
  const r = nvpnStateFor({ binPresent: true, meshIp: null });
  assert.equal(r.state, 'warn');
  assert.equal(r.ok, false);
  assert.equal(r.value, 'not connected');
});

test('nvpnStateFor: binary present + mesh ip → ok / shows ip', () => {
  const r = nvpnStateFor({ binPresent: true, meshIp: '10.42.0.7' });
  assert.equal(r.state, 'ok');
  assert.equal(r.ok, true);
  assert.equal(r.value, '10.42.0.7');
});

test('watchdogStateFor: missing → err / not running', () => {
  const r = watchdogStateFor({ exists: false, ageMs: null });
  assert.equal(r.state, 'err');
  assert.equal(r.value, 'not running');
});

test('watchdogStateFor: fresh (≤7m) → ok', () => {
  const r = watchdogStateFor({ exists: true, ageMs: 4 * 60_000 });
  assert.equal(r.state, 'ok');
  assert.equal(r.ok, true);
  assert.match(r.value, /heartbeat 4m ago/);
});

test('watchdogStateFor: just-now (<1m) renders "just now"', () => {
  const r = watchdogStateFor({ exists: true, ageMs: 5_000 });
  assert.equal(r.state, 'ok');
  assert.equal(r.value, 'heartbeat just now');
});

test('watchdogStateFor: stale (>7m) → warn', () => {
  const r = watchdogStateFor({ exists: true, ageMs: 12 * 60_000 });
  assert.equal(r.state, 'warn');
  assert.equal(r.ok, false);
  assert.match(r.value, /12m ago — stale/);
});

test('watchdogStateFor: exactly at 7m → ok (boundary inclusive)', () => {
  const r = watchdogStateFor({ exists: true, ageMs: 7 * 60_000 });
  assert.equal(r.state, 'ok');
});

test('watchdogStateFor: exactly past 7m → warn', () => {
  const r = watchdogStateFor({ exists: true, ageMs: 7 * 60_000 + 1 });
  assert.equal(r.state, 'warn');
});
