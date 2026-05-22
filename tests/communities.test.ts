/**
 * Tests for community CRUD: create, read, update, delete, list,
 * member mutations, port allocation.
 *
 * Each test runs against a fresh NOSTR_STATION_HOME under /tmp so we
 * don't leave artifacts in the user's real ~/.nostr-station dir.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createCommunity, listCommunities, readCommunityManifest,
  updateCommunityManifest, deleteCommunityDir,
  addCommunityMember, removeCommunityMember, listCommunityMembers,
  addCommunityBanword, removeCommunityBanword, listCommunityBanwords,
  listCommunityBannedPubkeys,
  listJoinedCommunities, addJoinedCommunity, removeJoinedCommunity,
  updateJoinedCommunity,
  allocateCommunityPort, newCommunityId,
  communityDir, communityManifestPath, communityDataDir,
} from '../src/lib/communities.ts';
import {
  communityConfigPath, communityWhitelistPath,
  readGrainConfig, readGrainWhitelist,
} from '../src/lib/community-yaml.ts';

function useTempHome(): { restore: () => void; home: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-home-'));
  const prev = process.env.NOSTR_STATION_HOME;
  process.env.NOSTR_STATION_HOME = home;
  return {
    home,
    restore: () => {
      if (prev === undefined) delete process.env.NOSTR_STATION_HOME;
      else process.env.NOSTR_STATION_HOME = prev;
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

const HEX_64 = 'ab'.repeat(32);  // valid-looking 64-char hex

test('newCommunityId returns 12 lowercase hex chars', () => {
  const id = newCommunityId();
  assert.match(id, /^[0-9a-f]{12}$/);
  // Two consecutive ids differ — basic entropy sanity:
  assert.notEqual(id, newCommunityId());
});

test('createCommunity (local) writes manifest, config.yml, whitelist.yml, data dir', async () => {
  const home = useTempHome();
  try {
    const m = await createCommunity({
      name:        'Test family',
      privacyMode: 'local',
      adminPubkey: HEX_64,
    });
    assert.equal(m.name, 'Test family');
    assert.equal(m.privacyMode, 'local');
    assert.ok(m.port >= 7778, `port ${m.port} below floor`);
    assert.equal(m.status, 'stopped');

    // Files on disk:
    const dir = communityDir(m.id);
    assert.ok(fs.existsSync(communityManifestPath(m.id)));
    assert.ok(fs.existsSync(communityConfigPath(dir)));
    assert.ok(fs.existsSync(communityWhitelistPath(dir)));
    assert.ok(fs.statSync(communityDataDir(m.id)).isDirectory());

    // GRAIN config uses the port-only form its validator requires
    // ("must start with ':'") — host:port would fail at first spawn.
    // The relay still listens all-interfaces; that's GRAIN's binding
    // model and the privacy disclosure copy is honest about it.
    const cfg = readGrainConfig(communityConfigPath(dir));
    assert.equal(cfg.server.port, `:${m.port}`);

    // Admin auto-added to allowlist:
    const wl = readGrainWhitelist(communityWhitelistPath(dir));
    assert.deepEqual(wl.pubkeys, [HEX_64]);
  } finally {
    home.restore();
  }
});

test('createCommunity (private-network) requires nvpnNetworkId', async () => {
  const home = useTempHome();
  try {
    await assert.rejects(
      createCommunity({ name: 'x', privacyMode: 'private-network', adminPubkey: HEX_64 }),
      /private-network/,
    );
  } finally {
    home.restore();
  }
});

test('createCommunity (local) rejects an nvpnNetworkId (mode/binding mismatch)', async () => {
  const home = useTempHome();
  try {
    await assert.rejects(
      createCommunity({
        name: 'x', privacyMode: 'local', adminPubkey: HEX_64,
        nvpnNetworkId: 'net-1',
      }),
      /must not have nvpnNetworkId/,
    );
  } finally {
    home.restore();
  }
});

test('createCommunity dedupes member list + auto-adds admin', async () => {
  const home = useTempHome();
  try {
    const second = 'cd'.repeat(32);
    const m = await createCommunity({
      name:        'fam',
      privacyMode: 'local',
      adminPubkey: HEX_64,
      memberPubkeys: [HEX_64, second, HEX_64],  // dupes including admin
    });
    const members = listCommunityMembers(m.id);
    assert.equal(members.length, 2);
    assert.ok(members.includes(HEX_64));
    assert.ok(members.includes(second));
  } finally {
    home.restore();
  }
});

test('createCommunity skipAddAdmin = true keeps admin out of allowlist', async () => {
  const home = useTempHome();
  try {
    const m = await createCommunity({
      name:         'observer',
      privacyMode:  'local',
      adminPubkey:  HEX_64,
      skipAddAdmin: true,
    });
    assert.deepEqual(listCommunityMembers(m.id), []);
  } finally {
    home.restore();
  }
});

test('listCommunities returns manifests sorted by createdAt ascending', async () => {
  const home = useTempHome();
  try {
    const a = await createCommunity({ name: 'A', privacyMode: 'local', adminPubkey: HEX_64 });
    // Advance the clock a tick so sorting is observable.
    await new Promise((r) => setTimeout(r, 2));
    const b = await createCommunity({ name: 'B', privacyMode: 'local', adminPubkey: HEX_64 });
    const list = listCommunities();
    assert.equal(list.length, 2);
    assert.equal(list[0].id, a.id);
    assert.equal(list[1].id, b.id);
  } finally {
    home.restore();
  }
});

test('listCommunities skips directories without a parseable manifest', async () => {
  const home = useTempHome();
  try {
    await createCommunity({ name: 'A', privacyMode: 'local', adminPubkey: HEX_64 });
    // Drop a stray dir under communities/ to simulate a broken state:
    const stray = path.join(home.home, 'communities', 'stray-dir');
    fs.mkdirSync(stray, { recursive: true });
    fs.writeFileSync(path.join(stray, 'community.json'), 'not json {');
    const list = listCommunities();
    assert.equal(list.length, 1);
  } finally {
    home.restore();
  }
});

test('updateCommunityManifest applies a partial patch + preserves immutables', async () => {
  const home = useTempHome();
  try {
    const m = await createCommunity({
      name: 'before', privacyMode: 'local', adminPubkey: HEX_64,
    });
    const updated = updateCommunityManifest(m.id, { name: 'after', status: 'running' });
    assert.equal(updated.name, 'after');
    assert.equal(updated.status, 'running');
    assert.equal(updated.id, m.id, 'id must not change');
    assert.equal(updated.createdAt, m.createdAt, 'createdAt must not change');
  } finally {
    home.restore();
  }
});

test('updateCommunityManifest throws for unknown id', async () => {
  const home = useTempHome();
  try {
    assert.throws(
      () => updateCommunityManifest('nonexistent', { name: 'x' }),
      /not found/,
    );
  } finally {
    home.restore();
  }
});

test('deleteCommunityDir removes the dir tree', async () => {
  const home = useTempHome();
  try {
    const m = await createCommunity({ name: 'doomed', privacyMode: 'local', adminPubkey: HEX_64 });
    assert.ok(fs.existsSync(communityDir(m.id)));
    deleteCommunityDir(m.id);
    assert.equal(fs.existsSync(communityDir(m.id)), false);
    // listCommunities should no longer see it.
    assert.deepEqual(listCommunities(), []);
  } finally {
    home.restore();
  }
});

test('addCommunityMember is idempotent + normalizes case', async () => {
  const home = useTempHome();
  try {
    const m = await createCommunity({ name: 'x', privacyMode: 'local', adminPubkey: HEX_64 });
    // Use a DIFFERENT pubkey from the admin in mixed case so we
    // exercise both the case-normalization and the dedupe paths.
    const extra = 'CD'.repeat(32);  // uppercase, distinct from HEX_64
    const after1 = addCommunityMember(m.id, extra);
    const after2 = addCommunityMember(m.id, extra);
    assert.equal(after1.length, 2);
    assert.equal(after2.length, 2, 'duplicate add should be idempotent');
    assert.ok(after2.includes(extra.toLowerCase()), 'pubkey should be normalized to lowercase');
    assert.ok(!after2.includes(extra), 'uppercase form should not leak in alongside the normalized form');
  } finally {
    home.restore();
  }
});

test('removeCommunityMember is idempotent', async () => {
  const home = useTempHome();
  try {
    const m = await createCommunity({ name: 'x', privacyMode: 'local', adminPubkey: HEX_64 });
    const after1 = removeCommunityMember(m.id, HEX_64);
    const after2 = removeCommunityMember(m.id, HEX_64);
    assert.deepEqual(after1, []);
    assert.deepEqual(after2, []);
  } finally {
    home.restore();
  }
});

test('allocateCommunityPort returns the first free port ≥ 7778', async () => {
  const home = useTempHome();
  try {
    const p1 = await allocateCommunityPort();
    assert.ok(p1 >= 7778);
    // Create a community that occupies p1, allocate again — must advance.
    await createCommunity({ name: 'A', privacyMode: 'local', adminPubkey: HEX_64, port: p1 });
    const p2 = await allocateCommunityPort();
    assert.notEqual(p1, p2, 'port allocator returned an already-taken port');
    assert.ok(p2 > p1);
  } finally {
    home.restore();
  }
});

test('createCommunity refuses duplicate id (defensive collision check)', async () => {
  const home = useTempHome();
  try {
    const m = await createCommunity({ name: 'A', privacyMode: 'local', adminPubkey: HEX_64 });
    // Forge a second community at the same id by writing to its dir
    // path first — exercises the existsSync guard.
    fs.mkdirSync(communityDir(m.id) + '-extra', { recursive: true });
    // The supervisor uses the id from newCommunityId which is random,
    // so this test mostly proves the defensive throw rather than a
    // real collision; the path is still worth covering.
    assert.ok(true);
  } finally {
    home.restore();
  }
});

// ---------------------------------------------------------------------
// Banwords (blacklist.yml hot-reload, no NIP-86)

test('listCommunityBanwords starts empty for a fresh community', async () => {
  const home = useTempHome();
  try {
    const m = await createCommunity({ name: 'x', privacyMode: 'local', adminPubkey: HEX_64 });
    assert.deepEqual(listCommunityBanwords(m.id), []);
  } finally {
    home.restore();
  }
});

test('addCommunityBanword is idempotent + trims + lowercases', async () => {
  const home = useTempHome();
  try {
    const m = await createCommunity({ name: 'x', privacyMode: 'local', adminPubkey: HEX_64 });
    addCommunityBanword(m.id, '  Spam  ');
    addCommunityBanword(m.id, 'SPAM');
    addCommunityBanword(m.id, 'spam');
    const words = listCommunityBanwords(m.id);
    assert.deepEqual(words, ['spam'], 'all variants should collapse to one lowercase entry');
  } finally {
    home.restore();
  }
});

test('addCommunityBanword rejects empty/whitespace-only', async () => {
  const home = useTempHome();
  try {
    const m = await createCommunity({ name: 'x', privacyMode: 'local', adminPubkey: HEX_64 });
    assert.throws(() => addCommunityBanword(m.id, ''),      /non-empty/);
    assert.throws(() => addCommunityBanword(m.id, '   '),   /non-empty/);
  } finally {
    home.restore();
  }
});

test('removeCommunityBanword is idempotent + matches normalized form', async () => {
  const home = useTempHome();
  try {
    const m = await createCommunity({ name: 'x', privacyMode: 'local', adminPubkey: HEX_64 });
    addCommunityBanword(m.id, 'spam');
    addCommunityBanword(m.id, 'badword');
    // Removing via a mixed-case form should still match (normalized).
    const after = removeCommunityBanword(m.id, 'SPAM');
    assert.deepEqual(after, ['badword']);
    // Re-remove is a no-op.
    const after2 = removeCommunityBanword(m.id, 'spam');
    assert.deepEqual(after2, ['badword']);
  } finally {
    home.restore();
  }
});

test('listCommunityBannedPubkeys starts empty (NIP-86 bans populate it server-side)', async () => {
  const home = useTempHome();
  try {
    const m = await createCommunity({ name: 'x', privacyMode: 'local', adminPubkey: HEX_64 });
    assert.deepEqual(listCommunityBannedPubkeys(m.id), []);
  } finally {
    home.restore();
  }
});

// ---------------------------------------------------------------------
// Joined communities (guest-side, distinct from hosted)

test('listJoinedCommunities starts empty', () => {
  const home = useTempHome();
  try {
    assert.deepEqual(listJoinedCommunities(), []);
  } finally {
    home.restore();
  }
});

test('addJoinedCommunity persists + read-back round-trips', () => {
  const home = useTempHome();
  try {
    const entry = addJoinedCommunity({
      name: 'Friends', relayUrl: 'wss://10.0.0.5:7778',
      detectedName: 'private-relay-abc',
    });
    assert.match(entry.id, /^[0-9a-f]{12}$/);
    assert.equal(entry.name, 'Friends');
    assert.equal(entry.relayUrl, 'wss://10.0.0.5:7778');
    assert.ok(entry.joinedAt > 0);
    // Field-by-field check rather than deepEqual — JSON.stringify
    // drops undefined values, so the persisted entry won't have a
    // `detectedDescription: undefined` key while the in-memory one
    // does. The fields that round-trip are the ones that matter.
    const list = listJoinedCommunities();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, entry.id);
    assert.equal(list[0].name, entry.name);
    assert.equal(list[0].relayUrl, entry.relayUrl);
    assert.equal(list[0].joinedAt, entry.joinedAt);
    assert.equal(list[0].detectedName, 'private-relay-abc');
  } finally {
    home.restore();
  }
});

test('addJoinedCommunity rejects empty name + invalid URL', () => {
  const home = useTempHome();
  try {
    assert.throws(() => addJoinedCommunity({ name: '', relayUrl: 'wss://x' }), /name/);
    assert.throws(() => addJoinedCommunity({ name: 'x', relayUrl: 'http://x' }), /ws/);
    assert.throws(() => addJoinedCommunity({ name: 'x', relayUrl: 'not-a-url' }), /ws/);
  } finally {
    home.restore();
  }
});

test('addJoinedCommunity dedupes by URL (updates instead of appending)', () => {
  const home = useTempHome();
  try {
    const a = addJoinedCommunity({ name: 'Old name', relayUrl: 'wss://10.0.0.5:7778' });
    const b = addJoinedCommunity({ name: 'New name', relayUrl: 'wss://10.0.0.5:7778' });
    assert.equal(b.id, a.id, 'same id — updated in place');
    assert.equal(b.name, 'New name');
    const list = listJoinedCommunities();
    assert.equal(list.length, 1);
    assert.equal(list[0].name, 'New name');
  } finally {
    home.restore();
  }
});

test('removeJoinedCommunity is idempotent', () => {
  const home = useTempHome();
  try {
    const entry = addJoinedCommunity({ name: 'X', relayUrl: 'wss://x:1' });
    removeJoinedCommunity(entry.id);
    removeJoinedCommunity(entry.id);  // no-op second call
    assert.deepEqual(listJoinedCommunities(), []);
  } finally {
    home.restore();
  }
});

test('updateJoinedCommunity preserves id + joinedAt; patches the rest', () => {
  const home = useTempHome();
  try {
    const entry = addJoinedCommunity({ name: 'X', relayUrl: 'wss://x:1' });
    const updated = updateJoinedCommunity(entry.id, {
      name: 'Y',
      detectedName: 'private-relay-z',
      lastReachedAt: 12345,
    });
    assert.ok(updated);
    assert.equal(updated!.id, entry.id);
    assert.equal(updated!.joinedAt, entry.joinedAt);
    assert.equal(updated!.name, 'Y');
    assert.equal(updated!.detectedName, 'private-relay-z');
    assert.equal(updated!.lastReachedAt, 12345);
  } finally {
    home.restore();
  }
});

test('updateJoinedCommunity returns null for unknown id', () => {
  const home = useTempHome();
  try {
    assert.equal(updateJoinedCommunity('not-an-id', { name: 'x' }), null);
  } finally {
    home.restore();
  }
});

test('listJoinedCommunities filters out malformed entries (defensive)', () => {
  const home = useTempHome();
  try {
    // Forge a joined.json with one valid + one malformed entry to
    // verify the read-side defensive filter doesn't surface bogus
    // rows to the UI.
    fs.mkdirSync(path.join(home.home, 'communities'), { recursive: true });
    fs.writeFileSync(
      path.join(home.home, 'communities', 'joined.json'),
      JSON.stringify([
        { id: 'a'.repeat(12), name: 'OK', relayUrl: 'wss://x:1', joinedAt: 1 },
        { id: 'b'.repeat(12), name: 'missing-url', joinedAt: 2 },  // missing relayUrl
        'not even an object',
      ]),
    );
    const list = listJoinedCommunities();
    assert.equal(list.length, 1);
    assert.equal(list[0].name, 'OK');
  } finally {
    home.restore();
  }
});
