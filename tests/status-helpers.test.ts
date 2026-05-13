// Characterisation tests for the pure helpers in src/commands/Status.tsx
// that gatherStatus() / cli.tsx --json depend on.
//
// The helpers we pin here have no external IO (no execSync, no fs), so they
// test cheaply and cover every documented branch. The wider gatherStatus()
// function shells out to nc / nvpn / binaries on PATH and isn't unit-tested
// — that's covered by status-routes.test.ts at the HTTP layer + the CI
// smoke for `status --json`.

import test from 'node:test';
import assert from 'node:assert/strict';
import { watchdogStateFor, nvpnStateFor, formatStatusJson } from '../src/commands/Status.js';

// ──────────────────────────────────────────────────────────────────────────
// watchdogStateFor
//   missing               → err  · 'not running'
//   present + fresh ≤7m   → ok   · 'heartbeat (just now|Nm ago)'
//   present + stale  >7m  → warn · 'heartbeat Nm ago — stale'
// ──────────────────────────────────────────────────────────────────────────

test('watchdogStateFor: missing heartbeat file → err / not running', () => {
  const r = watchdogStateFor({ exists: false, ageMs: null });
  assert.deepEqual(r, { value: 'not running', state: 'err', ok: false });
});

test('watchdogStateFor: file present but ageMs:null → err / not running', () => {
  const r = watchdogStateFor({ exists: true, ageMs: null });
  assert.deepEqual(r, { value: 'not running', state: 'err', ok: false });
});

test('watchdogStateFor: 0ms ago → ok / heartbeat just now', () => {
  const r = watchdogStateFor({ exists: true, ageMs: 0 });
  assert.equal(r.state, 'ok');
  assert.equal(r.ok, true);
  assert.equal(r.value, 'heartbeat just now');
});

test('watchdogStateFor: 90s ago → ok / heartbeat 1m ago (floor)', () => {
  const r = watchdogStateFor({ exists: true, ageMs: 90_000 });
  assert.equal(r.state, 'ok');
  assert.equal(r.ok, true);
  assert.equal(r.value, 'heartbeat 1m ago');
});

test('watchdogStateFor: exactly 7m boundary → ok (inclusive)', () => {
  const r = watchdogStateFor({ exists: true, ageMs: 7 * 60_000 });
  assert.equal(r.state, 'ok');
  assert.equal(r.ok, true);
  assert.equal(r.value, 'heartbeat 7m ago');
});

test('watchdogStateFor: 1ms past 7m → warn / stale', () => {
  const r = watchdogStateFor({ exists: true, ageMs: 7 * 60_000 + 1 });
  assert.equal(r.state, 'warn');
  assert.equal(r.ok, false);
  assert.equal(r.value, 'heartbeat 7m ago — stale');
});

test('watchdogStateFor: 30m ago → warn / stale', () => {
  const r = watchdogStateFor({ exists: true, ageMs: 30 * 60_000 });
  assert.equal(r.state, 'warn');
  assert.equal(r.ok, false);
  assert.equal(r.value, 'heartbeat 30m ago — stale');
});

// ──────────────────────────────────────────────────────────────────────────
// nvpnStateFor
//   bin missing                              → err  · 'not installed'
//   bin present, daemon not running          → warn · 'not connected'
//   bin present, running, no mesh IP         → warn · 'not connected'
//   bin present, running, mesh IP set        → ok   · <ip>
// ──────────────────────────────────────────────────────────────────────────

test('nvpnStateFor: no binary → err / not installed', () => {
  const r = nvpnStateFor({ binPresent: false, running: false, meshIp: null });
  assert.deepEqual(r, { value: 'not installed', state: 'err', ok: false });
});

test('nvpnStateFor: daemon stopped → warn / not connected (even with stale tunnel IP)', () => {
  // Regression: when the daemon is stopped, `nvpn status --json` can still
  // emit a cached `tunnel_ip` from config. The dashboard must gate on
  // `daemon.running` first, otherwise the SERVICES card flips green while
  // the detail page correctly shows stopped.
  const r = nvpnStateFor({ binPresent: true, running: false, meshIp: '10.44.247.100/32' });
  assert.deepEqual(r, { value: 'not connected', state: 'warn', ok: false });
});

test('nvpnStateFor: binary present, running but no IP → warn / not connected', () => {
  const r = nvpnStateFor({ binPresent: true, running: true, meshIp: null });
  assert.deepEqual(r, { value: 'not connected', state: 'warn', ok: false });
});

test('nvpnStateFor: binary present + running + tunnel IP → ok', () => {
  const r = nvpnStateFor({ binPresent: true, running: true, meshIp: '100.64.0.5' });
  assert.deepEqual(r, { value: '100.64.0.5', state: 'ok', ok: true });
});

test('nvpnStateFor: empty-string IP (running) is treated as missing → warn', () => {
  const r = nvpnStateFor({ binPresent: true, running: true, meshIp: '' });
  assert.equal(r.state, 'warn');
  assert.equal(r.value, 'not connected');
});

// ──────────────────────────────────────────────────────────────────────────
// formatStatusJson
//   keyed by `label`, each value { ok, value }.
//   This is the schema CI's smoke check asserts against (.github/workflows/
//   ci.yml ~line 88-95); pin the shape so any unrelated refactor that
//   accidentally changes it fails locally before it fails CI.
// ──────────────────────────────────────────────────────────────────────────

test('formatStatusJson: shape is { label: { ok, value } }', () => {
  const json = formatStatusJson([
    { id: 'relay',    label: 'Relay',     value: 'ws://127.0.0.1:7777 ✓', ok: true,  state: 'ok',   kind: 'service' },
    { id: 'watchdog', label: 'watchdog',  value: 'not running',           ok: false, state: 'err',  kind: 'service' },
    { id: 'ngit',     label: 'ngit',      value: 'not installed',         ok: false, state: 'err',  kind: 'binary'  },
  ]);
  const parsed = JSON.parse(json);
  assert.deepEqual(parsed, {
    Relay:    { ok: true,  value: 'ws://127.0.0.1:7777 ✓' },
    watchdog: { ok: false, value: 'not running' },
    ngit:     { ok: false, value: 'not installed' },
  });
});

test('formatStatusJson: ignores extra row fields (id/state/kind/plugins)', () => {
  const json = formatStatusJson([
    {
      id: 'claude', label: 'claude-code', value: 'v1.0', ok: true, state: 'ok', kind: 'binary',
      plugins: [{ id: 'wiki@llm-wiki', name: 'llm-wiki', version: null, installed: false, recommended: true }],
    },
  ]);
  const parsed = JSON.parse(json);
  assert.deepEqual(parsed, { 'claude-code': { ok: true, value: 'v1.0' } });
});
