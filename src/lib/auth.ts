/**
 * Dashboard authentication — station owner lock.
 *
 * Every /api/* endpoint (except /api/auth/{status,challenge,verify} and the
 * bunker polling endpoint) requires a Bearer token from the session store.
 * Sessions are in-memory only — cleared on server restart, stored in a Map
 * keyed by a 64-char hex token (crypto.randomBytes(32)).
 *
 * The station owner proves ownership by signing a NIP-98 challenge with the
 * pubkey matching identity.json#npub. The challenge is one-shot, 60s TTL.
 * Session TTL is 8h (overridable via NOSTR_STATION_SESSION_TTL), with a 30m
 * sliding extension on each authenticated request up to the hard cap.
 *
 * Localhost exemption: if identity.json sets requireAuth:false and the
 * request comes from 127.0.0.1 / ::1, auth is skipped. Opt-in only.
 */

import crypto from 'crypto';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { verifyEvent } from 'nostr-tools/pure';
import { nip19 } from 'nostr-tools';
import { readIdentity } from './identity.js';

// ── Configuration ───────────────────────────────────────────────────────────

const SESSION_TTL_MS = (() => {
  const raw = process.env.NOSTR_STATION_SESSION_TTL;
  const hours = raw ? Number(raw) : 8;
  return (Number.isFinite(hours) && hours > 0 ? hours : 8) * 60 * 60 * 1000;
})();

const SLIDING_EXTEND_MS = 30 * 60 * 1000;
const CHALLENGE_TTL_MS  = 60 * 1000;
const NIP98_SKEW_SEC    = 60;

// ── Stores ──────────────────────────────────────────────────────────────────

export interface Session {
  token:     string;
  npub:      string;
  createdAt: number;
  expiresAt: number;
  userAgent: string;
}

const sessions   = new Map<string, Session>();
const challenges = new Map<string, number>();  // challenge → expiresAt

export function clearAllSessions(): void {
  sessions.clear();
  challenges.clear();
}

// ── Session persistence (survives a controlled restart) ────────────────────
//
// Sessions are still in-memory authoritative, but we snapshot non-expired
// entries to disk so a "one-click update" restart drops the user back in
// authenticated. The file is rewritten atomically on shutdown and loaded
// once at boot, then deleted — a crash or kill -9 won't leak old tokens.

function sessionsPath(): string {
  return path.join(os.homedir(), '.config', 'nostr-station', 'sessions.json');
}

export function persistSessions(): void {
  const now = Date.now();
  const live: Session[] = [];
  for (const s of sessions.values()) {
    if (s.expiresAt > now) live.push(s);
  }
  const file = sessionsPath();
  try {
    if (live.length === 0) {
      try { fs.unlinkSync(file); } catch {}
      return;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ sessions: live }), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    // Persistence is best-effort — a failure here just means the user
    // logs back in after the next restart. Don't crash shutdown over it.
  }
}

export function loadSessions(): void {
  const file = sessionsPath();
  let raw: string;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch { return; }
  // Snapshot is single-use — remove immediately so a crash or kill -9
  // after this point can't replay it.
  try { fs.unlinkSync(file); } catch {}
  try {
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed?.sessions) ? parsed.sessions : [];
    const now = Date.now();
    for (const s of list) {
      if (!s || typeof s.token !== 'string' || !/^[a-f0-9]{64}$/.test(s.token)) continue;
      if (typeof s.expiresAt !== 'number' || s.expiresAt <= now) continue;
      if (typeof s.createdAt !== 'number' || typeof s.npub !== 'string') continue;
      sessions.set(s.token, {
        token:     s.token,
        npub:      s.npub,
        createdAt: s.createdAt,
        expiresAt: s.expiresAt,
        userAgent: typeof s.userAgent === 'string' ? s.userAgent : '',
      });
    }
  } catch {
    // Malformed snapshot — already unlinked above, just move on.
  }
}

// ── Constant-time string equality ───────────────────────────────────────────
//
// Used for explicit equality checks against attacker-controlled inputs
// (NIP-98 challenge content, claimed pubkey). JS `===` on strings can
// short-circuit at the first differing byte; timingSafeEqual on
// equal-length Buffers reads every byte regardless. Practical impact
// over loopback is near-zero (nanosecond timing differences are below
// the network noise floor) but the helper is free and removes
// "timing-attack on session" from the threat-model conversation.
//
// Map-based lookups (sessions, challenges) intentionally stay as-is:
// V8's Map.get does a full equality compare internally and is constant
// in expected timing modulo hash randomization. Iterating all entries
// and timingSafeEqual'ing each would be O(n) for no real-world gain.
function eqConstantTime(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch { return false; }
}

// ── Challenges ──────────────────────────────────────────────────────────────

export function issueChallenge(): { challenge: string; expiresAt: number } {
  pruneChallenges();
  const challenge = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + CHALLENGE_TTL_MS;
  challenges.set(challenge, expiresAt);
  return { challenge, expiresAt };
}

// Consumes the challenge (single-use). Returns true if it existed and was
// still within its TTL when the call was made.
export function consumeChallenge(challenge: string): boolean {
  const exp = challenges.get(challenge);
  if (!exp) return false;
  challenges.delete(challenge);
  return exp >= Date.now();
}

function pruneChallenges(): void {
  const now = Date.now();
  for (const [c, exp] of challenges) if (exp < now) challenges.delete(c);
}

// ── Sessions ────────────────────────────────────────────────────────────────

export function createSession(npub: string, userAgent: string): Session {
  const token     = crypto.randomBytes(32).toString('hex');
  const createdAt = Date.now();
  const expiresAt = createdAt + SESSION_TTL_MS;
  const s: Session = { token, npub, createdAt, expiresAt, userAgent };
  sessions.set(token, s);
  return s;
}

export function getSession(token: string | null): Session | null {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (s.expiresAt < Date.now()) { sessions.delete(token); return null; }
  return s;
}

// Bumps the session expiry by the sliding window, capped at the original
// hard TTL. Safe to call on every authenticated request.
export function touchSession(token: string): void {
  const s = sessions.get(token);
  if (!s) return;
  const hardCap  = s.createdAt + SESSION_TTL_MS;
  const proposed = Date.now() + SLIDING_EXTEND_MS;
  s.expiresAt = Math.min(hardCap, Math.max(s.expiresAt, proposed));
}

export function deleteSession(token: string): boolean {
  return sessions.delete(token);
}

// ── Download tokens ────────────────────────────────────────────────────────
//
// Short-lived single-use tokens for `<a target="_blank">` / `<a download>`
// flows where the long-lived session token would otherwise have to live
// in the URL. URLs end up in browser history; the session token there is
// a 8-hour bearer credential. A download token is 60 seconds, one use,
// tied to its issuing session — leaking it after consumption is
// harmless, and even before consumption it can only fetch resources
// the issuing session itself could.
//
// Wire: POST /api/auth/download-token (session-authed) → { token, expiresAt }
//       GET  /any?dt=<download_token>  resolves to the session's auth
//
// Existing `?token=<session>` query-string usage for SSE / WS stays
// (those don't enter browser history), so this is additive — not a
// replacement.

interface DownloadToken {
  sessionToken: string;     // the session this delegates to
  expiresAt:    number;     // ms epoch
}
const downloadTokens = new Map<string, DownloadToken>();
const DOWNLOAD_TOKEN_TTL_MS = 60 * 1000;

export function issueDownloadToken(sessionToken: string): { token: string; expiresAt: number } | null {
  // Only issue if the session is currently valid. The download token
  // outlives nothing — it expires before the session would and is
  // single-use anyway.
  if (!getSession(sessionToken)) return null;
  pruneDownloadTokens();
  const token     = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + DOWNLOAD_TOKEN_TTL_MS;
  downloadTokens.set(token, { sessionToken, expiresAt });
  return { token, expiresAt };
}

// Consumes a download token and returns the underlying session token
// on success. Single-use: any subsequent presentation of the same
// download token returns null.
function consumeDownloadToken(token: string): string | null {
  const entry = downloadTokens.get(token);
  if (!entry) return null;
  downloadTokens.delete(token);
  if (entry.expiresAt < Date.now()) return null;
  // Verify the underlying session is still live.
  if (!getSession(entry.sessionToken)) return null;
  return entry.sessionToken;
}

function pruneDownloadTokens(): void {
  const now = Date.now();
  for (const [t, e] of downloadTokens) if (e.expiresAt < now) downloadTokens.delete(t);
}

export function extractBearer(req: http.IncomingMessage): string | null {
  const h = req.headers['authorization'];
  if (typeof h === 'string') {
    const m = h.match(/^Bearer\s+([a-f0-9]{64})$/i);
    if (m) return m[1];
  }
  // Fallback: browser APIs that can't set Authorization headers
  // (EventSource, WebSocket) pass the session token as a `?token=…`
  // query param. EventSource / WebSocket URLs don't enter browser
  // history, so this is fine on loopback.
  //
  // Downloads (`<a target="_blank">` / `<a download>`) instead use a
  // short-lived single-use `?dt=…` token that's minted by
  // POST /api/auth/download-token. The URL still enters browser
  // history but the token is already consumed by the time anyone
  // could read it back. See issueDownloadToken / consumeDownloadToken.
  const url = req.url || '';
  const q   = url.indexOf('?');
  if (q < 0) return null;
  const params = new URLSearchParams(url.slice(q + 1));
  const dt = params.get('dt');
  if (dt && /^[a-f0-9]{64}$/.test(dt)) {
    const session = consumeDownloadToken(dt);
    if (session) return session;
    // Invalid / expired / already-consumed download token. Don't fall
    // through to ?token= — the request explicitly opted into the
    // download-token flow; treating it as if it had no auth is what
    // we want (the caller's URL was stale).
    return null;
  }
  const tok = params.get('token');
  return tok && /^[a-f0-9]{64}$/.test(tok) ? tok : null;
}

// ── NIP-98 verification ─────────────────────────────────────────────────────

function npubToHex(input: string): string | null {
  if (/^[0-9a-f]{64}$/.test(input)) return input;
  try {
    const d = nip19.decode(input);
    if (d.type === 'npub' && typeof d.data === 'string') return d.data;
  } catch {}
  return null;
}

export interface VerifyInput {
  challenge:   string;
  event:       any;
  expectedUrl: string;
}

export interface VerifyResult {
  ok:    boolean;
  error?: string;
  npub?: string;
}

// Enforces every NIP-98 rule the spec calls out. Errors are specific enough
// to aid debugging but never leak which step succeeded vs failed in a way
// that helps an attacker guess.
export function verifyNip98(input: VerifyInput): VerifyResult {
  const ident = readIdentity();
  if (!ident.npub) return { ok: false, error: 'no station owner configured' };
  const expectedHex = npubToHex(ident.npub);
  if (!expectedHex) return { ok: false, error: 'configured npub is invalid' };

  const ev = input.event;
  if (!ev || typeof ev !== 'object')       return { ok: false, error: 'missing event' };
  if (ev.kind !== 27235)                   return { ok: false, error: 'event kind must be 27235 (NIP-98)' };
  if (typeof ev.content !== 'string')      return { ok: false, error: 'event content missing' };
  if (!eqConstantTime(ev.content, input.challenge)) return { ok: false, error: 'challenge mismatch' };
  if (typeof ev.created_at !== 'number')   return { ok: false, error: 'invalid created_at' };

  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - ev.created_at) > NIP98_SKEW_SEC) {
    return { ok: false, error: `event timestamp outside ±${NIP98_SKEW_SEC}s window` };
  }

  const tags   = Array.isArray(ev.tags) ? ev.tags : [];
  const uTag   = tags.find((t: any) => Array.isArray(t) && t[0] === 'u');
  const mTag   = tags.find((t: any) => Array.isArray(t) && t[0] === 'method');
  if (!uTag || uTag[1] !== input.expectedUrl) return { ok: false, error: 'u tag must match dashboard URL' };
  if (!mTag || mTag[1] !== 'POST')            return { ok: false, error: 'method tag must be POST' };

  if (typeof ev.pubkey !== 'string'
      || !eqConstantTime(ev.pubkey.toLowerCase(), expectedHex.toLowerCase())) {
    return { ok: false, error: 'pubkey does not match station owner' };
  }

  try {
    if (!verifyEvent(ev)) return { ok: false, error: 'invalid signature' };
  } catch {
    return { ok: false, error: 'invalid signature' };
  }

  return { ok: true, npub: ident.npub };
}

// ── Localhost exemption ─────────────────────────────────────────────────────

export function isLocalhost(req: http.IncomingMessage): boolean {
  const ra = req.socket.remoteAddress || '';
  return ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1';
}

export function localhostExempt(req: http.IncomingMessage): boolean {
  if (!isLocalhost(req)) return false;
  const ident = readIdentity();
  // Exemption paths for localhost requests:
  //   1. Fresh install — no station owner yet. Nothing to auth against.
  //   2. Wizard in flight — setupComplete is *explicitly* false (not
  //      undefined, which is the legacy/TUI path and means "done").
  //      While the wizard runs we let it hit otherwise-gated endpoints
  //      (relay start, AI config, ngit login) without a session.
  //   3. Manual opt-out — requireAuth:false in identity.json.
  if (!ident.npub) return true;
  if (ident.setupComplete === false) return true;
  return ident.requireAuth === false;
}

// ── Status snapshot ─────────────────────────────────────────────────────────

export interface AuthStatus {
  configured:      boolean;
  npub:            string | null;
  authenticated:   boolean;
  requireAuth:     boolean;
  localhostExempt: boolean;
  // True when nostr-station is running its in-process Nostr relay
  // (the default). STATION_INPROC_RELAY=0 opts out, in which case
  // the dashboard runs without an embedded relay — typically a dev
  // workflow pointed at an external one.
  inprocRelay:     boolean;
  session?: {
    createdAt: number;
    expiresAt: number;
    npub:      string;
  };
}

// True when this process is running the in-process relay. Mirrors the
// shouldStartInprocRelay() decision in web-server.ts (kept here so auth
// stays free of cross-module imports). STATION_INPROC_RELAY=0 opts out.
function inprocRelayActive(): boolean {
  return process.env.STATION_INPROC_RELAY !== '0';
}

export function authStatus(req: http.IncomingMessage): AuthStatus {
  const ident      = readIdentity();
  const requireAuth = ident.requireAuth !== false;
  const exempt     = localhostExempt(req);
  const token      = extractBearer(req);
  const session    = getSession(token);
  return {
    configured:      !!ident.npub,
    npub:            ident.npub || null,
    requireAuth,
    localhostExempt: exempt,
    inprocRelay:     inprocRelayActive(),
    authenticated:   !!session || exempt,
    session: session
      ? { createdAt: session.createdAt, expiresAt: session.expiresAt, npub: session.npub }
      : undefined,
  };
}

// ── Middleware ──────────────────────────────────────────────────────────────

// Paths that do NOT require a session. Everything else under /api/* is gated.
// The bunker polling endpoint is public because it returns the session token
// on success — requiring a token to retrieve a token would deadlock.
const PUBLIC_API_PREFIXES = [
  '/api/auth/status',
  '/api/auth/challenge',
  '/api/auth/verify',
  '/api/auth/bunker-connect',
  '/api/auth/bunker-session/',
  '/api/auth/bunker-url',
  // Setup wizard needs to preview a profile for a user-pasted npub
  // BEFORE any session exists — read-only, takes the npub in the query
  // string, never touches stored identity state.
  '/api/identity/profile/preview',
  // Image proxy: <img> tags can't set Authorization headers, so the
  // proxy MUST be reachable without a session. Threat model is fine
  // — the proxy only fetches public https images (private IPs are
  // refused), has a 5 MiB size cap + 5 s timeout, validates
  // content-type against a small allowlist. An unauth'd attacker on
  // loopback could only trigger fetches of public URLs they could
  // already fetch directly. See src/lib/img-proxy.ts.
  '/api/img-proxy',
];

export function isPublicApi(urlPath: string): boolean {
  return PUBLIC_API_PREFIXES.some(p => urlPath === p || urlPath.startsWith(p));
}

export function requireSession(
  req: http.IncomingMessage, res: http.ServerResponse,
): Session | null {
  if (localhostExempt(req)) {
    // Synthetic session — never stored, never extended. Represents the
    // "auth disabled for localhost" exemption so downstream handlers can
    // treat it like any other authenticated request.
    const ident = readIdentity();
    return {
      token: 'localhost-exempt',
      npub: ident.npub || '',
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      userAgent: String(req.headers['user-agent'] || ''),
    };
  }
  const token   = extractBearer(req);
  const session = getSession(token);
  if (!session) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return null;
  }
  touchSession(session.token);
  return session;
}

// Dashboard URL the client is expected to have signed against. The caller
// passes the bound loopback port — we do NOT derive it from req.headers.host
// because that header is attacker-controlled (DNS rebinding). The HTTP
// dispatcher rejects non-loopback Host headers upstream, so by the time we
// get here the request is known to have been sent to our socket; we return
// a canonical URL pinned to the actual bound port.
export function expectedDashboardUrl(_req: http.IncomingMessage, boundPort: number): string {
  return `http://127.0.0.1:${boundPort}`;
}
