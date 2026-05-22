/**
 * /api/communities/* — REST + SSE surface for the Communities feature.
 *
 * Wire shape mirrors the existing identity / nvpn routes: one
 * exported `handleCommunities(req, res, url, method)` that returns
 * true if it handled the request. The orchestrator in web-server.ts
 * calls each section handler in turn.
 *
 * Endpoints (all require an authenticated session):
 *
 *   GET    /api/communities                       list with runtime status
 *   POST   /api/communities                       create
 *   GET    /api/communities/:id                   detail + runtime status
 *   DELETE /api/communities/:id                   stop + delete dir
 *
 *   POST   /api/communities/:id/start
 *   POST   /api/communities/:id/stop
 *   POST   /api/communities/:id/restart
 *
 *   POST   /api/communities/:id/members           body: { pubkey: hex }
 *   DELETE /api/communities/:id/members/:hex
 *
 *   GET    /api/communities/:id/logs              SSE; replays the
 *                                                 ring buffer on connect,
 *                                                 follows new lines.
 *
 * Auth model: every mutating endpoint requires a session — the same
 * gate the rest of /api uses. The SSE endpoint accepts `?token=` since
 * EventSource can't set Authorization (same workaround as the existing
 * /api/logs/* routes).
 */

import http from 'node:http';
import https from 'node:https';
import { readBody } from './_shared.js';
import { requireSession } from '../auth.js';
import {
  listCommunities, readCommunityManifest,
  createCommunity, deleteCommunityDir,
  addCommunityMember, removeCommunityMember,
  listCommunityMembers,
  addCommunityBanword, removeCommunityBanword, listCommunityBanwords,
  listCommunityBannedPubkeys,
  listJoinedCommunities, addJoinedCommunity, removeJoinedCommunity,
  updateJoinedCommunity,
  updateCommunityManifest,
  type CreateCommunityInput,
} from '../communities.js';
import { banPubkey, unbanPubkey } from '../community-admin.js';
import {
  startCommunity, stopCommunity, restartCommunity,
  getCommunityRuntimeStatus, getCommunityLog,
} from '../community-process.js';
import { readNvpnRoster, probeNvpnStatus } from '../nvpn.js';
import { npubToHex } from '../identity.js';

// =====================================================================
// Pubkey normalization
//
// Centralized so every endpoint that takes a "pubkey" body field
// (member add, ban pubkey, etc.) accepts both forms users actually
// have on hand:
//   - raw 64-char hex (mixed case)
//   - bech32 npub1…
// and returns lowercase hex (or null on either malformed input or
// a decode failure). Server-side decode is the robust path —
// browsers can't be trusted to have window.NostrTools loaded, and a
// "Ban pubkey" / "Add member" button that silently does nothing
// (the previous client-only normalizePubkey returned null and
// surfaced nothing visible) is a worse UX than a 400 from the API.

const HEX_64_LOOSE = /^[0-9a-f]{64}$/i;

function normalizePubkeyInput(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;
  if (HEX_64_LOOSE.test(s)) return s.toLowerCase();
  if (s.startsWith('npub1')) {
    try { return npubToHex(s).toLowerCase(); }
    catch { return null; }
  }
  return null;
}

// =====================================================================
// URL parsing — small + bounded so we don't pull in a router library

interface CommunityRoute {
  id?:     string;
  action?: 'start' | 'stop' | 'restart' | 'members' | 'logs' | 'banwords' | 'bans' | 'joined' | 'probe';
  memberHex?: string;
  banword?:  string;
  bannedHex?: string;
}

/**
 * Parse a `/api/communities[/...]` URL into its parts. Returns null
 * when the path doesn't start with the expected prefix; non-null but
 * with all fields undefined for the bare list/create endpoint; the
 * fields fill in as deeper paths are matched.
 */
function parseRoute(url: string): CommunityRoute | null {
  // Strip query string before splitting.
  const path = url.split('?', 1)[0];
  if (path === '/api/communities' || path === '/api/communities/') return {};
  // /api/communities/joined[/<id>] — list / add / delete joined communities.
  // Distinct from the per-community routes below because "joined" isn't
  // a community id and we don't want to spawn a GRAIN process for it.
  if (path === '/api/communities/joined' || path === '/api/communities/joined/') {
    return { action: 'joined' };
  }
  const jm = path.match(/^\/api\/communities\/joined\/([0-9a-f]{12})$/);
  if (jm) return { action: 'joined', id: jm[1] };
  // /api/communities/probe — NIP-11 probe helper used by the join wizard
  // before the user commits to adding the relay to their joined list.
  if (path === '/api/communities/probe') return { action: 'probe' };
  const m = path.match(/^\/api\/communities\/([0-9a-f]{12})(\/.*)?$/);
  if (!m) return null;
  const id = m[1];
  const tail = (m[2] ?? '').replace(/^\//, '');
  if (tail === '')          return { id };
  if (tail === 'start')     return { id, action: 'start' };
  if (tail === 'stop')      return { id, action: 'stop' };
  if (tail === 'restart')   return { id, action: 'restart' };
  if (tail === 'members')   return { id, action: 'members' };
  if (tail === 'logs')      return { id, action: 'logs' };
  if (tail === 'banwords')  return { id, action: 'banwords' };
  if (tail === 'bans')      return { id, action: 'bans' };
  const mm = tail.match(/^members\/([0-9a-f]{64})$/);
  if (mm) return { id, action: 'members', memberHex: mm[1] };
  // Banwords: URL-encoded since words can contain anything. Cap at
  // 200 chars to avoid pathological paths; decoder runs in the
  // handler.
  const bw = tail.match(/^banwords\/(.{1,200})$/);
  if (bw) return { id, action: 'banwords', banword: bw[1] };
  const bn = tail.match(/^bans\/([0-9a-f]{64})$/);
  if (bn) return { id, action: 'bans', bannedHex: bn[1] };
  return null;
}

// =====================================================================
// Response shaping

/** Combine the on-disk manifest with the live supervisor status into
 *  the single shape the dashboard renders. Keeps the wire format
 *  flat so client code doesn't have to merge two objects. */
function shapeCommunity(id: string): unknown | null {
  const manifest = readCommunityManifest(id);
  if (!manifest) return null;
  const runtime = getCommunityRuntimeStatus(id);
  return {
    id:                  manifest.id,
    name:                manifest.name,
    description:         manifest.description,
    privacyMode:         manifest.privacyMode,
    port:                manifest.port,
    nvpnNetworkId:       manifest.nvpnNetworkId,
    nvpnTunnelIp:        manifest.nvpnTunnelIp,
    adminPubkey:         manifest.adminPubkey,
    createdAt:           manifest.createdAt,
    // Runtime fields override the on-disk status (which is an
    // eventually-consistent snapshot; the supervisor is the source
    // of truth for `pid` / `uptimeMs`).
    status:              runtime.status,
    pid:                 runtime.pid,
    startedAt:           runtime.startedAt,
    uptimeMs:            runtime.uptimeMs,
    consecutiveFailures: runtime.consecutiveFailures,
    lastError:           runtime.lastError ?? manifest.lastError,
    memberCount:         listCommunityMembers(id).length,
  };
}

/**
 * Probe a relay's NIP-11 endpoint. NIP-11 spec: GET the relay URL
 * with `Accept: application/nostr+json`; the relay responds with
 * the JSON document. We translate ws:// → http:// and wss:// → https://
 * to hit the same host/port over HTTP.
 *
 * Strict timeout (caller-supplied; default 5s) so a wedged relay
 * doesn't hang the wizard.
 */
function probeNip11Remote(relayUrl: string, timeoutMs: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try { parsed = new URL(relayUrl); }
    catch (e) { reject(new Error(`invalid relay URL: ${(e as Error).message}`)); return; }
    const isSecure = parsed.protocol === 'wss:';
    const httpUrl  = `${isSecure ? 'https' : 'http'}://${parsed.host}/`;
    const lib      = isSecure ? https : http;
    const req = lib.request(httpUrl, {
      method: 'GET',
      headers: { Accept: 'application/nostr+json' },
      timeout: timeoutMs,
    }, (res) => {
      if ((res.statusCode ?? 0) >= 400) {
        res.resume();
        reject(new Error(`NIP-11 returned HTTP ${res.statusCode}`));
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; if (body.length > 32_768) { res.destroy(); } });
      res.on('end', () => {
        try { resolve(JSON.parse(body) as Record<string, unknown>); }
        catch (e) { reject(new Error(`NIP-11 response not JSON: ${(e as Error).message}`)); }
      });
      res.on('error', (e) => reject(e));
    });
    req.on('error',   (e) => reject(e));
    req.on('timeout', ()  => { req.destroy(); reject(new Error(`probe timed out after ${timeoutMs} ms`)); });
    req.end();
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function sendError(res: http.ServerResponse, status: number, message: string): void {
  sendJson(res, status, { ok: false, error: message });
}

// =====================================================================
// Validators

const HEX_64 = /^[0-9a-f]{64}$/;

/**
 * Coerce + validate a CreateCommunity payload. Each field's missing /
 * malformed case maps to a specific 400 message rather than a generic
 * "bad input" — the wizard surfaces these directly to the user.
 */
function validateCreatePayload(raw: any): { ok: true; input: CreateCommunityInput } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'JSON body required' };
  const name = String(raw.name ?? '').trim();
  if (!name) return { ok: false, error: '`name` is required' };
  if (name.length > 60) return { ok: false, error: '`name` must be ≤ 60 chars' };

  const privacyMode = raw.privacyMode;
  if (privacyMode !== 'local' && privacyMode !== 'private-network') {
    return { ok: false, error: '`privacyMode` must be "local" or "private-network"' };
  }

  const adminPubkey = String(raw.adminPubkey ?? '').toLowerCase();
  if (!HEX_64.test(adminPubkey)) {
    return { ok: false, error: '`adminPubkey` must be 64-char lowercase hex' };
  }

  // nvpnNetworkId is optional in the request body — the route layer
  // auto-resolves it from the user's active nvpn network when the
  // wizard didn't pass one. This is the per-Option-B model: every
  // private-network community on the host shares the single active
  // nvpn mesh. Validation here ensures the resulting value is a
  // non-empty string; the auto-resolve step lives in the POST
  // handler (which has access to nvpn helpers).
  let nvpnNetworkId: string | undefined;
  if (privacyMode === 'private-network') {
    const explicit = String(raw.nvpnNetworkId ?? '').trim();
    if (explicit) nvpnNetworkId = explicit;
    // Empty case left to the POST handler to fill in from the live
    // nvpn state — surfaces a specific error there if no network is
    // active, rather than rejecting at the validator level when the
    // wizard intentionally elided the field.
  }

  let memberPubkeys: string[] | undefined;
  if (raw.memberPubkeys !== undefined) {
    if (!Array.isArray(raw.memberPubkeys)) {
      return { ok: false, error: '`memberPubkeys` must be an array of hex strings' };
    }
    const normalized: string[] = [];
    for (const pk of raw.memberPubkeys) {
      const s = String(pk).toLowerCase();
      if (!HEX_64.test(s)) {
        return { ok: false, error: `member pubkey ${String(pk).slice(0, 12)}… is not 64-char hex` };
      }
      normalized.push(s);
    }
    memberPubkeys = normalized;
  }

  const description = raw.description === undefined ? undefined : String(raw.description);
  if (description !== undefined && description.length > 200) {
    return { ok: false, error: '`description` must be ≤ 200 chars' };
  }

  return {
    ok: true,
    input: {
      name,
      description,
      privacyMode,
      adminPubkey,
      nvpnNetworkId,
      memberPubkeys,
      skipAddAdmin: raw.skipAddAdmin === true,
    },
  };
}

// =====================================================================
// Handler

export async function handleCommunities(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: string,
  method: string,
): Promise<boolean> {
  const route = parseRoute(url);
  if (route === null) return false;

  // ── Collection routes ─────────────────────────────────────────────
  if (route.id === undefined) {
    if (method === 'GET') {
      if (!requireSession(req, res)) return true;
      const list = listCommunities().map((c) => shapeCommunity(c.id));
      sendJson(res, 200, { ok: true, communities: list });
      return true;
    }
    if (method === 'POST') {
      if (!requireSession(req, res)) return true;
      let raw: any;
      try { raw = JSON.parse(await readBody(req)); }
      catch { sendError(res, 400, 'invalid JSON body'); return true; }
      const v = validateCreatePayload(raw);
      if (!v.ok) { sendError(res, 400, v.error); return true; }

      // Auto-resolve nvpnNetworkId for private-network communities
      // whose wizard didn't pass one. Under nvpn's one-active-
      // network model (Path B), every private-network community on
      // this host shares the single active mesh — there's no
      // selection to make at create time, just discovery. If nvpn
      // isn't installed / running / has no active network, surface
      // a specific 400 the wizard can act on (Install nvpn /
      // Start nvpn / Join a network).
      const input = { ...v.input };
      if (input.privacyMode === 'private-network' && !input.nvpnNetworkId) {
        const st = await probeNvpnStatus();
        if (!st.installed) {
          sendError(res, 400, 'private-network mode requires nvpn — install it from Config');
          return true;
        }
        if (!st.running) {
          sendError(res, 400, 'nvpn is installed but not running — start it from the nvpn panel');
          return true;
        }
        const roster = readNvpnRoster();
        if (!roster.networkId) {
          sendError(res, 400, 'nvpn is running but no network is active — join a network first');
          return true;
        }
        input.nvpnNetworkId = roster.networkId;
      }

      try {
        const m = await createCommunity(input);
        sendJson(res, 201, { ok: true, community: shapeCommunity(m.id) });
      } catch (e: any) {
        // The CRUD layer throws Error with a specific message we can
        // pass through; cap so a stack trace never leaks.
        sendError(res, 400, (e?.message ?? 'create failed').slice(0, 240));
      }
      return true;
    }
    sendError(res, 405, 'method not allowed');
    return true;
  }

  // ── Joined communities (separate persistence, not per-dir) ───────
  if (route.action === 'joined' && !route.id) {
    if (!requireSession(req, res)) return true;
    if (method === 'GET') {
      sendJson(res, 200, { ok: true, joined: listJoinedCommunities() });
      return true;
    }
    if (method === 'POST') {
      let raw: any;
      try { raw = JSON.parse(await readBody(req)); }
      catch { sendError(res, 400, 'invalid JSON body'); return true; }
      const name     = String(raw?.name ?? '').trim();
      const relayUrl = String(raw?.relayUrl ?? '').trim();
      if (!name)     { sendError(res, 400, '`name` is required'); return true; }
      if (!/^wss?:\/\//.test(relayUrl)) {
        sendError(res, 400, '`relayUrl` must start with ws:// or wss://');
        return true;
      }
      try {
        const entry = addJoinedCommunity({
          name, relayUrl,
          detectedName:        raw?.detectedName,
          detectedDescription: raw?.detectedDescription,
        });
        sendJson(res, 201, { ok: true, entry });
      } catch (e: any) {
        sendError(res, 400, (e?.message ?? 'join failed').slice(0, 240));
      }
      return true;
    }
    sendError(res, 405, 'method not allowed');
    return true;
  }
  if (route.action === 'joined' && route.id && method === 'DELETE') {
    if (!requireSession(req, res)) return true;
    removeJoinedCommunity(route.id);
    sendJson(res, 200, { ok: true });
    return true;
  }
  if (route.action === 'joined' && route.id && method === 'PATCH') {
    if (!requireSession(req, res)) return true;
    let raw: any;
    try { raw = JSON.parse(await readBody(req)); }
    catch { sendError(res, 400, 'invalid JSON body'); return true; }
    const patch: any = {};
    if (typeof raw?.lastReachedAt === 'number') patch.lastReachedAt = raw.lastReachedAt;
    if (typeof raw?.detectedName === 'string')  patch.detectedName  = raw.detectedName;
    if (typeof raw?.detectedDescription === 'string') patch.detectedDescription = raw.detectedDescription;
    if (typeof raw?.name === 'string' && raw.name.trim()) patch.name = raw.name.trim();
    const updated = updateJoinedCommunity(route.id, patch);
    if (!updated) { sendError(res, 404, 'joined community not found'); return true; }
    sendJson(res, 200, { ok: true, entry: updated });
    return true;
  }

  // ── NIP-11 probe helper for the join wizard ──────────────────────
  // Lets the dashboard fetch a relay's self-description BEFORE the
  // user commits to adding it to their joined list. Doesn't touch
  // any persisted state. Strict timeout so a wedged relay doesn't
  // hang the wizard.
  if (route.action === 'probe' && method === 'POST') {
    if (!requireSession(req, res)) return true;
    let raw: any;
    try { raw = JSON.parse(await readBody(req)); }
    catch { sendError(res, 400, 'invalid JSON body'); return true; }
    const relayUrl = String(raw?.relayUrl ?? '').trim();
    if (!/^wss?:\/\//.test(relayUrl)) {
      sendError(res, 400, '`relayUrl` must start with ws:// or wss://');
      return true;
    }
    try {
      const nip11 = await probeNip11Remote(relayUrl, 5_000);
      sendJson(res, 200, { ok: true, nip11 });
    } catch (e: any) {
      sendJson(res, 200, {
        ok: false,
        error: (e?.message ?? 'probe failed').slice(0, 240),
      });
    }
    return true;
  }

  // ── Per-community routes ─────────────────────────────────────────
  const id = route.id;

  // Logs SSE — handled before the require-session gate because
  // EventSource can't set Authorization. The auth happens through
  // the ?token= query param, which the requireSession path also
  // honors.
  if (route.action === 'logs' && method === 'GET') {
    if (!requireSession(req, res)) return true;
    const log = getCommunityLog(id);
    res.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection':    'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    // Replay current ring buffer first so a freshly-opened panel
    // shows context, then follow new lines via the subscribe hook.
    const initial = log.drain();
    try { res.write(`data: ${JSON.stringify({ lines: initial })}\n\n`); } catch {}
    const unsub = log.subscribe((line) => {
      try { res.write(`data: ${JSON.stringify({ lines: [line] })}\n\n`); }
      catch { /* socket closed; cleanup runs in req.on('close') */ }
    });
    req.on('close', () => { unsub(); });
    return true;
  }

  // Every other per-community route is a state mutation — require a
  // session up front so we don't leak existence-of-id via timing.
  if (!requireSession(req, res)) return true;

  // GET detail
  if (route.action === undefined && method === 'GET') {
    const shaped = shapeCommunity(id);
    if (!shaped) { sendError(res, 404, 'community not found'); return true; }
    sendJson(res, 200, { ok: true, community: shaped });
    return true;
  }

  // PATCH detail — accepts { name?, description? } only. Port / privacy
  // mode / admin pubkey are immutable at this stage: changing them
  // would require coordinated state changes across the supervisor,
  // the nvpn roster, and the GRAIN config, which the plan defers.
  if (route.action === undefined && method === 'PATCH') {
    const existing = readCommunityManifest(id);
    if (!existing) { sendError(res, 404, 'community not found'); return true; }
    let raw: any;
    try { raw = JSON.parse(await readBody(req)); }
    catch { sendError(res, 400, 'invalid JSON body'); return true; }
    const patch: { name?: string; description?: string } = {};
    if (raw.name !== undefined) {
      const n = String(raw.name).trim();
      if (!n)                 { sendError(res, 400, '`name` must be non-empty'); return true; }
      if (n.length > 60)      { sendError(res, 400, '`name` must be ≤ 60 chars'); return true; }
      patch.name = n;
    }
    if (raw.description !== undefined) {
      const d = String(raw.description);
      if (d.length > 200)     { sendError(res, 400, '`description` must be ≤ 200 chars'); return true; }
      patch.description = d;
    }
    if (Object.keys(patch).length === 0) {
      sendError(res, 400, 'nothing to update — pass `name` and/or `description`');
      return true;
    }
    updateCommunityManifest(id, patch);
    sendJson(res, 200, { ok: true, community: shapeCommunity(id) });
    return true;
  }

  // DELETE — stop the supervisor (best-effort) then remove the dir.
  if (route.action === undefined && method === 'DELETE') {
    const exists = readCommunityManifest(id);
    if (!exists) { sendError(res, 404, 'community not found'); return true; }
    try {
      await stopCommunity(id);
    } catch (e: any) {
      // Stopping a community we can't supervise (e.g. nvpn down) is
      // fine — proceed to delete the dir. Log the detail for forensics
      // by burying it in the response; this isn't an error from the
      // caller's perspective.
      await updateCommunityManifest(id, { status: 'stopped', lastError: (e?.message ?? 'stop failed') });
    }
    deleteCommunityDir(id);
    sendJson(res, 200, { ok: true });
    return true;
  }

  // POST lifecycle
  if (route.action === 'start' && method === 'POST') {
    if (!readCommunityManifest(id)) { sendError(res, 404, 'community not found'); return true; }
    try {
      const r = await startCommunity(id);
      sendJson(res, 200, { ok: true, status: r });
    } catch (e: any) {
      sendError(res, 409, (e?.message ?? 'start failed').slice(0, 240));
    }
    return true;
  }
  if (route.action === 'stop' && method === 'POST') {
    if (!readCommunityManifest(id)) { sendError(res, 404, 'community not found'); return true; }
    await stopCommunity(id);
    sendJson(res, 200, { ok: true });
    return true;
  }
  if (route.action === 'restart' && method === 'POST') {
    if (!readCommunityManifest(id)) { sendError(res, 404, 'community not found'); return true; }
    try {
      const r = await restartCommunity(id);
      sendJson(res, 200, { ok: true, status: r });
    } catch (e: any) {
      sendError(res, 409, (e?.message ?? 'restart failed').slice(0, 240));
    }
    return true;
  }

  // Members
  if (route.action === 'members' && method === 'POST') {
    if (!readCommunityManifest(id)) { sendError(res, 404, 'community not found'); return true; }
    let raw: any;
    try { raw = JSON.parse(await readBody(req)); }
    catch { sendError(res, 400, 'invalid JSON body'); return true; }
    const pubkey = normalizePubkeyInput(raw?.pubkey);
    if (!pubkey) {
      sendError(res, 400, '`pubkey` must be an npub1… or 64-char hex string');
      return true;
    }
    const members = addCommunityMember(id, pubkey);
    sendJson(res, 200, { ok: true, members });
    return true;
  }
  if (route.action === 'members' && method === 'GET') {
    if (!readCommunityManifest(id)) { sendError(res, 404, 'community not found'); return true; }
    sendJson(res, 200, { ok: true, members: listCommunityMembers(id) });
    return true;
  }
  if (route.action === 'members' && route.memberHex && method === 'DELETE') {
    if (!readCommunityManifest(id)) { sendError(res, 404, 'community not found'); return true; }
    const members = removeCommunityMember(id, route.memberHex);
    sendJson(res, 200, { ok: true, members });
    return true;
  }

  // ── Banwords (blacklist.yml hot-reload, no NIP-86) ──────────────
  // Storage-side edit only. GRAIN hot-reloads blacklist.yml within
  // ~2s of the write, so the new word is enforced without a restart.
  if (route.action === 'banwords' && method === 'GET') {
    if (!readCommunityManifest(id)) { sendError(res, 404, 'community not found'); return true; }
    sendJson(res, 200, { ok: true, banwords: listCommunityBanwords(id) });
    return true;
  }
  if (route.action === 'banwords' && method === 'POST') {
    if (!readCommunityManifest(id)) { sendError(res, 404, 'community not found'); return true; }
    let raw: any;
    try { raw = JSON.parse(await readBody(req)); }
    catch { sendError(res, 400, 'invalid JSON body'); return true; }
    const word = String(raw?.word ?? '').trim();
    if (!word) { sendError(res, 400, '`word` is required'); return true; }
    if (word.length > 200) { sendError(res, 400, '`word` must be ≤ 200 chars'); return true; }
    try {
      const banwords = addCommunityBanword(id, word);
      sendJson(res, 200, { ok: true, banwords });
    } catch (e: any) {
      sendError(res, 400, (e?.message ?? 'add failed').slice(0, 240));
    }
    return true;
  }
  if (route.action === 'banwords' && route.banword && method === 'DELETE') {
    if (!readCommunityManifest(id)) { sendError(res, 404, 'community not found'); return true; }
    // The path-encoded form is the source of truth; the YAML store
    // normalizes again on its end so a mismatched case won't no-op.
    let word: string;
    try { word = decodeURIComponent(route.banword); }
    catch { sendError(res, 400, 'malformed banword in URL'); return true; }
    const banwords = removeCommunityBanword(id, word);
    sendJson(res, 200, { ok: true, banwords });
    return true;
  }

  // ── Bans (NIP-86 banpubkey / allowpubkey) ──────────────────────
  // These verbs prompt the user's Amber signer per call. The silent-
  // sign delegation toggle that buffers the prompt for 8h lives with
  // the Moderation tab UI in a follow-up — for now every ban is one
  // tap. The endpoint surfaces both the storage view (blacklist.yml's
  // pubkeys field, updated by GRAIN on a successful banpubkey RPC)
  // and the NIP-86 call result.
  if (route.action === 'bans' && method === 'GET') {
    if (!readCommunityManifest(id)) { sendError(res, 404, 'community not found'); return true; }
    sendJson(res, 200, { ok: true, bannedPubkeys: listCommunityBannedPubkeys(id) });
    return true;
  }
  if (route.action === 'bans' && method === 'POST') {
    if (!readCommunityManifest(id)) { sendError(res, 404, 'community not found'); return true; }
    let raw: any;
    try { raw = JSON.parse(await readBody(req)); }
    catch { sendError(res, 400, 'invalid JSON body'); return true; }
    const pubkey = normalizePubkeyInput(raw?.pubkey);
    if (!pubkey) {
      sendError(res, 400, '`pubkey` must be an npub1… or 64-char hex string');
      return true;
    }
    const reason = String(raw?.reason ?? '').slice(0, 200);
    try {
      const r = await banPubkey(id, pubkey, reason);
      if (!r.ok) {
        sendError(res, 502, r.detail || 'banpubkey RPC failed');
        return true;
      }
      sendJson(res, 200, {
        ok: true,
        bannedPubkeys: listCommunityBannedPubkeys(id),
      });
    } catch (e: any) {
      sendError(res, 400, (e?.message ?? 'ban failed').slice(0, 240));
    }
    return true;
  }
  if (route.action === 'bans' && route.bannedHex && method === 'DELETE') {
    if (!readCommunityManifest(id)) { sendError(res, 404, 'community not found'); return true; }
    try {
      const r = await unbanPubkey(id, route.bannedHex);
      if (!r.ok) {
        sendError(res, 502, r.detail || 'allowpubkey RPC failed');
        return true;
      }
      sendJson(res, 200, {
        ok: true,
        bannedPubkeys: listCommunityBannedPubkeys(id),
      });
    } catch (e: any) {
      sendError(res, 400, (e?.message ?? 'unban failed').slice(0, 240));
    }
    return true;
  }

  sendError(res, 405, 'method not allowed');
  return true;
}

// Exported for tests.
export { parseRoute as _parseRoute, validateCreatePayload as _validateCreatePayload };
