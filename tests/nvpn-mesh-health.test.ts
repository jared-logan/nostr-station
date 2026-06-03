/**
 * Tests for analyzeMeshPeers() — per-peer mesh reachability (#256, Phase-2
 * Layer-2 item 2.1). Pure over the detailed status.daemon.state.peers[] shape;
 * driven by the ground-truth fixture (synthetic values).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeMeshPeers, relayCandidates, pickBestRelay } from '../src/lib/nvpn-mesh-health.ts';
import { daemonStatePeers } from './fixtures/nvpn-mesh-peers.ts';

test('classifies the full reachability spectrum from the ground-truth fixture', () => {
  const { peers, counts } = analyzeMeshPeers(daemonStatePeers);
  assert.equal(peers.length, 4);

  // 1) reachable, direct UDP
  assert.deepEqual(
    { reachable: peers[0].reachable, path: peers[0].path, state: peers[0].state,
      latencyMs: peers[0].latencyMs, transportType: peers[0].transportType },
    { reachable: true, path: 'direct', state: 'up', latencyMs: 8, transportType: 'udp' },
  );
  // 2) reachable, relayed — srtt 0 ⇒ latency null; no transport type on a relay
  assert.deepEqual(
    { reachable: peers[1].reachable, path: peers[1].path, state: peers[1].state,
      latencyMs: peers[1].latencyMs, transportType: peers[1].transportType },
    { reachable: true, path: 'relayed', state: 'up', latencyMs: null, transportType: null },
  );
  // 3) unreachable, pending (handshook before; "fips link pending")
  assert.equal(peers[2].reachable, false);
  assert.equal(peers[2].path, 'none');           // no runtime_endpoint field
  assert.equal(peers[2].state, 'pending');       // last_handshake_at non-null
  assert.equal(peers[2].detail, 'fips link pending');
  // 4) unreachable, never handshook
  assert.equal(peers[3].reachable, false);
  assert.equal(peers[3].state, 'never');         // last_handshake_at null
  assert.equal(peers[3].lastHandshakeAt, null);

  assert.deepEqual(counts, { total: 4, reachable: 2, direct: 1, relayed: 1, unreachable: 2 });
});

test('sources the pubkey from participant_pubkey, never the empty node_id', () => {
  const { peers } = analyzeMeshPeers(daemonStatePeers);
  assert.equal(peers[0].pubkey, 'a'.repeat(64));
  assert.ok(peers.every(p => p.pubkey.length === 64));
});

test('strips the CIDR from tunnel_ip', () => {
  assert.equal(analyzeMeshPeers(daemonStatePeers).peers[0].tunnelIp, '10.44.0.5');
});

test('runtime_endpoint ip:port → direct, "fips" → relayed, absent → none', () => {
  const r = analyzeMeshPeers([
    { participant_pubkey: 'a'.repeat(64), runtime_endpoint: '198.51.100.9:51820', reachable: true },
    { participant_pubkey: 'b'.repeat(64), runtime_endpoint: 'fips', reachable: true },
    { participant_pubkey: 'c'.repeat(64), reachable: false },
  ]);
  assert.deepEqual(r.peers.map(p => p.path), ['direct', 'relayed', 'none']);
});

test('prefers a 64-hex participant_pubkey but falls back gracefully', () => {
  // If participant_pubkey is somehow non-hex but public_key holds the pubkey.
  const r = analyzeMeshPeers([
    { participant_pubkey: 'box.nvpn', public_key: 'e'.repeat(64), reachable: true, runtime_endpoint: 'fips' },
  ]);
  assert.equal(r.peers[0].pubkey, 'e'.repeat(64));
});

test('latency only when srtt is a positive measurement', () => {
  const r = analyzeMeshPeers([
    { participant_pubkey: 'a'.repeat(64), fips_srtt_ms: 0,  reachable: true, runtime_endpoint: 'fips' },
    { participant_pubkey: 'b'.repeat(64), fips_srtt_ms: 12, reachable: true, runtime_endpoint: '192.0.2.5:51820' },
  ]);
  assert.equal(r.peers[0].latencyMs, null);
  assert.equal(r.peers[1].latencyMs, 12);
});

// (#257) relay-through candidates
test('endpoint is the direct ip:port, null for relayed/none', () => {
  const { peers } = analyzeMeshPeers(daemonStatePeers);
  assert.equal(peers[0].endpoint, '192.0.2.20:51820'); // direct
  assert.equal(peers[1].endpoint, null);               // relayed
  assert.equal(peers[2].endpoint, null);               // none
});

test('relayCandidates = reachable + direct + endpoint; pickBestRelay = lowest latency', () => {
  const report = analyzeMeshPeers([
    { participant_pubkey: 'a'.repeat(64), reachable: true,  runtime_endpoint: '192.0.2.20:51820', fips_srtt_ms: 30 },
    { participant_pubkey: 'b'.repeat(64), reachable: true,  runtime_endpoint: '192.0.2.21:51820', fips_srtt_ms: 9 },
    { participant_pubkey: 'c'.repeat(64), reachable: true,  runtime_endpoint: 'fips' },              // relayed — not a candidate
    { participant_pubkey: 'd'.repeat(64), reachable: false, runtime_endpoint: '192.0.2.22:51820' }, // unreachable — not a candidate
  ]);
  const cands = relayCandidates(report);
  assert.deepEqual(cands.map(c => c.pubkey), ['a'.repeat(64), 'b'.repeat(64)]);
  assert.equal(pickBestRelay(report).pubkey, 'b'.repeat(64)); // 9ms < 30ms
});

test('pickBestRelay returns null when there are no eligible candidates', () => {
  const report = analyzeMeshPeers([
    { participant_pubkey: 'a'.repeat(64), reachable: true, runtime_endpoint: 'fips' },
    { participant_pubkey: 'b'.repeat(64), reachable: false, runtime_endpoint: '192.0.2.20:51820' },
  ]);
  assert.equal(relayCandidates(report).length, 0);
  assert.equal(pickBestRelay(report), null);
});

test('defensive — non-array / junk input yields an empty report, no throw', () => {
  for (const bad of [null, undefined, 42, 'nope', {}]) {
    const r = analyzeMeshPeers(bad);
    assert.deepEqual(r.peers, []);
    assert.equal(r.counts.total, 0);
  }
  // non-object array entries are skipped
  assert.equal(analyzeMeshPeers([null, 1, 'x']).peers.length, 0);
});
