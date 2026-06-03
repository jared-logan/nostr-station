/**
 * Tests for isRelayTargetEligible() (#279) — gates the "relay via" action on
 * presence recency (last_mesh_seen_at) rather than handshake history, so the
 * action shows only for online-but-unreachable peers (NAT-blocked), not
 * genuinely-OFF peers. Shared pure module (src/web/relay-eligibility.js).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { isRelayTargetEligible, PRESENCE_FRESH_SECS } from '../src/web/relay-eligibility.js';
import { analyzeMeshPeers } from '../src/lib/nvpn-mesh-health.ts';
import { daemonStatePeers } from './fixtures/nvpn-mesh-peers.ts';

const NOW = 1700000400; // aligns with the fixture's freshest timestamps

test('reachable peers are never relay targets', () => {
  assert.equal(isRelayTargetEligible({ reachable: true, lastMeshSeenAt: NOW }, NOW), false);
});

test('unreachable + recent presence ⇒ eligible (online, NAT-blocked)', () => {
  assert.equal(isRelayTargetEligible({ reachable: false, lastMeshSeenAt: NOW - 10 }, NOW), true);
});

test('unreachable + stale presence ⇒ not eligible (offline)', () => {
  assert.equal(isRelayTargetEligible({ reachable: false, lastMeshSeenAt: NOW - 300 }, NOW), false);
});

test('unreachable + zero/null/absent presence ⇒ not eligible', () => {
  assert.equal(isRelayTargetEligible({ reachable: false, lastMeshSeenAt: 0 }, NOW), false);
  assert.equal(isRelayTargetEligible({ reachable: false, lastMeshSeenAt: null }, NOW), false);
  assert.equal(isRelayTargetEligible({ reachable: false }, NOW), false);
});

test('freshness boundary is PRESENCE_FRESH_SECS (exclusive)', () => {
  assert.equal(isRelayTargetEligible({ reachable: false, lastMeshSeenAt: NOW - (PRESENCE_FRESH_SECS - 1) }, NOW), true);
  assert.equal(isRelayTargetEligible({ reachable: false, lastMeshSeenAt: NOW - PRESENCE_FRESH_SECS }, NOW), false);
});

test('null/garbage peer ⇒ not eligible, no throw', () => {
  for (const bad of [null, undefined, {}, 42]) {
    assert.equal(isRelayTargetEligible(bad as any, NOW), false);
  }
});

// Integration with the analyzer output + the ground-truth fixture:
test('fixture: recent-unreachable peer eligible, offline (0) peer not', () => {
  const { peers } = analyzeMeshPeers(daemonStatePeers);
  const byPk = (c: string) => peers.find(p => p.pubkey === c.repeat(64))!;
  // peer c: unreachable, last_mesh_seen_at 1700000350 (recent at NOW) → eligible
  assert.equal(byPk('c').lastMeshSeenAt, 1700000350);
  assert.equal(isRelayTargetEligible(byPk('c'), NOW), true);
  // peer d: unreachable, last_mesh_seen_at 0 → offline → not eligible
  assert.equal(byPk('d').lastMeshSeenAt, 0);
  assert.equal(isRelayTargetEligible(byPk('d'), NOW), false);
  // reachable peers a/b never eligible
  assert.equal(isRelayTargetEligible(byPk('a'), NOW), false);
  assert.equal(isRelayTargetEligible(byPk('b'), NOW), false);
});
