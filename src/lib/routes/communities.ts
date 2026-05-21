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
import { readBody } from './_shared.js';
import { requireSession } from '../auth.js';
import {
  listCommunities, readCommunityManifest,
  createCommunity, deleteCommunityDir,
  addCommunityMember, removeCommunityMember,
  listCommunityMembers,
  updateCommunityManifest,
  type CreateCommunityInput,
} from '../communities.js';
import {
  startCommunity, stopCommunity, restartCommunity,
  getCommunityRuntimeStatus, getCommunityLog,
} from '../community-process.js';

// =====================================================================
// URL parsing — small + bounded so we don't pull in a router library

interface CommunityRoute {
  id?:     string;
  action?: 'start' | 'stop' | 'restart' | 'members' | 'logs';
  memberHex?: string;
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
  const mm = tail.match(/^members\/([0-9a-f]{64})$/);
  if (mm) return { id, action: 'members', memberHex: mm[1] };
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

  let nvpnNetworkId: string | undefined;
  if (privacyMode === 'private-network') {
    nvpnNetworkId = String(raw.nvpnNetworkId ?? '').trim();
    if (!nvpnNetworkId) {
      return { ok: false, error: 'private-network communities require `nvpnNetworkId`' };
    }
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
      try {
        const m = await createCommunity(v.input);
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
    const pubkey = String(raw?.pubkey ?? '').toLowerCase();
    if (!HEX_64.test(pubkey)) {
      sendError(res, 400, '`pubkey` must be 64-char lowercase hex');
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

  sendError(res, 405, 'method not allowed');
  return true;
}

// Exported for tests.
export { parseRoute as _parseRoute, validateCreatePayload as _validateCreatePayload };
