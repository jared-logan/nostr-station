import test from 'node:test';
import assert from 'node:assert/strict';
import { clampInt, isSettableNvpnKey } from '../src/lib/nvpn.ts';

// ── clampInt ──────────────────────────────────────────────────────────

test('clampInt: in-range value returns floor', () => {
  assert.equal(clampInt(3, 1, 10, 5), 3);
  assert.equal(clampInt(3.7, 1, 10, 5), 3);  // floor, not round
});

test('clampInt: clamps to bounds', () => {
  assert.equal(clampInt(0, 1, 10, 5), 1);
  assert.equal(clampInt(99, 1, 10, 5), 10);
});

test('clampInt: non-numeric returns fallback', () => {
  assert.equal(clampInt('abc', 1, 10, 5), 5);
  assert.equal(clampInt(undefined, 1, 10, 5), 5);
  assert.equal(clampInt(null, 1, 10, 5), 5);
  assert.equal(clampInt(NaN, 1, 10, 5), 5);
  assert.equal(clampInt(Infinity, 1, 10, 5), 5);
});

test('clampInt: numeric strings are accepted', () => {
  assert.equal(clampInt('7', 1, 10, 5), 7);
});

// ── isSettableNvpnKey ─────────────────────────────────────────────────

test('isSettableNvpnKey: known nvpn-set keys', () => {
  // Curated subset of `nvpn set --<key>` flags. Add cases here when the
  // allowlist grows in src/lib/nvpn.ts.
  for (const k of ['node-name', 'listen-port', 'autoconnect',
                   'advertise-exit-node', 'advertise-routes',
                   'relay-for-others', 'magic-dns-suffix', 'tunnel-ip',
                   'endpoint', 'exit-node', 'provide-nat-assist',
                   'network-id']) {
    assert.equal(isSettableNvpnKey(k), true, `expected ${k} to be settable`);
  }
});

test('isSettableNvpnKey: unknown / dangerous keys are rejected', () => {
  // Things we don't allow the dashboard to mutate via /api/nvpn/set:
  assert.equal(isSettableNvpnKey('private-key'), false);
  assert.equal(isSettableNvpnKey('secret-key'),  false);
  assert.equal(isSettableNvpnKey('config'),      false);
  assert.equal(isSettableNvpnKey(''),            false);
  // Underscore form (TOML key) — must use the kebab-case CLI flag form.
  assert.equal(isSettableNvpnKey('node_name'),   false);
});
