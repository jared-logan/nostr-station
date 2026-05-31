/**
 * Nostr client routes — the read-and-post surface that powers the
 * /client (#client) panel in the dashboard. Ships feed + notifications
 * + profile lookup + reactions + reposts + replies; private DMs (NIP-17)
 * and zap sending (NIP-57 LN wallet integration) are intentionally
 * deferred to a follow-up.
 *
 * Read paths consult the station owner's read relays — `identity.readRelays`
 * in identity.json, which the user manages via Config → Identity. The
 * in-process relay is NOT a feed source: it's a NIP-01 relay the owner
 * publishes through, not a fan-out from their network. The "owner's synced
 * public relays" framing from the design conversation is implemented by
 * `identity.readRelays`.
 *
 * Surface:
 *   GET  /api/client/health               — nak presence + relay count
 *   GET  /api/client/contacts             — owner's kind-3 follows (cached 60s)
 *   GET  /api/client/feed?limit=&until=&authors=
 *                                         — kind-1 from owner's follows
 *                                           (or comma-separated `authors`)
 *   GET  /api/client/notifications?limit=&until=
 *                                         — mentions/replies/reposts/reactions/zaps
 *                                           tagging the owner's pubkey
 *   GET  /api/client/profile?pubkey=hex   — single kind-0 lookup
 *   GET  /api/client/thread?id=hex        — fetch a single kind-1 event
 *                                           (used to render reply parents)
 *   GET  /api/client/event-stats?ids=hex,…
 *                                         — reaction / repost / reply counts
 *                                           plus the owner's own reaction
 *   POST /api/client/publish              — sign + broadcast a kind-1/6/7
 *                                           (auto-stamps ["client","nostr-station"])
 *
 * Returns `true` when matched and a response was written; `false` lets
 * the orchestrator continue trying its remaining route groups.
 */
import http from 'http';
import {
  readIdentity, npubToHex, hexToNpub,
  DEFAULT_READ_RELAYS, getEffectiveReadRelays, setReadRelays, isValidRelayUrl,
} from '../identity.js';
// Use the direct-WebSocket variant of queryRelays for the Client panel:
// nak-based queries kept missing kind-0 / kind-3 / kind-1 events that the
// direct-WS path (identity-config flow) reliably fetched against the same
// relays, leaving Feed / Notifications / Profile blank for many users.
// queryRelaysDirect has the same signature, so the swap is API-neutral.
import { queryRelaysDirect as queryRelays, type NostrEvent } from '../nostr-query.js';
import { getLocalStore } from '../inproc-store-ref.js';
import { signEventWithSavedBunker } from '../auth-bunker.js';
import { publishEventToRelays } from './repo.js';
import { CLIENT_TAG as SHARED_CLIENT_TAG } from '../client-tag.js';
import { safeHttpUrl } from '../url-safety.js';
import { signProxyUrl } from '../img-proxy-sign.js';
import { readBody } from './_shared.js';
import { findBin } from '../detect.js';

// ── Constants ──────────────────────────────────────────────────────────────

const RELAY_QUERY_TIMEOUT_MS = 8_000;
const FEED_DEFAULT_LIMIT     = 50;
const FEED_MAX_LIMIT         = 200;
const CONTACTS_CACHE_TTL_MS  = 60_000;
const PROFILE_CACHE_TTL_MS   = 5 * 60_000;
// Client identity stamped on every event published through this surface.
// Now sourced from the shared src/lib/client-tag.ts so the native
// /api/client path, repo announcements, and nsite deploys all emit an
// identical NIP-89 client tag (and thus link to the same kind-31990
// handler event). Local alias kept mutable for the existing spread sites.
const CLIENT_TAG: string[] = [...SHARED_CLIENT_TAG];

// Notification kinds we surface in the UI. Matches what Damus/Primal show:
//   1     — kind-1 with a p tag (mentions + replies)
//   6     — repost
//   7     — reaction
//   9735  — zap receipt
const NOTIFICATION_KINDS = [1, 6, 7, 9735];

// Event-stats fan-out limit. Asking 50+ event ids in one query is fine for
// nak but the response can be large; cap the request side so a runaway
// caller can't trigger an unbounded query.
const EVENT_STATS_MAX_IDS = 50;
// Default reaction content for a like — matches what Damus + most clients
// publish when the user hits the heart. Anything non-empty is allowed; the
// "+" sentinel is the convention for an unspecified positive reaction.
const REACTION_LIKE_CONTENT = '+';

// NIP-65 outbox-discovery bootstrap set — relays that aggregate kind-10002
// events across the network. The sync-relays endpoint queries these IN
// ADDITION to the user's configured Station Relays so a fresh user whose
// only Station Relays are different from where their kind-10002 actually
// lives can still bootstrap. purplepag.es is the canonical profile +
// relay-list indexer; the rest are wide general-purpose indexers + Ditto's
// own relay (where many @user@happytavern.co / Ditto-instance users
// actually have their kind-10002 published).
const NIP65_BOOTSTRAP_RELAYS: string[] = [
  'wss://purplepag.es',
  'wss://relay.nostr.band',
  'wss://relay.damus.io',
  'wss://relay.primal.net',
  'wss://nos.lol',
  'wss://relay.ditto.pub',
];

// Cached "is nak installed?" check. findBin walks PATH on every call;
// memoizing for the process lifetime is fine because the answer doesn't
// change without a restart. `nakAvailable()` returns null when missing so
// callers can branch on it explicitly.
let _nakBinCache: string | null | undefined;
function nakBin(): string | null {
  if (_nakBinCache === undefined) _nakBinCache = findBin('nak');
  return _nakBinCache;
}

// Build the standard "client unavailable" payload — shared by every read
// endpoint so the dashboard always gets the same shape and can render a
// single install-nak banner instead of N differently-shaped errors.
interface ClientUnavailable {
  empty:        string;
  unavailable:  true;
  reason:       'nak-missing' | 'no-read-relays' | 'no-owner';
  hint?:        string;
}
function unavailable(reason: ClientUnavailable['reason']): ClientUnavailable {
  if (reason === 'nak-missing') {
    return {
      unavailable: true,
      reason,
      empty: 'nak is not installed — the client can\'t reach your relays',
      hint:  'install nak (Setup → Tools) and refresh',
    };
  }
  if (reason === 'no-read-relays') {
    return {
      unavailable: true,
      reason,
      empty: 'no read relays configured',
      hint:  'add at least one read relay in Config → Identity',
    };
  }
  return {
    unavailable: true,
    reason,
    empty: 'no station owner configured',
    hint:  'finish setup before opening the client',
  };
}

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

// Effective read relays — union of (App Relays, Your Relays) per the
// identity helper. The local helper here exists so a single call site
// can swap to a different policy (e.g. outbox model per author) later
// without every route knowing.
function readRelays(): string[] {
  // The Client panel is the dashboard's PUBLIC-Nostr surface — the
  // user's doorway to the public network for browsing + posting.
  // Always uses the station's effective read-relay list (App Relays ∪
  // Your Relays per NIP-65, owned by PR #78). Project active-env
  // selection deliberately does NOT influence this — that switch is
  // scoped to spawned dev servers + chat context, not the Client
  // panel. Clear separation: Projects/Chat = private dev relay or
  // explicitly-toggled public; Client panel = always public; Relay
  // panel = local in-process relay inspection.
  return getEffectiveReadRelays().filter(r => /^wss?:\/\//i.test(r));
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
  hex:           string;
  npub:          string;
  name?:         string;
  displayName?:  string;
  about?:        string;
  picture?:      string;
  banner?:       string;
  nip05?:        string;
  cachedAt:      number;
}

const profileCache = new Map<string, ProfileLite>();

function parseKind0(ev: NostrEvent): Partial<ProfileLite> {
  const out: Partial<ProfileLite> = {};
  try {
    const meta = JSON.parse(ev.content);
    // `name` is the handle/username; `display_name` (NIP-24) is the
    // longer "Display Name" most clients prefer for the prominent label.
    // Surface both so the renderer can pick — fallback to whichever
    // exists if only one is set.
    if (typeof meta.name         === 'string') out.name        = meta.name;
    if (typeof meta.display_name === 'string') out.displayName = meta.display_name;
    if (typeof meta.about        === 'string') out.about       = meta.about;
    if (typeof meta.picture      === 'string') out.picture     = meta.picture;
    if (typeof meta.banner       === 'string') out.banner      = meta.banner;
    if (typeof meta.nip05        === 'string') out.nip05       = meta.nip05;
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

  // Local-first hydration: the in-process relay materialized kind-0
  // events into a profiles table at ingest (src/relay/store.ts).
  // Resolving from there is microseconds and works offline. Only the
  // pubkeys we still don't know about after this fall through to a
  // remote relay query.
  const localStore = getLocalStore();
  if (localStore) {
    const localProfiles = localStore.getProfiles(need);
    const stillNeed: string[] = [];
    for (const hex of need) {
      const p = localProfiles.get(hex);
      if (!p) { stillNeed.push(hex); continue; }
      const lite: ProfileLite = { hex, npub: hexToNpub(hex), cachedAt: now };
      if (p.name)         lite.name        = p.name;
      if (p.display_name) lite.displayName = p.display_name;
      if (p.about)        lite.about       = p.about;
      if (p.nip05)        lite.nip05       = p.nip05;
      if (p.picture) {
        const safe = safeHttpUrl(p.picture);
        if (safe) lite.picture = signProxyUrl(safe) ?? undefined;
      }
      if (p.banner) {
        const safe = safeHttpUrl(p.banner);
        if (safe) lite.banner = signProxyUrl(safe) ?? undefined;
      }
      profileCache.set(hex, lite);
      out.set(hex, lite);
    }
    need.length = 0;
    need.push(...stillNeed);
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
    // Sanitize picture + banner at cache time so callers can render
    // <img src> without re-checking schemes. Same defense-in-depth
    // against javascript: / data: smuggling in user-controlled URLs.
    // Then pre-sign as a /api/img-proxy URL so the dashboard's CSP
    // img-src 'self' is satisfied and the proxy's signature gate
    // accepts the request (see src/lib/img-proxy-sign.ts).
    if (profile.picture) {
      const safe = safeHttpUrl(profile.picture);
      profile.picture = safe ? (signProxyUrl(safe) ?? undefined) : undefined;
    }
    if (profile.banner) {
      const safe = safeHttpUrl(profile.banner);
      profile.banner = safe ? (signProxyUrl(safe) ?? undefined) : undefined;
    }
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

  // ── GET /api/client/health ───────────────────────────────────────────────
  //
  // Fast-path the dashboard hits on panel-enter to decide whether to render
  // a "client is broken" banner before any feed/notifications query fires.
  // Reports nak presence, read-relay count, and owner-configured state in
  // one round-trip — three things that would otherwise need three separate
  // /api/client/* probes.
  if (path === '/api/client/health' && method === 'GET') {
    const me = ownerHex();
    const relays = readRelays();
    // nak is no longer required for the Client panel — queries now use
    // direct WebSockets (queryRelaysDirect). The field stays on the
    // response for back-compat / diagnostic use; ok is independent of it.
    const nak = nakBin();
    const ok = relays.length > 0 && me !== null;
    return json(res, 200, {
      ok,
      ownerConfigured: me !== null,
      readRelayCount:  relays.length,
      nakInstalled:    nak !== null,
      reason: !me ? 'no-owner' : relays.length === 0 ? 'no-read-relays' : null,
    });
  }

  // ── GET /api/client/relay-config ─────────────────────────────────────────
  //
  // Composite view of the relays nostr-station uses for its own Nostr
  // lookups. Single endpoint for the dashboard's status indicator + the
  // Config → Station Relays section. Includes:
  //   appRelays         — DEFAULT_READ_RELAYS (fixed, ships with nostr-station)
  //   appRelaysEnabled  — toggle state (true = App Relays merged into effective)
  //   yourRelays        — identity.readRelays (user's editable list)
  //   effective         — deduped union actually used for /client reads
  //
  // The same data is partly exposed via /api/identity/config — kept here
  // so /client doesn't have to peek across into the identity surface and
  // so a future consumer can swap effective for a per-author outbox-model
  // resolution without rippling through /api/identity/config callers.
  if (path === '/api/client/relay-config' && method === 'GET') {
    const ident = readIdentity();
    return json(res, 200, {
      appRelays:        DEFAULT_READ_RELAYS.slice(),
      appRelaysEnabled: ident.appRelaysEnabled !== false,
      yourRelays:       (ident.readRelays || []).slice(),
      effective:        getEffectiveReadRelays(),
    });
  }

  // ── POST /api/client/sync-relays ─────────────────────────────────────────
  //
  // NIP-65 outbox sync: fetches the owner's kind 10002 relay list event
  // from the currently-effective relays, parses every `r` tag, and mirrors
  // identity.readRelays to match it exactly — adding URLs that are new and
  // removing local URLs that aren't in the published list. Returns both the
  // additions and removals so the UI can render an accurate toast.
  //
  // "Mirror" means Your Relays ends up equal to your kind-10002 list, so
  // manually-added relays not present in NIP-65 are dropped. We guard the
  // empty / not-found cases below so a missing or unparseable event never
  // wipes the list.
  //
  // This is a one-shot sync, not a continuous binding — after it runs the
  // list is user-managed again until the next sync. Per-author outbox
  // routing (read THEIR posts from THEIR write relays) is the bigger
  // architectural follow-up and intentionally deferred.
  if (path === '/api/client/sync-relays' && method === 'POST') {
    const me = ownerHex();
    if (!me) return json(res, 400, { error: 'no station owner configured' });
    // Union of the user's configured relays + the NIP-65 bootstrap set.
    // The bootstrap relays widen the search so a fresh user whose
    // configured Station Relays don't happen to mirror their kind-10002
    // can still discover their published relay list. Capped at 12 to
    // bound fan-out (queryRelays opens one WebSocket per entry).
    const configured = readRelays();
    const merged = [...new Set([...configured, ...NIP65_BOOTSTRAP_RELAYS])];
    const relays = merged.slice(0, 12);
    if (relays.length === 0) return json(res, 200, { added: [], ...unavailable('no-read-relays') });
    try {
      const r = await queryRelays({
        filter: { kinds: [10002], authors: [me], limit: 1 },
        relays,
        timeoutMs: RELAY_QUERY_TIMEOUT_MS,
        stream: false,
        acceptUntil: (evs) => evs.length >= 1,
      });
      // Pick the freshest kind 10002 (replaceable — relays should already
      // return one, but de-dup defensively).
      let newest: NostrEvent | null = null;
      for (const ev of r.events) {
        if (ev.kind !== 10002) continue;
        if (!newest || ev.created_at > newest.created_at) newest = ev;
      }
      if (!newest) {
        // We queried both the user's configured relays AND the NIP-65
        // bootstrap aggregators. If none of them have a kind-10002 for
        // this npub, the user almost certainly hasn't published one.
        // Surface the actionable hint rather than a vague "not found".
        return json(res, 200, {
          added: [],
          empty: `No NIP-65 relay list (kind 10002) found for your npub on ${relays.length} relays (your configured ${configured.length} + ${NIP65_BOOTSTRAP_RELAYS.length} bootstrap aggregators). Some clients (Ditto, etc.) don't publish kind-10002 by default — try publishing one from Damus / Amethyst / nostr.guru first, then re-sync.`,
          queriedRelays: relays,
        });
      }
      const before = (readIdentity().readRelays || []).slice();
      const beforeKeys = new Set(before.map(s => s.toLowerCase()));
      // NIP-65 r-tag shapes:
      //   ["r", "wss://relay.example.com"]            — read+write
      //   ["r", "wss://relay.example.com", "read"]    — read only
      //   ["r", "wss://relay.example.com", "write"]   — write only
      // We import all of them — the read/write distinction is a per-author
      // routing hint, not a "should this be in my own list" filter.
      const desired: string[] = [];
      const desiredKeys = new Set<string>();
      for (const t of newest.tags) {
        if (!Array.isArray(t) || t[0] !== 'r') continue;
        const url = typeof t[1] === 'string' ? t[1].trim() : '';
        if (!url || !isValidRelayUrl(url)) continue;
        const key = url.toLowerCase();
        if (desiredKeys.has(key)) continue;
        desiredKeys.add(key);
        desired.push(url);
      }
      // Guard: a kind-10002 with no usable `r` tags must not wipe the list.
      // Treat it as "nothing to mirror" and leave readRelays untouched.
      if (desired.length === 0) {
        return json(res, 200, {
          added: [],
          removed: [],
          empty: 'Your NIP-65 list (kind 10002) had no usable relay entries — nothing to mirror.',
          sourceCreatedAt: newest.created_at,
          yourRelays:      before,
        });
      }
      const added   = desired.filter(u => !beforeKeys.has(u.toLowerCase()));
      const removed = before.filter(u => !desiredKeys.has(u.toLowerCase()));
      const set = setReadRelays(desired);
      return json(res, 200, {
        added,
        removed,
        sourceCreatedAt: newest.created_at,
        yourRelays:      set.relays.slice(),
      });
    } catch (e: any) {
      return json(res, 500, { error: String(e?.message || e) });
    }
  }

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
      return json(res, 200, { events: [], profiles: {}, ...unavailable('no-read-relays'), usingContacts });
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
    if (relays.length === 0) return json(res, 200, { events: [], profiles: {}, ...unavailable('no-read-relays') });

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

  // ── GET /api/client/thread?id=hex ────────────────────────────────────────
  //
  // Single-event fetch used by the dashboard to render reply context — the
  // "parent note above the reply" affordance every major client has. Returns
  // the event + the author's profile (or { empty: '...' } if the event
  // can't be resolved on the configured relays). Bounded to one event so
  // an attacker-controlled id query can't fan out to a thread-flood.
  if (path === '/api/client/thread' && method === 'GET') {
    const id = (u.searchParams.get('id') || '').trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(id)) return json(res, 400, { error: 'invalid event id' });
    const relays = capRelays(readRelays());
    if (relays.length === 0) return json(res, 200, { ...unavailable('no-read-relays') });
    try {
      const r = await queryRelays({
        filter: { ids: [id], limit: 1 },
        relays,
        timeoutMs: RELAY_QUERY_TIMEOUT_MS,
        stream: false,
        acceptUntil: (evs) => evs.length >= 1,
      });
      const event = r.events.find(e => e.id.toLowerCase() === id) || null;
      if (!event) return json(res, 200, { event: null, empty: 'event not found on configured relays' });
      const profiles = await fetchProfiles([event.pubkey]).catch(() => new Map<string, ProfileLite>());
      const profileObj: Record<string, ProfileLite> = {};
      for (const [k, v] of profiles) profileObj[k] = v;
      return json(res, 200, { event, profiles: profileObj });
    } catch (e: any) {
      return json(res, 500, { error: String(e?.message || e) });
    }
  }

  // ── GET /api/client/event-stats?ids=hex,hex,… ────────────────────────────
  //
  // Aggregate reactions / reposts / reply counts for a batch of event ids.
  // Powers the per-post counters in the feed and notifications views.
  // Also reports whether the station owner has already reacted (so the
  // heart can render "filled" state without a second round-trip).
  if (path === '/api/client/event-stats' && method === 'GET') {
    const me = ownerHex();
    const relays = capRelays(readRelays());
    if (relays.length === 0) return json(res, 200, { stats: {}, ...unavailable('no-read-relays') });

    const idsParam = (u.searchParams.get('ids') || '').trim();
    const ids = idsParam
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter(s => /^[0-9a-f]{64}$/.test(s))
      .slice(0, EVENT_STATS_MAX_IDS);
    if (ids.length === 0) return json(res, 200, { stats: {} });

    try {
      const r = await queryRelays({
        // One filter covering all three engagement kinds tagged at any of
        // the requested event ids. The relay returns the union; we bucket
        // per-id locally.
        filter: { kinds: [1, 6, 7], tags: { e: ids } },
        relays,
        timeoutMs: RELAY_QUERY_TIMEOUT_MS,
        stream: true,
        // Don't acceptUntil — the relay's EOSE is what we want. Bounded
        // by the wall-clock timeout. Reactions on a popular post can be
        // thousands of events, but we only need counts; a 8s ceiling is
        // a reasonable trade for "show stale counts on busy posts".
      });
      type Bucket = { reactions: number; reposts: number; replies: number; mine: string | null };
      const stats: Record<string, Bucket> = {};
      for (const id of ids) stats[id] = { reactions: 0, reposts: 0, replies: 0, mine: null };
      const seen = new Set<string>(); // de-dupe by event id (the same engagement event can come from multiple relays)
      for (const ev of r.events) {
        if (seen.has(ev.id)) continue;
        seen.add(ev.id);
        const eTag = ev.tags.find(t => Array.isArray(t) && t[0] === 'e' && /^[0-9a-f]{64}$/.test(String(t[1] || '').toLowerCase()));
        if (!eTag) continue;
        const target = String(eTag[1]).toLowerCase();
        const b = stats[target];
        if (!b) continue;
        if (ev.kind === 1) b.replies++;
        else if (ev.kind === 6) b.reposts++;
        else if (ev.kind === 7) {
          b.reactions++;
          // Track the owner's own reaction so the UI can render filled
          // state. Only record once (the freshest); ignore "-" downvotes
          // for the toggle since we only render the like button in v1.
          if (me && ev.pubkey.toLowerCase() === me && ev.content !== '-') {
            b.mine = ev.content || '+';
          }
        }
      }
      return json(res, 200, {
        stats,
        diagnostics: {
          relays,
          ids:         ids.length,
          eventsSeen:  r.diagnostics.eventsSeen,
          durationMs:  r.diagnostics.durationMs,
        },
      });
    } catch (e: any) {
      return json(res, 500, { error: String(e?.message || e) });
    }
  }

  // ── POST /api/client/publish/build ──────────────────────────────────────
  //
  // Returns the unsigned event template the publish endpoint would build
  // for the same body. Used by the NIP-07 (browser-extension) flow:
  // the dashboard fetches the template, hands it to window.nostr.signEvent,
  // and POSTs the signed event back to /api/client/publish — the server
  // never touches the user's secret. Body shape matches /publish exactly
  // (see below). Returns { template } on success, { error } on validation
  // failure.
  if (path === '/api/client/publish/build' && method === 'POST') {
    let body: any;
    try { body = JSON.parse(await readBody(req)); }
    catch { return json(res, 400, { error: 'bad json' }); }
    const built = buildPublishTemplate(body);
    if (!built.ok) return json(res, 400, { error: built.error });
    return json(res, 200, { template: built.template });
  }

  // ── POST /api/client/publish ─────────────────────────────────────────────
  //
  // Two body shapes:
  //
  //   1. Template body (server signs via bunker — Amber NIP-46):
  //        { kind?: 1, content: string, replyTo?: { id, pubkey, relay? } }
  //        { kind: 7, target: { id, pubkey }, content?: '+' | '-' | emoji }
  //        { kind: 6, target: { id, pubkey, relay? } }
  //      Builds the event, signs via the persisted bunker pairing,
  //      broadcasts to the owner's read relays. The client tag is
  //      auto-stamped.
  //
  //   2. Pre-signed event (browser already signed via NIP-07):
  //        { event: SignedEvent }
  //      Server verifies signature + pubkey matches the station owner,
  //      then broadcasts as-is. The browser was responsible for stamping
  //      the client tag (publish/build does it for them).
  //
  // The two shapes coexist so a user signed in via Alby / nos2x doesn't
  // need a separate Amber pairing just to publish — whichever signer
  // they used to authenticate becomes the signer for posting.
  if (path === '/api/client/publish' && method === 'POST') {
    let body: any;
    try { body = JSON.parse(await readBody(req)); }
    catch { return json(res, 400, { error: 'bad json' }); }

    const me = ownerHex();
    if (!me) return json(res, 400, { error: 'no station owner configured — finish setup first' });

    let signedEvent: any;

    if (body && body.event && typeof body.event === 'object') {
      // Mode 2 — pre-signed event from a NIP-07 signer.
      const ev = body.event;
      // Cheap structural sanity-check before reaching for the heavier
      // verifyEvent — saves a syscall on bad input.
      if (typeof ev.id !== 'string' || typeof ev.sig !== 'string' ||
          typeof ev.pubkey !== 'string' || typeof ev.kind !== 'number' ||
          typeof ev.created_at !== 'number' || !Array.isArray(ev.tags) ||
          typeof ev.content !== 'string') {
        return json(res, 400, { error: 'event missing required fields' });
      }
      if (ev.pubkey.toLowerCase() !== me) {
        return json(res, 403, { error: 'event pubkey does not match station owner' });
      }
      // verifyEvent performs full signature + id-hash check. Reject any
      // tampered event before broadcast — we'd rather error than send
      // garbage to public relays.
      const { verifyEvent } = await import('nostr-tools/pure');
      let valid = false;
      try { valid = verifyEvent(ev); } catch { valid = false; }
      if (!valid) return json(res, 400, { error: 'event signature invalid' });
      signedEvent = ev;
    } else {
      // Mode 1 — template body, server signs via bunker.
      const built = buildPublishTemplate(body);
      if (!built.ok) return json(res, 400, { error: built.error });
      const signed = await signEventWithSavedBunker(built.template, 60_000);
      if (!signed.ok || !signed.signedEvent) {
        return json(res, signed.tried ? 502 : 400, {
          error: signed.error || 'sign failed',
          tried: signed.tried,
        });
      }
      signedEvent = signed.signedEvent;
    }

    const relays = capRelays(readRelays());
    if (relays.length === 0) {
      return json(res, 502, { error: 'no read relays configured — cannot broadcast', signedEvent });
    }

    const results = await publishEventToRelays(signedEvent, relays);
    const accepted = results.filter(r => r.ok).length;
    return json(res, accepted > 0 ? 200 : 502, {
      ok:          accepted > 0,
      signedEvent,
      publish:     results,
      accepted,
      targets:     relays.length,
    });
  }

  return false;
}

// ── Template builder (shared by /publish and /publish/build) ─────────────
//
// Validates the request body and returns the unsigned event template.
// Lifted out of the publish handler so the NIP-07 build endpoint and the
// bunker-signing branch share one source of truth for kind-specific
// validation + tag construction (NIP-10 reply threading, NIP-25 reaction
// shape, NIP-18 repost).
type TemplateBuildResult =
  | { ok: true;  template: { kind: number; created_at: number; tags: string[][]; content: string } }
  | { ok: false; error: string };

function buildPublishTemplate(body: any): TemplateBuildResult {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'body required' };
  }
  const kind = typeof body.kind === 'number' ? body.kind : 1;
  if (![1, 6, 7].includes(kind)) {
    return { ok: false, error: `unsupported kind ${kind} (allowed: 1, 6, 7)` };
  }

  const tags: string[][] = [];
  let content = '';

  if (kind === 1) {
    content = typeof body.content === 'string' ? body.content : '';
    if (!content.trim()) return { ok: false, error: 'content required' };
    if (content.length > 32_000) return { ok: false, error: 'content too long (max 32000 chars)' };
    if (body.replyTo && typeof body.replyTo === 'object') {
      const id     = typeof body.replyTo.id     === 'string' ? body.replyTo.id.toLowerCase()     : '';
      const pubkey = typeof body.replyTo.pubkey === 'string' ? body.replyTo.pubkey.toLowerCase() : '';
      const relay  = typeof body.replyTo.relay  === 'string' ? body.replyTo.relay                : '';
      if (/^[0-9a-f]{64}$/.test(id)) {
        tags.push(['e', id, relay, 'reply']);
        if (/^[0-9a-f]{64}$/.test(pubkey)) tags.push(['p', pubkey]);
      }
    }
  } else if (kind === 7) {
    const target = body.target;
    if (!target || typeof target !== 'object') return { ok: false, error: 'target required for reaction' };
    const id     = typeof target.id     === 'string' ? target.id.toLowerCase()     : '';
    const pubkey = typeof target.pubkey === 'string' ? target.pubkey.toLowerCase() : '';
    if (!/^[0-9a-f]{64}$/.test(id))     return { ok: false, error: 'target.id must be 64-char hex' };
    if (!/^[0-9a-f]{64}$/.test(pubkey)) return { ok: false, error: 'target.pubkey must be 64-char hex' };
    const rawContent = typeof body.content === 'string' ? body.content : REACTION_LIKE_CONTENT;
    content = rawContent.slice(0, 32);
    tags.push(['e', id]);
    tags.push(['p', pubkey]);
  } else if (kind === 6) {
    const target = body.target;
    if (!target || typeof target !== 'object') return { ok: false, error: 'target required for repost' };
    const id     = typeof target.id     === 'string' ? target.id.toLowerCase()     : '';
    const pubkey = typeof target.pubkey === 'string' ? target.pubkey.toLowerCase() : '';
    const relay  = typeof target.relay  === 'string' ? target.relay                : '';
    if (!/^[0-9a-f]{64}$/.test(id))     return { ok: false, error: 'target.id must be 64-char hex' };
    if (!/^[0-9a-f]{64}$/.test(pubkey)) return { ok: false, error: 'target.pubkey must be 64-char hex' };
    tags.push(['e', id, relay, 'mention']);
    tags.push(['p', pubkey]);
  }

  // Stamp client identity (full 4-element NIP-89 form; see CLIENT_TAG).
  tags.push([...CLIENT_TAG]);

  return {
    ok: true,
    template: {
      kind,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content,
    },
  };
}
