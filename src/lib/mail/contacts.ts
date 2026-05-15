/**
 * Contacts cache for mail filtering.
 *
 * Looks up the station owner's NIP-02 kind-3 contact list from their
 * configured read relays and caches the resulting set of pubkeys.
 * Used by the inbox worker to decide whether an incoming gift wrap
 * lands in the user's inbox or the Requests bucket.
 *
 * Cache lifetime: 10 minutes. The user adding a follow on another
 * client won't trigger an immediate spam-bucket re-evaluation, but the
 * impact is bounded — at worst the next mail from a newly-followed
 * pubkey lands in Requests for one cache cycle.
 *
 * Distinct from routes/client.ts's own contacts cache: that one is
 * scoped to the social Client panel and has a 60-second TTL aimed at
 * keyboard-feel feed refreshes. Mail wants a longer lifetime + a
 * different cache key, so we own a separate copy.
 */

import { queryRelaysDirect, type NostrEvent } from '../nostr-query.js';
import { readIdentity, npubToHex } from '../identity.js';

const CONTACTS_CACHE_TTL_MS = 10 * 60_000;
const RELAY_QUERY_TIMEOUT_MS = 8_000;

interface ContactsCacheEntry {
  pubkeys:   Set<string>;
  cachedAt:  number;
}

let _cache: ContactsCacheEntry | null = null;

/**
 * Returns true when `hex` appears in the owner's most recently fetched
 * kind-3 list. On cache miss / network failure, returns false — which
 * intentionally routes the message into Requests rather than Inbox
 * (fail-closed for spam-likely senders, even at the cost of the
 * occasional false-positive on a friend the user follows).
 */
export async function isContact(hex: string): Promise<boolean> {
  const set = await getContacts();
  return set.has(hex.toLowerCase());
}

export async function getContacts(force = false): Promise<Set<string>> {
  const now = Date.now();
  if (!force && _cache && (now - _cache.cachedAt) < CONTACTS_CACHE_TTL_MS) {
    return _cache.pubkeys;
  }
  try {
    const ident = readIdentity();
    if (!ident.npub) return new Set();
    const me = npubToHex(ident.npub).toLowerCase();
    const relays = (ident.readRelays || []).slice(0, 8);
    if (relays.length === 0) {
      // No read relays configured → no source for kind 3. Return empty.
      _cache = { pubkeys: new Set(), cachedAt: now };
      return _cache.pubkeys;
    }
    const r = await queryRelaysDirect({
      filter:    { kinds: [3], authors: [me], limit: 1 },
      relays,
      timeoutMs: RELAY_QUERY_TIMEOUT_MS,
      stream:    false,
      acceptUntil: (evs) => evs.length >= 1,
    });
    // kind 3 is replaceable — pick the newest if the relays returned
    // multiple copies (some still do).
    let newest: NostrEvent | null = null;
    for (const ev of r.events) {
      if (ev.kind !== 3) continue;
      if (!newest || ev.created_at > newest.created_at) newest = ev;
    }
    const set = new Set<string>();
    if (newest) {
      for (const t of newest.tags) {
        if (!Array.isArray(t) || t[0] !== 'p') continue;
        const v = typeof t[1] === 'string' ? t[1].toLowerCase() : '';
        if (/^[0-9a-f]{64}$/.test(v)) set.add(v);
      }
    }
    _cache = { pubkeys: set, cachedAt: now };
    return set;
  } catch {
    // Network failure → empty set, refetch on next call.
    _cache = { pubkeys: new Set(), cachedAt: now };
    return _cache.pubkeys;
  }
}

export function clearContactsCache(): void {
  _cache = null;
}
