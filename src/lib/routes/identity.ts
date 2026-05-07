/**
 * Identity routes — split out of `web-server.ts` as part of the route-group
 * refactor. The profile lookup helpers (cache, kind-0 fetcher, NIP-05
 * verifier) move with the routes because nothing outside of /api/identity/*
 * consumes them — keeping them here means web-server.ts loses ~110 lines of
 * Nostr-relay plumbing it doesn't need to see.
 *
 * Surface (verbatim from the pre-refactor inline blocks):
 *   GET    /api/identity/config                — npub / readRelays / ngitRelay / graspServers
 *   POST   /api/identity/set                   — npub | ngitRelay | setupComplete
 *   POST   /api/identity/relays/add            — append a read relay
 *   POST   /api/identity/relays/remove         — remove a read relay
 *   POST   /api/identity/grasp/add             — append a grasp server
 *   POST   /api/identity/grasp/remove          — remove a grasp server
 *   GET    /api/identity/profile/preview?npub= — wizard-time public lookup
 *   GET    /api/identity/profile               — owner profile
 *   POST   /api/identity/profile/sync          — bust cache + re-fetch
 *
 * Returns `true` when matched and a response was written; `false` lets the
 * orchestrator continue trying its remaining route groups.
 */
import http from 'http';
import { WebSocket } from 'ws';
import {
  readIdentity, addReadRelay, removeReadRelay,
  setNpub as setIdentityNpub, setNgitRelay as setIdentityNgitRelay,
  setSetupComplete, isNpubOrHex, isNsec,
  DEFAULT_READ_RELAYS, hexToNpub, npubToHex,
  getGraspServers, addGraspServer, removeGraspServer,
} from '../identity.js';
import { safeHttpUrl } from '../url-safety.js';
import { readBody } from './_shared.js';

// ── Profile lookup helpers (kind-0 over ws + 5min memo) ────────────────────
//
// Runs raw WebSocket REQs against the user's read-relay list with a short
// cap; the newest kind-0 reply per pubkey wins. Memoized for 5 minutes so
// drawer re-opens stay snappy. Cache-bust via `bustProfileCache()` on any
// /api/identity/* mutation that could invalidate the previous result
// (npub change, relay list change, explicit /sync).

interface Profile {
  npub: string;
  hex:  string;
  name?: string;
  about?: string;
  picture?: string;
  nip05?: string;
  nip05Verified?: boolean;
  cachedAt: number;
}

const PROFILE_CACHE = new Map<string, Profile>();
const PROFILE_TTL_MS = 5 * 60 * 1000;

async function fetchNip05(name: string, domain: string, expectedHex: string): Promise<boolean> {
  try {
    const url = `https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(name)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return false;
    const data = await res.json() as { names?: Record<string, string> };
    const got = data.names?.[name];
    return typeof got === 'string' && got.toLowerCase() === expectedHex.toLowerCase();
  } catch { return false; }
}

// Fetch a kind-0 event from one relay via raw WebSocket.
// Resolves with the event (or null on timeout/error/EOSE-with-no-match).
function fetchKind0FromRelay(relayUrl: string, hex: string, timeoutMs: number): Promise<any | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ev: any | null) => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch {}
      clearTimeout(timer);
      resolve(ev);
    };
    let ws: WebSocket;
    try { ws = new WebSocket(relayUrl); }
    catch { resolve(null); return; }

    const timer = setTimeout(() => finish(null), timeoutMs);
    const subId = 'ns-profile-' + Math.random().toString(36).slice(2, 8);

    ws.addEventListener('open', () => {
      try {
        ws.send(JSON.stringify(['REQ', subId, { authors: [hex], kinds: [0], limit: 1 }]));
      } catch { finish(null); }
    });
    ws.addEventListener('message', (m: any) => {
      try {
        const msg = JSON.parse(typeof m.data === 'string' ? m.data : m.data.toString());
        if (Array.isArray(msg)) {
          if (msg[0] === 'EVENT' && msg[1] === subId && msg[2]?.kind === 0) finish(msg[2]);
          else if (msg[0] === 'EOSE' && msg[1] === subId) finish(null);
        }
      } catch {}
    });
    ws.addEventListener('error', () => finish(null));
    ws.addEventListener('close', () => finish(null));
  });
}

async function lookupProfile(npubOrHex: string, relays: string[]): Promise<Profile> {
  const hex = npubToHex(npubOrHex);
  if (!hex) throw new Error('could not resolve npub/hex');
  const npub = hexToNpub(hex);
  const cacheKey = hex;

  const cached = PROFILE_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < PROFILE_TTL_MS) return cached;

  const profile: Profile = { npub, hex, cachedAt: Date.now() };
  if (relays.length === 0) { PROFILE_CACHE.set(cacheKey, profile); return profile; }

  // Query all relays in parallel; take the newest kind-0 that answers.
  // Each relay gets a 5s budget. Promise.all means we wait for the slowest
  // relay (or its timeout), but since all run in parallel the total cap
  // is still ~5s.
  const results = await Promise.all(
    relays.map(r => fetchKind0FromRelay(r, hex, 5000)),
  );
  const events = results.filter(Boolean);

  const newest = events
    .filter((e: any) => e && e.kind === 0 && typeof e.content === 'string')
    .sort((a: any, b: any) => (b.created_at || 0) - (a.created_at || 0))[0];

  if (newest) {
    try {
      const meta = JSON.parse(newest.content);
      if (typeof meta.name    === 'string') profile.name    = meta.name;
      if (typeof meta.about   === 'string') profile.about   = meta.about;
      if (typeof meta.picture === 'string') profile.picture = meta.picture;
      if (typeof meta.nip05   === 'string') profile.nip05   = meta.nip05;
    } catch {}
  }

  if (profile.nip05) {
    const at = profile.nip05.indexOf('@');
    const name   = at >= 0 ? profile.nip05.slice(0, at) : '_';
    const domain = at >= 0 ? profile.nip05.slice(at + 1) : profile.nip05;
    profile.nip05Verified = await fetchNip05(name, domain, hex);
  }

  PROFILE_CACHE.set(cacheKey, profile);
  return profile;
}

function bustProfileCache(): void { PROFILE_CACHE.clear(); }

// ── Route handler ──────────────────────────────────────────────────────────

export async function handleIdentity(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: string,
  method: string,
): Promise<boolean> {
  if (url === '/api/identity/config' && method === 'GET') {
    const ident = readIdentity();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      npub:         ident.npub,
      readRelays:   ident.readRelays,
      ngitRelay:    ident.ngitRelay || '',
      // graspServers always returns a non-empty list — getGraspServers()
      // falls back to DEFAULT_GRASP_SERVERS when the user hasn't yet
      // touched the list, so the dashboard can render the section
      // without an empty-state branch.
      graspServers: getGraspServers(),
      hasProfile:   !!ident.npub,
    }));
    return true;
  }

  if (url === '/api/identity/set' && method === 'POST') {
    let parsed: any = {};
    try { parsed = JSON.parse(await readBody(req)); }
    catch { res.writeHead(400); res.end('bad json'); return true; }
    // Fields accepted by this route:
    //   - npub          (bootstrap owner)
    //   - ngitRelay     (station-level default for ngit)
    //   - setupComplete (wizard progress marker — see localhostExempt)
    // All optional; handler updates whichever is present.
    const hasNpub     = typeof parsed.npub      === 'string';
    const hasNgitRly  = typeof parsed.ngitRelay === 'string';
    const hasSetup    = typeof parsed.setupComplete === 'boolean';
    if (!hasNpub && !hasNgitRly && !hasSetup) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'nothing to update' }));
      return true;
    }
    let npubResult: { ok: boolean; error?: string; npub?: string } | null = null;
    let ngitResult: { ok: boolean; error?: string; ngitRelay?: string } | null = null;
    if (hasNpub) {
      npubResult = setIdentityNpub(String(parsed.npub || '').trim());
      if (npubResult.ok) bustProfileCache();
    }
    if (hasNgitRly) {
      ngitResult = setIdentityNgitRelay(String(parsed.ngitRelay || '').trim());
    }
    if (hasSetup) {
      setSetupComplete(parsed.setupComplete);
    }
    const ok = (!npubResult || npubResult.ok) && (!ngitResult || ngitResult.ok);
    const body: any = { ok };
    if (npubResult) { if (npubResult.npub) body.npub = npubResult.npub; if (npubResult.error) body.error = npubResult.error; }
    if (ngitResult) { if (ngitResult.ngitRelay !== undefined) body.ngitRelay = ngitResult.ngitRelay; if (ngitResult.error) body.error = ngitResult.error; }
    res.writeHead(ok ? 200 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
    return true;
  }

  if (url === '/api/identity/relays/add' && method === 'POST') {
    let parsed: any = {};
    try { parsed = JSON.parse(await readBody(req)); }
    catch { res.writeHead(400); res.end('bad json'); return true; }
    const r = addReadRelay(String(parsed.url || '').trim());
    res.writeHead(r.ok ? 200 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(r));
    if (r.ok) bustProfileCache();
    return true;
  }

  if (url === '/api/identity/relays/remove' && method === 'POST') {
    let parsed: any = {};
    try { parsed = JSON.parse(await readBody(req)); }
    catch { res.writeHead(400); res.end('bad json'); return true; }
    const r = removeReadRelay(String(parsed.url || '').trim());
    bustProfileCache();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(r));
    return true;
  }

  // Grasp server list — same shape as the read-relay endpoints above
  // but persisted to identity.graspServers. No profile-cache bust here
  // (grasp picks don't influence kind-0 lookups).
  if (url === '/api/identity/grasp/add' && method === 'POST') {
    let parsed: any = {};
    try { parsed = JSON.parse(await readBody(req)); }
    catch { res.writeHead(400); res.end('bad json'); return true; }
    const r = addGraspServer(String(parsed.url || '').trim());
    res.writeHead(r.ok ? 200 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(r));
    return true;
  }

  if (url === '/api/identity/grasp/remove' && method === 'POST') {
    let parsed: any = {};
    try { parsed = JSON.parse(await readBody(req)); }
    catch { res.writeHead(400); res.end('bad json'); return true; }
    const r = removeGraspServer(String(parsed.url || '').trim());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(r));
    return true;
  }

  // Public read-only profile lookup for the setup wizard. Takes an
  // npub in the query string and resolves it against the default
  // discovery relays. Intentionally does NOT use stored identity
  // state — the wizard runs before identity.json is written.
  if (url.startsWith('/api/identity/profile/preview') && method === 'GET') {
    const qpos = (req.url || '').indexOf('?');
    const qs = qpos >= 0 ? new URLSearchParams((req.url || '').slice(qpos + 1)) : new URLSearchParams();
    const raw = (qs.get('npub') || '').trim();
    if (!raw || !isNpubOrHex(raw) || isNsec(raw)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid npub' }));
      return true;
    }
    try {
      const p = await lookupProfile(raw, DEFAULT_READ_RELAYS.slice());
      // Scheme-gate the attacker-controlled `picture` URL so a hostile
      // kind-0 can't land `javascript:` / `data:image/svg+xml` into an
      // <img src>. Defense-in-depth alongside the CSP img-src allowlist.
      const sanitized = { ...p, picture: safeHttpUrl((p as any)?.picture) };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(sanitized));
    } catch (e: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(e.message || e) }));
    }
    return true;
  }

  if (url === '/api/identity/profile' && method === 'GET') {
    const ident = readIdentity();
    if (!ident.npub) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ empty: true }));
      return true;
    }
    try {
      const p = await lookupProfile(ident.npub, ident.readRelays);
      const sanitized = { ...p, picture: safeHttpUrl((p as any)?.picture) };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(sanitized));
    } catch (e: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(e.message || e) }));
    }
    return true;
  }

  if (url === '/api/identity/profile/sync' && method === 'POST') {
    const ident = readIdentity();
    bustProfileCache();
    if (!ident.npub) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ empty: true }));
      return true;
    }
    try {
      const p = await lookupProfile(ident.npub, ident.readRelays);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(p));
    } catch (e: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(e.message || e) }));
    }
    return true;
  }

  return false;
}
