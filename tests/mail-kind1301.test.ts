/**
 * Kind 1301 + RFC 2822 round-trip tests (PR 9 protocol cutover).
 *
 * Exercises the full path: build an RFC 2822 message → wrap as a
 * kind-1301 rumor → seal → gift wrap → unwrap → parse → store insert
 * → read back. Asserts every layer preserves the user-visible fields
 * (subject, body, attachments, threading headers) and that the store
 * correctly drops out-of-protocol kinds.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { generateSecretKey, getPublicKey, getEventHash } from 'nostr-tools/pure';
import Database from 'better-sqlite3';
import { LocalSigner } from '../src/lib/mail/signer.js';
import { buildGiftWrap, unwrapGift } from '../src/lib/mail/wrap.js';
import { buildMessage, mintMessageId } from '../src/lib/mail/rfc2822.js';
import { MailStore } from '../src/lib/mail/store.js';
import {
  KIND_EMAIL, KIND_DM_RUMOR, KIND_FILE_RUMOR, type Rumor,
} from '../src/lib/mail/types.js';

function tmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-1301-'));
  return path.join(dir, 'mail.db');
}

function makePair() {
  const aliceSecret = generateSecretKey();
  const bobSecret   = generateSecretKey();
  return {
    alicePub: getPublicKey(aliceSecret),
    bobPub:   getPublicKey(bobSecret),
    alice:    new LocalSigner(aliceSecret),
    bob:      new LocalSigner(bobSecret),
  };
}

test('1301: end-to-end alice → bob preserves subject + body + threading', async () => {
  const { alice, bob, alicePub, bobPub } = makePair();

  const rfc2822 = buildMessage({
    fromPubkey: alicePub,
    toPubkey:   bobPub,
    subject:    'Lunch tomorrow?',
    body:       'Want to grab lunch around 1pm?',
    messageId:  mintMessageId(),
  });

  const { wrap } = await buildGiftWrap(
    { kind: KIND_EMAIL, content: rfc2822, tags: [['p', bobPub]] },
    bobPub, alice,
  );
  assert.equal(wrap.kind, 1059, 'outer is a gift wrap');

  // Bob receives + unwraps + the store parses RFC 2822.
  const { rumor } = await unwrapGift(wrap, bob);
  assert.equal(rumor.kind,   KIND_EMAIL);
  assert.equal(rumor.pubkey, alicePub);

  const store = new MailStore(tmpDbPath());
  const row = store.insertMessage(rumor, wrap.id, bobPub);
  assert.ok(row);
  assert.equal(row!.subject,     'Lunch tomorrow?');
  assert.equal(row!.body,        'Want to grab lunch around 1pm?');
  assert.equal(row!.direction,   'in');
  assert.equal(row!.counterparty, alicePub);
  assert.ok(row!.message_id, 'parsed Message-ID header should round-trip');
  assert.equal(row!.attachments.length, 0);
});

test('1301: inline + blossom attachments survive into store.attachments[]', async () => {
  const { alice, bob, alicePub, bobPub } = makePair();
  const smallBytes = Buffer.from('inline-bytes-here');

  const rfc2822 = buildMessage({
    fromPubkey: alicePub, toPubkey: bobPub,
    subject: 'mixed atts', body: 'check these',
    messageId: mintMessageId(),
    attachments: [
      // Inline: bytes carried in the multipart body as base64.
      { name: 'note.txt', mime: 'text/plain', size: smallBytes.length,
        inline: { base64: smallBytes.toString('base64') } },
      // Blossom: metadata only; the AES-GCM ciphertext lives on a URL.
      { name: 'big.mp4', mime: 'video/mp4', size: 5_000_000,
        blossom: {
          url:      'http://example.test/blob',
          sha256:   'a'.repeat(64),
          keyHex:   'b'.repeat(64),
          nonceHex: 'c'.repeat(24),
        },
      },
    ],
  });

  const { wrap } = await buildGiftWrap(
    { kind: KIND_EMAIL, content: rfc2822, tags: [['p', bobPub]] },
    bobPub, alice,
  );
  const { rumor } = await unwrapGift(wrap, bob);

  const store = new MailStore(tmpDbPath());
  const row = store.insertMessage(rumor, wrap.id, bobPub);
  assert.ok(row);
  assert.equal(row!.attachments.length, 2);

  const inlineAtt = row!.attachments.find(a => a.name === 'note.txt');
  assert.ok(inlineAtt);
  assert.equal(inlineAtt!.mime, 'text/plain');
  assert.ok(inlineAtt!.inlineBase64, 'inline attachment should keep base64 payload');
  // Round-trip: base64 in store decodes back to the original bytes.
  assert.equal(
    Buffer.from(inlineAtt!.inlineBase64!, 'base64').toString('utf8'),
    smallBytes.toString('utf8'),
  );

  const blossomAtt = row!.attachments.find(a => a.name === 'big.mp4');
  assert.ok(blossomAtt);
  assert.equal(blossomAtt!.inlineBase64, undefined);
  assert.equal(blossomAtt!.blossom?.url,      'http://example.test/blob');
  assert.equal(blossomAtt!.blossom?.keyHex,   'b'.repeat(64));
  assert.equal(blossomAtt!.blossom?.nonceHex, 'c'.repeat(24));
});

test('1301: store drops kind 14 and kind 15 rumors silently', () => {
  const store    = new MailStore(tmpDbPath());
  const alicePub = getPublicKey(generateSecretKey());
  const sender   = generateSecretKey();
  const senderPub = getPublicKey(sender);

  // Build a legacy NIP-17 DM (kind 14) and a file message (kind 15)
  // — the store must drop them now that nostr-mail is 1301-only.
  for (const kind of [KIND_DM_RUMOR, KIND_FILE_RUMOR]) {
    const template = {
      pubkey:     senderPub,
      kind,
      created_at: Math.floor(Date.now() / 1000),
      tags:       [['p', alicePub]],
      content:    'legacy content',
    };
    const rumor: Rumor = { ...template, id: getEventHash(template as any) };
    const row = store.insertMessage(rumor, `w-${kind}`, alicePub);
    assert.equal(row, null, `kind ${kind} rumor should not be stored`);
  }

  // No threads in either bucket.
  assert.equal(store.threadSummaries('inbox').length,      0);
  assert.equal(store.threadSummaries('quarantine').length, 0);
});

test('1301: migration drops kind 14/15 rows from an existing DB', () => {
  // First open with a hand-rolled schema that PR-pre-9 builds would
  // have created (no attachments_json column, kind 14/15 rows present).
  const dbPath = tmpDbPath();
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, counterparty TEXT NOT NULL, direction TEXT NOT NULL,
      kind INTEGER NOT NULL, subject TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '', tags_json TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL, read INTEGER NOT NULL DEFAULT 0,
      wrap_id TEXT NOT NULL, received_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'inbox'
    );
    CREATE TABLE seen_wraps (wrap_id TEXT PRIMARY KEY, received_at INTEGER NOT NULL);
    CREATE TABLE mail_allowlist (pubkey TEXT PRIMARY KEY, added_at INTEGER NOT NULL);
    CREATE TABLE mail_blocklist (pubkey TEXT PRIMARY KEY, added_at INTEGER NOT NULL);
    INSERT INTO messages (id, counterparty, direction, kind, body, created_at, wrap_id, received_at)
      VALUES ('a'||hex(randomblob(31)), 'cp1', 'in', 14, 'legacy dm',   1000, 'w-dm',   1000);
    INSERT INTO messages (id, counterparty, direction, kind, body, created_at, wrap_id, received_at)
      VALUES ('b'||hex(randomblob(31)), 'cp2', 'in', 15, 'legacy file', 2000, 'w-file', 2000);
    INSERT INTO messages (id, counterparty, direction, kind, body, created_at, wrap_id, received_at)
      VALUES ('c'||hex(randomblob(31)), 'cp3', 'in', 1301, 'modern email', 3000, 'w-1301', 3000);
  `);
  db.close();

  // Open via MailStore — the constructor's migration must delete the
  // kind 14 and kind 15 rows and leave the kind 1301 row intact.
  const store = new MailStore(dbPath);
  const inbox = store.threadSummaries('inbox');
  assert.equal(inbox.length, 1, 'only the kind-1301 row should survive');
  assert.equal(inbox[0].counterparty, 'cp3');
});
