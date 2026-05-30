import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  CLIENT_TAG, CLIENT_NAME, CLIENT_HANDLER_PUBKEY,
  hasNostrStationClientTag, stampClientTag,
  // @ts-expect-error — runtime .ts import
} = await import('../src/lib/client-tag.ts');

test('CLIENT_TAG: 4-element NIP-89 form pointing at the kind-31990 handler', () => {
  assert.equal(CLIENT_TAG.length, 4);
  assert.equal(CLIENT_TAG[0], 'client');
  assert.equal(CLIENT_TAG[1], CLIENT_NAME);
  assert.equal(CLIENT_TAG[2], `31990:${CLIENT_HANDLER_PUBKEY}:${CLIENT_NAME}`);
  assert.match(CLIENT_TAG[3], /^wss:\/\//);
  assert.match(CLIENT_HANDLER_PUBKEY, /^[0-9a-f]{64}$/);
});

test('CLIENT_TAG: frozen (callers must spread, not mutate the shared array)', () => {
  assert.throws(() => { (CLIENT_TAG as string[]).push('x'); });
});

test('hasNostrStationClientTag: detects 2- and 4-element forms', () => {
  assert.equal(hasNostrStationClientTag([['client', 'nostr-station']]), true);
  assert.equal(hasNostrStationClientTag([[...CLIENT_TAG]]), true);
  assert.equal(hasNostrStationClientTag([['client', 'shakespeare.diy']]), false);
  assert.equal(hasNostrStationClientTag([['d', 'x']]), false);
});

test('stampClientTag: appends the 4-element tag when absent', () => {
  const tags: string[][] = [['d', 'x']];
  stampClientTag(tags);
  const c = tags.find(t => t[0] === 'client');
  assert.equal(c?.length, 4);
  assert.equal(c?.[1], 'nostr-station');
});

test('stampClientTag: idempotent — does not double-stamp', () => {
  const tags: string[][] = [['client', 'nostr-station']];
  stampClientTag(tags);
  assert.equal(tags.filter(t => t[0] === 'client').length, 1);
});

test('stampClientTag: leaves another client tag in place but does not add ours twice over it', () => {
  // A foreign client tag uses a different name, so ours IS still added —
  // both coexist (provenance + attribution).
  const tags: string[][] = [['client', 'shakespeare.diy', '31990:abc:shakespeare']];
  stampClientTag(tags);
  assert.equal(tags.filter(t => t[0] === 'client').length, 2);
  assert.ok(tags.some(t => t[1] === 'nostr-station'));
  assert.ok(tags.some(t => t[1] === 'shakespeare.diy'));
});
