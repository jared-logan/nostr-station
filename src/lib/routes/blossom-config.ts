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
