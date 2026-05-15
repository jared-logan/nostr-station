/**
 * Blossom routes — config (read-only stats snapshot), control
 * (start/stop/restart), wipe, and a paged blob listing for the
 * dashboard Status panel.
 *
 *   GET    /api/blossom-config         — { url, running, stats } snapshot
 *   POST   /api/blossom/start          — boot the in-process Blossom server
 *   POST   /api/blossom/stop           — stop it
 *   POST   /api/blossom/restart        — stop + start
 *   POST   /api/blossom/wipe           — delete every blob (DB + files)
 *   GET    /api/blossom/blobs          — paged list ({ limit, offset })
 *
 * The actual BlossomServer handle lives in web-server.ts (module-level
 * variable, parallel to inprocRelay). This file owns the request shape
 * and HTTP plumbing; web-server.ts owns the lifecycle.
 */
import http from 'http';
import type { BlossomServer } from '../../blossom/index.js';
import { readBody } from './_shared.js';

export interface BlossomHandlers {
  // Lifecycle (web-server.ts wires these).
  getServer:    () => BlossomServer | null;
  start:        () => Promise<void>;
  stop:         () => Promise<void>;
}

export async function handleBlossomConfig(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: string,
  method: string,
  h: BlossomHandlers,
): Promise<boolean> {
  if (url === '/api/blossom-config' && method === 'GET') {
    const server = h.getServer();
    const stats  = server ? server.blobStore.stats() : null;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      running: !!server,
      url:     server ? `http://127.0.0.1:${blossomPort()}` : null,
      stats,
    }));
    return true;
  }

  const action = url.match(/^\/api\/blossom\/(start|stop|restart)$/);
  if (action && method === 'POST') {
    const verb = action[1];
    try {
      if (verb === 'stop' || verb === 'restart') await h.stop();
      if (verb === 'start' || verb === 'restart') await h.start();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, action: verb, running: !!h.getServer() }));
    } catch (e: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e?.message || String(e) }));
    }
    return true;
  }

  // Admin-mediated single-blob delete. Distinct from the BUD-02 DELETE
  // exposed by the Blossom server itself (which requires NIP-98 + the
  // uploader pubkey) — this endpoint is reached only through the
  // dashboard's already-authenticated session, so we skip the auth-event
  // ceremony. The shape mirrors `/wipe` in spirit but for one blob.
  const oneDelMatch = url.match(/^\/api\/blossom\/blobs\/([0-9a-f]{64})$/i);
  if (oneDelMatch && method === 'DELETE') {
    const server = h.getServer();
    if (!server) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'blossom is not running' }));
      return true;
    }
    const sha = oneDelMatch[1].toLowerCase();
    const ok = server.blobStore.delete(sha);
    if (!ok) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'blob not found' }));
      return true;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, sha256: sha }));
    return true;
  }

  // Bulk delete — body { sha256s: string[] }. Either fully accepts a
  // list of hex shas or rejects with 400 on a malformed body. Returns
  // per-sha results so the UI can show which deletions succeeded.
  if (url === '/api/blossom/blobs/bulk-delete' && method === 'POST') {
    const server = h.getServer();
    if (!server) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'blossom is not running' }));
      return true;
    }
    let parsed: any = {};
    try { parsed = JSON.parse(await readBody(req)); }
    catch { res.writeHead(400); res.end('bad json'); return true; }
    const shas: string[] = Array.isArray(parsed?.sha256s)
      ? parsed.sha256s.filter((s: any) => typeof s === 'string' && /^[0-9a-f]{64}$/i.test(s))
                      .map((s: string) => s.toLowerCase())
      : [];
    if (shas.length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'sha256s must be a non-empty array of 64-hex strings' }));
      return true;
    }
    // Cap fan-out so a runaway client can't request 100k deletes in one
    // call. 500 is comfortably above any UI selection size.
    if (shas.length > 500) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'too many shas (max 500 per call)' }));
      return true;
    }
    const results = shas.map(sha => ({ sha256: sha, ok: server.blobStore.delete(sha) }));
    const deletedCount = results.filter(r => r.ok).length;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, deletedCount, results }));
    return true;
  }

  if (url === '/api/blossom/wipe' && method === 'POST') {
    try { await readBody(req); } catch {}
    const server = h.getServer();
    if (!server) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'blossom is not running' }));
      return true;
    }
    server.blobStore.wipe();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }

  if (url.startsWith('/api/blossom/blobs') && method === 'GET') {
    const server = h.getServer();
    if (!server) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'blossom is not running' }));
      return true;
    }
    const u = new URL(url, 'http://localhost');
    const limit  = Number(u.searchParams.get('limit')  || '50');
    const offset = Number(u.searchParams.get('offset') || '0');
    const blobs = server.blobStore.list(limit, offset);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ blobs, total: server.blobStore.stats().blobCount }));
    return true;
  }

  return false;
}

function blossomPort(): number {
  return Number(process.env.STATION_INPROC_BLOSSOM_PORT || '8081');
}
