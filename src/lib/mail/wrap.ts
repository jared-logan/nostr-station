/**
 * NIP-17 + NIP-59 wrap / unwrap pipeline.
 *
 * Two operations:
 *
 *   buildGiftWrap(template, recipientPubkey, signer)
 *     Wraps the user's plaintext rumor for a single recipient. Returns
 *     a signed kind-1059 event ready to publish to the recipient's
 *     inbox relays. The same rumor must be wrapped again separately for
 *     the sender (so sent-mail shows up in their own inbox view across
 *     devices) — call buildGiftWrap a second time with the sender's
 *     own pubkey as `recipientPubkey`.
 *
 *   unwrapGift(wrap, signer)
 *     Peels a kind-1059 received from a relay. Returns the rumor + the
 *     verified sender pubkey, or throws if the seal/rumor mismatch
 *     suggests tampering. The wrap's signer is ephemeral and MUST NOT be
 *     trusted as the sender — only the seal pubkey identifies them.
 *
 * Timestamps on the seal and the gift wrap are randomised up to 2 days
 * before "now" per NIP-59 §"Timestamp tweaking". The rumor's
 * created_at stays at the caller-provided value (default: now), and
 * UIs should sort by THAT field — never the wrap's outer created_at.
 */

import { generateSecretKey, getPublicKey, getEventHash } from 'nostr-tools/pure';
import { nip44 } from 'nostr-tools';
import type { Signer } from './signer.js';
import {
  KIND_SEAL, KIND_GIFT_WRAP,
  type Rumor, type DecryptedMail, type NostrEvent,
} from './types.js';

// Per NIP-59: randomise the outer + seal timestamps backwards by up to
// 2 days from "now" so a passive observer cannot use timing to
// correlate a sent event with the moment a user pressed Send.
const TIMESTAMP_FUZZ_WINDOW_S = 2 * 24 * 60 * 60;

function fuzzedNow(): number {
  const nowS = Math.floor(Date.now() / 1000);
  return nowS - Math.floor(Math.random() * TIMESTAMP_FUZZ_WINDOW_S);
}

// Rumor template the caller hands us. id + pubkey are filled in by
// buildGiftWrap (id comes from getEventHash after we stamp pubkey).
export interface RumorTemplate {
  kind:        number;
  content:     string;
  tags:        string[][];
  // Optional override. Defaults to now (in seconds) — UIs sort by this.
  created_at?: number;
}

/**
 * Build a NIP-17 gift-wrapped event. The caller supplies a partially-
 * complete rumor template; this function:
 *   1) Stamps the rumor with the user's pubkey + a computed id (unsigned).
 *   2) Seals the rumor: NIP-44-encrypts rumor JSON to the recipient using
 *      the user's key (via Signer.nip44Encrypt) and asks the Signer to
 *      sign a kind-13 carrying the ciphertext.
 *   3) Wraps the seal: generates a one-shot ephemeral keypair, NIP-44-
 *      encrypts the seal JSON to the recipient with that ephemeral key,
 *      and signs the kind-1059 locally with the ephemeral key. The user
 *      key is NOT exposed at this layer — only the recipient (via their
 *      private key) can reach the seal underneath.
 *
 * Returns the rumor (for caller-side bookkeeping — local "sent" rows
 * record the rumor, not the wrap) and the wrap (to publish).
 */
export async function buildGiftWrap(
  template:        RumorTemplate,
  recipientPubkey: string,
  signer:          Signer,
): Promise<{ rumor: Rumor; wrap: NostrEvent }> {
  if (!/^[0-9a-f]{64}$/i.test(recipientPubkey)) {
    throw new Error('buildGiftWrap: recipient pubkey must be 64-char hex');
  }

  const senderPubkey = await signer.getPublicKey();
  if (!/^[0-9a-f]{64}$/i.test(senderPubkey)) {
    throw new Error(`buildGiftWrap: signer returned invalid pubkey: ${senderPubkey}`);
  }

  // ── 1) Rumor ──────────────────────────────────────────────────────────
  const rumorTemplate = {
    pubkey:     senderPubkey,
    created_at: template.created_at ?? Math.floor(Date.now() / 1000),
    kind:       template.kind,
    tags:       template.tags.map(t => t.slice()),
    content:    template.content,
  };
  const rumor: Rumor = {
    ...rumorTemplate,
    id: getEventHash(rumorTemplate as any),
  };

  // ── 2) Seal (kind 13) — signed by the user via Signer ────────────────
  const sealCiphertext = await signer.nip44Encrypt(recipientPubkey, JSON.stringify(rumor));
  const seal = await signer.signEvent({
    kind:       KIND_SEAL,
    created_at: fuzzedNow(),
    tags:       [],
    content:    sealCiphertext,
  });

  // ── 3) Gift wrap (kind 1059) — signed locally by an ephemeral key ─────
  // The ephemeral key is generated here, used once, never persisted.
  // Anyone who can later compromise our process gains nothing from this
  // material: it was only ever used to sign a single 1059 event whose
  // outer pubkey is already public on the wire.
  const ephemeralSecret = generateSecretKey();
  const ephemeralPubkey = getPublicKey(ephemeralSecret);
  const wrapKey = nip44.v2.utils.getConversationKey(ephemeralSecret, recipientPubkey);
  const wrapCiphertext = nip44.v2.encrypt(JSON.stringify(seal), wrapKey);

  // Lift finalizeEvent inline so the wrap fully completes without
  // touching the user key in any form. (We can't use the helper from
  // local-signer.ts here — it carries the test-identity client tag
  // safety story which doesn't apply to ephemeral wrap signers.)
  const { finalizeEvent } = await import('nostr-tools/pure');
  const wrap = finalizeEvent({
    kind:       KIND_GIFT_WRAP,
    created_at: fuzzedNow(),
    tags:       [['p', recipientPubkey]],
    content:    wrapCiphertext,
  }, ephemeralSecret) as unknown as NostrEvent;

  // Defence-in-depth: explicitly check that the wrap's pubkey is the
  // ephemeral one we just generated and NOT the user's. A bug in
  // finalizeEvent that ever signed with a leaked key would be a
  // catastrophic privacy regression — assert here to fail fast in dev.
  if (wrap.pubkey !== ephemeralPubkey) {
    throw new Error(`buildGiftWrap: wrap pubkey mismatch (got ${wrap.pubkey}, expected ${ephemeralPubkey})`);
  }
  if (wrap.pubkey === senderPubkey) {
    throw new Error('buildGiftWrap: wrap accidentally signed with sender key');
  }

  return { rumor, wrap };
}

/**
 * Peel a NIP-17 gift wrap. On success returns the rumor + the verified
 * sender pubkey (from the seal layer, not the wrap layer). Throws on
 * any structural mismatch — callers should treat thrown wraps as
 * "skip silently" rather than surface to the user, since malformed
 * gift wraps are routine background noise from spammy senders.
 */
export async function unwrapGift(
  wrap:   NostrEvent,
  signer: Signer,
): Promise<DecryptedMail> {
  if (wrap.kind !== KIND_GIFT_WRAP) {
    throw new Error(`unwrapGift: expected kind ${KIND_GIFT_WRAP}, got ${wrap.kind}`);
  }
  if (!wrap.id || !wrap.pubkey || typeof wrap.content !== 'string') {
    throw new Error('unwrapGift: wrap missing id/pubkey/content');
  }

  // The wrap was encrypted with shared(ephemeral_priv, recipient_pub).
  // From our side we need shared(recipient_priv, ephemeral_pub), which
  // is the same key by symmetry of getConversationKey. The signer's
  // nip44Decrypt takes the third-party pubkey (= the wrap's pubkey).
  let sealJson: string;
  try {
    sealJson = await signer.nip44Decrypt(wrap.pubkey, wrap.content);
  } catch (e: any) {
    throw new Error(`unwrapGift: outer decrypt failed: ${e?.message || e}`);
  }

  let seal: any;
  try {
    seal = JSON.parse(sealJson);
  } catch {
    throw new Error('unwrapGift: outer payload was not JSON');
  }
  if (!seal || seal.kind !== KIND_SEAL) {
    throw new Error(`unwrapGift: outer payload was not a kind-${KIND_SEAL} seal`);
  }
  if (typeof seal.pubkey !== 'string' || typeof seal.content !== 'string') {
    throw new Error('unwrapGift: seal missing pubkey/content');
  }

  // ── Peel the seal ─────────────────────────────────────────────────────
  let rumorJson: string;
  try {
    rumorJson = await signer.nip44Decrypt(seal.pubkey, seal.content);
  } catch (e: any) {
    throw new Error(`unwrapGift: inner decrypt failed: ${e?.message || e}`);
  }

  let rumor: any;
  try {
    rumor = JSON.parse(rumorJson);
  } catch {
    throw new Error('unwrapGift: inner payload was not JSON');
  }
  if (!rumor || typeof rumor.kind !== 'number' || typeof rumor.pubkey !== 'string') {
    throw new Error('unwrapGift: rumor missing kind/pubkey');
  }

  // Anti-spoof: per NIP-17 §"Decryption" the rumor's claimed author MUST
  // equal the seal's signer. A mismatch means whoever sealed this rumor
  // didn't author it, which is the exact shape of a relay-side replay
  // attempting to spoof the sender. Drop it.
  if (rumor.pubkey.toLowerCase() !== seal.pubkey.toLowerCase()) {
    throw new Error('unwrapGift: rumor pubkey does not match seal signer');
  }

  return {
    senderPubkey: seal.pubkey.toLowerCase(),
    rumor:        rumor as Rumor,
    sealPubkey:   seal.pubkey.toLowerCase(),
    wrapId:       wrap.id,
  };
}

/**
 * Convenience: wrap one rumor for both the recipient AND the sender, so
 * the sender's own inbox view shows their sent mail. Returns both wraps
 * and the rumor. Callers then publish each wrap to the corresponding
 * relay set (recipient's inbox relays vs. sender's own).
 */
export async function buildGiftWrapPair(
  template:        RumorTemplate,
  recipientPubkey: string,
  signer:          Signer,
): Promise<{ rumor: Rumor; recipientWrap: NostrEvent; selfWrap: NostrEvent }> {
  // Build the recipient wrap first so the rumor is computed once.
  const a = await buildGiftWrap(template, recipientPubkey, signer);
  const senderPubkey = a.rumor.pubkey;
  // Self-wrap uses the SAME rumor (same id, same content) but a fresh
  // seal + fresh ephemeral wrap key. We can't simply re-use the
  // recipient seal here because the seal ciphertext is keyed to the
  // recipient — the user couldn't decrypt their own copy.
  const b = await buildGiftWrap(
    {
      kind:       template.kind,
      content:    template.content,
      tags:       template.tags,
      created_at: a.rumor.created_at,
    },
    senderPubkey,
    signer,
  );
  // Sanity: rumor ids must match. If they don't, a clock or pubkey
  // changed between the two calls and the two wraps would land in
  // different threads on the receive side.
  if (a.rumor.id !== b.rumor.id) {
    throw new Error('buildGiftWrapPair: rumor id drifted between recipient and self wrap');
  }
  return { rumor: a.rumor, recipientWrap: a.wrap, selfWrap: b.wrap };
}
