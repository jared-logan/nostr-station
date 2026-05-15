/**
 * NIP-32 labels for folder + read-state sync across devices.
 *
 * Each label is a kind 1985 event signed by the station owner that
 * references a rumor id via an `e` tag and carries the label value
 * via the `L` (namespace) + `l` (value, namespace) tag pair.
 *
 *   ["L", "nostr-mail/folder"]
 *   ["l", "archive", "nostr-mail/folder"]
 *   ["e", "<rumor-id>"]
 *
 *   ["L", "nostr-mail/read"]
 *   ["l", "read", "nostr-mail/read"]
 *   ["e", "<rumor-id>"]
 *
 * Why label the RUMOR id and not the gift wrap id: the rumor id is
 * locally computed from the unsigned rumor and never published to any
 * relay. It's a deterministic identifier the recipient (us) and the
 * sender both know, but is meaningless to passive observers. The gift
 * wrap id, by contrast, is on the wire; labeling it would let a relay
 * correlate "user did X with wrap id Y" with the wrap they already
 * see. The rumor id approach gives an outside observer nothing.
 *
 * The kind 1985 events themselves go out unwrapped — they're plaintext
 * because their payload (a rumor id + a string label) leaks no useful
 * information. This is the same trade-off NIP-51 lists, NIP-65 relay
 * lists, and most other "user metadata" kinds make.
 */

import type { NostrEvent } from './types.js';
import {
  KIND_LABEL, LABEL_NS_FOLDER, LABEL_NS_READ,
} from './types.js';
import { signEventWithSavedBunker } from '../auth-bunker.js';
import { publishEventToRelays } from '../routes/repo.js';
import { readInboxRelays } from './inbox-relays.js';

export interface ParsedLabel {
  rumorId:    string;
  namespace:  string;
  value:      string;
  created_at: number;
  authorPubkey: string;
}

/**
 * Pull the (rumor-id, namespace, value) triple out of a kind 1985.
 * Returns null when the event doesn't match the shape we emit (NIP-32
 * is fairly permissive; we only consume our own labels here).
 */
export function parseLabel(event: NostrEvent): ParsedLabel | null {
  if (event.kind !== KIND_LABEL) return null;
  const eTag = event.tags.find(t => t[0] === 'e' && typeof t[1] === 'string');
  const lTag = event.tags.find(t => t[0] === 'l' && typeof t[1] === 'string' && typeof t[2] === 'string');
  if (!eTag || !lTag) return null;
  const rumorId   = eTag[1];
  const value     = lTag[1];
  const namespace = lTag[2];
  if (!/^[0-9a-f]{64}$/i.test(rumorId)) return null;
  if (namespace !== LABEL_NS_FOLDER && namespace !== LABEL_NS_READ) return null;
  return {
    rumorId, namespace, value,
    created_at:   event.created_at,
    authorPubkey: event.pubkey,
  };
}

/**
 * Build (but don't publish) a kind 1985 label event template ready to
 * hand to Amber. created_at must be strictly newer than any prior
 * local label for the same (rumor, namespace) — callers pass it via
 * `seedCreatedAt` so a clock skew doesn't accidentally produce a
 * label that loses to its predecessor.
 */
export function buildLabelTemplate(
  rumorId:        string,
  namespace:      typeof LABEL_NS_FOLDER | typeof LABEL_NS_READ,
  value:          string,
  seedCreatedAt?: number,
): { kind: number; created_at: number; tags: string[][]; content: string } {
  const nowS = Math.floor(Date.now() / 1000);
  const created_at = seedCreatedAt && seedCreatedAt >= nowS ? seedCreatedAt + 1 : nowS;
  return {
    kind: KIND_LABEL,
    created_at,
    tags: [
      ['L', namespace],
      ['l', value, namespace],
      ['e', rumorId],
    ],
    content: '',
  };
}

/**
 * Sign the label via Amber and publish to the user's own inbox relays
 * (so all the user's devices see it). Best-effort — returns the per-
 * relay result list so the caller can surface "saved locally but not
 * yet published" if the publish fails.
 */
export async function publishLabel(
  rumorId:        string,
  namespace:      typeof LABEL_NS_FOLDER | typeof LABEL_NS_READ,
  value:          string,
  seedCreatedAt?: number,
): Promise<{ ok: boolean; event?: NostrEvent; results?: any[]; error?: string }> {
  const template = buildLabelTemplate(rumorId, namespace, value, seedCreatedAt);
  const signed = await signEventWithSavedBunker(template);
  if (!signed.ok || !signed.signedEvent) {
    return { ok: false, error: signed.error || 'bunker signature unavailable' };
  }
  const targets = readInboxRelays();
  const results = await publishEventToRelays(signed.signedEvent as NostrEvent, targets);
  const okCount = results.filter(r => r.ok).length;
  return {
    ok:      okCount > 0,
    event:   signed.signedEvent as NostrEvent,
    results,
  };
}
