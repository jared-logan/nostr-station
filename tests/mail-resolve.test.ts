/**
 * resolveRecipient tests.
 *
 * Pubkey shapes (npub / hex) we can test offline. The NIP-05 + kind 10050
 * lookup paths hit the network; we don't exercise them here — they're
 * covered indirectly by the manual end-to-end verification step in the
 * plan. The negative-input cases (empty, garbage) do run.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { nip19 } from 'nostr-tools';
import { resolveRecipient, RecipientError } from '../src/lib/mail/resolve.js';

// In offline test mode the kind 10050 lookup will fail (network down).
// resolveRecipient returns inboxRelays=[] in that case rather than
// throwing — the send pipeline surfaces a warning to the user. The tests
// below assert that the npub/hex paths still succeed regardless.

test('resolve: bech32 npub decodes to lowercase hex', async () => {
  const sk     = generateSecretKey();
  const hex    = getPublicKey(sk);
  const npub   = nip19.npubEncode(hex);
  const r      = await resolveRecipient(npub);
  assert.equal(r.pubkey,    hex.toLowerCase());
  assert.equal(r.inputForm, npub);
  assert.ok(Array.isArray(r.inboxRelays));
});

test('resolve: 64-char hex is accepted verbatim', async () => {
  const hex = 'A'.repeat(64);  // mixed case to confirm lowercasing
  const r   = await resolveRecipient(hex);
  assert.equal(r.pubkey, hex.toLowerCase());
});

test('resolve: empty input throws RecipientError', async () => {
  await assert.rejects(() => resolveRecipient(''),         RecipientError);
  await assert.rejects(() => resolveRecipient('   '),      RecipientError);
});

test('resolve: garbage input throws with a helpful message', async () => {
  await assert.rejects(
    () => resolveRecipient('not an address'),
    (e: any) => e instanceof RecipientError && /unrecognised recipient/i.test(e.message),
  );
});

test('resolve: malformed npub throws', async () => {
  await assert.rejects(
    () => resolveRecipient('npub1xxxxxxx'),
    (e: any) => e instanceof RecipientError && /could not decode npub/i.test(e.message),
  );
});
