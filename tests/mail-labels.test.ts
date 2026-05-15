/**
 * NIP-32 label tests (PR 10 — Smart Syncing).
 *
 * Covers parsing, building, and the store's last-write-wins
 * application logic. Publish-side (sign via Amber + broadcast) isn't
 * tested here — that's exercised end-to-end with a paired bunker.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { generateSecretKey, getPublicKey, finalizeEvent, getEventHash } from 'nostr-tools/pure';
import { MailStore } from '../src/lib/mail/store.js';
import {
  parseLabel, buildLabelTemplate,
} from '../src/lib/mail/labels.js';
import {
  KIND_LABEL, KIND_EMAIL, LABEL_NS_FOLDER, LABEL_NS_READ, type Rumor,
} from '../src/lib/mail/types.js';
import { buildMessage, mintMessageId } from '../src/lib/mail/rfc2822.js';

function tmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-labels-'));
  return path.join(dir, 'mail.db');
}

function makeStoredEmail(store: MailStore, opts: {
  from?: Uint8Array; to: string; content: string; folder?: string;
}): Rumor {
  const secret = opts.from ?? generateSecretKey();
  const pubkey = getPublicKey(secret);
  const rfc = buildMessage({
    fromPubkey: pubkey, toPubkey: opts.to,
    subject: 's', body: opts.content, messageId: mintMessageId(),
  });
  const created_at = Math.floor(Date.now() / 1000);
  const template = {
    pubkey, kind: KIND_EMAIL, created_at,
    tags: [['p', opts.to]], content: rfc,
  };
  const rumor: Rumor = { ...template, id: getEventHash(template as any) };
  store.insertMessage(rumor, 'wrap-' + rumor.id.slice(0, 8), opts.to);
  if (opts.folder) store.setFolder(rumor.id, opts.folder);
  return rumor;
}

test('labels: parseLabel reads back a folder label', () => {
  const rumorId = 'a'.repeat(64);
  const sk = generateSecretKey();
  const tpl = buildLabelTemplate(rumorId, LABEL_NS_FOLDER, 'archive');
  const signed = finalizeEvent(tpl, sk);
  const parsed = parseLabel(signed as any);
  assert.ok(parsed);
  assert.equal(parsed!.rumorId,   rumorId);
  assert.equal(parsed!.namespace, LABEL_NS_FOLDER);
  assert.equal(parsed!.value,     'archive');
  assert.equal(parsed!.authorPubkey, getPublicKey(sk));
});

test('labels: parseLabel rejects unknown namespaces', () => {
  const rumorId = 'a'.repeat(64);
  const tpl = {
    kind: KIND_LABEL,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['L', 'foo.bar/random'], ['l', 'whatever', 'foo.bar/random'], ['e', rumorId]],
    content: '',
  };
  const signed = finalizeEvent(tpl, generateSecretKey());
  assert.equal(parseLabel(signed as any), null);
});

test('labels: parseLabel rejects events with no e tag', () => {
  const tpl = {
    kind: KIND_LABEL,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['L', LABEL_NS_FOLDER], ['l', 'inbox', LABEL_NS_FOLDER]],
    content: '',
  };
  const signed = finalizeEvent(tpl, generateSecretKey());
  assert.equal(parseLabel(signed as any), null);
});

test('labels: buildLabelTemplate bumps created_at past a stale seed', () => {
  const future = Math.floor(Date.now() / 1000) + 86400;  // a day from now
  const tpl = buildLabelTemplate('a'.repeat(64), LABEL_NS_READ, 'read', future);
  assert.equal(tpl.created_at, future + 1,
    'when the seed is already > now, we emit seed+1 so the new label wins');
});

test('labels: store.applyLabel moves a message to the target folder', () => {
  const store = new MailStore(tmpDbPath());
  const alicePub = getPublicKey(generateSecretKey());
  const r = makeStoredEmail(store, { to: alicePub, content: 'hi' });

  // Default folder after insert.
  assert.equal(store.messageById(r.id)?.folder, 'inbox');

  const applied = store.applyLabel(r.id, LABEL_NS_FOLDER, 'archive', Math.floor(Date.now() / 1000));
  assert.equal(applied, true);
  assert.equal(store.messageById(r.id)?.folder, 'archive');
});

test('labels: store.applyLabel is last-write-wins on created_at', () => {
  const store = new MailStore(tmpDbPath());
  const alicePub = getPublicKey(generateSecretKey());
  const r = makeStoredEmail(store, { to: alicePub, content: 'hi' });

  store.applyLabel(r.id, LABEL_NS_FOLDER, 'archive', 100);
  assert.equal(store.messageById(r.id)?.folder, 'archive');

  // Older label loses.
  const olderApplied = store.applyLabel(r.id, LABEL_NS_FOLDER, 'inbox', 50);
  assert.equal(olderApplied, false);
  assert.equal(store.messageById(r.id)?.folder, 'archive');

  // Newer label wins.
  const newerApplied = store.applyLabel(r.id, LABEL_NS_FOLDER, 'trash', 200);
  assert.equal(newerApplied, true);
  assert.equal(store.messageById(r.id)?.folder, 'trash');
});

test('labels: store.applyLabel flips the read flag on read label', () => {
  const store = new MailStore(tmpDbPath());
  const alicePub = getPublicKey(generateSecretKey());
  const r = makeStoredEmail(store, { to: alicePub, content: 'hi' });
  assert.equal(store.messageById(r.id)?.read, false);
  store.applyLabel(r.id, LABEL_NS_READ, 'read', Math.floor(Date.now() / 1000));
  assert.equal(store.messageById(r.id)?.read, true);
});

test('labels: folder labels arriving BEFORE the rumor are still respected on insert', () => {
  // Simulates the edge case where the label event arrives on a relay
  // faster than the gift-wrap. The worker's handleLabel will call
  // applyLabel which seeds mail_labels; later when the rumor's gift
  // wrap arrives and insertMessage runs, it should pick up the
  // pre-applied folder rather than defaulting to 'inbox'.
  const store = new MailStore(tmpDbPath());
  const alicePub = getPublicKey(generateSecretKey());

  // 1. Label lands first — no row yet for the rumor.
  const rumorId = 'b'.repeat(64);
  store.applyLabel(rumorId, LABEL_NS_FOLDER, 'archive', Math.floor(Date.now() / 1000));

  // 2. Rumor arrives. We build it with the same id by tweaking the
  //    inputs until the hash matches (deterministic for our test
  //    we just confirm the lookup path runs — easier to fabricate a
  //    realistic rumor and apply the label against IT first).
  const bob = generateSecretKey();
  const tpl = {
    pubkey:     getPublicKey(bob),
    kind:       KIND_EMAIL,
    created_at: Math.floor(Date.now() / 1000),
    tags:       [['p', alicePub]],
    content:    buildMessage({
      fromPubkey: getPublicKey(bob), toPubkey: alicePub,
      subject: 's', body: 'hi', messageId: mintMessageId(),
    }),
  };
  const rumor: Rumor = { ...tpl, id: getEventHash(tpl as any) };
  // Re-seed: label uses the actual rumor id.
  store.applyLabel(rumor.id, LABEL_NS_FOLDER, 'archive', Math.floor(Date.now() / 1000));
  // Now insert.
  const inserted = store.insertMessage(rumor, 'w-1', alicePub);
  assert.equal(inserted?.folder, 'archive');
});

test('labels: threadSummariesInFolder filters correctly', () => {
  const store = new MailStore(tmpDbPath());
  const alicePub = getPublicKey(generateSecretKey());

  const r1 = makeStoredEmail(store, { to: alicePub, content: 'one' });
  const r2 = makeStoredEmail(store, { to: alicePub, content: 'two' });
  store.setFolder(r2.id, 'archive');

  assert.equal(store.threadSummariesInFolder('inbox', 'inbox').length,   1);
  assert.equal(store.threadSummariesInFolder('inbox', 'archive').length, 1);
  assert.equal(store.threadSummariesInFolder('inbox', 'trash').length,   0);
});
