import test from 'node:test';
import assert from 'node:assert/strict';
import { clampInt, isSettableNvpnKey, renderLinuxCapsDropIn } from '../src/lib/nvpn.ts';

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
                   'relay-for-others', 'magic-dns-suffix',
                   'magic-dns-port', 'tunnel-ip',
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

// ── renderLinuxCapsDropIn ─────────────────────────────────────────────
// The drop-in is what lets the nvpn daemon flush the kernel route cache
// (CAP_DAC_OVERRIDE for /proc/sys/net/ipv4/route/flush) and run its NAT
// probes (CAP_NET_RAW) without surfacing permission-denied lines in the
// log panel on every connect. Pin the systemd-readable shape so a stray
// edit doesn't break the unit silently.

test('renderLinuxCapsDropIn: contains [Service] section header', () => {
  assert.match(renderLinuxCapsDropIn(), /^\[Service\]$/m);
});

test('renderLinuxCapsDropIn: grants the three caps nvpn needs', () => {
  const out = renderLinuxCapsDropIn();
  for (const cap of ['CAP_NET_ADMIN', 'CAP_DAC_OVERRIDE', 'CAP_NET_RAW']) {
    assert.match(out, new RegExp(`AmbientCapabilities=[^\\n]*${cap}`),
                 `AmbientCapabilities missing ${cap}`);
    assert.match(out, new RegExp(`CapabilityBoundingSet=[^\\n]*${cap}`),
                 `CapabilityBoundingSet missing ${cap}`);
  }
});

test('renderLinuxCapsDropIn: ends with a newline (systemd-friendly)', () => {
  assert.ok(renderLinuxCapsDropIn().endsWith('\n'),
            'drop-in must end with a newline');
});
