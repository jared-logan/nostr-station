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
  type NostrEvent,
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

// Same defaults `nostr-station nsite init` proposes. Used when the author's
// kind:10063 list is empty or unfetchable.
export const DEFAULT_BLOSSOM_SERVERS: string[] = [
  'https://cdn.satellite.earth',
  'https://blossom.primal.net',
];

const NSITE_FILE_KIND     = 34128;
const BLOSSOM_SERVERS_KIND = 10063;
const RELAY_QUERY_TIMEOUT_MS = 8_000;

// ── Address resolution ────────────────────────────────────────────────────

const HEX64 = /^[0-9a-f]{64}$/i;
// NSIT name spec: a-z, 0-9, hyphens; 1–41 chars; lowercase. The exact
// `^[a-z0-9-]{1,41}$` rule comes from the NSIT protocol doc, but we
// deliberately reject empty + over-long strings here, not enforce length
// minutiae — the indexer is the authority on what's a valid registration.
const NSIT_NAME = /^[a-z0-9-]{1,41}$/;

/**
 * Normalize whatever the user typed into a resolved pubkey + display form.
 * Accepts:
 *   - `npub1...`                  → bech32 decode
 *   - bare hex pubkey (64 chars)  → passthrough
 *   - `user@host` / `user.host`   → NIP-05 lookup
 *   - `nsite://<x>`               → strip scheme, re-dispatch
 *   - bare NSIT name              → trusted-indexer lookup
 *
 * `nameIndexerUrl` is consulted ONLY for bare NSIT names. Pass null to
 * disable NSIT resolution; the function then throws `name_indexer_disabled`
 * for any input that's not an npub / hex / NIP-05.
 */
export async function resolveAddress(
  raw: string,
  nameIndexerUrl: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<ResolvedAddress> {
  const trimmed = (raw || '').trim();
  if (!trimmed) throw new NsiteError('bad_address', 'empty address');

  // Strip nsite:// scheme + any trailing slash so the rest of the dispatch
  // works on the bare identifier.
  let s = trimmed;
  if (s.startsWith('nsite://')) s = s.slice('nsite://'.length);
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

  // NIP-05 identifier: must contain '@' OR be of the form `user.host.tld`
  // with at least one '.' AND not look like a NSIT name. We require '@' or
  // a dot-with-tld to avoid clashing with bare names like `titan` —
  // those go through the indexer path below.
  if (s.includes('@')) {
    const pubkey = await resolveNip05(s, fetchImpl);
    return { pubkey, source: 'nip05', display: s };
  }

  // NSIT bare name
  if (NSIT_NAME.test(s)) {
    if (!nameIndexerUrl) {
      throw new NsiteError(
        'name_indexer_disabled',
        `NSIT name "${s}" needs a name indexer to resolve. Set NSITE_NAME_INDEXER_URL in the station env, or use the author's npub / NIP-05 directly.`,
      );
    }
    const pubkey = await resolveNsitName(s, nameIndexerUrl, fetchImpl);
    return { pubkey, source: 'nsit', display: s };
  }

  // Final fallback: try NIP-05 (`name.tld` form, no `@` — NIP-05 implicitly
  // uses `_@<host>` for the bare-domain case).
  if (s.includes('.')) {
    const pubkey = await resolveNip05(`_@${s}`, fetchImpl);
    return { pubkey, source: 'nip05', display: s };
  }

  throw new NsiteError('bad_address', `unrecognized address shape: ${trimmed}`);
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

// ── NSIT name indexer ─────────────────────────────────────────────────────
//
// The reference implementation (btcjt/titan, Rust) resolves NSIT names by
// scanning Bitcoin OP_RETURN data. nostr-station deliberately does NOT do
// that — we trust a configurable HTTP indexer instead. Expected response:
//
//   GET <indexerUrl>/<name>          →  200  { "pubkey": "<64-hex>" }
//                                    →  404  (name unregistered)
//
// If the user's chosen indexer uses a different URL shape, they can point
// `nameIndexerUrl` directly at a templated URL by including `{name}` in
// it — we substitute, otherwise append `/{name}`.

async function resolveNsitName(
  name: string,
  indexerUrl: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  const base = safeHttpUrl(indexerUrl);
  if (!base) throw new NsiteError('name_indexer_disabled', `invalid name indexer URL: ${indexerUrl}`);
  const url = base.includes('{name}')
    ? base.replace('{name}', encodeURIComponent(name))
    : `${base.replace(/\/+$/, '')}/${encodeURIComponent(name)}`;
  let res: Response;
  try {
    res = await fetchImpl(url, { redirect: 'follow' });
  } catch (e: any) {
    throw new NsiteError('name_not_found', `name indexer unreachable: ${e?.message || e}`);
  }
  if (res.status === 404) {
    throw new NsiteError('name_not_found', `NSIT name '${name}' not registered`);
  }
  if (!res.ok) {
    throw new NsiteError('name_not_found', `name indexer returned status ${res.status}`);
  }
  let json: any;
  try { json = await res.json(); }
  catch { throw new NsiteError('name_not_found', `name indexer returned invalid JSON`); }
  const hex = typeof json?.pubkey === 'string' ? json.pubkey.toLowerCase() : '';
  if (!HEX64.test(hex)) {
    throw new NsiteError('name_not_found', `name indexer returned no usable pubkey for '${name}'`);
  }
  return hex;
}

// ── Site index (kind:34128) ───────────────────────────────────────────────

/**
 * Fetch the file manifest from the author's relays. Each kind:34128 event
 * is a single file: `d` tag = path, `x` tag = SHA256 hex. Replaceable per
 * (pubkey, d) so the latest event per path wins.
 *
 * Returns the deduped map. Throws `no_files` if zero file events came back.
 */
export async function fetchSiteIndex(
  pubkey: string,
  relays: string[],
): Promise<SiteIndex> {
  const { events } = await queryRelaysDirect({
    filter: { kinds: [NSITE_FILE_KIND], authors: [pubkey], limit: 500 },
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

  const files = new Map<string, string>();
  let latestAt = 0;
  for (const [path, ev] of latestPerPath) {
    const x = getTagValue(ev, 'x');
    if (!x || !HEX64.test(x)) continue;
    files.set(path, x.toLowerCase());
    if (ev.created_at > latestAt) latestAt = ev.created_at;
  }

  if (files.size === 0) {
    throw new NsiteError('no_files', `no kind:${NSITE_FILE_KIND} events found for ${pubkey.slice(0, 12)}…`);
  }
  return { files, latestAt };
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

export async function fetchBlossomServers(
  pubkey: string,
  relays: string[],
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
  if (!newest) return DEFAULT_BLOSSOM_SERVERS.slice();
  const servers: string[] = [];
  for (const tag of getTags(newest, 'server')) {
    const url = safeHttpUrl(tag[1]);
    if (url) servers.push(url.replace(/\/+$/, ''));
  }
  return servers.length ? servers : DEFAULT_BLOSSOM_SERVERS.slice();
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
