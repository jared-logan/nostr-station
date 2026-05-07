import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { useTempHome, resetTempHome } from './_home.js';

const HOME = useTempHome();

const {
  getGraspServers,
  addGraspServer,
  removeGraspServer,
  DEFAULT_GRASP_SERVERS,
  readIdentity,
  writeIdentity,
} = await import('../src/lib/identity.ts');

beforeEach(() => resetTempHome(HOME));

// Seed enough of an identity record that writeIdentity round-trips
// without exploding on missing fields. The grasp helpers don't depend
// on npub at all, but readIdentity expects the file to parse.
function seedIdentity(extra: Record<string, unknown> = {}): void {
  writeIdentity({
    npub:       '',
    readRelays: ['wss://relay.example'],
    ...extra,
  } as any);
}

test('grasp: getGraspServers returns DEFAULT_GRASP_SERVERS when nothing stored', () => {
  seedIdentity();
  const list = getGraspServers();
  assert.deepEqual(list, DEFAULT_GRASP_SERVERS);
});

test('grasp: getGraspServers returns the persisted list when present', () => {
  seedIdentity({ graspServers: ['wss://my.grasp', 'wss://other.grasp'] });
  const list = getGraspServers();
  assert.deepEqual(list, ['wss://my.grasp', 'wss://other.grasp']);
});

test('grasp: addGraspServer rejects non-ws/wss URLs', () => {
  seedIdentity();
  const r = addGraspServer('https://nope.example');
  assert.equal(r.ok, false);
  assert.match(r.error || '', /ws:\/\//);
});

test('grasp: addGraspServer seeds defaults + appends when list was empty', () => {
  // First add against a default-only state should anchor the defaults
  // PLUS the new URL — not just [the new URL]. Otherwise users who add
  // their company's grasp end up replacing relay.ngit.dev/git.shakespeare.diy
  // when they meant to add to them.
  seedIdentity();
  const r = addGraspServer('wss://my.grasp');
  assert.equal(r.ok, true);
  assert.deepEqual(
    r.graspServers,
    [...DEFAULT_GRASP_SERVERS, 'wss://my.grasp'],
    'add must seed defaults before appending the new entry',
  );

  // Round-trip via disk to confirm persistence.
  const readBack = readIdentity();
  assert.deepEqual(readBack.graspServers, [...DEFAULT_GRASP_SERVERS, 'wss://my.grasp']);
});

test('grasp: addGraspServer is a no-op for duplicates', () => {
  seedIdentity({ graspServers: ['wss://a', 'wss://b'] });
  const r = addGraspServer('wss://a');
  assert.equal(r.ok, true);
  assert.deepEqual(r.graspServers, ['wss://a', 'wss://b'], 'duplicate add must not double-list');
});

test('grasp: addGraspServer trims whitespace', () => {
  seedIdentity({ graspServers: [] });
  const r = addGraspServer('  wss://trim.me  ');
  assert.equal(r.ok, true);
  assert.ok(r.graspServers?.includes('wss://trim.me'));
  assert.ok(!r.graspServers?.includes('  wss://trim.me  '));
});

test('grasp: removeGraspServer drops the requested URL', () => {
  seedIdentity({ graspServers: ['wss://a', 'wss://b', 'wss://c'] });
  const r = removeGraspServer('wss://b');
  assert.deepEqual(r.graspServers, ['wss://a', 'wss://c']);
});

test('grasp: removeGraspServer from a defaults-only state anchors the user choice', () => {
  // Removing relay.ngit.dev when the list was implicit defaults should
  // leave the remaining default explicitly stored — getGraspServers()
  // must then return ['wss://git.shakespeare.diy'], not the full defaults
  // again. Otherwise the user's removal would be silently undone on the
  // next read.
  seedIdentity();
  const r = removeGraspServer('wss://relay.ngit.dev');
  assert.deepEqual(r.graspServers, ['wss://git.shakespeare.diy']);
  assert.deepEqual(getGraspServers(), ['wss://git.shakespeare.diy']);
});

test('grasp: removeGraspServer of an absent URL is a no-op', () => {
  seedIdentity({ graspServers: ['wss://a'] });
  const r = removeGraspServer('wss://not-there');
  assert.deepEqual(r.graspServers, ['wss://a']);
});

test('grasp: getGraspServers falls back to defaults when stored list goes empty', () => {
  // Clearing every entry should still render *something* in the UI —
  // the user can't end up with a blank list that produces a useless
  // form. The fallback applies on read; the empty stored list still
  // exists on disk (so adds don't re-seed defaults), but consumers
  // see DEFAULT_GRASP_SERVERS until the user adds their own.
  seedIdentity({ graspServers: ['wss://only-one'] });
  removeGraspServer('wss://only-one');
  // Stored list is now [] — getGraspServers should return defaults.
  assert.deepEqual(getGraspServers(), DEFAULT_GRASP_SERVERS);
});
