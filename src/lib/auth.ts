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

export function extractBearer(req: http.IncomingMessage): string | null {
  const h = req.headers['authorization'];
  if (typeof h === 'string') {
    const m = h.match(/^Bearer\s+([a-f0-9]{64})$/i);
    if (m) return m[1];
  }
  // Fallback: browser APIs that can't set Authorization headers (EventSource,
  // WebSocket, <a> downloads) pass the session token as a `?token=…` query
  // param instead. Accepted because the dashboard is 127.0.0.1-only and
  // session tokens are short-lived — the standard caveats about tokens in
  // URLs don't apply on the local trust boundary.
  const url = req.url || '';
  const q   = url.indexOf('?');
  if (q < 0) return null;
  const tok = new URLSearchParams(url.slice(q + 1)).get('token');
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
  if (ev.content !== input.challenge)      return { ok: false, error: 'challenge mismatch' };
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

  if (typeof ev.pubkey !== 'string' || ev.pubkey.toLowerCase() !== expectedHex.toLowerCase()) {
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

// Container deployment: when the dashboard runs inside a Docker container with
// the host port published as 127.0.0.1:<port>:<port>, every request that
// reaches the listener has already passed the host kernel's loopback gate.
// Inside the container the source address is the bridge gateway, not 127.0.0.1
// — but the trust boundary is the host port binding, not the container's view
// of the socket. Treat any source IP as localhost-equivalent here.
//
// This is opt-in via STATION_MODE=container. The compose stack is responsible
// for keeping the host port loopback-only; binding 0.0.0.0:<port> on the host
// would silently widen the trust boundary, which is why this is an env var,
// not auto-detected.
export function isContainerMode(): boolean {
  return process.env.STATION_MODE === 'container';
}

export function isLocalhost(req: http.IncomingMessage): boolean {
  if (isContainerMode()) return true;
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
  containerMode:   boolean;
  // True when nostr-station is running an in-process Nostr relay (the
  // default for the host-Node deployment). The /setup wizard uses this
  // to skip the legacy "install relay" stage — the relay is already up
  // and serving on ws://127.0.0.1:7777 by the time the wizard renders.
  inprocRelay:     boolean;
  session?: {
    createdAt: number;
    expiresAt: number;
    npub:      string;
  };
}

// True when this process is running the in-process relay. Mirrors the
// shouldStartInprocRelay() decision in web-server.ts (kept here so auth
// stays free of cross-module imports). Container mode and the explicit
// STATION_INPROC_RELAY=0 opt-out short-circuit the default.
function inprocRelayActive(): boolean {
  if (isContainerMode()) return false;
  if (process.env.STATION_INPROC_RELAY === '0') return false;
  return true;
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
    containerMode:   isContainerMode(),
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
