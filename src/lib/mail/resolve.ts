/**
 * Recipient resolution for the mail compose form.
 *
 * Three input shapes the caller may pass to /api/mail/send:
 *
 *   - bech32 npub  ("npub1...")     → decode → hex pubkey
 *   - 64-char hex  ("a1b2c3...")    → use as-is
 *   - NIP-05       ("alice@example.com") → fetch
 *       https://example.com/.well-known/nostr.json?name=alice and read
 *       names[alice] → hex pubkey. The same JSON also exposes a
 *       `relays` map keyed by hex pubkey — if present, we use those as
 *       the recipient's inbox relays in addition to whatever their
 *       kind 10050 says.
 *
 * After we resolve a pubkey, we look up the recipient's kind 10050
 * (NIP-17 inbox relay list) via a small set of well-known discovery
 * relays. The send pipeline publishes wraps to that list; falling
 * back to the sender's own outbox relays if the recipient hasn't
 * advertised any (with a "delivery may fail" warning surfaced to the
 * caller).
 */

import { nip19 } from 'nostr-tools';
import { queryRelaysDirect, type NostrEvent } from '../nostr-query.js';
import { KIND_INBOX_RELAYS } from './types.js';
import { safeHttpUrl } from '../url-safety.js';

export interface ResolvedRecipient {
  // Always 64-char lowercase hex.
  pubkey:       string;
  // Original input as the user typed it — useful for the audit log /
  // toast message.
  inputForm:    string;
  // From the recipient's kind 10050. Empty array = no inbox relays
  // advertised → caller should surface a warning.
  inboxRelays:  string[];
  // If the input was a NIP-05 with a `relays` hint pre-attached, those
  // get merged into inboxRelays here so callers don't need to know the
  // distinction.
  nip05?:       string;
}

const DISCOVERY_RELAYS_FOR_KIND_10050 = [
  'wss://purplepag.es',         // canonical relay-list indexer
  'wss://relay.damus.io',
  'wss://relay.nostr.band',
  'wss://nos.lol',
  'wss://relay.primal.net',
];

const RELAY_QUERY_TIMEOUT_MS = 6_000;

const HEX_RE  = /^[0-9a-f]{64}$/i;
const NIP05_RE = /^([a-zA-Z0-9._-]+)@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})$/;

export class RecipientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecipientError';
  }
}

/**
 * Resolve a free-text recipient input into a pubkey + inbox relays.
 * Throws a RecipientError on any input shape we can't handle; callers
 * surface the message to the user as-is.
 */
export async function resolveRecipient(input: string): Promise<ResolvedRecipient> {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) throw new RecipientError('recipient is required');

  // ── npub bech32 ─────────────────────────────────────────────────────
  if (raw.startsWith('npub1')) {
    try {
      const decoded = nip19.decode(raw);
      if (decoded.type !== 'npub') {
        throw new RecipientError(`expected an npub, got ${decoded.type}`);
      }
      const hex = (decoded.data as string).toLowerCase();
      const inboxRelays = await fetchInboxRelays(hex);
      return { pubkey: hex, inputForm: raw, inboxRelays };
    } catch (e: any) {
      if (e instanceof RecipientError) throw e;
      throw new RecipientError(`could not decode npub: ${e?.message || e}`);
    }
  }

  // ── 64-char hex ─────────────────────────────────────────────────────
  if (HEX_RE.test(raw)) {
    const hex = raw.toLowerCase();
    const inboxRelays = await fetchInboxRelays(hex);
    return { pubkey: hex, inputForm: raw, inboxRelays };
  }

  // ── NIP-05 ──────────────────────────────────────────────────────────
  const m = raw.match(NIP05_RE);
  if (m) {
    const [, name, domain] = m;
    const looked = await fetchNip05(name.toLowerCase(), domain.toLowerCase());
    if (!looked) {
      throw new RecipientError(`NIP-05 lookup failed for ${raw}`);
    }
    // Merge in any relays the .well-known JSON suggests for this pubkey.
    const seenRelays = new Set<string>(looked.relayHints);
    const advertised = await fetchInboxRelays(looked.pubkey);
    for (const r of advertised) seenRelays.add(r);
    return {
      pubkey:      looked.pubkey,
      inputForm:   raw,
      inboxRelays: [...seenRelays],
      nip05:       raw,
    };
  }

  throw new RecipientError(
    `unrecognised recipient: expected npub1…, 64-char hex, or alice@example.com`,
  );
}

// ── NIP-05 ────────────────────────────────────────────────────────────────

interface Nip05Result {
  pubkey:      string;
  relayHints:  string[];
}

async function fetchNip05(name: string, domain: string): Promise<Nip05Result | null> {
  const url = `https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(name)}`;
  // Guard against the unlikely-but-possible "domain pointed at internal
  // IP via DNS" scenario by checking the parsed URL. (We're not running
  // server-side fetch on user-controllable URLs in general — this is
  // strictly a NIP-05 lookup — but defence in depth costs nothing.)
  if (!safeHttpUrl(url)) return null;
  try {
    const res = await fetch(url, {
      signal:  AbortSignal.timeout(5_000),
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const data = await res.json() as {
      names?:  Record<string, string>;
      relays?: Record<string, string[]>;
    };
    const got = data.names?.[name];
    if (typeof got !== 'string' || !HEX_RE.test(got)) return null;
    const hex = got.toLowerCase();
    // Relay hints from the .well-known JSON. NIP-05 specifies this is a
    // map { pubkey: [relay, ...] }; we pick the entry for our pubkey.
    const hints = Array.isArray(data.relays?.[hex])
      ? data.relays![hex]!.filter(s => typeof s === 'string' && /^wss?:\/\//.test(s))
      : [];
    return { pubkey: hex, relayHints: hints.slice(0, 6) };
  } catch {
    return null;
  }
}

// ── kind 10050 (inbox relay list) lookup ──────────────────────────────────

async function fetchInboxRelays(hex: string): Promise<string[]> {
  try {
    const r = await queryRelaysDirect({
      relays:  DISCOVERY_RELAYS_FOR_KIND_10050,
      filter:  { kinds: [KIND_INBOX_RELAYS], authors: [hex], limit: 1 },
      timeoutMs: RELAY_QUERY_TIMEOUT_MS,
    });
    const newest = pickNewest(r.events);
    if (!newest) return [];
    return extractRelayUrls(newest);
  } catch {
    return [];
  }
}

function pickNewest(events: NostrEvent[]): NostrEvent | null {
  let out: NostrEvent | null = null;
  for (const e of events) {
    if (!out || e.created_at > out.created_at) out = e;
  }
  return out;
}

function extractRelayUrls(event: NostrEvent): string[] {
  const out: string[] = [];
  // NIP-17 §"Inbox relay list" describes kind 10050 as carrying
  // ["relay", "wss://..."] tags. Some older clients use the bare URL
  // as the first tag value — accept both shapes.
  for (const t of event.tags) {
    if (!Array.isArray(t) || t.length === 0) continue;
    if (t[0] === 'relay' && typeof t[1] === 'string') {
      if (/^wss?:\/\//.test(t[1])) out.push(t[1]);
    } else if (typeof t[0] === 'string' && /^wss?:\/\//.test(t[0])) {
      out.push(t[0]);
    }
  }
  // Cap at 6 to bound the fan-out cost of subsequent publishes.
  return Array.from(new Set(out)).slice(0, 6);
}
