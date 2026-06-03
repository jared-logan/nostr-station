import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureNodeTunnelIp } from '../src/lib/nvpn.ts';

// P0: join wrote network_id but never the node's tunnel_ip, so a fresh node
// stayed on the pre-join placeholder (10.44.0.1) and was "online" at an
// unroutable address. ensureNodeTunnelIp sets the deterministic value.
// Synthetic IPs only.

const PLACEHOLDER = '10.44.0.1';
const WANT = '10.44.123.45';

test('ensureNodeTunnelIp: rewrites the placeholder, leaving other fields byte-identical', () => {
  const toml = `[node]\nprivate_key = "secret"\ntunnel_ip = "${PLACEHOLDER}"\nlisten_port = 51820\n\n[[networks]]\nnetwork_id = "abc"\n`;
  const r = ensureNodeTunnelIp(toml, WANT);
  assert.equal(r.changed, true);
  assert.equal(r.from, PLACEHOLDER);
  assert.match(r.toml, new RegExp(`tunnel_ip = "${WANT.replace(/\./g, '\\.')}"`));
  assert.equal(r.toml.includes(PLACEHOLDER), false);
  assert.match(r.toml, /private_key = "secret"/);     // untouched
  assert.match(r.toml, /listen_port = 51820/);        // untouched
  assert.match(r.toml, /network_id = "abc"/);         // untouched
});

test('ensureNodeTunnelIp: no-op when already the deterministic value', () => {
  const toml = `[node]\ntunnel_ip = "${WANT}"\n`;
  const r = ensureNodeTunnelIp(toml, WANT);
  assert.equal(r.changed, false);
  assert.equal(r.from, null);
  assert.equal(r.toml, toml);
});

test('ensureNodeTunnelIp: inserts the line when [node] has no tunnel_ip', () => {
  const toml = `[node]\nprivate_key = "secret"\n\n[stun]\nenabled = true\n`;
  const r = ensureNodeTunnelIp(toml, WANT);
  assert.equal(r.changed, true);
  assert.equal(r.from, null);
  assert.match(r.toml, new RegExp(`\\[node\\]\\ntunnel_ip = "${WANT.replace(/\./g, '\\.')}"`));
  assert.match(r.toml, /private_key = "secret"/);
  assert.match(r.toml, /\[stun\]\nenabled = true/);   // adjacent section intact
});

test('ensureNodeTunnelIp: leaves config untouched when there is no [node] table', () => {
  const toml = `[[networks]]\nnetwork_id = "abc"\n`;
  const r = ensureNodeTunnelIp(toml, WANT);
  assert.equal(r.changed, false);
  assert.equal(r.toml, toml);
});
