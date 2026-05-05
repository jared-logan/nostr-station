import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
