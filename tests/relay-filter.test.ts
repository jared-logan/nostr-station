import test from 'node:test';
import assert from 'node:assert/strict';
import { eventMatchesFilter, eventMatchesAny } from '../src/relay/filter.ts';
import type { NostrEvent, NostrFilter } from '../src/relay/types.ts';

const baseEvent: NostrEvent = {
  id:         'a'.repeat(64),
  pubkey:     'b'.repeat(64),
  created_at: 1_700_000_000,
  kind:       1,
  tags:       [['e', 'eee'], ['p', 'ppp'], ['t', 'nostr']],
  content:    'hello',
  sig:        'c'.repeat(128),
};

test('filter: empty filter matches everything', () => {
  assert.equal(eventMatchesFilter(baseEvent, {}), true);
});

test('filter: ids must contain the event id', () => {
  assert.equal(eventMatchesFilter(baseEvent, { ids: [baseEvent.id] }), true);
  assert.equal(eventMatchesFilter(baseEvent, { ids: ['z'.repeat(64)] }), false);
});

test('filter: authors must contain the event pubkey', () => {
  assert.equal(eventMatchesFilter(baseEvent, { authors: [baseEvent.pubkey] }), true);
  assert.equal(eventMatchesFilter(baseEvent, { authors: ['z'.repeat(64)] }), false);
});

test('filter: kinds must contain the event kind', () => {
  assert.equal(eventMatchesFilter(baseEvent, { kinds: [1, 2, 3] }), true);
  assert.equal(eventMatchesFilter(baseEvent, { kinds: [4, 5] }), false);
});

test('filter: since/until are inclusive', () => {
  assert.equal(eventMatchesFilter(baseEvent, { since: baseEvent.created_at }), true);
  assert.equal(eventMatchesFilter(baseEvent, { until: baseEvent.created_at }), true);
  assert.equal(eventMatchesFilter(baseEvent, { since: baseEvent.created_at + 1 }), false);
  assert.equal(eventMatchesFilter(baseEvent, { until: baseEvent.created_at - 1 }), false);
});

test('filter: tag filters match by name + value', () => {
  const f1: NostrFilter = { '#e': ['eee'] };
  const f2: NostrFilter = { '#e': ['nope'] };
  const f3: NostrFilter = { '#t': ['nostr', 'other'] };
  assert.equal(eventMatchesFilter(baseEvent, f1), true);
  assert.equal(eventMatchesFilter(baseEvent, f2), false);
  assert.equal(eventMatchesFilter(baseEvent, f3), true);
});

test('filter: multiple tag filters AND together', () => {
  const f: NostrFilter = { '#e': ['eee'], '#p': ['nope'] };
  assert.equal(eventMatchesFilter(baseEvent, f), false);
});

test('filter: top-level conditions AND together', () => {
  const f: NostrFilter = { kinds: [1], authors: ['nope'] };
  assert.equal(eventMatchesFilter(baseEvent, f), false);
});

test('filter: eventMatchesAny ORs across filters', () => {
  const filters: NostrFilter[] = [
    { authors: ['nope'] },
    { kinds: [1] },
  ];
  assert.equal(eventMatchesAny(baseEvent, filters), true);
});

test('filter: long-tag-name filters (>1 char) are ignored', () => {
  // "#exp" isn't a NIP-01 single-letter tag filter; we ignore it rather
  // than treat it as a real constraint. An event without that tag should
  // still match.
  const f = { '#exp': ['anything'] } as unknown as NostrFilter;
  assert.equal(eventMatchesFilter(baseEvent, f), true);
});
