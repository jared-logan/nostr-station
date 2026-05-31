import test from 'node:test';
import assert from 'node:assert/strict';
import {
  planNvpnRepair,
  extractAllNetworksSections,
  extractTomlString,
} from '../src/lib/nvpn.ts';
import { computeNvpnTunnelIp } from '../src/lib/nvpn-diagnostics.ts';

// All network ids / pubkeys here are SYNTHETIC. The IP formula is pure
// SHA256 and doesn't validate inputs, so fabricated values exercise the
// same path — no real mesh data in the repo.
const HEX = '33'.repeat(32);
const CORRECT_IP = computeNvpnTunnelIp('aabbccdd', HEX); // 10.44.68.227

function networkIds(toml: string): (string | null)[] {
  return extractAllNetworksSections(toml).map(s => extractTomlString(s, 'network_id'));
}

test('planNvpnRepair: no networks → not needed', () => {
  const p = planNvpnRepair('[nat]\nenabled = true\n', null);
  assert.equal(p.needed, false);
  assert.equal(p.newToml, null);
});

test('planNvpnRepair: single canonical network, nothing stale → not needed', () => {
  const toml = `[[networks]]
network_id = "aabbccdd"
participants = ["x"]
relays = []
`;
  const p = planNvpnRepair(toml, HEX);
  assert.equal(p.needed, false);
});

test('planNvpnRepair: forked duplicate → keep canonical survivor, drop the other', () => {
  const toml = `[[networks]]
network_id = "aabbccdd"
participants = ["x", "y"]
relays = ["wss://keep/"]

[[networks]]
network_id = "aabb-ccdd"
participants = []
relays = ["wss://drop/"]

[nat]
enabled = true
`;
  const p = planNvpnRepair(toml, null);
  assert.equal(p.needed, true);
  assert.deepEqual(p.removedNetworkIds, ['aabb-ccdd']);
  // Exactly one network remains, and it's the canonical one.
  assert.deepEqual(networkIds(p.newToml!), ['aabbccdd']);
  assert.match(p.newToml!, /wss:\/\/keep\//);
  assert.equal(p.newToml!.includes('wss://drop/'), false);
  // Non-network table preserved.
  assert.match(p.newToml!, /\[nat\][\s\S]*enabled = true/);
});

test('planNvpnRepair: non-canonical single active → rename to canonical', () => {
  const toml = `[[networks]]
network_id = "aabb-ccdd"
participants = ["x"]
relays = []
`;
  const p = planNvpnRepair(toml, null);
  assert.equal(p.needed, true);
  assert.deepEqual(p.renamedActiveId, { from: 'aabb-ccdd', to: 'aabbccdd' });
  assert.deepEqual(networkIds(p.newToml!), ['aabbccdd']);
});

test('planNvpnRepair: forked with active = the hyphenated block → reorder canonical first', () => {
  const toml = `[[networks]]
network_id = "aabb-ccdd"
participants = []
relays = []

[[networks]]
network_id = "aabbccdd"
participants = ["x", "y"]
relays = []
`;
  const p = planNvpnRepair(toml, null);
  assert.equal(p.needed, true);
  assert.deepEqual(p.removedNetworkIds, ['aabb-ccdd']);
  // Canonical survivor is the sole, active (first) network.
  assert.deepEqual(networkIds(p.newToml!), ['aabbccdd']);
});

test('planNvpnRepair: re-pins a stale explicit tunnel_ip override', () => {
  const toml = `[[networks]]
network_id = "aabbccdd"
tunnel_ip = "10.44.9.9"
participants = ["x"]
relays = []
`;
  const p = planNvpnRepair(toml, HEX);
  assert.equal(p.needed, true);
  assert.deepEqual(p.ipRepin, { from: '10.44.9.9', to: CORRECT_IP });
  assert.match(p.newToml!, new RegExp(`tunnel_ip = "${CORRECT_IP.replace(/\./g, '\\.')}"`));
  assert.equal(p.newToml!.includes('10.44.9.9'), false);
});

test('planNvpnRepair: correct tunnel_ip is left untouched', () => {
  const toml = `[[networks]]
network_id = "aabbccdd"
tunnel_ip = "${CORRECT_IP}"
participants = ["x"]
relays = []
`;
  const p = planNvpnRepair(toml, HEX);
  assert.equal(p.needed, false);
});

test('planNvpnRepair: no pubkey → cannot re-pin (leaves tunnel_ip alone)', () => {
  const toml = `[[networks]]
network_id = "aabbccdd"
tunnel_ip = "10.44.9.9"
participants = ["x"]
relays = []
`;
  const p = planNvpnRepair(toml, null);
  assert.equal(p.needed, false);
  assert.equal(p.ipRepin, null);
});

test('planNvpnRepair: combined fork + non-canonical + re-pin in one plan', () => {
  const toml = `[[networks]]
network_id = "aabb-ccdd"
tunnel_ip = "10.44.9.9"
participants = ["x", "y"]

[[networks]]
network_id = "ffeeddcc"
participants = ["z"]
`;
  const p = planNvpnRepair(toml, HEX);
  assert.equal(p.needed, true);
  // active hyphenated id renamed to canonical
  assert.deepEqual(p.renamedActiveId, { from: 'aabb-ccdd', to: 'aabbccdd' });
  // stale IP repinned
  assert.deepEqual(p.ipRepin, { from: '10.44.9.9', to: CORRECT_IP });
  // both networks survive (different canonicals), active first
  assert.deepEqual(networkIds(p.newToml!), ['aabbccdd', 'ffeeddcc']);
  assert.ok(p.summary.length >= 2);
});
