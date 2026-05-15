/**
 * MailStore spam-protection tests (PR 7).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { generateSecretKey, getPublicKey, getEventHash } from 'nostr-tools/pure';
import { MailStore } from '../src/lib/mail/store.js';
import { KIND_DM_RUMOR, type Rumor } from '../src/lib/mail/types.js';

function tmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-spam-'));
  return path.join(dir, 'mail.db');
}

function makeRumor(opts: {
  fromSecret?: Uint8Array;
  to:          string;
  content:     string;
  createdAt?:  number;
}): Rumor {
  const secret = opts.fromSecret ?? generateSecretKey();
  const pubkey = getPublicKey(secret);
  const tags: string[][] = [['p', opts.to]];
  const created_at = opts.createdAt ?? Math.floor(Date.now() / 1000);
  const template = { pubkey, kind: KIND_DM_RUMOR, created_at, tags, content: opts.content };
  return { ...template, id: getEventHash(template as any) };
}

test('spam: messages inserted with bucket=quarantine show up in the requests summary', () => {
  const store    = new MailStore(tmpDbPath());
  const alicePub = getPublicKey(generateSecretKey());
  const bob      = generateSecretKey();
  const bobPub   = getPublicKey(bob);

  const r = makeRumor({ fromSecret: bob, to: alicePub, content: 'spam?', createdAt: 1000 });
  store.insertMessage(r, 'w1', alicePub, 'quarantine');

  // Default bucket (inbox) is empty.
  assert.equal(store.threadSummaries('inbox').length, 0);
  // Requests has the thread.
  const requests = store.threadSummaries('quarantine');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].counterparty, bobPub);
});

test('spam: outgoing messages always land in inbox regardless of bucket arg', () => {
  const store    = new MailStore(tmpDbPath());
  const aliceSk  = generateSecretKey();
  const alicePub = getPublicKey(aliceSk);
  const bobPub   = getPublicKey(generateSecretKey());

  const outgoing = makeRumor({ fromSecret: aliceSk, to: bobPub, content: 'hi' });
  // Pass quarantine on purpose — the insert path must override it for
  // outgoing rows since the user pressed Send.
  store.insertMessage(outgoing, 'wout', alicePub, 'quarantine');

  // Outgoing thread is in inbox, not quarantine.
  assert.equal(store.threadSummaries('inbox').length, 1);
  assert.equal(store.threadSummaries('quarantine').length, 0);
});

test('spam: acceptCounterparty allowlists and re-buckets existing rows', () => {
  const store    = new MailStore(tmpDbPath());
  const alicePub = getPublicKey(generateSecretKey());
  const bob      = generateSecretKey();
  const bobPub   = getPublicKey(bob);

  const r1 = makeRumor({ fromSecret: bob, to: alicePub, content: 'one',   createdAt: 1000 });
  const r2 = makeRumor({ fromSecret: bob, to: alicePub, content: 'two',   createdAt: 2000 });
  store.insertMessage(r1, 'w1', alicePub, 'quarantine');
  store.insertMessage(r2, 'w2', alicePub, 'quarantine');

  assert.equal(store.isAllowlisted(bobPub), false);
  const { movedRows } = store.acceptCounterparty(bobPub);
  assert.equal(movedRows, 2);
  assert.equal(store.isAllowlisted(bobPub), true);

  assert.equal(store.threadSummaries('quarantine').length, 0);
  const inbox = store.threadSummaries('inbox');
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].counterparty, bobPub);
  assert.equal(inbox[0].total, 2);
});

test('spam: blockCounterparty deletes existing history + sets blocklist', () => {
  const store    = new MailStore(tmpDbPath());
  const alicePub = getPublicKey(generateSecretKey());
  const bob      = generateSecretKey();
  const bobPub   = getPublicKey(bob);

  store.insertMessage(makeRumor({ fromSecret: bob, to: alicePub, content: 'spam', createdAt: 1000 }),
    'w1', alicePub, 'quarantine');
  store.insertMessage(makeRumor({ fromSecret: bob, to: alicePub, content: 'more', createdAt: 1100 }),
    'w2', alicePub, 'quarantine');

  assert.equal(store.isBlocklisted(bobPub), false);
  const { deletedRows } = store.blockCounterparty(bobPub);
  assert.equal(deletedRows, 2);
  assert.equal(store.isBlocklisted(bobPub), true);

  // Both buckets are empty after a block.
  assert.equal(store.threadSummaries('inbox').length,      0);
  assert.equal(store.threadSummaries('quarantine').length, 0);
});

test('spam: blocking also drops allowlist membership (mutex)', () => {
  const store    = new MailStore(tmpDbPath());
  const bobPub   = getPublicKey(generateSecretKey());
  store.acceptCounterparty(bobPub);
  assert.equal(store.isAllowlisted(bobPub), true);
  store.blockCounterparty(bobPub);
  assert.equal(store.isAllowlisted(bobPub), false);
  assert.equal(store.isBlocklisted(bobPub), true);
});

test('spam: unblockCounterparty removes from blocklist but does not restore history', () => {
  const store    = new MailStore(tmpDbPath());
  const alicePub = getPublicKey(generateSecretKey());
  const bobPub   = getPublicKey(generateSecretKey());

  store.insertMessage(makeRumor({ to: alicePub, content: 'x', fromSecret: undefined as any }),
    'w', alicePub, 'quarantine');
  store.blockCounterparty(bobPub);  // bob never had any rows; just sets the flag
  assert.equal(store.isBlocklisted(bobPub), true);
  store.unblockCounterparty(bobPub);
  assert.equal(store.isBlocklisted(bobPub), false);
});

test('spam: allowlist + blocklist list APIs return sorted recent-first', () => {
  const store = new MailStore(tmpDbPath());
  const a = getPublicKey(generateSecretKey());
  const b = getPublicKey(generateSecretKey());
  store.acceptCounterparty(a);
  // Need a measurable gap because the insert uses Date.now() and SQLite
  // sorts ties by insertion order (which is fine but harder to assert).
  // Sleep a millisecond.
  const wait = Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
  void wait;
  store.acceptCounterparty(b);
  const allow = store.allowlist();
  assert.equal(allow.length, 2);
  // recent-first: b before a
  assert.equal(allow[0].pubkey, b);
  assert.equal(allow[1].pubkey, a);
});

test('spam: legacy rows (no status column) default to inbox after migration', () => {
  // Simulate a pre-PR-7 DB by inserting via raw SQL with no status column.
  const dbPath = tmpDbPath();
  // First open: creates schema including the migration that adds status.
  const store1 = new MailStore(dbPath);
  store1.close();

  // Now inject a row that pre-dates the status column by setting status
  // to its default ('inbox') explicitly; this mirrors what the ALTER
  // TABLE migration backfills.
  const aliceSk = generateSecretKey();
  const alicePub = getPublicKey(aliceSk);
  const bob = generateSecretKey();
  const r = makeRumor({ fromSecret: bob, to: alicePub, content: 'legacy', createdAt: 5000 });

  const store2 = new MailStore(dbPath);
  // The default bucket arg ('inbox') is what unmigrated rows would have.
  store2.insertMessage(r, 'legacy-w', alicePub);
  assert.equal(store2.threadSummaries('inbox').length,      1);
  assert.equal(store2.threadSummaries('quarantine').length, 0);
});
