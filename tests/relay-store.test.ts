import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { EventStore } from '../src/relay/store.ts';
import type { NostrEvent } from '../src/relay/types.ts';

function tmpDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-store-'));
  return path.join(dir, 'relay.db');
}

function ev(overrides: Partial<NostrEvent> & { id: string }): NostrEvent {
  return {
    pubkey:     'b'.repeat(64),
    created_at: 1_700_000_000,
    kind:       1,
    tags:       [],
    content:    '',
    sig:        'c'.repeat(128),
    ...overrides,
  };
}

test('store: round-trip a single event', () => {
  const s = new EventStore({ dbPath: tmpDb() });
  const e = ev({ id: 'a'.repeat(64), content: 'hello' });
  const r = s.add(e);
  assert.equal(r.stored, true);
  assert.equal(r.duplicate, false);
  const out = s.query({ ids: [e.id] });
  assert.equal(out.length, 1);
  assert.equal(out[0].content, 'hello');
  s.close();
});

test('store: duplicates are detected by id', () => {
  const s = new EventStore({ dbPath: tmpDb() });
  const e = ev({ id: 'd'.repeat(64) });
  s.add(e);
  const second = s.add(e);
  assert.equal(second.duplicate, true);
  assert.equal(s.count(), 1);
  s.close();
});

test('store: replaceable kinds (kind 0) overwrite older versions by author', () => {
  const s = new EventStore({ dbPath: tmpDb() });
  const author = 'b'.repeat(64);
  s.add(ev({ id: '1'.repeat(64), kind: 0, pubkey: author, created_at: 100, content: 'old' }));
  s.add(ev({ id: '2'.repeat(64), kind: 0, pubkey: author, created_at: 200, content: 'new' }));
  const out = s.query({ kinds: [0], authors: [author] });
  assert.equal(out.length, 1);
  assert.equal(out[0].content, 'new');
  s.close();
});

test('store: parameterized-replaceable (30000+) keys on (kind,pubkey,d-tag)', () => {
  const s = new EventStore({ dbPath: tmpDb() });
  const author = 'b'.repeat(64);
  s.add(ev({ id: '1'.repeat(64), kind: 30023, pubkey: author, created_at: 100, tags: [['d', 'post-a']], content: 'a-old' }));
  s.add(ev({ id: '2'.repeat(64), kind: 30023, pubkey: author, created_at: 200, tags: [['d', 'post-a']], content: 'a-new' }));
  s.add(ev({ id: '3'.repeat(64), kind: 30023, pubkey: author, created_at: 100, tags: [['d', 'post-b']], content: 'b-only' }));
  const out = s.query({ kinds: [30023], authors: [author] });
  assert.equal(out.length, 2);
  const contents = out.map(e => e.content).sort();
  assert.deepEqual(contents, ['a-new', 'b-only']);
  s.close();
});

test('store: tag filters (#e, #p) hit the indexed tags table', () => {
  const s = new EventStore({ dbPath: tmpDb() });
  s.add(ev({ id: '1'.repeat(64), tags: [['e', 'target']] }));
  s.add(ev({ id: '2'.repeat(64), tags: [['e', 'other']] }));
  const out = s.query({ '#e': ['target'] } as any);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, '1'.repeat(64));
  s.close();
});

test('store: queryMany dedupes across filters and orders newest-first', () => {
  const s = new EventStore({ dbPath: tmpDb() });
  s.add(ev({ id: '1'.repeat(64), kind: 1, created_at: 100 }));
  s.add(ev({ id: '2'.repeat(64), kind: 1, created_at: 200 }));
  s.add(ev({ id: '3'.repeat(64), kind: 2, created_at: 150 }));
  // Both filters match event #1 (kind 1) and #2 (kind 1) — dedupe should leave one each.
  const out = s.queryMany([{ kinds: [1] }, { kinds: [1, 2] }]);
  assert.equal(out.length, 3);
  assert.deepEqual(out.map(e => e.created_at), [200, 150, 100]);
  s.close();
});

test('store: maxEvents evicts oldest', () => {
  const s = new EventStore({ dbPath: tmpDb(), maxEvents: 3 });
  for (let i = 0; i < 5; i++) {
    s.add(ev({ id: String(i).padStart(64, '0'), created_at: 1000 + i }));
  }
  assert.equal(s.count(), 3);
  const remaining = s.query({}).map(e => e.created_at).sort((a, b) => a - b);
  assert.deepEqual(remaining, [1002, 1003, 1004]);
  s.close();
});

test('store: full-text search finds events by content keyword', () => {
  const s = new EventStore({ dbPath: tmpDb() });
  s.add(ev({ id: '1'.repeat(64), kind: 1, content: 'Hello LMDB, how are you?' }));
  s.add(ev({ id: '2'.repeat(64), kind: 1, content: 'nothing to see here' }));
  s.add(ev({ id: '3'.repeat(64), kind: 1, content: 'LMDB is a B+tree' }));

  const hits = s.search('LMDB');
  assert.equal(hits.length, 2);
  const ids = new Set(hits.map(h => h.id));
  assert.ok(ids.has('1'.repeat(64)));
  assert.ok(ids.has('3'.repeat(64)));
  s.close();
});

test('store: search can be narrowed by kind', () => {
  const s = new EventStore({ dbPath: tmpDb() });
  s.add(ev({ id: '1'.repeat(64), kind: 1, content: 'apple pie' }));
  s.add(ev({ id: '2'.repeat(64), kind: 7, content: 'apple sauce' }));
  const onlyNotes = s.search('apple', { kinds: [1] });
  assert.equal(onlyNotes.length, 1);
  assert.equal(onlyNotes[0].id, '1'.repeat(64));
  s.close();
});

test('store: search reflects deletions via the FTS sync trigger', () => {
  const s = new EventStore({ dbPath: tmpDb(), maxEvents: 1 });
  s.add(ev({ id: '1'.repeat(64), kind: 1, content: 'evictme please', created_at: 100 }));
  assert.equal(s.search('evictme').length, 1);
  // Adding a second event triggers eviction of the first.
  s.add(ev({ id: '2'.repeat(64), kind: 1, content: 'unrelated', created_at: 200 }));
  assert.equal(s.search('evictme').length, 0, 'FTS row should be removed when the event row is');
  s.close();
});

test('store: FTS index backfills from existing events on first migration', () => {
  // Seed a DB with the events table only (no events_fts) to simulate an
  // upgrade scenario, then re-open through EventStore to trigger the
  // rebuild path.
  const dbPath = tmpDb();
  const seed   = new Database(dbPath);
  seed.exec(`
    CREATE TABLE events (
      id TEXT PRIMARY KEY, pubkey TEXT NOT NULL, created_at INTEGER NOT NULL,
      kind INTEGER NOT NULL, content TEXT NOT NULL, sig TEXT NOT NULL,
      tags_json TEXT NOT NULL
    );
    CREATE TABLE tags (
      event_id TEXT NOT NULL, tag_name TEXT NOT NULL, tag_value TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
    );
  `);
  seed.prepare(`INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    'a'.repeat(64), 'p'.repeat(64), 1234, 1, 'searchable archived note', 's'.repeat(128), '[]',
  );
  seed.close();

  const s = new EventStore({ dbPath });
  const hits = s.search('archived');
  assert.equal(hits.length, 1);
  s.close();
});

test('store: kind-0 ingest materializes a profile row', () => {
  const s = new EventStore({ dbPath: tmpDb() });
  const author = 'a'.repeat(64);
  s.add(ev({
    id: 'p1'.padEnd(64, '0'),
    pubkey: author,
    kind: 0,
    created_at: 1_700_000_000,
    content: JSON.stringify({
      name: 'alice', display_name: 'Alice', nip05: 'alice@example.com',
      picture: 'https://example.com/a.png', lud16: 'alice@ln.example',
      about: 'Hi.', website: 'https://alice.example',
    }),
  }));
  const p = s.getProfile(author);
  assert.ok(p, 'expected a profile row');
  assert.equal(p!.name,         'alice');
  assert.equal(p!.display_name, 'Alice');
  assert.equal(p!.nip05,        'alice@example.com');
  assert.equal(p!.picture,      'https://example.com/a.png');
  assert.equal(p!.updated_at,   1_700_000_000);
  s.close();
});

test('store: a malformed kind-0 does not break ingest', () => {
  const s = new EventStore({ dbPath: tmpDb() });
  // Not JSON at all — common in spammy / fuzzed events.
  const r = s.add(ev({
    id:      'b'.repeat(64),
    pubkey:  'c'.repeat(64),
    kind:    0,
    content: 'not-json',
  }));
  assert.equal(r.stored, true);
  assert.equal(s.getProfile('c'.repeat(64)), null);
  s.close();
});

test('store: newer kind-0 overwrites older profile, stale events are ignored', () => {
  const s = new EventStore({ dbPath: tmpDb() });
  const author = 'd'.repeat(64);
  s.add(ev({
    id: '1'.repeat(64), pubkey: author, kind: 0, created_at: 100,
    content: JSON.stringify({ name: 'old' }),
  }));
  s.add(ev({
    id: '2'.repeat(64), pubkey: author, kind: 0, created_at: 200,
    content: JSON.stringify({ name: 'new' }),
  }));
  assert.equal(s.getProfile(author)!.name, 'new');

  // A stale event arriving after the fresher one must not clobber it.
  // (The replaceable-event path also deletes the older row from
  // `events`, but the profiles upsert is what we're guarding here.)
  s.add(ev({
    id: '3'.repeat(64), pubkey: author, kind: 0, created_at: 50,
    content: JSON.stringify({ name: 'stale' }),
  }));
  assert.equal(s.getProfile(author)!.name, 'new');
  s.close();
});

test('store: getProfiles returns a Map keyed by pubkey, missing entries absent', () => {
  const s = new EventStore({ dbPath: tmpDb() });
  const a = 'a'.repeat(64);
  const b = 'b'.repeat(64);
  const c = 'c'.repeat(64);
  s.add(ev({ id: '1'.repeat(64), pubkey: a, kind: 0, content: JSON.stringify({ name: 'A' }) }));
  s.add(ev({ id: '2'.repeat(64), pubkey: b, kind: 0, content: JSON.stringify({ name: 'B' }) }));
  const m = s.getProfiles([a, b, c]);
  assert.equal(m.size, 2);
  assert.equal(m.get(a)!.name, 'A');
  assert.equal(m.get(b)!.name, 'B');
  assert.equal(m.has(c), false);
  s.close();
});

test('store: backfills profiles from existing kind-0 events on first open', () => {
  // Seed a fresh DB with kind-0 events via a previous EventStore, then
  // drop the profiles table to simulate an upgrade-from-old-version
  // scenario where kind-0s already exist but profiles is empty.
  const dbPath = tmpDb();
  {
    const s = new EventStore({ dbPath });
    s.add(ev({
      id: '1'.repeat(64), pubkey: 'a'.repeat(64), kind: 0, created_at: 500,
      content: JSON.stringify({ name: 'first' }),
    }));
    s.close();
  }
  // Forcibly clear profiles (the prior session already populated them).
  const wipe = new Database(dbPath);
  wipe.exec('DROP TABLE profiles');
  wipe.close();

  // Reopen — backfill should re-derive the profile from the kind-0 event.
  const s2 = new EventStore({ dbPath });
  const p  = s2.getProfile('a'.repeat(64));
  assert.equal(p?.name, 'first');
  assert.equal(p?.updated_at, 500);
  s2.close();
});

test('store: wipe clears profiles alongside events', () => {
  const s = new EventStore({ dbPath: tmpDb() });
  s.add(ev({
    id: '1'.repeat(64), pubkey: 'a'.repeat(64), kind: 0,
    content: JSON.stringify({ name: 'x' }),
  }));
  assert.ok(s.getProfile('a'.repeat(64)));
  s.wipe();
  assert.equal(s.getProfile('a'.repeat(64)), null);
  assert.equal(s.count(), 0);
  s.close();
});

test('store: migrates a legacy tags-without-created_at schema in place', () => {
  // Build a database with the pre-migration schema: tags has no
  // created_at column. Seed one event + one tag row so we can verify
  // the backfill populates created_at from the joined events row.
  const dbPath = tmpDb();
  const seed   = new Database(dbPath);
  seed.exec(`
    CREATE TABLE events (
      id TEXT PRIMARY KEY, pubkey TEXT NOT NULL, created_at INTEGER NOT NULL,
      kind INTEGER NOT NULL, content TEXT NOT NULL, sig TEXT NOT NULL,
      tags_json TEXT NOT NULL
    );
    CREATE TABLE tags (
      event_id TEXT NOT NULL, tag_name TEXT NOT NULL, tag_value TEXT NOT NULL,
      FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
    );
  `);
  const evId = 'e'.repeat(64);
  seed.prepare(`INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    evId, 'p'.repeat(64), 1234, 1, 'x', 's'.repeat(128), '[]',
  );
  seed.prepare(`INSERT INTO tags VALUES (?, ?, ?)`).run(evId, 'e', 'target');
  seed.close();

  // Open the store — migration should run on construction.
  const s = new EventStore({ dbPath });

  // The .bak file was written before the schema mutation.
  assert.equal(fs.existsSync(dbPath + '.bak'), true);

  // tags.created_at now exists and has been backfilled from events.created_at.
  const check = new Database(dbPath, { readonly: true });
  const cols  = check.prepare('PRAGMA table_info(tags)').all() as Array<{ name: string }>;
  assert.equal(cols.some(c => c.name === 'created_at'), true);
  const row = check.prepare('SELECT created_at FROM tags').get() as { created_at: number };
  assert.equal(row.created_at, 1234);
  check.close();

  // The store is usable post-migration — a tag query still returns the row.
  const out = s.query({ '#e': ['target'] } as any);
  assert.equal(out.length, 1);
  s.close();
});
