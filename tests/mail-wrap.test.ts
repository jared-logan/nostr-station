/**
 * Round-trip + sanity tests for the NIP-17 gift-wrap pipeline.
 *
 * Exercises buildGiftWrap / unwrapGift with two LocalSigner instances
 * standing in for sender and recipient. The same pipeline runs in
 * production with AmberSigner — that path can't be unit-tested without
 * a paired Amber session, so it's covered indirectly via the end-to-end
 * verification described in the plan.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { verifyEvent } from 'nostr-tools/pure';

import { LocalSigner } from '../src/lib/mail/signer.js';
import { buildGiftWrap, unwrapGift, buildGiftWrapPair } from '../src/lib/mail/wrap.js';
import {
  KIND_SEAL, KIND_EMAIL, KIND_GIFT_WRAP,
} from '../src/lib/mail/types.js';

function makePair() {
  const aliceSecret = generateSecretKey();
  const bobSecret   = generateSecretKey();
  return {
    aliceSecret,
    bobSecret,
    alicePub: getPublicKey(aliceSecret),
    bobPub:   getPublicKey(bobSecret),
    alice:    new LocalSigner(aliceSecret),
    bob:      new LocalSigner(bobSecret),
  };
}

test('round-trip: alice → bob recovers identical rumor', async () => {
  const { alice, bob, alicePub, bobPub } = makePair();

  const tpl = {
    kind:    KIND_EMAIL,
    content: 'hello bob',
    tags:    [
      ['p',       bobPub],
      ['subject', 'Re: lunch tomorrow?'],
    ],
  };

  const { rumor, wrap } = await buildGiftWrap(tpl, bobPub, alice);

  // Outer shape: kind 1059, signed by SOME ephemeral key (not alice).
  assert.equal(wrap.kind, KIND_GIFT_WRAP);
  assert.notEqual(wrap.pubkey, alicePub, 'wrap pubkey must be ephemeral, not sender');
  assert.notEqual(wrap.pubkey, bobPub,   'wrap pubkey must be ephemeral, not recipient');
  assert.equal(verifyEvent(wrap as any), true, 'wrap must verify against its own sig');

  // p tag points at bob so relays can route.
  const pTag = wrap.tags.find(t => t[0] === 'p');
  assert.deepEqual(pTag, ['p', bobPub]);

  // Bob unwraps.
  const decrypted = await unwrapGift(wrap, bob);
  assert.equal(decrypted.senderPubkey, alicePub, 'sender must be recovered from seal');
  assert.equal(decrypted.sealPubkey,   alicePub);
  assert.equal(decrypted.wrapId,       wrap.id);

  // Rumor content survives intact.
  assert.equal(decrypted.rumor.content, 'hello bob');
  assert.equal(decrypted.rumor.kind,    KIND_EMAIL);
  assert.equal(decrypted.rumor.pubkey,  alicePub);
  assert.equal(decrypted.rumor.id,      rumor.id);
  // Subject tag preserved.
  assert.deepEqual(
    decrypted.rumor.tags.find(t => t[0] === 'subject'),
    ['subject', 'Re: lunch tomorrow?'],
  );
});

test('wrap pubkey is unique per send (ephemeral, never reused)', async () => {
  const { alice, bobPub } = makePair();
  const tpl = { kind: KIND_EMAIL, content: 'one', tags: [['p', bobPub]] };

  const a = await buildGiftWrap(tpl, bobPub, alice);
  const b = await buildGiftWrap(tpl, bobPub, alice);
  const c = await buildGiftWrap(tpl, bobPub, alice);

  assert.notEqual(a.wrap.pubkey, b.wrap.pubkey);
  assert.notEqual(b.wrap.pubkey, c.wrap.pubkey);
  assert.notEqual(a.wrap.pubkey, c.wrap.pubkey);
});

test('seal under the wrap is kind 13, signed by sender, verifies', async () => {
  const { alice, bob, alicePub, bobPub } = makePair();
  const tpl = { kind: KIND_EMAIL, content: 'seal-check', tags: [['p', bobPub]] };
  const { wrap } = await buildGiftWrap(tpl, bobPub, alice);

  // We need to peek INSIDE the wrap to verify the seal — easiest path is
  // to nip44_decrypt the wrap content with bob's signer (we control bob
  // in this test). In production the unwrapGift() helper does this; we
  // re-do it inline here to assert on the seal's shape directly.
  const sealJson = await bob.nip44Decrypt(wrap.pubkey, wrap.content);
  const seal     = JSON.parse(sealJson);
  assert.equal(seal.kind,   KIND_SEAL);
  assert.equal(seal.pubkey, alicePub);
  assert.equal(seal.tags.length, 0, 'seal must have empty tags (NIP-17 §Seal)');
  assert.equal(verifyEvent(seal), true);
});

test('rumor created_at is preserved through the round trip', async () => {
  // The wrap + seal timestamps are randomised backward up to 2 days by
  // design; only the rumor's created_at carries trustworthy ordering.
  // This test pins down a specific created_at and checks it survives.
  const { alice, bob, bobPub } = makePair();
  const fixedAt = 1735689600;  // 2025-01-01 00:00:00 UTC
  const tpl = {
    kind:       KIND_EMAIL,
    content:    'fixed-time',
    tags:       [['p', bobPub]],
    created_at: fixedAt,
  };
  const { wrap } = await buildGiftWrap(tpl, bobPub, alice);
  const decrypted = await unwrapGift(wrap, bob);
  assert.equal(decrypted.rumor.created_at, fixedAt);

  // The wrap's outer created_at is fuzzed — assert it's NOT equal to the
  // rumor's, with high probability. (Fuzz window is 2 days; equality
  // would require the random offset to be exactly 0, p ≈ 1/172800.)
  assert.notEqual(wrap.created_at, fixedAt);
});

test('unwrap rejects a wrap aimed at a different recipient', async () => {
  const { alice, bobPub } = makePair();
  const { bob: charlie } = makePair();  // a different identity

  const tpl = { kind: KIND_EMAIL, content: 'for-bob', tags: [['p', bobPub]] };
  const { wrap } = await buildGiftWrap(tpl, bobPub, alice);

  // Charlie tries to unwrap a wrap addressed to bob — nip44 decrypt fails
  // (conversation key derives differently) and we throw a generic error.
  await assert.rejects(
    () => unwrapGift(wrap, charlie),
    /outer decrypt failed/,
  );
});

test('unwrap rejects a tampered seal pubkey (anti-spoof guard)', async () => {
  // We construct a malicious wrap where the seal claims one author but
  // the rumor inside claims another, simulating a relay-side attempt to
  // forge sender attribution. unwrapGift must reject.
  const { alice, bob, bobPub, alicePub } = makePair();
  const { aliceSecret: malloryPrivkey } = makePair();
  const malloryPub = getPublicKey(malloryPrivkey);

  // Build a normal wrap from alice to bob — this gives us a valid seal.
  const tpl = { kind: KIND_EMAIL, content: 'genuine', tags: [['p', bobPub]] };
  const { wrap } = await buildGiftWrap(tpl, bobPub, alice);

  // Peek inside, rewrite the rumor's pubkey to mallory, and re-seal +
  // re-wrap as alice (so the seal signature still verifies but the
  // rumor's claimed author is a lie).
  const sealJson = await bob.nip44Decrypt(wrap.pubkey, wrap.content);
  const seal     = JSON.parse(sealJson);
  const rumorJson = await bob.nip44Decrypt(seal.pubkey, seal.content);
  const tamperedRumor = { ...JSON.parse(rumorJson), pubkey: malloryPub };
  const tamperedRumorJson = JSON.stringify(tamperedRumor);

  // Re-seal with alice (so seal.pubkey = alice), then re-wrap.
  const tamperedSealContent = await alice.nip44Encrypt(bobPub, tamperedRumorJson);
  const tamperedSeal = await alice.signEvent({
    kind: KIND_SEAL, created_at: seal.created_at, tags: [], content: tamperedSealContent,
  });
  // Reuse alice's nip44Encrypt for the outer layer too (this isn't how a
  // real attacker would build it — they'd use an ephemeral key — but for
  // this test we just need bob to be able to decrypt it).
  const tamperedWrapContent = await alice.nip44Encrypt(bobPub, JSON.stringify(tamperedSeal));
  const tamperedWrap = await alice.signEvent({
    kind: KIND_GIFT_WRAP, created_at: wrap.created_at,
    tags: [['p', bobPub]], content: tamperedWrapContent,
  });

  await assert.rejects(
    () => unwrapGift(tamperedWrap, bob),
    /rumor pubkey does not match seal signer/,
  );
  // (Also confirms unused alicePub variable; sanity.)
  assert.equal(typeof alicePub, 'string');
});

test('buildGiftWrapPair produces a recipient wrap AND a self wrap', async () => {
  const { alice, bob, alicePub, bobPub } = makePair();
  const tpl = { kind: KIND_EMAIL, content: 'sent-mail', tags: [['p', bobPub]] };

  const { rumor, recipientWrap, selfWrap } = await buildGiftWrapPair(tpl, bobPub, alice);

  // Both wraps are kind 1059 with ephemeral signers.
  assert.equal(recipientWrap.kind, KIND_GIFT_WRAP);
  assert.equal(selfWrap.kind,      KIND_GIFT_WRAP);
  assert.notEqual(recipientWrap.pubkey, selfWrap.pubkey,
    'each wrap should use a distinct ephemeral key');

  // Recipient wrap p-tags bob; self-wrap p-tags alice.
  assert.equal(recipientWrap.tags.find(t => t[0] === 'p')?.[1], bobPub);
  assert.equal(selfWrap.tags     .find(t => t[0] === 'p')?.[1], alicePub);

  // Both peel to the same rumor.
  const byBob   = await unwrapGift(recipientWrap, bob);
  const byAlice = await unwrapGift(selfWrap,      alice);
  assert.equal(byBob.rumor.id,   rumor.id);
  assert.equal(byAlice.rumor.id, rumor.id);
  assert.equal(byBob.rumor.content,   'sent-mail');
  assert.equal(byAlice.rumor.content, 'sent-mail');
});
