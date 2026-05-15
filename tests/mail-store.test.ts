/**
 * MailStore tests — exercises the SQLite persistence layer with a temp
 * database file, since the singleton in store.ts hardcodes the prod
 * path under ~/.nostr-station/data.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { generateSecretKey, getPublicKey, getEventHash } from 'nostr-tools/pure';
import { MailStore } from '../src/lib/mail/store.js';
import { KIND_EMAIL, type Rumor } from '../src/lib/mail/types.js';
import { buildMessage, mintMessageId } from '../src/lib/mail/rfc2822.js';

function tmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-store-'));
  return path.join(dir, 'mail.db');
}

// Builds a kind-1301 rumor whose `content` is a real RFC 2822 message,
// matching what the worker would insert on receive. The store parses
// the content at insert time so subject + body live in their columns.
function makeRumor(opts: {
  fromSecret?: Uint8Array;
  to:          string;
  content:     string;
  subject?:    string;
  createdAt?:  number;
}): Rumor {
  const secret = opts.fromSecret ?? generateSecretKey();
  const pubkey = getPublicKey(secret);
  const created_at = opts.createdAt ?? Math.floor(Date.now() / 1000);
  const rfc2822 = buildMessage({
    fromPubkey: pubkey,
    toPubkey:   opts.to,
    subject:    opts.subject ?? '',
    body:       opts.content,
    messageId:  mintMessageId(),
  });
  const template = {
    pubkey, kind: KIND_EMAIL, created_at,
    tags: [['p', opts.to]], content: rfc2822,
  };
  return { ...template, id: getEventHash(template as any) };
}

test('store: insertMessage stamps direction + counterparty correctly', () => {
  const store = new MailStore(tmpDbPath());
  const aliceSecret = generateSecretKey();
  const alicePub    = getPublicKey(aliceSecret);
  const bobSecret   = generateSecretKey();
  const bobPub      = getPublicKey(bobSecret);

  // Incoming: bob → alice. alice is the station owner.
  const incoming = makeRumor({
    fromSecret: bobSecret, to: alicePub,
    content: 'hi alice', subject: 'meeting',
  });
  const inRow = store.insertMessage(incoming, 'wrap-1', alicePub);
  assert.equal(inRow?.direction, 'in');
  assert.equal(inRow?.counterparty, bobPub);
  assert.equal(inRow?.subject, 'meeting');

  // Outgoing: alice → bob. alice is the station owner.
  const outgoing = makeRumor({
    fromSecret: aliceSecret, to: bobPub,
    content: 'hi bob', subject: 'meeting reply',
  });
  const outRow = store.insertMessage(outgoing, 'wrap-2', alicePub);
  assert.equal(outRow?.direction, 'out');
  assert.equal(outRow?.counterparty, bobPub);
});

test('store: insertMessage is idempotent on rumor id', () => {
  const store = new MailStore(tmpDbPath());
  const alicePub = getPublicKey(generateSecretKey());
  const r = makeRumor({ to: alicePub, content: 'dupe-test' });
  const first  = store.insertMessage(r, 'w1', alicePub);
  const second = store.insertMessage(r, 'w1', alicePub);
  assert.ok(first);
  assert.equal(second, null, 'duplicate insert should return null');
  const thread = store.messagesForThread(r.pubkey);
  assert.equal(thread.length, 1);
});

test('store: insertMessage drops out-of-scope kinds', () => {
  const store = new MailStore(tmpDbPath());
  const alicePub = getPublicKey(generateSecretKey());
  const reactionRumor: Rumor = {
    ...makeRumor({ to: alicePub, content: '+' }),
    kind: 7,  // reaction — not surfaced in the inbox
  };
  reactionRumor.id = getEventHash(reactionRumor as any);
  const row = store.insertMessage(reactionRumor, 'w1', alicePub);
  assert.equal(row, null);
});

test('store: seen_wraps dedup table', () => {
  const store = new MailStore(tmpDbPath());
  assert.equal(store.hasSeenWrap('w-abc'), false);
  store.markSeenWrap('w-abc');
  assert.equal(store.hasSeenWrap('w-abc'), true);
});

test('store: threadSummaries sorts by recency, counts unread', () => {
  const store    = new MailStore(tmpDbPath());
  const alicePub = getPublicKey(generateSecretKey());
  const bob      = generateSecretKey();
  const carol    = generateSecretKey();
  const bobPub   = getPublicKey(bob);
  const carolPub = getPublicKey(carol);

  // bob's thread: two incoming (one old, one new). One read, one unread.
  const b1 = makeRumor({ fromSecret: bob, to: alicePub, content: 'older',  subject: '',          createdAt: 1000 });
  const b2 = makeRumor({ fromSecret: bob, to: alicePub, content: 'newer',  subject: 'bob-newest',createdAt: 2000 });
  // carol's thread: one incoming, even newer.
  const c1 = makeRumor({ fromSecret: carol, to: alicePub, content: 'cnew', subject: 'carol-newest', createdAt: 3000 });

  store.insertMessage(b1, 'wb1', alicePub);
  store.insertMessage(b2, 'wb2', alicePub);
  store.insertMessage(c1, 'wc1', alicePub);

  // Mark b1 read; b2 + c1 stay unread.
  store.markRead([b1.id]);

  const threads = store.threadSummaries();
  assert.equal(threads.length, 2);
  // Most-recent first → carol on top, bob second.
  assert.equal(threads[0].counterparty, carolPub);
  assert.equal(threads[0].last_subject, 'carol-newest');
  assert.equal(threads[0].unread,       1);
  assert.equal(threads[0].total,        1);
  assert.equal(threads[1].counterparty, bobPub);
  assert.equal(threads[1].last_subject, 'bob-newest');
  assert.equal(threads[1].unread,       1);
  assert.equal(threads[1].total,        2);
});

test('store: messagesForThread returns messages oldest-first', () => {
  const store    = new MailStore(tmpDbPath());
  const alicePub = getPublicKey(generateSecretKey());
  const bob      = generateSecretKey();
  const bobPub   = getPublicKey(bob);
  const r1 = makeRumor({ fromSecret: bob, to: alicePub, content: 'one',   createdAt: 1000 });
  const r2 = makeRumor({ fromSecret: bob, to: alicePub, content: 'two',   createdAt: 2000 });
  const r3 = makeRumor({ fromSecret: bob, to: alicePub, content: 'three', createdAt: 3000 });
  // Insert out of order.
  store.insertMessage(r3, 'w3', alicePub);
  store.insertMessage(r1, 'w1', alicePub);
  store.insertMessage(r2, 'w2', alicePub);
  const msgs = store.messagesForThread(bobPub);
  assert.deepEqual(msgs.map(m => m.body), ['one', 'two', 'three']);
});
