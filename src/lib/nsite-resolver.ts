/**
 * nsite resolver — read-side complement to src/commands/Nsite.tsx (the
 * publish side). Given an address (`npub`, NIP-05 identifier, NSIT name,
 * or `nsite://<x>` URI), produce:
 *
 *   1. The author's hex pubkey
 *   2. A path → SHA256 map built from their kind:34128 events (NIP-5A v1,
 *      which is what `nsyte` actually publishes today)
 *   3. The author's Blossom server list (kind:10063 BUD-03, with fallback)
 *
 * The HTTP layer in routes/nsite.ts then fetches blobs from those Blossom
 * servers (verifying SHA256 on every byte) and serves them into a
 * sandboxed iframe in the dashboard's nsite panel.
 *
 * Out of scope for v1:
 *   - NIP-5A v2 manifests (kind 15128 / 35128). `nsyte` publishes v1; if
 *     v2 appears in the wild later, add a path here that prefers v2 and
 *     falls back to v1.
 *   - Bitcoin OP_RETURN scanning for NSIT names. Resolution goes through
 *     a configurable trusted indexer (see resolveNsitName below).
 *
 * Everything is pure async + functional so the route layer can compose
 * these calls without state. The in-memory caches live in routes/nsite.ts,
 * not here.
 */
import { nip19 } from 'nostr-tools';
import {
  queryRelaysDirect, getTagValue, getTags,
  type NostrEvent, type RelayQueryOptions, type RelayQueryResult,
} from './nostr-query.js';
import { safeHttpUrl } from './url-safety.js';

// ── Types ─────────────────────────────────────────────────────────────────

export type AddressSource = 'npub' | 'nip05' | 'nsit' | 'hex';

export interface ResolvedAddress {
  pubkey: string;          // 64-char hex
  source: AddressSource;
  /** Display form preserved for the address bar (e.g. the bech32 npub). */
  display: string;
}

export interface SiteIndex {
  /** path (no leading slash) → SHA256 (hex, lowercased). */
  files: Map<string, string>;
  /** Newest event's created_at; used for cache-bust + freshness indicator. */
  latestAt: number;
  /** Oldest event's created_at; surfaces stale-publish situations. */
  oldestAt: number;
  /** Per-file diagnostic detail (the events that won the per-path dedup). */
  entries: SiteIndexEntry[];
  /** Total file events seen across relays before per-path dedup. */
  totalEventsSeen: number;
  /** Which NIP-5A flavor this index came from. v2 manifests pack a whole
   *  site into one event; v1 has one event per file. */
  format: 'v2-named' | 'v2-root' | 'v1';
  /** Blossom servers announced in a v2 manifest's `server` tags. Empty
   *  for v1 (use kind:10063 fetch instead). The route layer prefers
   *  these over kind:10063 when present — they're the canonical
   *  declaration for the specific publish. */
  manifestServers: string[];
}

export interface SiteIndexEntry {
  path:      string;
  sha256:    string;
  createdAt: number;
  /** event id for cross-referencing with raw relay data (`nak event`, etc). */
  eventId:   string;
}

export interface BlossomFetchResult {
  bytes: Uint8Array;
  /** Sniffed from the response Content-Type, may be empty. */
  contentType: string;
  /** Which server actually served it (for diagnostics). */
  servedBy: string;
}

export class NsiteError extends Error {
  constructor(public code: NsiteErrorCode, message: string) {
    super(message);
    this.name = 'NsiteError';
  }
}
export type NsiteErrorCode =
  | 'bad_address'
  | 'name_indexer_disabled'
  | 'name_not_found'
  | 'nip05_failed'
  | 'no_files'
  | 'no_blossom_servers'
  | 'blob_fetch_failed'
  | 'hash_mismatch';

// ── Defaults ──────────────────────────────────────────────────────────────

// Mirrors the defaults `nostr-station nsite init` writes into project.json.
export const DEFAULT_NSITE_RELAYS: string[] = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band',
];

// Same defaults `nostr-station nsite init` proposes, plus the broader
// public Blossom pool. Used as a fallback union when the author's
// kind:10063 list is missing, empty, or comes back 404 on every blob —
// many published nsites announce only one server (e.g. their own
// blossom.band instance), so without a fallback the panel renders blank
// on a single-server outage. nsite.lol does the same union internally.
export const DEFAULT_BLOSSOM_SERVERS: string[] = [
  'https://blossom.westernbtc.com',
  'https://cdn.satellite.earth',
  'https://blossom.primal.net',
  'https://blossom.band',
  'https://nostr.download',
];

const NSITE_FILE_KIND_V1        = 34128;  // NIP-5A v1: one event per file
const NSITE_MANIFEST_KIND_NAMED = 35128;  // NIP-5A v2: name-keyed manifest (addressable, d-tag = name)
const NSITE_MANIFEST_KIND_ROOT  = 15128;  // NIP-5A v2: root manifest (replaceable)
const BLOSSOM_SERVERS_KIND      = 10063;
const NSIT_NAME_KIND            = 35129;  // addressable name → pubkey index (NSIT)
const OUTBOX_RELAYS_KIND        = 10002;  // NIP-65 relay list metadata
const RELAY_QUERY_TIMEOUT_MS = 8_000;

// Titan's hosted nsit-indexer (Rust service that watches Bitcoin blocks for
// NSIT OP_RETURNs and publishes kind:35129 name→pubkey events). Hardcoded
// in btcjt/titan crates/titan-resolver/src/lib.rs as INDEXER_PUBKEY_HEX.
// Trust model: we accept this pubkey's signed events by default; anyone
// who'd rather run their own indexer can override via env. NSIT names are
// content-derived from Bitcoin, so an honest indexer will always agree
// with the chain — the trust is in "this pubkey runs an honest indexer",
// not "this pubkey decides who owns what".
export const DEFAULT_NSIT_INDEXER_PUBKEY =
  'bec1a370130fed4fb9f78f9efc725b35104d827470e75573558a87a9ac5cde44';

// Discovery relays the indexer publishes to (Titan defaults). Standard
// read relays (damus.io, nos.lol, …) rarely carry kind:35129 events, so
// the resolver queries these dedicated index relays instead of the
// station owner's read-relay set.
export const DEFAULT_NSIT_INDEXER_RELAYS = [
  'wss://purplepag.es',
  'wss://user.kindpag.es',
  'wss://relay.westernbtc.com',
  'wss://relay.primal.net',
  'wss://relay.damus.io',
];

// Profile / outbox discovery relays. Purplepag.es and user.kindpag.es
// specifically index profile-adjacent kinds — kind:0 metadata, kind:3
// follows, kind:10002 NIP-65 relay lists, etc. Titan Browser keeps a
// connection open to these during content fetch (visible in its devtools
// network tab) so that the author's kind:10002 outbox announcement can
// be discovered even when neither the station owner nor any of their
// configured relays carry it.
//
// Without this, the NIP-65 union we added in #106 has a bootstrap
// problem: we use the OWNER'S relays to find the AUTHOR's outbox event,
// so if the owner's relays don't have the author's kind:10002 we get an
// empty outbox tier even though the author has one announced elsewhere.
export const PROFILE_DISCOVERY_RELAYS = [
  'wss://purplepag.es',
  'wss://user.kindpag.es',
];

// Content discovery fallback for kind:34128 / kind:10063 queries.
//
// Mirrors Titan's FALLBACK_RELAYS in btcjt/titan crates/titan-resolver/
// src/lib.rs. Titan-ecosystem nsites land on relay.westernbtc.com (the
// Titan crew's own content relay), and Titan Browser always queries this
// set in addition to whatever NIP-65 / user-configured relays it has —
// otherwise a fresh box with no read-relay overlap simply can't see
// Titan-published content (this is exactly the bug surfaced when
// nsite://titan rendered the full TITAN site in Titan Browser but came
// up empty in nostr-station).
//
// Why a separate constant from DEFAULT_NSITE_RELAYS: DEFAULT_NSITE_RELAYS
// is the publish-side default that `nsite init` writes into project.json
// (changing it could surprise users who rely on those specific relays).
// DEFAULT_CONTENT_RELAYS is the read-side discovery safety net —
// always-on, complementary to the user's configured relays.
export const DEFAULT_CONTENT_RELAYS = [
  'wss://relay.westernbtc.com',
  'wss://relay.primal.net',
  'wss://relay.damus.io',
];

// ── Address resolution ────────────────────────────────────────────────────

const HEX64 = /^[0-9a-f]{64}$/i;
// NSIT name spec: a-z, 0-9, hyphens; 1–41 chars; lowercase. The exact
// `^[a-z0-9-]{1,41}$` rule comes from the NSIT protocol doc, but we
// deliberately reject empty + over-long strings here, not enforce length
// minutiae — the indexer is the authority on what's a valid registration.
const NSIT_NAME = /^[a-z0-9-]{1,41}$/;

/**
 * Configuration for the NSIT (Bitcoin name) resolution path. Pass `null`
 * to disable NSIT lookups entirely (then bare names produce
 * `name_indexer_disabled`).
 */
export interface NsitResolveConfig {
  /** 64-hex pubkey of the indexer service whose kind:35129 events we trust. */
  indexerPubkey: string;
  /** Relays where the indexer publishes kind:35129. Distinct from owner read relays. */
  relays: string[];
}

/** Pluggable relay-query function — defaults to queryRelaysDirect. Tests inject their own. */
export type QueryFn = (opts: RelayQueryOptions) => Promise<RelayQueryResult>;

/**
 * Normalize whatever the user typed into a resolved pubkey + display form.
 * Accepts:
 *   - `npub1...`                          → bech32 decode
 *   - bare hex pubkey (64 chars)          → passthrough
 *   - `user@host`                         → NIP-05 lookup
 *   - `user.tld` (no `@`, has a dot)      → NIP-05 `_@<host>` fallback
 *   - `nsite://<x>`                       → strip scheme, re-dispatch
 *   - `https://<x>.nsite.lol/...` or
 *     `https://<x>.nostr.hu/...`          → recognize as gateway URL,
 *                                            extract the npub-encoded
 *                                            subdomain, re-dispatch
 *   - bare NSIT name (a-z0-9-, 1–41ch)    → indexer lookup via kind:35129
 *
 * `nsitConfig === null` disables NSIT lookups; bare names then throw
 * `name_indexer_disabled` so the caller can surface a clear message.
 */
export async function resolveAddress(
  raw: string,
  nsitConfig: NsitResolveConfig | null,
  fetchImpl: typeof fetch = fetch,
  queryFn: QueryFn = queryRelaysDirect,
): Promise<ResolvedAddress> {
  const trimmed = (raw || '').trim();
  if (!trimmed) throw new NsiteError('bad_address', 'empty address');

  // Strip nsite:// scheme + any trailing slash so the rest of the dispatch
  // works on the bare identifier.
  let s = trimmed;
  if (s.startsWith('nsite://')) s = s.slice('nsite://'.length);

  // Gateway URLs paste-in fix: `https://<encoded>.nsite.lol/path` and
  // `https://<encoded>.nostr.hu/path` both encode the author's npub in the
  // leftmost subdomain. Two encodings observed in the wild:
  //   1. `<bech32-npub>.nsite.lol`         — full or hrp-stripped bech32
  //   2. `<base36-pubkey><project-name>.nsite.lol` — nsyte's nsite.lol
  //      gateway, pubkey base36-encoded then project name appended
  //      (verified empirically: nostr-station's own published nsite).
  // Strip everything else and re-dispatch through the normal pubkey path.
  const gwMatch = s.match(/^https?:\/\/([^./]+)\.(?:nsite\.lol|nostr\.hu)(?::\d+)?(?:\/.*)?$/i);
  if (gwMatch) {
    const sub = gwMatch[1];
    const fromGateway = decodeGatewaySubdomain(sub);
    if (fromGateway) s = fromGateway;
    else throw new NsiteError(
      'bad_address',
      `gateway URL subdomain "${sub}" did not decode to a recognizable pubkey — paste the author's npub directly`,
    );
  }

  s = s.replace(/\/+$/, '');

  // Bare hex pubkey
  if (HEX64.test(s)) {
    return { pubkey: s.toLowerCase(), source: 'hex', display: s.toLowerCase() };
  }

  // bech32 npub
  if (s.startsWith('npub1')) {
    try {
      const dec = nip19.decode(s);
      if (dec.type !== 'npub') throw new NsiteError('bad_address', `expected npub, got ${dec.type}`);
      return { pubkey: dec.data as string, source: 'npub', display: s };
    } catch (e: any) {
      if (e instanceof NsiteError) throw e;
      throw new NsiteError('bad_address', `invalid npub: ${e?.message || e}`);
    }
  }

  // NIP-05 identifier with explicit '@'.
  if (s.includes('@')) {
    const pubkey = await resolveNip05(s, fetchImpl);
    return { pubkey, source: 'nip05', display: s };
  }

  // NSIT bare name — query the trusted indexer via Nostr.
  if (NSIT_NAME.test(s)) {
    if (!nsitConfig) {
      throw new NsiteError(
        'name_indexer_disabled',
        `NSIT name "${s}" needs a name indexer to resolve. Set NSITE_NSIT_INDEXER_PUBKEY in the station env (default: Titan's hosted indexer), or use the author's npub / NIP-05 directly.`,
      );
    }
    const pubkey = await resolveNsitName(s, nsitConfig, queryFn);
    return { pubkey, source: 'nsit', display: s };
  }

  // Final fallback: bare-domain NIP-05 (`name.tld` form → `_@<host>`).
  if (s.includes('.')) {
    const pubkey = await resolveNip05(`_@${s}`, fetchImpl);
    return { pubkey, source: 'nip05', display: s };
  }

  throw new NsiteError('bad_address', `unrecognized address shape: ${trimmed}`);
}

// ── Gateway subdomain decoding ────────────────────────────────────────────

/**
 * Try to extract a 32-byte hex pubkey from a gateway subdomain. Handles
 * three shapes seen in the wild on nsite.lol / nostr.hu:
 *
 *   - bare bech32 npub:           `npub1<58chars>`         (full)
 *   - hrp-stripped bech32:        `<58chars>`              (no `npub1`)
 *   - nsyte+nsite.lol form:       `<base36-pubkey><name>`  (49–50 chars
 *                                                           of base36 +
 *                                                           project name)
 *
 * Base36 of a random 32-byte value is almost always 50 chars (49 only when
 * the high byte is 0x00, ~1/256). We try 50 first and fall back to 49.
 *
 * Returns the bech32 npub form so the caller can re-dispatch through the
 * existing npub branch (single source of truth for pubkey validation).
 */
export function decodeGatewaySubdomain(sub: string): string | null {
  if (!sub) return null;

  // Direct bech32 npub.
  if (/^npub1[023456789ac-hj-np-z]+$/.test(sub)) {
    try { if (nip19.decode(sub).type === 'npub') return sub; } catch {}
  }

  // hrp-stripped bech32: prepend `npub1` and try.
  if (/^[023456789ac-hj-np-z]{58}$/.test(sub)) {
    const candidate = `npub1${sub}`;
    try { if (nip19.decode(candidate).type === 'npub') return candidate; } catch {}
  }

  // nsyte+nsite.lol base36 form. Try 50 then 49 leading chars.
  for (const prefixLen of [50, 49]) {
    if (sub.length < prefixLen) continue;
    const candidate = sub.slice(0, prefixLen).toLowerCase();
    if (!/^[0-9a-z]+$/.test(candidate)) continue;
    const hex = base36ToHex32(candidate);
    if (!hex) continue;
    try { return nip19.npubEncode(hex); } catch { /* try next */ }
  }
  return null;
}

/**
 * Base36 → 32-byte hex (lowercase, zero-padded). Returns null if the
 * decoded value overflows 256 bits (i.e. the prefix-length guess was too
 * generous and the trailing chars are actually project-name letters).
 */
function base36ToHex32(s: string): string | null {
  const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz';
  let n = 0n;
  for (const c of s) {
    const v = DIGITS.indexOf(c);
    if (v < 0) return null;
    n = n * 36n + BigInt(v);
  }
  if (n >= (1n << 256n) || n === 0n) return null;
  return n.toString(16).padStart(64, '0');
}

// ── NIP-05 ────────────────────────────────────────────────────────────────

async function resolveNip05(identifier: string, fetchImpl: typeof fetch): Promise<string> {
  const at = identifier.indexOf('@');
  const local = at >= 0 ? identifier.slice(0, at) : '_';
  const host  = at >= 0 ? identifier.slice(at + 1) : identifier;
  if (!host || !/^[a-z0-9.-]+$/i.test(host)) {
    throw new NsiteError('bad_address', `invalid NIP-05 host: ${host}`);
  }
  const url = `https://${host}/.well-known/nostr.json?name=${encodeURIComponent(local)}`;
  let json: any;
  try {
    const res = await fetchImpl(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`status ${res.status}`);
    json = await res.json();
  } catch (e: any) {
    throw new NsiteError('nip05_failed', `NIP-05 lookup failed for ${identifier}: ${e?.message || e}`);
  }
  const hex = json?.names?.[local];
  if (typeof hex !== 'string' || !HEX64.test(hex)) {
    throw new NsiteError('nip05_failed', `NIP-05 ${identifier} did not return a valid pubkey`);
  }
  return hex.toLowerCase();
}

// ── NSIT name resolution (kind:35129 via Nostr) ───────────────────────────
//
// Titan's nsit-indexer service scans Bitcoin OP_RETURN data for NSIT
// registrations and publishes a kind:35129 event per name:
//
//   kind:    35129  (parameterized replaceable; key = `d` tag)
//   pubkey:  <indexer pubkey>  (signs the event — we filter on this)
//   tags:    [["d", "<name>"], ["p", "<resolved-pubkey-hex>"], …]
//
// We trust the configured indexer pubkey to honestly index the chain.
// Bitcoin makes the mapping deterministic, so any honest indexer arrives
// at the same answer. nostr-station never scans the chain itself —
// running a Bitcoin node is out of scope for a Nostr station.

export async function resolveNsitName(
  name: string,
  config: NsitResolveConfig,
  queryFn: QueryFn = queryRelaysDirect,
): Promise<string> {
  if (!HEX64.test(config.indexerPubkey)) {
    throw new NsiteError(
      'name_indexer_disabled',
      `indexer pubkey is not a valid 64-hex string`,
    );
  }
  if (config.relays.length === 0) {
    throw new NsiteError(
      'name_indexer_disabled',
      `no relays configured for NSIT name lookups`,
    );
  }
  const { events } = await queryFn({
    filter: {
      kinds:   [NSIT_NAME_KIND],
      authors: [config.indexerPubkey],
      tags:    { d: name },
    },
    relays:    config.relays,
    stream:    false,
    timeoutMs: 6_000,
    // Short-circuit on the first matching event — replaceable events from
    // a single author are unique by `d`, so one hit is the answer. The
    // race-then-linger semantics Titan describes amount to this.
    acceptUntil: (evs) => evs.length > 0,
  });
  if (!events.length) {
    throw new NsiteError(
      'name_not_found',
      `NSIT name '${name}' not found on indexer relays — name may be unregistered, or the indexer is behind`,
    );
  }
  // Replaceable per (author, d) — newest wins if multiple slip through.
  const newest = events.reduce((a, b) => (b.created_at > a.created_at ? b : a));
  const p = getTagValue(newest, 'p');
  if (!p || !HEX64.test(p)) {
    throw new NsiteError(
      'name_not_found',
      `NSIT event for '${name}' lacks a valid p tag`,
    );
  }
  return p.toLowerCase();
}

// ── Site index — NIP-5A v2 manifest preferred, v1 fallback ────────────────

export interface FetchSiteIndexOpts {
  /** NSIT site name when the address resolved via kind:35129. Triggers a
   *  kind:35128 (`d=<name>`) lookup before the kind:15128 root probe. */
  name?: string;
}

/**
 * Build the path → SHA256 manifest for an author. Tries three sources in
 * order; the first non-empty result wins:
 *
 *   1. Kind 35128 (NSIT-named v2 manifest, `d` tag = name)  — if `name` is set
 *   2. Kind 15128 (root v2 manifest, replaceable)
 *   3. Kind 34128 (v1, one event per file)
 *
 * v2 manifests carry the entire site in one event's tags (`["path", path,
 * sha256]` per file, `["server", url]` per Blossom server). v1 spreads it
 * across per-file events keyed by `d`.
 *
 * Mirrors Titan's `fetch_manifest` → `fetch_v1_file_events` fallback in
 * btcjt/titan crates/titan-resolver/src/relay.rs; without this, Titan-
 * ecosystem nsites published as v2 (notably nsite://titan and Shakespeare-
 * built sites) are invisible to us.
 *
 * Throws `no_files` only when all three probes come back empty.
 */
export async function fetchSiteIndex(
  pubkey: string,
  relays: string[],
  opts: FetchSiteIndexOpts | QueryFn = {},
  queryFn: QueryFn = queryRelaysDirect,
): Promise<SiteIndex> {
  // Back-compat: callers used to pass queryFn as the third positional arg.
  // If we got a function in opts position, treat it as the queryFn and
  // synthesize an empty opts.
  let options: FetchSiteIndexOpts;
  if (typeof opts === 'function') { queryFn = opts as QueryFn; options = {}; }
  else options = opts;

  // 1. Named v2 manifest (kind:35128)
  if (options.name) {
    const named = await tryV2Manifest(
      pubkey, options.name, NSITE_MANIFEST_KIND_NAMED, 'v2-named', relays, queryFn,
    );
    if (named) return named;
  }

  // 2. Root v2 manifest (kind:15128)
  const root = await tryV2Manifest(
    pubkey, null, NSITE_MANIFEST_KIND_ROOT, 'v2-root', relays, queryFn,
  );
  if (root) return root;

  // 3. Fall back to v1 — one event per file
  return fetchV1FileEvents(pubkey, relays, queryFn);
}

async function tryV2Manifest(
  pubkey: string,
  name: string | null,
  kind: number,
  format: 'v2-named' | 'v2-root',
  relays: string[],
  queryFn: QueryFn,
): Promise<SiteIndex | null> {
  const filter: any = { kinds: [kind], authors: [pubkey], limit: 5 };
  if (name) filter.tags = { d: name };
  const { events } = await queryFn({
    filter, relays, stream: false, timeoutMs: RELAY_QUERY_TIMEOUT_MS,
  });
  if (!events.length) return null;
  // Replaceable: newest wins (kind:35128 is per-name addressable;
  // kind:15128 is per-author replaceable).
  const newest = events.reduce((a, b) => (b.created_at > a.created_at ? b : a));
  return parseV2Manifest(newest, format, events.length);
}

function parseV2Manifest(
  event: NostrEvent,
  format: 'v2-named' | 'v2-root',
  totalEventsSeen: number,
): SiteIndex | null {
  // Tag schema (verified against btcjt/titan crates/titan-resolver/src/manifest.rs):
  //   ["path", "<path>", "<sha256-hex>"]    one per file
  //   ["server", "<https-url>"]             one per Blossom server
  //   ["d", "<name>"]                       present on kind:35128 only
  const files   = new Map<string, string>();
  const entries: SiteIndexEntry[] = [];
  const servers: string[] = [];
  for (const tag of event.tags) {
    if (!Array.isArray(tag) || tag.length < 2) continue;
    if (tag[0] === 'path' && tag.length >= 3 && typeof tag[1] === 'string' && typeof tag[2] === 'string' && HEX64.test(tag[2])) {
      const path = normalizePath(tag[1]);
      const sha  = tag[2].toLowerCase();
      files.set(path, sha);
      entries.push({ path, sha256: sha, createdAt: event.created_at, eventId: event.id });
    } else if (tag[0] === 'server' && typeof tag[1] === 'string') {
      const url = safeHttpUrl(tag[1]);
      if (url) servers.push(url.replace(/\/+$/, ''));
    }
  }
  if (files.size === 0) return null;
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return {
    files,
    latestAt:        event.created_at,
    oldestAt:        event.created_at,
    entries,
    totalEventsSeen,
    format,
    manifestServers: servers,
  };
}

async function fetchV1FileEvents(
  pubkey: string,
  relays: string[],
  queryFn: QueryFn,
): Promise<SiteIndex> {
  const { events } = await queryFn({
    filter: { kinds: [NSITE_FILE_KIND_V1], authors: [pubkey], limit: 500 },
    relays,
    stream: false,
    timeoutMs: RELAY_QUERY_TIMEOUT_MS,
  });

  // Replaceable: keep newest event per `d` tag.
  const latestPerPath = new Map<string, NostrEvent>();
  for (const ev of events) {
    const d = getTagValue(ev, 'd');
    if (!d) continue;
    const path = normalizePath(d);
    const prev = latestPerPath.get(path);
    if (!prev || ev.created_at > prev.created_at) latestPerPath.set(path, ev);
  }

  const files   = new Map<string, string>();
  const entries: SiteIndexEntry[] = [];
  let latestAt  = 0;
  let oldestAt  = Number.MAX_SAFE_INTEGER;
  for (const [path, ev] of latestPerPath) {
    const x = getTagValue(ev, 'x');
    if (!x || !HEX64.test(x)) continue;
    const sha = x.toLowerCase();
    files.set(path, sha);
    entries.push({ path, sha256: sha, createdAt: ev.created_at, eventId: ev.id });
    if (ev.created_at > latestAt) latestAt = ev.created_at;
    if (ev.created_at < oldestAt) oldestAt = ev.created_at;
  }
  if (oldestAt === Number.MAX_SAFE_INTEGER) oldestAt = 0;
  entries.sort((a, b) => a.path.localeCompare(b.path));

  if (files.size === 0) {
    throw new NsiteError(
      'no_files',
      `pubkey ${pubkey.slice(0, 12)}… resolves correctly, but no NIP-5A v2 manifest (kind:35128/15128) and no v1 file events (kind:34128) were found on the queried relays — the author may not have published an nsite under this address yet, or it lives on relays you don't currently query`,
    );
  }
  return {
    files,
    latestAt,
    oldestAt,
    entries,
    totalEventsSeen: events.length,
    format:          'v1',
    manifestServers: [],
  };
}

/** Normalize a path tag to "no leading slash, lowercase". `/index.html` → `index.html`. */
export function normalizePath(p: string): string {
  let s = p.trim();
  if (!s) return 'index.html';
  // Drop query/hash if present — d-tags are path-only by convention but
  // we'd rather forgive than 404 on a stray suffix.
  const q = s.indexOf('?'); if (q >= 0) s = s.slice(0, q);
  const h = s.indexOf('#'); if (h >= 0) s = s.slice(0, h);
  s = s.replace(/^\/+/, '');
  if (!s || s.endsWith('/')) s = `${s}index.html`;
  return s;
}

// ── Blossom server list (kind:10063 / BUD-03) ─────────────────────────────

/**
 * Returns the author's announced Blossom servers UNIONed with the public
 * default pool, deduplicated, author-listed first. Why the union: many
 * published nsites announce only their own single Blossom server, which
 * then 404s for assets that weren't successfully uploaded (or have since
 * been GC'd). Trying the public pool as a fallback recovers most of those
 * cases — gateways like nsite.lol take the same approach internally.
 *
 * If the author published no kind:10063, we return the defaults alone.
 */
export async function fetchBlossomServers(
  pubkey: string,
  relays: string[],
  /** Fallback Blossom server list. Defaults to DEFAULT_BLOSSOM_SERVERS;
   *  the Config-panel-aware route passes the user-edited list instead. */
  fallbackServers: string[] = DEFAULT_BLOSSOM_SERVERS,
): Promise<string[]> {
  const { events } = await queryRelaysDirect({
    filter: { kinds: [BLOSSOM_SERVERS_KIND], authors: [pubkey], limit: 5 },
    relays,
    stream: false,
    timeoutMs: 4_000,
  });
  // Replaceable kind: newest wins.
  let newest: NostrEvent | null = null;
  for (const ev of events) {
    if (!newest || ev.created_at > newest.created_at) newest = ev;
  }
  const authorListed: string[] = [];
  if (newest) {
    for (const tag of getTags(newest, 'server')) {
      const url = safeHttpUrl(tag[1]);
      if (url) authorListed.push(url.replace(/\/+$/, ''));
    }
  }
  // Author-listed first (they're presumed canonical), defaults appended
  // and deduped. Lowercased for the dedupe pass so http://x and http://X
  // don't both make it through.
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of [...authorListed, ...fallbackServers]) {
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

// ── Author outbox relays (NIP-65 / kind:10002) ────────────────────────────
//
// When browsing someone else's nsite, their kind:34128 and kind:10063
// events live on THEIR relays — which usually overlap with the station
// owner's read set, but aren't guaranteed to. NIP-65 (kind:10002) is the
// canonical "where do I publish" announcement: a list of relay URLs tagged
// `r` with an optional read/write hint.
//
// Strategy: query the bootstrap relays (the owner's read set) for the
// author's kind:10002, take the write-marked or untagged relay URLs
// (those are the author's outbox), and return them. The caller unions
// these with the bootstrap set before fetching the file index / Blossom
// server list — maximizing the chance that the author's events are
// reachable without changing the owner's relay config.
//
// If no kind:10002 is found, returns []. Caller can decide whether to
// fall back to bootstrap relays alone (current behavior).
export async function fetchAuthorOutboxRelays(
  pubkey: string,
  bootstrapRelays: string[],
): Promise<string[]> {
  if (bootstrapRelays.length === 0) return [];
  const { events } = await queryRelaysDirect({
    filter: { kinds: [OUTBOX_RELAYS_KIND], authors: [pubkey], limit: 5 },
    relays: bootstrapRelays,
    stream: false,
    timeoutMs: 4_000,
  });
  // Replaceable kind: newest wins.
  let newest: NostrEvent | null = null;
  for (const ev of events) {
    if (!newest || ev.created_at > newest.created_at) newest = ev;
  }
  if (!newest) return [];
  const outbox: string[] = [];
  for (const tag of getTags(newest, 'r')) {
    const url = (tag[1] ?? '').trim();
    if (!url || !/^wss?:\/\//i.test(url)) continue;
    // NIP-65 marker: tag[2] is optional. "write" means outbox (we want),
    // "read" means inbox-only (we don't want for nsite browsing), absent
    // means both. Anything else: treat as both (forgiving).
    const marker = (tag[2] ?? '').toLowerCase();
    if (marker === 'read') continue;
    outbox.push(url.replace(/\/+$/, ''));
  }
  return outbox;
}

/**
 * Union of two relay lists, deduped (lowercased for the dedupe key so
 * `wss://Foo/` and `wss://foo` don't both make it through), order
 * preserved with `primary` first.
 */
export function unionRelays(primary: string[], secondary: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of [...primary, ...secondary]) {
    const k = r.toLowerCase().replace(/\/+$/, '');
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

// ── Blob fetch with SHA256 verify ─────────────────────────────────────────

import { createHash } from 'crypto';

/**
 * Try each Blossom server in order; return the first byte stream that
 * verifies against `sha256`. A 404 / network error advances to the next
 * server. A hash mismatch is treated as fatal for that server (and counted
 * as 'tampered') — we continue, but the count surfaces in diagnostics so a
 * misbehaving CDN doesn't quietly become the only source.
 */
export async function fetchBlob(
  sha256: string,
  servers: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<BlossomFetchResult> {
  if (!HEX64.test(sha256)) {
    throw new NsiteError('blob_fetch_failed', `invalid sha256: ${sha256}`);
  }
  if (servers.length === 0) {
    throw new NsiteError('no_blossom_servers', 'no Blossom servers configured');
  }
  const errors: string[] = [];
  for (const server of servers) {
    const url = `${server.replace(/\/+$/, '')}/${sha256}`;
    let res: Response;
    try {
      res = await fetchImpl(url, { redirect: 'follow' });
    } catch (e: any) {
      errors.push(`${server}: ${e?.message || e}`);
      continue;
    }
    if (!res.ok) {
      errors.push(`${server}: HTTP ${res.status}`);
      continue;
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    const actual = createHash('sha256').update(buf).digest('hex');
    if (actual !== sha256) {
      errors.push(`${server}: hash mismatch (got ${actual.slice(0, 12)}…)`);
      continue;
    }
    return {
      bytes: buf,
      contentType: String(res.headers.get('content-type') || ''),
      servedBy: server,
    };
  }
  throw new NsiteError('blob_fetch_failed', `all ${servers.length} servers failed:\n  ${errors.join('\n  ')}`);
}

// ── Content-type sniffing ─────────────────────────────────────────────────
//
// Blossom serves content-addressed bytes; the response Content-Type is the
// server's guess and is often wrong (most CDNs return `application/octet-
// stream` for unknown hashes). We re-derive from the requested PATH
// extension so the browser parses HTML as HTML, JS as JS, etc. Same as
// what gateways like nsite.lol do.

const MIME_BY_EXT: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm:  'text/html; charset=utf-8',
  css:  'text/css; charset=utf-8',
  js:   'application/javascript; charset=utf-8',
  mjs:  'application/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg:  'image/svg+xml',
  png:  'image/png',
  jpg:  'image/jpeg',
  jpeg: 'image/jpeg',
  gif:  'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico:  'image/x-icon',
  woff: 'font/woff',
  woff2:'font/woff2',
  ttf:  'font/ttf',
  otf:  'font/otf',
  txt:  'text/plain; charset=utf-8',
  md:   'text/plain; charset=utf-8',
  xml:  'application/xml; charset=utf-8',
  wasm: 'application/wasm',
  map:  'application/json; charset=utf-8',
};

export function mimeForPath(path: string, fallback = 'application/octet-stream'): string {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return fallback;
  const ext = path.slice(dot + 1).toLowerCase();
  return MIME_BY_EXT[ext] ?? fallback;
}
