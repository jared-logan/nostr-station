/**
 * Type shapes for the NIP-17 + NIP-59 mail pipeline.
 *
 * NIP-17 ("Private DMs") stacks three event kinds:
 *
 *   1. Rumor (kind 14 for DMs, kind 15 for file messages) — the plaintext
 *      payload. Authored by the user's pubkey, given a deterministic id,
 *      but never signed. The unsigned form prevents the rumor from being
 *      verifiable in isolation if it ever leaks.
 *
 *   2. Seal (kind 13) — signed by the user. content is the rumor JSON
 *      NIP-44-encrypted to the recipient. Reveals the sender's identity
 *      to whoever can decrypt it (the recipient).
 *
 *   3. Gift wrap (kind 1059) — signed by an ephemeral, single-use key.
 *      content is the seal JSON NIP-44-encrypted to the recipient.
 *      Carries a `p` tag pointing at the recipient. The ephemeral signer
 *      hides the sender from relays and any third party that can see
 *      the gift wrap; only the recipient can peel it.
 *
 * Timestamps on the seal and the gift wrap are randomised backwards up
 * to 2 days from "now" to defeat correlation by timing — only the
 * rumor's created_at is trustworthy for ordering in the UI.
 */

import type { NostrEvent } from '../nostr-query.js';

export const KIND_SEAL          = 13;
export const KIND_DM_RUMOR      = 14;
export const KIND_FILE_RUMOR    = 15;
export const KIND_GIFT_WRAP     = 1059;
export const KIND_INBOX_RELAYS  = 10050;

// An unsigned rumor — pubkey + id are set, sig is intentionally absent.
// Matches what nostr-tools/nip59.createRumor() produces.
export interface Rumor {
  id:         string;
  pubkey:     string;
  kind:       number;
  created_at: number;
  tags:       string[][];
  content:    string;
}

// One decrypted, verified incoming mail extracted from a gift wrap.
export interface DecryptedMail {
  // The rumor's signer — the actual sender's pubkey (NOT the gift wrap
  // pubkey, which is ephemeral and meaningless past delivery).
  senderPubkey: string;
  rumor:        Rumor;
  // Pubkey on the seal layer. Per NIP-17, must equal `senderPubkey`;
  // we reject the gift wrap when they disagree so a malicious relay
  // (or middlebox) can't impersonate a sender by swapping the seal.
  sealPubkey:   string;
  // The gift-wrap event we decoded from. Useful for caller-side
  // dedup / "already seen this id" checks.
  wrapId:       string;
}

// Subset of a kind-14 rumor's tag set that we surface in the UI.
export interface MailHeaders {
  subject?: string;
  // NIP-17 reply chains: ["e", <rumor-id>] points at the parent rumor.
  replyTo?: string;
}

export type { NostrEvent };
