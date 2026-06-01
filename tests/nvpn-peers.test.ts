import test from 'node:test';
import assert from 'node:assert/strict';
import { mergePeers, npubToHex } from '../src/web/nvpn-peers.js';
import { hexToNpub } from '../src/lib/identity.ts';

// Synthetic keypairs only — minted from the (tested) backend encoder so we
// never put a real mesh key in the repo.
const HEX = {
  a: '11'.repeat(32),
  b: '22'.repeat(32),
  c: '33'.repeat(32),
};
const NPUB = {
  a: hexToNpub(HEX.a),
  b: hexToNpub(HEX.b),
  c: hexToNpub(HEX.c),
};

test('npubToHex: passes through 64-char hex unchanged (lowercased)', () => {
  assert.equal(npubToHex(HEX.a), HEX.a);
  assert.equal(npubToHex(HEX.a.toUpperCase()), HEX.a);
});

test('npubToHex: decodes npub back to its hex (round-trips the backend encoder)', () => {
  assert.equal(npubToHex(NPUB.a), HEX.a);
  assert.equal(npubToHex(NPUB.b), HEX.b);
  assert.equal(npubToHex(NPUB.c), HEX.c);
});

test('npubToHex: rejects junk', () => {
  for (const j of ['', 'nope', 'npub1', 'npub1zzz', 'deadbeef', null as any, 42 as any]) {
    assert.equal(npubToHex(j), null, String(j));
  }
});

test('mergePeers: a rostered peer that is ALSO discovered renders as ONE row (the bug)', () => {
  // Roster stores npub; the daemon discovers the SAME peer by hex + IP.
  const roster = [NPUB.a];
  const live = [{ pubkey: HEX.a, ip: '10.0.0.5', connected: true }];
  const rows = mergePeers(roster, [], live, {});
  assert.equal(rows.length, 1, 'one row, not two');
  const r = rows[0];
  assert.equal(r.roster, true);
  assert.equal(r.live?.ip, '10.0.0.5', 'discovery folded into the roster row');
  assert.equal(r.connected, true, 'real online status, not "never seen"');
});

test('mergePeers: rostered peer with no live entry → never-seen shape (one row, live null)', () => {
  const rows = mergePeers([NPUB.b], [], [], {});
  assert.equal(rows.length, 1);
  assert.equal(rows[0].roster, true);
  assert.equal(rows[0].live, null);
  assert.equal(rows[0].connected, false);
});

test('mergePeers: a discovered peer NOT in the roster keeps its own row', () => {
  const rows = mergePeers([NPUB.a], [], [
    { pubkey: HEX.a, ip: '10.0.0.5', connected: true },
    { pubkey: HEX.c, ip: '10.0.0.9', connected: false },
  ], {});
  assert.equal(rows.length, 2);
  const discovered = rows.find(r => !r.roster);
  assert.ok(discovered && npubToHex(discovered.live.pubkey) === HEX.c);
});

test('mergePeers: two live entries for the same IP collapse to one discovered row', () => {
  const rows = mergePeers([], [], [
    { pubkey: HEX.a, ip: '10.0.0.7', connected: true },          // raw entry
    { npub: NPUB.b, ip: '10.0.0.7', connected: false },          // FIPS-overlay entry, same node/IP
  ], {});
  assert.equal(rows.length, 1, 'deduped by tunnel IP');
});

test('mergePeers: admin flag + alias resolve across npub/hex encodings', () => {
  const rows = mergePeers([NPUB.a], [NPUB.a], [{ pubkey: HEX.a, ip: '10.0.0.5', connected: true }], { [NPUB.a]: 'laptop' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].admin, true);
  assert.equal(rows[0].alias, 'laptop');
});

test('mergePeers: total rows = unique peers (4 peers as npub+hex pairs → 4 rows, not 8)', () => {
  const roster = [NPUB.a, NPUB.b, NPUB.c];
  const live = [
    { pubkey: HEX.a, ip: '10.0.0.1', connected: true },
    { pubkey: HEX.b, ip: '10.0.0.2', connected: false },
    { pubkey: HEX.c, ip: '10.0.0.3', connected: true },
  ];
  assert.equal(mergePeers(roster, [], live, {}).length, 3);
});
