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
// Legacy: NIP-17 DM (14) + file message (15). Pre-PR-9 builds used
// these for the mail panel; the worker now drops them on receive and
// the store's startup migration deletes any rows left behind. The
// constants are kept (no callers reference them post-migration) so a
// future "Direct Messages" panel can re-import them without inventing
// fresh numbers — they remain the canonical NIP-17 kinds.
export const KIND_DM_RUMOR      = 14;
export const KIND_FILE_RUMOR    = 15;
// Active wire kind for nostr-mail. Carries an RFC 2822 message
// (headers + body, optionally multipart with attachments) inside the
// content field. Wrapped end-to-end via the existing NIP-59 pipeline.
// Matches the format nogringo/nostr-mail's SDK emits + parses.
export const KIND_EMAIL         = 1301;
export const KIND_GIFT_WRAP     = 1059;
export const KIND_INBOX_RELAYS  = 10050;
// Smart Syncing (PR 10):
//   - 1985 = NIP-32 generic label. Used to sync folder + read-state
//            across the user's devices by labelling the rumor id (NOT
//            the gift wrap id — the rumor id is local-only and reveals
//            nothing to relay observers).
//   - 30078 = NIP-78 application-specific replaceable. d-tag value
//             "nostr-mail:settings" carries the user's mail prefs
//             (inbox relays, custom folder list, …) as JSON.
export const KIND_LABEL         = 1985;
export const KIND_APP_DATA      = 30078;

// NIP-32 namespaces we use. The namespace is also the L tag value;
// the label itself goes in the `l` tag's second slot.
export const LABEL_NS_FOLDER = 'nostr-mail/folder';
export const LABEL_NS_READ   = 'nostr-mail/read';

// NIP-78 d-tag for our settings blob. The dataset is parameterized-
// replaceable on (kind, pubkey, d), so publishing a new one supersedes
// the prior version atomically.
export const APP_DATA_D_SETTINGS = 'nostr-mail:settings';

// Default folder identifiers. Custom folders are arbitrary strings the
// user picks; these reserved values back the UI's well-known folders.
export const DEFAULT_FOLDERS = ['inbox', 'sent', 'archive', 'trash'] as const;
export type DefaultFolder = typeof DEFAULT_FOLDERS[number];

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
