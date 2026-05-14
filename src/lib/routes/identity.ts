/**
 * Identity routes — split out of `web-server.ts` as part of the route-group
 * refactor. The profile lookup helpers (cache, kind-0 fetcher, NIP-05
 * verifier) move with the routes because nothing outside of /api/identity/*
 * consumes them — keeping them here means web-server.ts loses ~110 lines of
 * Nostr-relay plumbing it doesn't need to see.
 *
 * Surface (verbatim from the pre-refactor inline blocks):
 *   GET    /api/identity/config                — npub / readRelays / graspServers
 *   POST   /api/identity/set                   — npub | setupComplete
 *   POST   /api/identity/relays/add            — append a read relay
 *   POST   /api/identity/relays/remove         — remove a read relay
 *   POST   /api/identity/grasp/add             — append a grasp server
 *   POST   /api/identity/grasp/remove          — remove a grasp server
 *   GET    /api/git-identity/global            — current global git identity + presets
 *   PUT    /api/git-identity/global            — set global git identity (name + email)
 *   GET    /api/identity/profile/preview?npub= — wizard-time public lookup
 *   GET    /api/identity/profile               — owner profile
 *   POST   /api/identity/profile/sync          — bust cache + re-fetch
 *
 * Returns `true` when matched and a response was written; `false` lets the
 * orchestrator continue trying its remaining route groups.
 */
import http from 'http';
import { WebSocket } from 'ws';
import { readIdentity, addReadRelay, removeReadRelay,
  setNpub as setIdentityNpub,
  setSetupComplete, isNpubOrHex, isNsec,
  DEFAULT_READ_RELAYS, hexToNpub, npubToHex,
  getGraspServers, addGraspServer, removeGraspServer,
  setAppRelaysEnabled,
} from '../identity.js';
import {
  readGlobalGitIdentity, writeGlobalGitIdentity,
  deriveGitIdentity,
} from '../git-identity.js';
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

// ── Batched profile lookup (kind-0 over ws, multi-author per REQ) ─────────
//
// The owner-profile flow above queries one author per REQ — fine for the
// drawer's single lookup but wasteful for the About-tab / maintainers-panel
// case where we need to resolve 3–10 pubkeys at once. This batched variant
// sends ONE REQ per relay with `authors: [hex…]` and collects all kind-0
// replies, picking the freshest per pubkey.
//
// Shape: returns Map<hex, ProfileLite>. Unknown pubkeys (no relay returned
// their kind-0) get a minimal entry with only `hex` + `npub` so the caller
// can still render an npub fallback without a separate code path.
//
// Reuses the PROFILE_CACHE — entries written here are interchangeable with
// the owner-profile path (same hex key, same 5min TTL). NIP-05 verification
// is intentionally SKIPPED in the batch path: it's one DNS + HTTP per
// profile, prohibitively expensive for a 10-row maintainers panel. The raw
// `nip05` claim is still returned so the UI can display "alex@gleasonator.dev"
// alongside a "(unverified)" marker if it cares.

interface ProfileLite {
  hex:          string;
  npub:         string;
  name?:        string;
  displayName?: string;     // kind-0 `display_name` field
  picture?:     string;
  nip05?:       string;     // raw claim
  nip05Verified?: boolean;  // true when the NIP-05's well-known JSON resolves back to this hex
  cachedAt:     number;
}

function fetchKind0BatchFromRelay(
  relayUrl: string,
  pubkeys: string[],
  timeoutMs: number,
): Promise<any[]> {
  return new Promise((resolve) => {
    const out: any[] = [];
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch {}
      clearTimeout(timer);
      resolve(out);
    };
    let ws: WebSocket;
    try { ws = new WebSocket(relayUrl); }
    catch { resolve(out); return; }
    const timer = setTimeout(finish, timeoutMs);
    const subId = 'ns-profiles-' + Math.random().toString(36).slice(2, 8);
    ws.addEventListener('open', () => {
      try {
        ws.send(JSON.stringify(['REQ', subId, { authors: pubkeys, kinds: [0] }]));
      } catch { finish(); }
    });
    ws.addEventListener('message', (m: any) => {
      try {
        const msg = JSON.parse(typeof m.data === 'string' ? m.data : m.data.toString());
        if (Array.isArray(msg)) {
          if (msg[0] === 'EVENT' && msg[1] === subId && msg[2]?.kind === 0) {
            out.push(msg[2]);
          } else if (msg[0] === 'EOSE' && msg[1] === subId) {
            finish();
          }
        }
      } catch {}
    });
    ws.addEventListener('error', () => finish());
    ws.addEventListener('close', () => finish());
  });
}

async function lookupProfilesBatch(
  pubkeys: string[],
  relays: string[],
  verifyNip05: boolean = false,
): Promise<Map<string, ProfileLite>> {
  const result = new Map<string, ProfileLite>();
  const need: string[] = [];
  // Cache hot-path: skip pubkeys whose entry is fresh. We re-fetch
  // (move to `need`) when verification was requested but we don't have
  // a verification result yet — otherwise the verified ✓ wouldn't
  // appear on a re-paint that arrived from cache.
  for (const hex of pubkeys) {
    if (!/^[0-9a-f]{64}$/.test(hex)) continue;
    const cached = PROFILE_CACHE.get(hex);
    const isFresh = cached && Date.now() - cached.cachedAt < PROFILE_TTL_MS;
    const needsVerification = verifyNip05 && cached?.nip05 && cached.nip05Verified === undefined;
    if (isFresh && !needsVerification) {
      result.set(hex, {
        hex:           cached!.hex,
        npub:          cached!.npub,
        name:          cached!.name,
        picture:       cached!.picture,
        nip05:         cached!.nip05,
        nip05Verified: cached!.nip05Verified,
        cachedAt:      cached!.cachedAt,
      });
    } else if (isFresh && needsVerification) {
      // Skip the relay roundtrip but include this hex in the
      // verification pass below by seeding `result` with the cached
      // profile values.
      result.set(hex, {
        hex:           cached!.hex,
        npub:          cached!.npub,
        name:          cached!.name,
        picture:       cached!.picture,
        nip05:         cached!.nip05,
        cachedAt:      cached!.cachedAt,
      });
    } else {
      need.push(hex);
    }
  }

  if (need.length === 0 || relays.length === 0) {
    // Still emit minimal entries for everything requested so the caller
    // can render an npub fallback uniformly.
    for (const hex of pubkeys) {
      if (!result.has(hex) && /^[0-9a-f]{64}$/.test(hex)) {
        result.set(hex, { hex, npub: hexToNpub(hex), cachedAt: Date.now() });
      }
    }
    return result;
  }

  // Parallel REQ across all relays. Each relay gets a 5s budget; total
  // wall-clock cap is ~5s because they run concurrently.
  const perRelay = await Promise.all(
    relays.map(r => fetchKind0BatchFromRelay(r, need, 5000)),
  );
  // Pick freshest kind-0 per pubkey across all relay responses.
  const freshest = new Map<string, any>();
  for (const events of perRelay) {
    for (const ev of events) {
      if (!ev || ev.kind !== 0 || typeof ev.pubkey !== 'string') continue;
      const prev = freshest.get(ev.pubkey);
      if (!prev || (ev.created_at || 0) > (prev.created_at || 0)) {
        freshest.set(ev.pubkey, ev);
      }
    }
  }

  for (const hex of need) {
    const ev = freshest.get(hex);
    const profile: ProfileLite = { hex, npub: hexToNpub(hex), cachedAt: Date.now() };
    if (ev && typeof ev.content === 'string') {
      try {
        const meta = JSON.parse(ev.content);
        if (typeof meta.name         === 'string') profile.name        = meta.name;
        if (typeof meta.display_name === 'string') profile.displayName = meta.display_name;
        if (typeof meta.picture      === 'string') profile.picture     = meta.picture;
        if (typeof meta.nip05        === 'string') profile.nip05       = meta.nip05;
      } catch {}
    }
    result.set(hex, profile);
  }

  // NIP-05 verification — opt-in via `verifyNip05` arg. Each lookup is
  // a DNS + HTTPS GET so it's not free; we cap parallelism so we don't
  // open 50 DNS lookups + sockets at once. Failures (network, 4xx,
  // mismatch) leave nip05Verified === false. Successes set true.
  if (verifyNip05) {
    const withClaim = [...result.values()].filter(p => typeof p.nip05 === 'string' && p.nip05.includes('@'));
    // Cap at 8 in flight at a time. The total wall-clock for, say, 12
    // claims is 2× the slowest fetch instead of all serialised.
    const queue = withClaim.slice();
    const inFlight: Promise<void>[] = [];
    const runOne = async (p: ProfileLite): Promise<void> => {
      const at = p.nip05!.indexOf('@');
      const name   = at >= 0 ? p.nip05!.slice(0, at) : '_';
      const domain = at >= 0 ? p.nip05!.slice(at + 1) : p.nip05!;
      try { p.nip05Verified = await fetchNip05(name, domain, p.hex); }
      catch { p.nip05Verified = false; }
    };
    const tick = async () => {
      while (queue.length > 0 && inFlight.length < 8) {
        const next = queue.shift()!;
        const promise = runOne(next).finally(() => {
          const idx = inFlight.indexOf(promise);
          if (idx >= 0) inFlight.splice(idx, 1);
        });
        inFlight.push(promise);
      }
    };
    while (queue.length > 0 || inFlight.length > 0) {
      await tick();
      if (inFlight.length > 0) await Promise.race(inFlight);
    }
  }

  // Mirror into the owner-profile cache so subsequent single lookups
  // for the same pubkey are free. Done after verification so the
  // verified flag is persisted alongside the rest.
  for (const hex of need) {
    const profile = result.get(hex)!;
    PROFILE_CACHE.set(hex, {
      hex,
      npub:          profile.npub,
      name:          profile.name,
      picture:       profile.picture,
      nip05:         profile.nip05,
      nip05Verified: profile.nip05Verified,
      cachedAt:      profile.cachedAt,
    });
  }
  return result;
}

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
      // graspServers always returns a non-empty list — getGraspServers()
      // falls back to DEFAULT_GRASP_SERVERS when the user hasn't yet
      // touched the list, so the dashboard can render the section
      // without an empty-state branch.
      graspServers: getGraspServers(),
      // App Relays (Ditto-style "default relays that ship with the app")
      // and the toggle controlling whether they participate in /client
      // reads. New users default to enabled so the feed works out of the
      // box. The list itself is fixed in code (DEFAULT_READ_RELAYS) so we
      // expose it here rather than as a separate /api/client/relay-config
      // GET — both flows want the same data.
      appRelays:        DEFAULT_READ_RELAYS.slice(),
      appRelaysEnabled: ident.appRelaysEnabled !== false,
      hasProfile:       !!ident.npub,
    }));
    return true;
  }

  // ── App Relays toggle ─────────────────────────────────────────────────
  //
  // Flips identity.appRelaysEnabled. Used by the Config → Client Relays
  // toggle. Returns the new state so the client doesn't have to round-trip
  // through /api/identity/config to re-render. No need to bust the profile
  // cache — App Relays affect /client reads but not the profile-lookup
  // path (that always uses the union via the existing readRelays field).
  if (url === '/api/identity/app-relays/toggle' && method === 'POST') {
    let parsed: any = {};
    try { parsed = JSON.parse(await readBody(req)); }
    catch { res.writeHead(400); res.end('bad json'); return true; }
    if (typeof parsed.enabled !== 'boolean') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'enabled (boolean) required' }));
      return true;
    }
    const r = setAppRelaysEnabled(parsed.enabled);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(r));
    return true;
  }

  if (url === '/api/identity/set' && method === 'POST') {
    let parsed: any = {};
    try { parsed = JSON.parse(await readBody(req)); }
    catch { res.writeHead(400); res.end('bad json'); return true; }
    // Fields accepted by this route:
    //   - npub          (bootstrap owner)
    //   - setupComplete (wizard progress marker — see localhostExempt)
    // All optional; handler updates whichever is present.
    const hasNpub  = typeof parsed.npub === 'string';
    const hasSetup = typeof parsed.setupComplete === 'boolean';
    if (!hasNpub && !hasSetup) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'nothing to update' }));
      return true;
    }
    let npubResult: { ok: boolean; error?: string; npub?: string } | null = null;
    if (hasNpub) {
      npubResult = setIdentityNpub(String(parsed.npub || '').trim());
      if (npubResult.ok) bustProfileCache();
    }
    if (hasSetup) {
      setSetupComplete(parsed.setupComplete);
    }
    const ok = !npubResult || npubResult.ok;
    const body: any = { ok };
    if (npubResult) { if (npubResult.npub) body.npub = npubResult.npub; if (npubResult.error) body.error = npubResult.error; }
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

  // Global git identity — read + write the user's `--global` user.name
  // and user.email from `~/.gitconfig`. Surfaced in the Config panel
  // so users can see what's set + change it without dropping to a
  // terminal. Auto-seed (git-identity.ts) is the empty-state fallback
  // for nostr-station-managed projects; this endpoint is the explicit
  // user-facing layer that overrides the seed.
  //
  // The GET also includes a `presets` block — npub-synthetic and
  // (when known) the user's npub itself, so the Config panel can
  // offer a "Use my Nostr identity" preset button without the client
  // having to know how to derive it.
  if (url === '/api/git-identity/global' && method === 'GET') {
    const ident = readIdentity();
    const current = readGlobalGitIdentity();
    const npubSynthetic = ident.npub ? deriveGitIdentity(ident.npub) : null;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      current,
      presets: {
        npubSynthetic,
        // nip-05 preset is left for the client to assemble — it depends on
        // a kind-0 lookup the client may already have cached via the
        // existing /api/identity/profile endpoint, no point duplicating
        // the relay query here.
      },
    }));
    return true;
  }
  if (url === '/api/git-identity/global' && method === 'PUT') {
    let parsed: any = {};
    try { parsed = JSON.parse(await readBody(req)); }
    catch { res.writeHead(400); res.end('bad json'); return true; }
    const r = writeGlobalGitIdentity({
      name:  typeof parsed.name  === 'string' ? parsed.name  : '',
      email: typeof parsed.email === 'string' ? parsed.email : '',
    });
    res.writeHead(r.ok ? 200 : 400, { 'Content-Type': 'application/json' });
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

  // ── Batched profile lookup ─────────────────────────────────────────────
  //
  // GET /api/profiles?pubkeys=hex1,hex2,...&relays=wss://a,wss://b
  //   Returns a hex → ProfileLite map. Used by the About tab + maintainers
  //   panel + comment author rows to swap npub fallbacks for real names
  //   and avatars. Caller passes the project's relay hints as `relays` so
  //   we don't lean entirely on the user's read-relay set for maintainers
  //   whose profiles live elsewhere.
  if (url.startsWith('/api/profiles') && method === 'GET') {
    const u = new URL(url, 'http://localhost');
    const pkParam = u.searchParams.get('pubkeys') || '';
    const pubkeys = pkParam
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter(s => /^[0-9a-f]{64}$/.test(s));
    if (pubkeys.length === 0) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ profiles: {} }));
      return true;
    }
    // Cap at 50 — the maintainer set for any realistic repo is small.
    // Refuse oversized requests so a stray caller doesn't open 50 WSes
    // per relay times N relays.
    if (pubkeys.length > 50) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'too many pubkeys (max 50)' }));
      return true;
    }
    const relaysParam = (u.searchParams.get('relays') || '').split(',')
      .map(s => s.trim()).filter(s => /^wss?:\/\//.test(s));
    const ident = readIdentity();
    const ownerRelays = Array.isArray(ident.readRelays) && ident.readRelays.length > 0
      ? ident.readRelays
      : DEFAULT_READ_RELAYS;
    const relays = [...new Set([...relaysParam, ...ownerRelays])].slice(0, 8);
    // verify=1 opts in to NIP-05 well-known verification per profile.
    // Off by default because it's DNS + HTTPS per claim — fine for the
    // owner profile but expensive on a 10-row maintainers panel. The
    // client invokes verify=1 in a follow-up async request after the
    // initial paint so the unverified state never blocks the UI.
    const verify = u.searchParams.get('verify') === '1';
    // ?debug=1 surfaces the relays we consulted + per-pubkey resolution
    // status. Lets users diagnose "why doesn't my name show up?" without
    // checking the server log — answer is in the response body.
    const debug = u.searchParams.get('debug') === '1';
    try {
      const map = await lookupProfilesBatch(pubkeys, relays, verify);
      const profiles: Record<string, any> = {};
      let resolved = 0;
      for (const [k, v] of map) {
        profiles[k] = v;
        if (v.name || v.displayName) resolved++;
      }
      // Always log when we asked for profiles but got mostly nothing —
      // catches misconfigured relays without needing debug=1.
      if (pubkeys.length > 0 && resolved === 0) {
        console.warn('[profiles] resolved 0/' + pubkeys.length,
          'pubkeys=', pubkeys.map(p => p.slice(0, 8) + '…').join(','),
          'relaysCount=', relays.length,
          'relays=', relays.slice(0, 8).join(','));
      }
      const body: any = { profiles };
      if (debug) {
        body.debug = {
          relays,
          requested:    pubkeys.length,
          resolved,
          resolvedFraction: pubkeys.length === 0 ? 0 : resolved / pubkeys.length,
          verifyRequested: verify,
        };
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    } catch (e: any) {
      console.warn('[profiles] FAIL', 'url=', url, 'error=', e?.message || e);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(e.message || e) }));
    }
    return true;
  }

  return false;
}
