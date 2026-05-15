/**
 * nsite HTTP routes — the read side of NIP-5A v1. Powers the dashboard's
 * /nsite (#nsite) panel.
 *
 * Surface:
 *   GET  /api/nsite/resolve?addr=<>   — pubkey + Blossom server list + file
 *                                       count + a short, opaque siteId
 *                                       (used by the iframe URLs). JSON.
 *   GET  /nsite-content/<siteId>/<path>
 *                                     — actual blob bytes, sniffed
 *                                       content-type, deliberately
 *                                       WITHOUT the dashboard's HTML
 *                                       security headers. Isolation is the
 *                                       caller's responsibility via the
 *                                       iframe `sandbox=""` attribute
 *                                       (no allow-same-origin).
 *
 * Why `siteId` instead of putting the npub straight into the URL: the
 * iframe loads from the SAME ORIGIN as the dashboard. Even though the
 * browser pins it to an opaque origin via the sandbox attribute, we want
 * a guarantee that the resolution context (Blossom servers, file index)
 * doesn't shift mid-page-load between subresources. A short server-side
 * id binds the iframe's session to a frozen snapshot of those.
 *
 * Caching: two in-process LRUs, both keyed by content (siteId for the
 * snapshot, sha256 for blobs). No TTL on the blob cache — content
 * addressing makes invalidation impossible by construction. SiteId
 * snapshots expire after IDX_TTL_MS so the panel picks up fresh
 * kind:34128 events on the next address-bar Go.
 */
import http from 'http';
import { randomBytes } from 'crypto';
import { readBody } from './_shared.js';
import { getEffectiveReadRelays } from '../identity.js';
import {
  resolveAddress, fetchSiteIndex, fetchBlossomServers, fetchBlob,
  normalizePath, mimeForPath,
  DEFAULT_NSITE_RELAYS, DEFAULT_BLOSSOM_SERVERS,
  DEFAULT_NSIT_INDEXER_PUBKEY, DEFAULT_NSIT_INDEXER_RELAYS,
  NsiteError, type SiteIndex, type NsitResolveConfig,
} from '../nsite-resolver.js';

// ── Settings ──────────────────────────────────────────────────────────────
//
// Read at request time from process env so the user can change it without
// a server restart. A real Config-panel wiring is a follow-up — this keeps
// the surface minimal for v1 while still being configurable.
//
//   NSITE_NSIT_INDEXER_PUBKEY  — 64-hex pubkey of the indexer whose
//                                 kind:35129 events we trust. Defaults
//                                 to Titan's hosted indexer. Set to
//                                 "disabled" (literal) to refuse NSIT
//                                 lookups entirely.
//   NSITE_NSIT_RELAYS          — comma-separated wss:// URLs to query for
//                                 the name index. Defaults to Titan's
//                                 discovery relays (purplepag.es etc.).
//   NSITE_BLOB_CACHE_MB        — defaults to 200 MiB in-memory.

function getSettings() {
  const cap = parseInt(process.env.NSITE_BLOB_CACHE_MB || '', 10);
  const indexerPubkeyRaw = (process.env.NSITE_NSIT_INDEXER_PUBKEY || '').trim();
  const indexerPubkey = indexerPubkeyRaw.toLowerCase() === 'disabled'
    ? null
    : (indexerPubkeyRaw || DEFAULT_NSIT_INDEXER_PUBKEY);
  const relaysRaw = (process.env.NSITE_NSIT_RELAYS || '').trim();
  const indexerRelays = relaysRaw
    ? relaysRaw.split(',').map(r => r.trim()).filter(r => /^wss?:\/\//i.test(r))
    : DEFAULT_NSIT_INDEXER_RELAYS.slice();
  const nsitConfig: NsitResolveConfig | null = indexerPubkey
    ? { indexerPubkey, relays: indexerRelays }
    : null;
  return {
    nsitConfig,
    cacheCapBytes: (Number.isFinite(cap) && cap > 0 ? cap : 200) * 1024 * 1024,
  };
}

// ── Site snapshot cache ───────────────────────────────────────────────────

interface SiteSnapshot {
  pubkey: string;          // 64-char hex
  display: string;         // what the user typed (for the address bar)
  index: SiteIndex;
  blossomServers: string[];
  createdAt: number;
}

const sites = new Map<string, SiteSnapshot>();
const IDX_TTL_MS = 5 * 60_000;
const IDX_MAX_ENTRIES = 64;

function gcSites() {
  const now = Date.now();
  for (const [id, snap] of sites) {
    if (now - snap.createdAt > IDX_TTL_MS) sites.delete(id);
  }
  // Bound the map size — drop oldest beyond the cap.
  if (sites.size > IDX_MAX_ENTRIES) {
    const sorted = [...sites.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
    for (const [id] of sorted.slice(0, sites.size - IDX_MAX_ENTRIES)) sites.delete(id);
  }
}

// ── Blob LRU ──────────────────────────────────────────────────────────────

interface BlobEntry { bytes: Uint8Array; mime: string; }
const blobs = new Map<string, BlobEntry>();   // sha256 → entry
let blobBytes = 0;

function rememberBlob(sha: string, bytes: Uint8Array, mime: string, cap: number) {
  // Refresh LRU position by re-inserting.
  const prev = blobs.get(sha);
  if (prev) blobBytes -= prev.bytes.byteLength;
  blobs.delete(sha);
  blobs.set(sha, { bytes, mime });
  blobBytes += bytes.byteLength;
  while (blobBytes > cap && blobs.size > 1) {
    const oldestKey = blobs.keys().next().value as string;
    const dropped = blobs.get(oldestKey)!;
    blobBytes -= dropped.bytes.byteLength;
    blobs.delete(oldestKey);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function json(res: http.ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function pickRelays(): string[] {
  // Prefer the station owner's read relays so a published nsite from this
  // box resolves through the same relays it was announced to. Fall back to
  // the curated defaults if the owner has no read relays set.
  const owner = getEffectiveReadRelays?.() ?? [];
  return owner.length ? owner : DEFAULT_NSITE_RELAYS.slice();
}

function shortId(): string { return randomBytes(8).toString('hex'); }

// ── Handlers ──────────────────────────────────────────────────────────────

export async function handleNsite(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  fullUrl: string,
  method: string,
): Promise<boolean> {
  const u = new URL(fullUrl, 'http://localhost');
  const path = u.pathname;

  if (path === '/api/nsite/resolve' && method === 'GET') {
    const addr = (u.searchParams.get('addr') || '').trim();
    if (!addr) { json(res, 400, { error: 'addr required' }); return true; }
    const { nsitConfig } = getSettings();
    try {
      const relays = pickRelays();
      const resolved = await resolveAddress(addr, nsitConfig);
      // Run index + server list in parallel — they're independent relay
      // queries against the same set of relays.
      const [index, blossomServers] = await Promise.all([
        fetchSiteIndex(resolved.pubkey, relays),
        fetchBlossomServers(resolved.pubkey, relays),
      ]);
      gcSites();
      const id = shortId();
      sites.set(id, {
        pubkey: resolved.pubkey,
        display: resolved.display,
        index,
        blossomServers,
        createdAt: Date.now(),
      });
      json(res, 200, {
        siteId: id,
        pubkey: resolved.pubkey,
        source: resolved.source,
        display: resolved.display,
        fileCount: index.files.size,
        latestAt: index.latestAt,
        blossomServers,
        relaysQueried: relays,
        entry: pickEntryPath(index),
      });
    } catch (e: any) {
      const code = e instanceof NsiteError ? e.code : 'bad_address';
      const status = code === 'no_files' || code === 'name_not_found' ? 404
                   : code === 'name_indexer_disabled' ? 501
                   : 400;
      json(res, status, { error: code, message: String(e?.message || e) });
    }
    return true;
  }

  // Settings probe — lets the panel show a friendly "configure name
  // indexer" hint without poking around the env.
  if (path === '/api/nsite/settings' && method === 'GET') {
    const s = getSettings();
    json(res, 200, {
      nsitEnabled: !!s.nsitConfig,
      nsitIndexerPubkey: s.nsitConfig?.indexerPubkey ?? null,
      nsitRelays: s.nsitConfig?.relays ?? [],
      defaultRelays: DEFAULT_NSITE_RELAYS,
      defaultBlossomServers: DEFAULT_BLOSSOM_SERVERS,
    });
    return true;
  }

  // Content path: /nsite-content/<siteId>/<file path...>
  const contentMatch = path.match(/^\/nsite-content\/([a-f0-9]{16})(\/.*)?$/);
  if (contentMatch && (method === 'GET' || method === 'HEAD')) {
    const siteId = contentMatch[1];
    const reqPath = contentMatch[2] ?? '/';
    await serveContent(req, res, siteId, reqPath);
    return true;
  }

  return false;
}

// ── Content serving ───────────────────────────────────────────────────────

async function serveContent(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  siteId: string,
  reqPath: string,
) {
  const snap = sites.get(siteId);
  if (!snap) {
    // Snapshot expired or never existed. The panel should re-resolve.
    res.writeHead(410, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('nsite session expired — reload the panel');
    return;
  }
  // Refresh LRU-style position so an actively-used snapshot doesn't age
  // out from under the user.
  snap.createdAt = Date.now();

  const path = normalizePath(decodeURIComponent(reqPath));
  let sha = snap.index.files.get(path);
  // SPA-friendly fallback: if the path doesn't exist as a file, but
  // index.html does, serve that. Matches the behavior of nsite.lol and
  // most static-site CDNs.
  if (!sha) {
    const indexSha = snap.index.files.get('index.html');
    if (indexSha && !looksLikeAsset(path)) {
      sha = indexSha;
    }
  }
  if (!sha) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`nsite: no file at /${path}`);
    return;
  }

  const { cacheCapBytes } = getSettings();
  const cached = blobs.get(sha);
  let entry: BlobEntry;
  if (cached) {
    // Refresh LRU position.
    blobs.delete(sha);
    blobs.set(sha, cached);
    entry = cached;
  } else {
    try {
      const got = await fetchBlob(sha, snap.blossomServers);
      // Re-derive content type from the requested path's extension
      // (Blossom servers commonly mis-label). Fall back to the
      // response's content-type if the path has no useful extension.
      const mime = mimeForPath(path, got.contentType || 'application/octet-stream');
      entry = { bytes: got.bytes, mime };
      rememberBlob(sha, entry.bytes, entry.mime, cacheCapBytes);
    } catch (e: any) {
      const code = e instanceof NsiteError ? e.code : 'unknown';
      const status = code === 'hash_mismatch' ? 502 : 502;
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`nsite: ${code}: ${e?.message || e}`);
      return;
    }
  }

  res.writeHead(200, {
    'Content-Type':    entry.mime,
    'Content-Length':  String(entry.bytes.byteLength),
    // Content-addressed → safe to cache aggressively for the lifetime of
    // the session. The URL incorporates a session-scoped siteId, so a
    // republish gets a fresh siteId and bypasses the browser cache.
    'Cache-Control':   'private, max-age=300',
    // Belt-and-braces: forbid embedding outside our own dashboard's
    // sandboxed iframe. The dashboard's main page sets
    // X-Frame-Options: DENY for ITSELF; we deliberately allow same-origin
    // here so the panel's iframe can load us.
    'X-Frame-Options': 'SAMEORIGIN',
    // Deliberately omit Content-Security-Policy here — the rendered
    // nsite needs to run its own scripts, load its own assets, etc.
    // Isolation comes from the sandbox attribute on the parent iframe,
    // which gives this response an opaque origin.
  });
  if (req.method === 'HEAD') { res.end(); return; }
  res.end(entry.bytes);
}

// ── Tiny helpers ──────────────────────────────────────────────────────────

const ASSET_EXT = /\.(?:html?|css|js|mjs|json|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|wasm|map|xml|txt|md)$/i;
function looksLikeAsset(p: string): boolean { return ASSET_EXT.test(p); }

function pickEntryPath(idx: SiteIndex): string {
  if (idx.files.has('index.html')) return 'index.html';
  // Fall back to lex-smallest html file, then any file.
  const htmlFiles = [...idx.files.keys()].filter(p => /\.html?$/i.test(p)).sort();
  if (htmlFiles.length) return htmlFiles[0];
  const any = [...idx.files.keys()].sort();
  return any[0] || 'index.html';
}

// Re-export for tests.
export const _internal = { sites, blobs };

// Silence "imported but unused" warnings for the env-driven readBody:
// kept available for future POST endpoints (e.g. a publish-progress proxy).
void readBody;
