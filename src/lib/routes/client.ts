/**
 * Nostr client routes — the read-and-post surface that powers the
 * /client (#client) panel in the dashboard. v1 ships feed + notifications
 * + profile lookup + kind-1 publish; private DMs (NIP-17) are intentionally
 * deferred to a follow-up so the inbox-relay + gift-wrap UX gets its own
 * design pass.
 *
 * Read paths consult the station owner's read relays — `identity.readRelays`
 * in identity.json, which the user manages via Config → Identity. The
 * in-process relay is NOT a feed source: it's a NIP-01 relay the owner
 * publishes through, not a fan-out from their network. The "owner's synced
 * public relays" framing from the design conversation is implemented by
 * `identity.readRelays`.
 *
 * Surface:
 *   GET  /api/client/contacts             — owner's kind-3 follows (cached 60s)
 *   GET  /api/client/feed?limit=&until=&authors=
 *                                         — kind-1 from owner's follows
 *                                           (or comma-separated `authors`)
 *   GET  /api/client/notifications?limit=&until=
 *                                         — mentions/replies/reposts/reactions/zaps
 *                                           tagging the owner's pubkey
 *   GET  /api/client/profile?pubkey=hex   — single kind-0 lookup
 *   POST /api/client/publish              — sign + broadcast kind-1
 *                                           (auto-stamps ["client","nostr-station"])
 *
 * Returns `true` when matched and a response was written; `false` lets
 * the orchestrator continue trying its remaining route groups.
 */
import http from 'http';
import { readIdentity, npubToHex, hexToNpub } from '../identity.js';
import { queryRelays, type NostrEvent } from '../nostr-query.js';
import { signEventWithSavedBunker } from '../auth-bunker.js';
import { publishEventToRelays } from './repo.js';
import { safeHttpUrl } from '../url-safety.js';
import { readBody } from './_shared.js';

// ── Constants ──────────────────────────────────────────────────────────────

const RELAY_QUERY_TIMEOUT_MS = 8_000;
const FEED_DEFAULT_LIMIT     = 50;
const FEED_MAX_LIMIT         = 200;
const CONTACTS_CACHE_TTL_MS  = 60_000;
const PROFILE_CACHE_TTL_MS   = 5 * 60_000;
const CLIENT_TAG: string[]   = ['client', 'nostr-station'];

// Notification kinds we surface in the UI. Matches what Damus/Primal show:
//   1     — kind-1 with a p tag (mentions + replies)
//   6     — repost
//   7     — reaction
//   9735  — zap receipt
const NOTIFICATION_KINDS = [1, 6, 7, 9735];

// ── Helpers ────────────────────────────────────────────────────────────────

function json(res: http.ServerResponse, status: number, body: object): boolean {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
  return true;
}

function ownerHex(): string | null {
  const ident = readIdentity();
  if (!ident.npub) return null;
  try { return npubToHex(ident.npub).toLowerCase(); }
  catch { return null; }
}

function readRelays(): string[] {
  const ident = readIdentity();
  return (ident.readRelays || []).filter(r => /^wss?:\/\//i.test(r));
}

// Cap relay fan-out so a misconfigured 30-entry read list doesn't open 30
// websockets per request. 8 matches what the profile lookup uses.
function capRelays(relays: string[]): string[] {
  return relays.slice(0, 8);
}

// ── Contact list cache (owner kind-3) ──────────────────────────────────────

interface ContactsCacheEntry {
  pubkeys:   string[];
  updatedAt: number;
  cachedAt:  number;
}

let contactsCache: ContactsCacheEntry | null = null;

async function fetchContacts(force = false): Promise<ContactsCacheEntry> {
  const now = Date.now();
  if (!force && contactsCache && (now - contactsCache.cachedAt) < CONTACTS_CACHE_TTL_MS) {
    return contactsCache;
  }
  const me = ownerHex();
  if (!me) return { pubkeys: [], updatedAt: 0, cachedAt: now };
  const relays = capRelays(readRelays());
  if (relays.length === 0) return { pubkeys: [], updatedAt: 0, cachedAt: now };

  const r = await queryRelays({
    filter: { kinds: [3], authors: [me], limit: 1 },
    relays,
    timeoutMs: RELAY_QUERY_TIMEOUT_MS,
    stream:    false,
    acceptUntil: (evs) => evs.length >= 1,
  });
  // Pick newest kind-3 (replaceable — most relays already collapse but we
  // hedge against a relay returning a stale copy).
  let newest: NostrEvent | null = null;
  for (const ev of r.events) {
    if (ev.kind !== 3) continue;
    if (!newest || ev.created_at > newest.created_at) newest = ev;
  }
  const pubkeys: string[] = [];
  if (newest) {
    for (const t of newest.tags) {
      if (!Array.isArray(t)) continue;
      if (t[0] !== 'p') continue;
      const v = typeof t[1] === 'string' ? t[1].toLowerCase() : '';
      if (/^[0-9a-f]{64}$/.test(v)) pubkeys.push(v);
    }
  }
  // De-dupe while preserving order.
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const p of pubkeys) { if (!seen.has(p)) { seen.add(p); unique.push(p); } }
  contactsCache = {
    pubkeys:   unique,
    updatedAt: newest ? newest.created_at : 0,
    cachedAt:  now,
  };
  return contactsCache;
}

// ── Profile cache (kind-0, hex → ProfileLite) ──────────────────────────────

interface ProfileLite {
  hex:      string;
  npub:     string;
  name?:    string;
  about?:   string;
  picture?: string;
  nip05?:   string;
  cachedAt: number;
}

const profileCache = new Map<string, ProfileLite>();

function parseKind0(ev: NostrEvent): Partial<ProfileLite> {
  const out: Partial<ProfileLite> = {};
  try {
    const meta = JSON.parse(ev.content);
    if (typeof meta.name         === 'string') out.name    = meta.name;
    else if (typeof meta.display_name === 'string') out.name = meta.display_name;
    if (typeof meta.about        === 'string') out.about   = meta.about;
    if (typeof meta.picture      === 'string') out.picture = meta.picture;
    if (typeof meta.nip05        === 'string') out.nip05   = meta.nip05;
  } catch { /* malformed kind-0 — leave fields undefined */ }
  return out;
}

async function fetchProfiles(pubkeys: string[]): Promise<Map<string, ProfileLite>> {
  const out = new Map<string, ProfileLite>();
  const now = Date.now();
  const need: string[] = [];
  for (const hex of pubkeys) {
    if (!/^[0-9a-f]{64}$/.test(hex)) continue;
    const cached = profileCache.get(hex);
    if (cached && (now - cached.cachedAt) < PROFILE_CACHE_TTL_MS) {
      out.set(hex, cached);
    } else {
      need.push(hex);
    }
  }
  if (need.length === 0) return out;

  const relays = capRelays(readRelays());
  if (relays.length === 0) {
    for (const hex of need) {
      const stub: ProfileLite = { hex, npub: hexToNpub(hex), cachedAt: now };
      profileCache.set(hex, stub);
      out.set(hex, stub);
    }
    return out;
  }

  const r = await queryRelays({
    filter: { kinds: [0], authors: need },
    relays,
    timeoutMs: RELAY_QUERY_TIMEOUT_MS,
    stream:    false,
    acceptUntil: (evs) => {
      const seen = new Set<string>();
      for (const e of evs) seen.add(e.pubkey);
      return seen.size >= need.length;
    },
  });
  const freshest = new Map<string, NostrEvent>();
  for (const ev of r.events) {
    if (ev.kind !== 0) continue;
    const prev = freshest.get(ev.pubkey);
    if (!prev || ev.created_at > prev.created_at) freshest.set(ev.pubkey, ev);
  }
  for (const hex of need) {
    const ev = freshest.get(hex);
    const profile: ProfileLite = { hex, npub: hexToNpub(hex), cachedAt: now };
    if (ev) Object.assign(profile, parseKind0(ev));
    // Sanitize picture at cache time so callers can render <img src>
    // without re-checking schemes.
    if (profile.picture) profile.picture = safeHttpUrl(profile.picture) || undefined;
    profileCache.set(hex, profile);
    out.set(hex, profile);
  }
  return out;
}

// ── Event-fetch helpers ────────────────────────────────────────────────────

// Sort newest-first, dedupe by id. Used by both feed and notifications.
function sortAndDedupe(events: NostrEvent[]): NostrEvent[] {
  const seen = new Set<string>();
  const out: NostrEvent[] = [];
  for (const ev of events) {
    if (seen.has(ev.id)) continue;
    seen.add(ev.id);
    out.push(ev);
  }
  out.sort((a, b) => b.created_at - a.created_at);
  return out;
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.floor(n), min), max);
}

// ── Route handler ──────────────────────────────────────────────────────────

export async function handleClient(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: string,
  method: string,
): Promise<boolean> {
  if (!url.startsWith('/api/client/')) return false;
  const u = new URL(url, 'http://localhost');
  const path = u.pathname;

  // ── GET /api/client/contacts ─────────────────────────────────────────────
  if (path === '/api/client/contacts' && method === 'GET') {
    const force = u.searchParams.get('refresh') === '1';
    try {
      const c = await fetchContacts(force);
      return json(res, 200, {
        pubkeys:   c.pubkeys,
        updatedAt: c.updatedAt,
        cachedAt:  c.cachedAt,
      });
    } catch (e: any) {
      return json(res, 500, { error: String(e?.message || e) });
    }
  }

  // ── GET /api/client/feed ─────────────────────────────────────────────────
  if (path === '/api/client/feed' && method === 'GET') {
    const limit = clampInt(u.searchParams.get('limit'), FEED_DEFAULT_LIMIT, 1, FEED_MAX_LIMIT);
    const until = clampInt(u.searchParams.get('until'), 0, 0, 2_000_000_000);

    // Author selection:
    //   - explicit `authors=hex,hex,…` overrides (so "view a user's posts"
    //     can reuse this endpoint)
    //   - otherwise, owner's contact list (kind 3 follows)
    const authorsParam = (u.searchParams.get('authors') || '').trim();
    let authors: string[];
    let usingContacts = false;
    if (authorsParam) {
      authors = authorsParam
        .split(',')
        .map(s => s.trim().toLowerCase())
        .filter(s => /^[0-9a-f]{64}$/.test(s))
        .slice(0, 500);
    } else {
      const c = await fetchContacts().catch(() => null);
      authors = c?.pubkeys ?? [];
      usingContacts = true;
    }

    const relays = capRelays(readRelays());
    if (relays.length === 0) {
      return json(res, 200, { events: [], profiles: {}, empty: 'no read relays configured', usingContacts });
    }
    if (authors.length === 0) {
      return json(res, 200, {
        events: [], profiles: {},
        empty: usingContacts ? 'no contacts found — follow some accounts and refresh' : 'no authors specified',
        usingContacts,
      });
    }

    try {
      const filter: any = { kinds: [1], authors, limit };
      if (until > 0) filter.until = until;
      const r = await queryRelays({
        filter,
        relays,
        timeoutMs: RELAY_QUERY_TIMEOUT_MS,
        // EOSE-mode for paged reads — we want the relay to return what it
        // has and exit, not stream new events. The acceptUntil short-circuit
        // resolves the moment we've collected `limit` events from any one
        // relay so the slowest relay can't pin the response.
        stream:    true,
        acceptUntil: (evs) => evs.length >= limit * 2,
      });
      const events = sortAndDedupe(r.events.filter(e => e.kind === 1)).slice(0, limit);
      const pubkeys = Array.from(new Set(events.map(e => e.pubkey)));
      const profiles = await fetchProfiles(pubkeys).catch(() => new Map<string, ProfileLite>());
      const profileObj: Record<string, ProfileLite> = {};
      for (const [k, v] of profiles) profileObj[k] = v;
      return json(res, 200, {
        events,
        profiles: profileObj,
        usingContacts,
        diagnostics: {
          relays,
          authorsCount: authors.length,
          eventsSeen:   r.diagnostics.eventsSeen,
          durationMs:   r.diagnostics.durationMs,
        },
      });
    } catch (e: any) {
      return json(res, 500, { error: String(e?.message || e) });
    }
  }

  // ── GET /api/client/notifications ────────────────────────────────────────
  if (path === '/api/client/notifications' && method === 'GET') {
    const me = ownerHex();
    if (!me) return json(res, 400, { error: 'no station owner configured' });
    const limit = clampInt(u.searchParams.get('limit'), FEED_DEFAULT_LIMIT, 1, FEED_MAX_LIMIT);
    const until = clampInt(u.searchParams.get('until'), 0, 0, 2_000_000_000);
    const relays = capRelays(readRelays());
    if (relays.length === 0) return json(res, 200, { events: [], profiles: {}, empty: 'no read relays configured' });

    try {
      const filter: any = { kinds: NOTIFICATION_KINDS, tags: { p: me }, limit };
      if (until > 0) filter.until = until;
      const r = await queryRelays({
        filter,
        relays,
        timeoutMs: RELAY_QUERY_TIMEOUT_MS,
        stream:    true,
        acceptUntil: (evs) => evs.length >= limit * 2,
      });
      // Drop self-events — the owner's own posts that p-tag themselves
      // (e.g. a reply where they re-mention themselves in the chain)
      // should NOT show in the notifications list.
      const filtered = r.events.filter(e => e.pubkey.toLowerCase() !== me);
      const events = sortAndDedupe(filtered).slice(0, limit);
      const pubkeys = Array.from(new Set(events.map(e => e.pubkey)));
      const profiles = await fetchProfiles(pubkeys).catch(() => new Map<string, ProfileLite>());
      const profileObj: Record<string, ProfileLite> = {};
      for (const [k, v] of profiles) profileObj[k] = v;
      return json(res, 200, {
        events,
        profiles: profileObj,
        diagnostics: {
          relays,
          eventsSeen: r.diagnostics.eventsSeen,
          durationMs: r.diagnostics.durationMs,
        },
      });
    } catch (e: any) {
      return json(res, 500, { error: String(e?.message || e) });
    }
  }

  // ── GET /api/client/profile?pubkey=hex ───────────────────────────────────
  if (path === '/api/client/profile' && method === 'GET') {
    const raw = (u.searchParams.get('pubkey') || '').trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(raw)) return json(res, 400, { error: 'invalid pubkey (expected 64-char hex)' });
    try {
      const map = await fetchProfiles([raw]);
      const p = map.get(raw);
      if (!p) return json(res, 404, { error: 'profile not found' });
      return json(res, 200, p);
    } catch (e: any) {
      return json(res, 500, { error: String(e?.message || e) });
    }
  }

  // ── POST /api/client/publish ─────────────────────────────────────────────
  //
  // Body: { content: string, replyTo?: { id: hex, pubkey: hex, relay?: string } }
  //
  // Builds a kind-1, signs it via the persisted Amber/bunker pairing, and
  // broadcasts to the owner's read relays. The client tag is auto-stamped
  // — that's the whole point of doing this through the station.
  if (path === '/api/client/publish' && method === 'POST') {
    let body: any;
    try { body = JSON.parse(await readBody(req)); }
    catch { return json(res, 400, { error: 'bad json' }); }

    const me = ownerHex();
    if (!me) return json(res, 400, { error: 'no station owner configured — finish setup first' });

    const content = typeof body.content === 'string' ? body.content : '';
    if (!content.trim()) return json(res, 400, { error: 'content required' });
    // Soft cap. Nothing in NIP-01 requires it, but past 32k the post is
    // almost certainly a mistake (pasted log file, runaway editor) and
    // most relays will reject it anyway. Surface the limit as a 400 so
    // the UI can show a clean error rather than parsing a relay's NOTICE.
    if (content.length > 32_000) return json(res, 400, { error: 'content too long (max 32000 chars)' });

    const tags: string[][] = [];

    // Reply threading per NIP-10 (marked tags). We only support the simple
    // "reply to one post" case in v1 — replying to a reply still works
    // because the second-level reply just tags the immediate parent; the
    // full ancestor chain reconstruction is the reader's job.
    if (body.replyTo && typeof body.replyTo === 'object') {
      const id     = typeof body.replyTo.id     === 'string' ? body.replyTo.id.toLowerCase()     : '';
      const pubkey = typeof body.replyTo.pubkey === 'string' ? body.replyTo.pubkey.toLowerCase() : '';
      const relay  = typeof body.replyTo.relay  === 'string' ? body.replyTo.relay                : '';
      if (/^[0-9a-f]{64}$/.test(id)) {
        tags.push(['e', id, relay, 'reply']);
        if (/^[0-9a-f]{64}$/.test(pubkey)) tags.push(['p', pubkey]);
      }
    }

    // Stamp client identity. Bare two-element form (NIP-89 handler
    // announcement is a phase-2 thing — for now the tag exists so other
    // clients can credit "via nostr-station").
    tags.push([...CLIENT_TAG]);

    const template = {
      kind:       1,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content,
    };

    const signed = await signEventWithSavedBunker(template, 60_000);
    if (!signed.ok || !signed.signedEvent) {
      return json(res, signed.tried ? 502 : 400, {
        error: signed.error || 'sign failed',
        tried: signed.tried,
      });
    }

    const relays = capRelays(readRelays());
    if (relays.length === 0) {
      return json(res, 502, { error: 'no read relays configured — cannot broadcast', signedEvent: signed.signedEvent });
    }

    const results = await publishEventToRelays(signed.signedEvent, relays);
    const accepted = results.filter(r => r.ok).length;
    return json(res, accepted > 0 ? 200 : 502, {
      ok:          accepted > 0,
      signedEvent: signed.signedEvent,
      publish:     results,
      accepted,
      targets:     relays.length,
    });
  }

  return false;
}
