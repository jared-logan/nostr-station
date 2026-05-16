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
  fetchAuthorOutboxRelays, unionRelays,
  normalizePath, mimeForPath,
  DEFAULT_NSITE_RELAYS, DEFAULT_BLOSSOM_SERVERS,
  DEFAULT_NSIT_INDEXER_PUBKEY, DEFAULT_NSIT_INDEXER_RELAYS,
  DEFAULT_CONTENT_RELAYS, PROFILE_DISCOVERY_RELAYS,
  NsiteError, type SiteIndex, type NsitResolveConfig,
} from '../nsite-resolver.js';
import {
  readNsiteConfig, writeNsiteConfig, defaultNsiteConfig, nsiteConfigPath,
} from '../nsite-config.js';

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
  // Layering (highest → lowest):
  //   1. Env vars (ops escape hatch — set "disabled" to refuse NSIT)
  //   2. nsite.json on disk (Config-panel editable)
  //   3. Hardcoded defaults (Titan-mirrored, exported by nsite-resolver)
  const file = readNsiteConfig();
  const cap  = parseInt(process.env.NSITE_BLOB_CACHE_MB || '', 10);

  // Indexer pubkey: env overrides file; literal "disabled" turns NSIT off.
  const indexerPubkeyRaw = (process.env.NSITE_NSIT_INDEXER_PUBKEY || '').trim();
  let indexerPubkey: string | null;
  if (indexerPubkeyRaw) {
    indexerPubkey = indexerPubkeyRaw.toLowerCase() === 'disabled' ? null : indexerPubkeyRaw;
  } else {
    indexerPubkey = file.nsitIndexerPubkey && file.nsitIndexerPubkey.toLowerCase() !== 'disabled'
      ? file.nsitIndexerPubkey
      : null;
  }

  // Indexer relays: env overrides file.
  const relaysRawEnv = (process.env.NSITE_NSIT_RELAYS || '').trim();
  const indexerRelays = relaysRawEnv
    ? relaysRawEnv.split(',').map(r => r.trim()).filter(r => /^wss?:\/\//i.test(r))
    : file.nsitIndexerRelays;

  const nsitConfig: NsitResolveConfig | null = indexerPubkey
    ? { indexerPubkey, relays: indexerRelays }
    : null;

  return {
    nsitConfig,
    contentFallback:   file.contentRelays,
    discoveryRelays:   file.discoveryRelays,
    blossomFallback:   file.blossomServers,
    cacheCapBytes:     (Number.isFinite(cap) && cap > 0 ? cap : 200) * 1024 * 1024,
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
    const { nsitConfig, contentFallback, discoveryRelays, blossomFallback } = getSettings();
    try {
      const ownerRelays = pickRelays();
      const resolved = await resolveAddress(addr, nsitConfig);
      // NIP-65 outbox discovery: query the owner's read relays for the
      // author's kind:10002, then union those outbox URLs with the owner's
      // own read set. This is what makes "browse anyone's nsite" reliable
      // — without it, an author who publishes exclusively to a relay the
      // station owner doesn't subscribe to would surface as "no kind:34128
      // events found" even though the nsite is fine.
      // Bootstrap NIP-65 lookup with the owner relays + profile-discovery
      // relays (purplepag.es / user.kindpag.es) — those are where authors'
      // kind:10002 outbox announcements actually live. Without the
      // profile-discovery set, the outbox tier silently collapses to []
      // for any author whose kind:10002 isn't already on a relay the
      // station owner happens to subscribe to. Mirrors Titan Browser's
      // observed behavior (its devtools shows a kept-alive WebSocket to
      // both profile-discovery relays during content fetches).
      const outboxBootstrap = unionRelays(ownerRelays, discoveryRelays);
      const authorOutbox = await fetchAuthorOutboxRelays(resolved.pubkey, outboxBootstrap)
        .catch(() => [] as string[]);
      // Three-tier content discovery: owner read relays first (their
      // existing subscription set), then the author's NIP-65 outbox
      // (where they explicitly publish), then the user-configured content
      // fallback (defaults to Titan's FALLBACK_RELAYS — primarily
      // relay.westernbtc.com for Titan-ecosystem nsites that otherwise
      // wouldn't be reachable). Editable in Config → nsite.
      const contentRelays = unionRelays(
        unionRelays(ownerRelays, authorOutbox),
        contentFallback,
      );
      // Pass the v2-manifest name (when known) into fetchSiteIndex so
      // it can try kind:35128 with d=<name> before falling back to
      // kind:15128 (root v2) and finally kind:34128 (v1 per-file).
      // resolved.name is set for both NSIT-resolved addresses AND for
      // gateway URLs whose subdomain encodes `<pubkey><name>` (like
      // `https://10vy5…e6nostr-station.nsite.lol` — Titan dispatches
      // these the same way, surfacing the named manifest over the
      // root/v1 publishes that may also live at the same pubkey).
      const nsitName = resolved.name;
      // Run index + author Blossom-list in parallel against the unioned set.
      // Wrap fetchSiteIndex to attach the relay context to its no_files
      // error so the panel can render Diagnostics for the FAILURE case too.
      let index, authorBlossomServers;
      try {
        [index, authorBlossomServers] = await Promise.all([
          fetchSiteIndex(resolved.pubkey, contentRelays, { name: nsitName }),
          fetchBlossomServers(resolved.pubkey, contentRelays, blossomFallback),
        ]);
      } catch (e: any) {
        if (e instanceof NsiteError && e.code === 'no_files') {
          json(res, 404, {
            error:   e.code,
            message: e.message,
            pubkey:  resolved.pubkey,
            display: resolved.display,
            source:  resolved.source,
            relays: {
              owner:           ownerRelays,
              authorOutbox,
              contentFallback,
              queried:         contentRelays,
              nsitIndexer:     nsitConfig?.relays ?? [],
            },
          });
          return true;
        }
        throw e;
      }
      // v2 manifests carry the canonical Blossom servers in their
      // `server` tags — prefer those when present, then union with the
      // kind:10063 list + configured fallback. This matches Titan's
      // behavior: manifest servers first, kind:10063 next, defaults last.
      const blossomServers = index.manifestServers.length
        ? unionRelays(index.manifestServers, authorBlossomServers)
        : authorBlossomServers;
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
        oldestAt: index.oldestAt,
        totalEventsSeen: index.totalEventsSeen,
        format: index.format,
        // Sandbox / CSP posture of the iframe — surfaced to the panel
        // so users can see "no external HTTP, WSS allowed" at a glance.
        sandbox: { csp: 'strict-nsite' },
        // Per-file event details for the diagnostics panel — paths,
        // sha256, eventId, timestamp. Sorted by path. Capped at 50 to
        // bound the payload; nobody publishes 50+ files in v1 nsites
        // (and the rest of the index is still served from the snapshot,
        // this is just the rendered detail view).
        entries: index.entries.slice(0, 50),
        blossomServers,
        relays: {
          owner:        ownerRelays,
          authorOutbox: authorOutbox,
          contentFallback,
          queried:      contentRelays,
          nsitIndexer:  nsitConfig?.relays ?? [],
          // Relays declared inside the v2 manifest itself. Empty for v1
          // and for v2 manifests without `relay` tags. Surfaced in the
          // panel's Diagnostics so a publisher can confirm we picked
          // them up; future cache-miss re-resolves can union them into
          // the content-relay set.
          manifest:     index.manifestRelays,
        },
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

  // Config get/put — what the Config panel section reads + writes.
  // Reports env-var overrides so the UI can render an "overridden by
  // env" badge instead of letting a user edit a field that won't take
  // effect on the next resolve.
  if (path === '/api/nsite/config' && method === 'GET') {
    json(res, 200, {
      config:   readNsiteConfig(),
      defaults: defaultNsiteConfig(),
      configPath: nsiteConfigPath(),
      envOverrides: {
        nsitIndexerPubkey: !!(process.env.NSITE_NSIT_INDEXER_PUBKEY || '').trim(),
        nsitIndexerRelays: !!(process.env.NSITE_NSIT_RELAYS || '').trim(),
      },
    });
    return true;
  }
  if (path === '/api/nsite/config' && method === 'PUT') {
    let payload: any;
    try { payload = JSON.parse(await readBody(req) || '{}'); }
    catch { json(res, 400, { error: 'invalid_json' }); return true; }
    try {
      const merged = writeNsiteConfig(payload);
      // Bust the per-pubkey site snapshot cache: a config change can
      // shift which relays/Blossom servers we consult, and stale
      // snapshots from the old config would mask the effect of the
      // edit on the next resolve.
      sites.clear();
      json(res, 200, { config: merged });
    } catch (e: any) {
      json(res, 400, { error: 'invalid_field', message: String(e?.message || e) });
    }
    return true;
  }

  // Content path: /nsite-content/<siteId>/<file path...>
  //
  // Legacy "path-prefix" mode. Still wired so direct hits work (and the
  // existing tests/bookmarks don't break), but new iframe loads from
  // the panel go through the per-origin subdomain mode below.
  const contentMatch = path.match(/^\/nsite-content\/([a-f0-9]{16})(\/.*)?$/);
  if (contentMatch && (method === 'GET' || method === 'HEAD')) {
    const siteId = contentMatch[1];
    const reqPath = contentMatch[2] ?? '/';
    await serveContent(req, res, siteId, reqPath, { mode: 'path-prefix' });
    return true;
  }

  return false;
}

/**
 * Entry point for *.nsite.localhost subdomain requests.
 *
 * Where path-prefix mode bundles the siteId into the URL
 * (/nsite-content/<sid>/...), subdomain mode bundles it into the Host
 * header (<sid>.nsite.localhost:<port>) and the URL is just the file
 * path. The caller (web-server.ts) is responsible for parsing the
 * Host and ensuring this is only invoked for recognized nsite hosts.
 *
 * The mode-aware `serveContent` skips the static path rewriter and
 * runtime shim — paths resolve naturally to the same origin via the
 * subdomain — and tunes the CSP so the dashboard (cross-origin parent)
 * can still embed us.
 */
export async function handleNsiteSubdomain(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  siteId: string,
  urlPath: string,
): Promise<void> {
  const method = req.method || 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('method not allowed on nsite subdomain');
    return;
  }
  // Strip query string for file lookup — nsite paths are content-
  // addressed, not query-parameterized.
  const path = urlPath.split('?')[0].split('#')[0];
  await serveContent(req, res, siteId, path, { mode: 'subdomain' });
}

// ── Content serving ───────────────────────────────────────────────────────

/**
 * "B-strict" CSP policy applied to every byte served under
 * /nsite-content/<siteId>/*. Matches the user-chosen lockdown level:
 *
 *   ALLOWED for the rendered nsite:
 *     - same-origin bytes ('self' = the iframe's own /nsite-content/<id>/*)
 *     - WebSocket connections (wss://) to any Nostr relay — required for
 *       Titan-ecosystem nsites that query the name index at runtime;
 *       this is the one "external" thing we keep because Nostr's whole
 *       point is open relay access
 *     - WebSocket to the station's in-process relay (ws://127.0.0.1:*)
 *     - data: and blob: URIs for inline media
 *     - inline <script> and <style> (covers bundled HTML + our runtime
 *       shim) — but NOT 'unsafe-eval', so dynamic code synthesis is
 *       blocked
 *
 *   BLOCKED:
 *     - external HTTP images / fonts / scripts / stylesheets (no
 *       `https:` in any -src directive)
 *     - fetch/XHR/EventSource to external HTTPS endpoints (trackers,
 *       analytics, third-party APIs)
 *     - <object>, <embed>, <applet> (object-src 'none')
 *     - acting as a clickjacking surface (frame-ancestors 'self')
 *     - rebasing the document via <base> (base-uri 'self')
 *
 * The user-facing implication: nsites must be self-contained — author's
 * own HTML + own SHA256-verified blobs on their own Blossom servers.
 * Authors referencing external resources (nostr.build URLs, Google
 * Fonts, etc.) will see those resources fail to load; the fix is to
 * republish the bytes through their own Blossom servers and reference
 * them as `/path` URLs (which the static rewrite + manifest lookup
 * already handle).
 *
 * Defense-in-depth, not the sole defense:
 *   1. CSP (here)             — browser refuses to load disallowed URLs
 *   2. Iframe sandbox          — no allow-same-origin → opaque origin
 *   3. CORS on dashboard /api/* — no ACAO → opaque origin can't read
 *   4. Auth gate on /api/*     — Bearer required → iframe has no token
 */
export const STRICT_NSITE_CSP = [
  "default-src 'self'",
  // ws://[::1]:* (IPv6 loopback) deliberately omitted — CSP3's source-expression
  // grammar doesn't accept bracketed IPv6 hosts and Chrome logs the clause as
  // "invalid source ... will be ignored", silently dropping it. The IPv4 +
  // localhost forms cover the in-process relay either way.
  "connect-src 'self' wss: ws://127.0.0.1:* ws://localhost:*",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "font-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  // 'wasm-unsafe-eval' lets the iframe call WebAssembly.compile /
  // .instantiate / .compileStreaming / .instantiateStreaming. It is a
  // CSP3-only token specifically narrowed to WASM — does NOT enable
  // arbitrary eval() / new Function() (those would still need
  // 'unsafe-eval', which we deliberately don't grant). Without this,
  // WASM-shipping nsites (e.g. Nostrord, which publishes ~6 MB of
  // .wasm + .wasm.br + .wasm.gz alongside its JS shell) hang on
  // their loading splash forever — the instantiation call throws
  // CompileError synchronously, the bundle's load-promise never
  // resolves, and the user sees an eternal spinner with no visible
  // error. Browsers that pre-date CSP3 (Safari <16) ignore unknown
  // source-expressions and fall back to allowing WASM-by-default,
  // so adding the token is forward-safe.
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
  "frame-src 'self'",
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

/**
 * Serving modes:
 *
 *   path-prefix (legacy):
 *     URL = `/nsite-content/<siteId>/<path>` on the dashboard's own origin.
 *     The iframe sandbox has no `allow-same-origin`, so its effective
 *     origin is opaque (`null`). HTML/CSS go through the static path
 *     rewriter so absolute paths land back under /nsite-content/<siteId>/.
 *     Module scripts get an importmap that maps `/` → /nsite-content/<sid>/.
 *     Inline runtime shim patches fetch / XHR / EventSource to do the
 *     same at runtime. Heavy, fragile, but kept for direct-hit URLs.
 *
 *   subdomain (new, used by the panel):
 *     URL = `/<path>` on a dedicated `<siteId>.nsite.localhost:<port>`
 *     origin. The siteId is bound to the Host header rather than the URL.
 *     Each nsite is a real, distinct browser origin (Secure Context, real
 *     `crypto.subtle`, real per-origin localStorage, real `Origin:` on
 *     WebSocket). No path rewriting needed — `<img src="/img.jpg">`
 *     natively resolves to `<sid>.nsite.localhost/img.jpg` which is the
 *     same lookup we'd do anyway. We still inject the reporter <script>
 *     for diagnostics, but skip the importmap, fetch-shim, and HTML/CSS
 *     path rewriters.
 *
 * The X-Frame-Options + CSP frame-ancestors directives both depend on
 * mode: in path-prefix mode the dashboard's origin == nsite's origin,
 * so `SAMEORIGIN` + `frame-ancestors 'self'` work. In subdomain mode
 * the dashboard is cross-origin, so we drop X-Frame-Options (the modern
 * CSP frame-ancestors directive supersedes it) and explicitly grant the
 * loopback dashboard origins to embed.
 */
type ServeMode = 'path-prefix' | 'subdomain';

async function serveContent(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  siteId: string,
  reqPath: string,
  opts: { mode: ServeMode } = { mode: 'path-prefix' },
) {
  // Permissive CORS on every /nsite-content/* response.
  //
  // The panel renders nsites inside a sandboxed iframe WITHOUT
  // `allow-same-origin`, so the iframe's effective origin is opaque
  // (`null`). ES module scripts (`<script type="module" src="/main.js">`,
  // which Vite/Rollup/Webpack ESM bundles default to) are ALWAYS fetched
  // with a CORS check, even when the URL is same-host. From the iframe
  // that check sends `Origin: null`; without ACAO on our response the
  // browser blocks the load with:
  //   Access to script at '…/main-Q2GFCNAP.js' from origin 'null' has
  //   been blocked by CORS policy: No 'Access-Control-Allow-Origin'
  //   header is present on the requested resource.
  // The SPA's entry chunk never loads → blank iframe. Identical mechanism
  // for `<link rel="modulepreload">`, `import()` chunks, web workers
  // spawned with `{ type: 'module' }`, and async fetch from a Request
  // built with `mode: 'cors'`.
  //
  // Why `*` is safe here despite the strict-everywhere posture elsewhere:
  //   - The bytes are content-addressed SHA256-verified public Blossom
  //     data. Anyone can already fetch the same SHAs directly from the
  //     upstream Blossom servers; ACAO `*` doesn't expose anything that
  //     wasn't already publicly readable.
  //   - This endpoint is NOT credentialed — no Bearer token, no cookies
  //     scoped to `/nsite-content/*`, no session state. With `*` the
  //     browser refuses to send credentials anyway (Fetch spec rule).
  //   - We deliberately do NOT add ACAO to `/api/*` — that surface IS
  //     credentialed and must remain origin-locked.
  res.setHeader('Access-Control-Allow-Origin', '*');
  // For a preflighted module fetch (rare, but harmless to handle) we
  // expose the headers the iframe might need to read. Vary on Origin so
  // a caching proxy doesn't pin the response to one requester.
  res.setHeader('Vary', 'Origin');

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

  // Body transformations — mode-aware.
  //
  // path-prefix: rewrite absolute paths so `<img src="/foo">` resolves
  // back under /nsite-content/<siteId>/. Inject the importmap + fetch
  // shim so module imports and runtime fetches also reach the prefix.
  // The reporter <script> goes in alongside everything else.
  //
  // subdomain: no rewriting (paths already resolve to <siteId>'s own
  // origin), no importmap, no runtime shim. Inject just the reporter so
  // the panel's Diagnostics still receives CSP violations / script
  // errors / loaded signals.
  let bodyBytes = entry.bytes;
  if (/^text\/html\b/i.test(entry.mime)) {
    bodyBytes = opts.mode === 'subdomain'
      ? injectReporterOnly(entry.bytes, siteId)
      : rewriteHtmlAbsolutePaths(entry.bytes, siteId);
  } else if (/^text\/css\b/i.test(entry.mime) && opts.mode === 'path-prefix') {
    bodyBytes = rewriteCssAbsoluteUrls(entry.bytes, siteId);
  }

  // Frame embedding: in path-prefix mode the iframe is same-origin to
  // the dashboard, so 'self' works. In subdomain mode the iframe lives
  // on <siteId>.nsite.localhost:<port> and the dashboard parent is at
  // localhost:<port> / 127.0.0.1:<port> / [::1]:<port> — all different
  // origins. Grant exactly those, and drop X-Frame-Options entirely
  // (CSP frame-ancestors supersedes it on every browser shipped in the
  // last decade, and X-Frame-Options' ALLOW-FROM is obsolete).
  const headers: Record<string, string> = {
    'Content-Type':    entry.mime,
    'Content-Length':  String(bodyBytes.byteLength),
    // Content-addressed → safe to cache aggressively for the lifetime of
    // the session. The URL incorporates a session-scoped siteId, so a
    // republish gets a fresh siteId and bypasses the browser cache.
    'Cache-Control':   'private, max-age=300',
    'Content-Security-Policy': buildCspForRequest(req, opts.mode),
  };
  if (opts.mode === 'path-prefix') {
    headers['X-Frame-Options'] = 'SAMEORIGIN';
  }
  res.writeHead(200, headers);
  if (req.method === 'HEAD') { res.end(); return; }
  res.end(bodyBytes);
}

/**
 * Build the CSP header for a single served response. The base policy
 * (STRICT_NSITE_CSP) is the same across modes; only frame-ancestors
 * needs to vary because the dashboard parent is same-origin in
 * path-prefix mode and cross-origin in subdomain mode.
 *
 * We derive the dashboard port from the request's Host header so we
 * don't need to thread the listening port through every call site.
 * The host is already validated by web-server.ts before we get here.
 */
function buildCspForRequest(req: http.IncomingMessage, mode: ServeMode): string {
  if (mode === 'path-prefix') return STRICT_NSITE_CSP;
  // Subdomain mode: substitute frame-ancestors to allow the loopback
  // dashboard origins. Port comes from the Host header (already
  // shaped <siteId>.nsite.localhost:<port>).
  //
  // No `http://[::1]:<port>` entry — same reason `ws://[::1]:*` got
  // pulled from connect-src in #118. CSP3's host-source grammar
  // doesn't accept bracketed IPv6 hosts; when Chromium's CSP parser
  // hits one in a directive's source list, it can silently invalidate
  // the WHOLE directive and fall back to that directive's default.
  // For frame-ancestors the default is `'self'`, which means
  // "same-origin only" — and the dashboard parent (`localhost:<port>`)
  // is cross-origin to the nsite (`<sid>.nsite.localhost:<port>`)
  // because they differ in hostname. End state: the iframe load gets
  // `ERR_BLOCKED_BY_RESPONSE` ("This content is blocked. Contact the
  // site owner to fix the issue."). Verified in field repro on Brave
  // 1.x: removing the bracketed-IPv6 source unblocks all five test
  // nsites (jaredlogan / titan / nostr-station / feed / Nostrord).
  // The IPv4 + `localhost` forms together cover every loopback access
  // path that matters; pure-IPv6 dashboard access (`http://[::1]:port`)
  // isn't a configuration we support for the panel anyway.
  const host = String(req.headers['host'] || '').toLowerCase();
  const portMatch = host.match(/:(\d+)$/);
  const port = portMatch ? portMatch[1] : '';
  const ancestors = port
    ? `http://localhost:${port} http://127.0.0.1:${port}`
    : "http://localhost http://127.0.0.1";
  return STRICT_NSITE_CSP.replace(
    "frame-ancestors 'self'",
    `frame-ancestors ${ancestors}`,
  );
}

/**
 * Inject only the reporter <script> into the served HTML. Used in
 * subdomain mode where the importmap / fetch-shim / static path
 * rewriter aren't needed (the per-nsite origin makes absolute paths
 * resolve correctly without any rewriting). The reporter itself stays
 * because the panel's Diagnostics block still wants to see CSP
 * violations / script errors / loaded signals.
 *
 * Reuses the same insertion logic as the full shim — <head>, then
 * <html>, then prepend.
 */
export function injectReporterOnly(bytes: Uint8Array, siteId: string): Uint8Array {
  const html = TEXT_DECODER.decode(bytes);
  const reporter = buildReporterScript(siteId);
  // <head> first, then <html>, then prepend.
  let matched = false;
  let out = html.replace(/<head\b[^>]*>/i, (m) => { matched = true; return m + reporter; });
  if (matched) return TEXT_ENCODER.encode(out);
  out = html.replace(/<html\b[^>]*>/i, (m) => { matched = true; return m + reporter; });
  if (matched) return TEXT_ENCODER.encode(out);
  return TEXT_ENCODER.encode(reporter + html);
}

// ── Absolute-path rewriting ───────────────────────────────────────────────

const TEXT_DECODER = new TextDecoder('utf-8');
const TEXT_ENCODER = new TextEncoder();

/**
 * Rewrite absolute-path references in HTML so they resolve under the
 * nsite-content prefix instead of the dashboard root.
 *
 * Matches the common attribute patterns: `src="/path"`, `href="/path"`,
 * `srcset="/path 1x, /path2 2x"`, plus url(/...) inside inline <style>
 * blocks. Same-origin scheme-relative URLs (`//host/...`) and absolute
 * URLs (`https://...`) are left alone — those go to a different origin
 * by design. Protocol-relative and root-relative paths starting with `//`
 * are deliberately NOT rewritten (they're cross-origin).
 *
 * Pure string rewrite, not a DOM parse — fast, but won't catch attributes
 * with single quotes followed by a leading space, attributes without
 * quotes, or paths constructed at runtime by JS. For sites that need
 * those, the iframe + a service-worker shim would be the proper fix.
 */
export function rewriteHtmlAbsolutePaths(bytes: Uint8Array, siteId: string): Uint8Array {
  const html = TEXT_DECODER.decode(bytes);
  const prefix = `/nsite-content/${siteId}`;
  const staticRewritten = html
    // src="/..." and href="/..." — the bulk of <img>, <script>, <link>, <a>.
    .replace(/\b(src|href)\s*=\s*"\/(?!\/)([^"]*)"/gi,
             (_, attr, p) => `${attr}="${prefix}/${p}"`)
    .replace(/\b(src|href)\s*=\s*'\/(?!\/)([^']*)'/gi,
             (_, attr, p) => `${attr}='${prefix}/${p}'`)
    // srcset is comma-separated. Rewrite each candidate's URL.
    .replace(/\bsrcset\s*=\s*"([^"]*)"/gi,
             (_, list) => `srcset="${rewriteSrcsetList(list, prefix)}"`)
    .replace(/\bsrcset\s*=\s*'([^']*)'/gi,
             (_, list) => `srcset='${rewriteSrcsetList(list, prefix)}'`)
    // url(/...) inside inline <style> blocks. Conservative — matches
    // only forms that obviously start with `/`.
    .replace(/url\(\s*\/(?!\/)([^)"'\s]+)\s*\)/gi,
             (_, p) => `url(${prefix}/${p})`)
    .replace(/url\(\s*"\/(?!\/)([^")]+)"\s*\)/gi,
             (_, p) => `url("${prefix}/${p}")`)
    .replace(/url\(\s*'\/(?!\/)([^')]+)'\s*\)/gi,
             (_, p) => `url('${prefix}/${p}')`);
  return TEXT_ENCODER.encode(injectRuntimeShim(staticRewritten, prefix, siteId));
}

/**
 * Inject a tiny inline `<script>` (and `<script type="importmap">`) at the
 * top of the `<head>` to rewrite absolute paths at RUNTIME — covers the
 * cases the static rewrite can't reach:
 *
 *   - `fetch('/api/x')` from JS bundles
 *   - `new XMLHttpRequest(); xhr.open('GET', '/data.json')`
 *   - ES module `import '/chunks/foo.js'` (via import map)
 *
 * Without this, SPA bundles built with `publicPath: '/'` (the Vite /
 * webpack default for "root-deployed" sites) fail their data + chunk
 * loads when rendered under our `/nsite-content/<siteId>/…` prefix — the
 * exact failure mode where the TITAN landing page renders the static
 * shell but every "Loading…" never resolves.
 *
 * Insertion point: first `<head>` tag found (case-insensitive). Falls
 * back to first `<html>` tag, then prepending. The shim is the FIRST
 * thing in <head> so it monkey-patches `window.fetch` before any other
 * `<script>` runs.
 *
 * Behavior of the shim:
 *   - URLs starting with `/` but NOT `//` and NOT already under the
 *     site prefix → prepend the prefix
 *   - Cross-origin (`http://...`, `wss://...`) and protocol-relative
 *     (`//host/...`) → untouched
 *   - Relative (`./foo`, `foo`) → untouched
 *
 * Tradeoffs: cannot intercept `<link rel="modulepreload">` (browser
 * managed before any script runs), so the import map is the only
 * coverage for that. Cannot intercept Worker constructors fully —
 * `new Worker('/foo.js')` is patched, `new Worker('/foo.js', { type:
 * 'module' })` too, but blob: workers spawned by JS are out of reach.
 * Good enough for nsite-shaped content; not enough for arbitrary apps.
 */
/**
 * Build the diagnostic-reporter <script> inline. Identical script in
 * both path-prefix and subdomain modes — the reporter has no
 * path-prefix dependency, only needs the siteId for postMessage
 * authentication.
 *
 * CSP violation + page-error reporter. Forwards browser-emitted
 * `securitypolicyviolation` events AND uncaught script errors to the
 * parent dashboard via postMessage. Without this, when the strict
 * CSP blocks an external resource (image, script, fetch), the failure
 * happens silently inside the iframe's console — invisible to the
 * user. With it, the panel's Diagnostics block shows e.g.
 *   CSP blocked (2)
 *     img      https://image.nostr.build/foo.jpg  (img-src)
 *     connect  https://tracker.example.com/p     (connect-src)
 *
 * Posts to '*' because the iframe is either in an opaque origin
 * (path-prefix mode) or a cross-origin subdomain (subdomain mode);
 * the parent validates by message shape + siteId match.
 *
 * Multi-path delivery (parent + top) and explicit console.warn on
 * failures: prior versions wrapped everything in a silent try/catch,
 * which made "Diagnostics never updates" indistinguishable from
 * "Sandbox clean". We log every failure path explicitly so the
 * iframe-context console always tells the truth.
 */
function buildReporterScript(siteId: string): string {
  return `<script>(function(){var S=${JSON.stringify(siteId)};` +
`try{console.info("[nsite-report] boot",S);}catch(_){}` +
`function send(t,p){` +
  `var msg=Object.assign({type:t,siteId:S},p);` +
  `var delivered=0;` +
  `try{if(window.parent&&window.parent!==window){window.parent.postMessage(msg,"*");delivered++;}}` +
  `catch(e){try{console.warn("[nsite-report] parent.postMessage threw",e);}catch(_){}}` +
  `try{if(window.top&&window.top!==window&&window.top!==window.parent){window.top.postMessage(msg,"*");delivered++;}}` +
  `catch(e){try{console.warn("[nsite-report] top.postMessage threw",e);}catch(_){}}` +
  `try{if(!delivered)console.warn("[nsite-report] no parent/top reachable for",t);}catch(_){}` +
`}` +
`try{` +
  `window.addEventListener("securitypolicyviolation",function(e){` +
    `send("nsite-csp-violation",{blockedURI:String(e.blockedURI||""),` +
    `violatedDirective:String(e.violatedDirective||""),` +
    `effectiveDirective:String(e.effectiveDirective||""),` +
    `disposition:String(e.disposition||""),` +
    `sourceFile:String(e.sourceFile||""),` +
    `lineNumber:e.lineNumber||0});` +
  `});` +
  `window.addEventListener("error",function(e){` +
    `send("nsite-script-error",{message:String(e.message||""),` +
    `filename:String(e.filename||""),` +
    `lineno:e.lineno||0,colno:e.colno||0});` +
  `},true);` +
  `window.addEventListener("unhandledrejection",function(e){` +
    `send("nsite-script-error",{message:"unhandledrejection: "+String((e.reason&&(e.reason.message||e.reason))||"")});` +
  `});` +
`}catch(e){try{console.warn("[nsite-report] listener setup threw",e);}catch(_){}}` +
`send("nsite-loaded",{href:String(location.href||"")});` +
`})();</script>`;
}

function injectRuntimeShim(html: string, prefix: string, siteId: string): string {
  // The import map maps absolute-path specifiers under `/` to our prefix.
  // Per the WHATWG import-maps spec, a key ending in `/` is a prefix
  // mapping, so `import '/foo.js'` → `${prefix}/foo.js`.
  const importMap = `<script type="importmap">${JSON.stringify({
    imports: { '/': `${prefix}/` },
  })}</script>`;

  const fetchShim = `<script>(function(){var P=${JSON.stringify(prefix)};` +
`function rw(u){if(typeof u!=="string")return u;` +
`if(u.charCodeAt(0)!==47)return u;` +     // not starting with '/'
`if(u.charCodeAt(1)===47)return u;` +     // protocol-relative '//'
`if(u.indexOf(P+"/")===0)return u;` +     // already prefixed
`return P+u;}` +
`var of=window.fetch;` +
`if(of){window.fetch=function(input,init){` +
`if(typeof input==="string"){return of.call(this,rw(input),init);}` +
`if(input&&typeof input==="object"&&"url" in input){` +
`var n=rw(input.url);` +
`if(n!==input.url){try{return of.call(this,new Request(n,input),init);}catch(e){}}` +
`}return of.call(this,input,init);};}` +
`var oo=XMLHttpRequest.prototype.open;` +
`XMLHttpRequest.prototype.open=function(m,u){` +
`var a=Array.prototype.slice.call(arguments);` +
`a[1]=rw(u);return oo.apply(this,a);};` +
`if(window.EventSource){var oES=window.EventSource;` +
`window.EventSource=function(u,c){return new oES(rw(u),c);};` +
`window.EventSource.prototype=oES.prototype;}` +
`})();</script>`;

  // Reporter <script> — same one used in subdomain mode (via
  // injectReporterOnly) since it has no path-prefix dependency.
  const reporter = buildReporterScript(siteId);

  const inject = importMap + fetchShim + reporter;

  // Try <head>, then <html>, then prepend.
  let matched = false;
  let out = html.replace(/<head\b[^>]*>/i, (m) => { matched = true; return m + inject; });
  if (matched) return out;
  out = html.replace(/<html\b[^>]*>/i, (m) => { matched = true; return m + inject; });
  if (matched) return out;
  return inject + html;
}

function rewriteSrcsetList(list: string, prefix: string): string {
  return list.split(',').map(part => {
    const trimmed = part.trim();
    if (!trimmed) return trimmed;
    const m = trimmed.match(/^(\/(?!\/)\S*)(.*)$/);
    if (!m) return trimmed;
    return `${prefix}${m[1]}${m[2]}`;
  }).join(', ');
}

export function rewriteCssAbsoluteUrls(bytes: Uint8Array, siteId: string): Uint8Array {
  const css = TEXT_DECODER.decode(bytes);
  const prefix = `/nsite-content/${siteId}`;
  const rewritten = css
    .replace(/url\(\s*\/(?!\/)([^)"'\s]+)\s*\)/gi,
             (_, p) => `url(${prefix}/${p})`)
    .replace(/url\(\s*"\/(?!\/)([^")]+)"\s*\)/gi,
             (_, p) => `url("${prefix}/${p}")`)
    .replace(/url\(\s*'\/(?!\/)([^')]+)'\s*\)/gi,
             (_, p) => `url('${prefix}/${p}')`)
    // @import "/foo.css" — less common but valid.
    .replace(/@import\s+"\/(?!\/)([^"]+)"/gi,
             (_, p) => `@import "${prefix}/${p}"`)
    .replace(/@import\s+'\/(?!\/)([^']+)'/gi,
             (_, p) => `@import '${prefix}/${p}'`);
  return TEXT_ENCODER.encode(rewritten);
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
