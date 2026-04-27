/**
 * Terminal routes — split out of `web-server.ts` as part of the route-group
 * refactor. Pure dispatch by URL + method for the HTTP surface; the
 * WebSocket upgrade handler is wired into the orchestrator's http.Server
 * via `mountTerminalWebSocket()` because it needs the same `allowedHosts`
 * + `isLoopbackUrl` H1/H2 primitives the request handler uses, and those
 * are closure-bound to the actual bound port in `startWebServer`.
 *
 * Surface (verbatim from the pre-refactor inline blocks):
 *   GET    /api/terminal/capability  — node-pty load probe
 *   GET    /api/terminal             — list active sessions
 *   POST   /api/terminal/create      — create a PTY session
 *   DELETE /api/terminal/:id         — destroy a session
 *
 * WebSocket:
 *   /api/terminal/ws/:id?token=<bearer>
 *     - mirrors HTTP H1 (loopback Host) + H2 (loopback Origin) checks
 *     - auth via session-token query param, localhostExempt fallback
 *     - control frames prefixed with a NUL byte (\x00) + JSON
 *
 * Returns `true` from `handleTerminal` when matched and a response was
 * written; `false` lets the orchestrator continue trying its remaining
 * route groups.
 */
import http from 'http';
import { WebSocketServer } from 'ws';
import {
  loadPty, createSession as createTerminal, attachClient as attachTerminal,
  detachClient as detachTerminal, destroySession as destroyTerminal,
  writeInput as writeTerminalInput, resizeSession as resizeTerminal,
  listSessions as listTerminals,
} from '../terminal.js';
import { getProject } from '../projects.js';
import { getSession, localhostExempt } from '../auth.js';
import { readBody, CLI_SPAWN } from './_shared.js';

export async function handleTerminal(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: string,
  method: string,
): Promise<boolean> {
  // Capability probe — tells the client whether the terminal bar can be
  // enabled. Lives at a stable URL so the client can render a degraded
  // "install python3 + build tools" hint without having to create a
  // session to find out.
  if (url === '/api/terminal/capability' && method === 'GET') {
    const pty = await loadPty();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      available: pty !== null,
      reason: pty === null
        ? 'node-pty not installed — run `nostr-station doctor --fix` or reinstall with build tools available'
        : undefined,
    }));
    return true;
  }

  // List active sessions — supports the client reconnect path: on boot
  // it checks stored session ids against this list, only rejoining ones
  // the server still knows about.
  if (url === '/api/terminal' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ sessions: listTerminals() }));
    return true;
  }

  // Create a new PTY session. Body shape: { key, cwd?, projectId? }.
  // `key` is one of the whitelisted strings in terminal.ts resolveCmd().
  // `projectId`, if given, is looked up server-side and its path used
  // as cwd — clients never pass raw paths here.
  if (url === '/api/terminal/create' && method === 'POST') {
    let parsed: any = {};
    try { parsed = JSON.parse(await readBody(req)); }
    catch { res.writeHead(400); res.end('bad json'); return true; }
    const key = String(parsed.key || '');
    let cwd: string | undefined;
    const pid = parsed.projectId ? String(parsed.projectId) : '';
    if (pid) {
      const p = getProject(pid);
      if (!p) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'project not found' }));
        return true;
      }
      if (p.path) cwd = p.path;
    }
    const r = await createTerminal({ key, cwd }, CLI_SPAWN);
    if (!r.ok) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: r.error }));
      return true;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: r.id, label: r.label }));
    return true;
  }

  const termDelMatch = url.match(/^\/api\/terminal\/([a-f0-9]{16,})$/);
  if (termDelMatch && method === 'DELETE') {
    const ok = destroyTerminal(termDelMatch[1], 'client-close');
    res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok }));
    return true;
  }

  return false;
}

/**
 * Wires the terminal WebSocket upgrade handler onto the orchestrator's
 * http.Server. Has to live as a closure-receiving function (rather than
 * a top-level handler) because the H1 / H2 primitives — the
 * `allowedHosts` set and the `isLoopbackUrl` predicate — are computed
 * from the actual bound port inside `startWebServer`, and we want the
 * WS layer to use the SAME values the HTTP request middleware does.
 *
 * Mirrors the HTTP layer's checks:
 *   1. Loopback Host header (H1 — DNS rebinding).
 *   2. Loopback Origin header (H2 — CSRF). Browsers always send Origin
 *      on upgrade, so a missing/foreign Origin is treated as hostile.
 *   3. Auth via session-token query param OR localhostExempt fallback.
 *
 * Server → client framing: raw PTY bytes are written straight through;
 * control frames are NUL-prefixed JSON. See the route-doc comment up top.
 */
export function mountTerminalWebSocket(
  server: http.Server,
  ctx: {
    allowedHosts: Set<string>;
    isLoopbackUrl: (u: string | undefined | null) => boolean;
  },
): void {
  const { allowedHosts, isLoopbackUrl } = ctx;
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = req.url || '';
    const match = url.match(/^\/api\/terminal\/ws\/([a-f0-9]{16,})(?:\?.*)?$/);
    if (!match) {
      socket.destroy();
      return;
    }
    const sessionId = match[1];

    // Mirror the HTTP Host + Origin checks at the WebSocket layer.
    // Browsers always send Origin on upgrade handshakes, so rejecting
    // missing/foreign Origin blocks cross-origin WS attempts (e.g. a
    // malicious page trying to attach to a live terminal session).
    const hostHeader = String(req.headers['host'] || '').toLowerCase();
    if (!allowedHosts.has(hostHeader)) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    const wsOrigin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
    if (!isLoopbackUrl(wsOrigin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    // Auth check using the same primitives as the REST middleware.
    let authed = localhostExempt(req);
    if (!authed) {
      // Extract token from ?token= query string.
      const qIdx = url.indexOf('?');
      const qs   = qIdx >= 0 ? new URLSearchParams(url.slice(qIdx + 1)) : null;
      const tok  = qs?.get('token') || '';
      if (tok && getSession(tok)) authed = true;
    }
    if (!authed) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      const sess = attachTerminal(sessionId, ws);
      if (!sess) {
        // Session vanished between create and WS open. Emit a JSON control
        // frame so the client can show a clean "session expired" state,
        // then close. Useful after long sleeps where the grace timer fired.
        try { ws.send(`\x00${JSON.stringify({ type: 'closed', reason: 'unknown-session' })}`); } catch {}
        try { ws.close(4404, 'unknown session'); } catch {}
        return;
      }

      ws.on('message', (raw) => {
        // PTY input is high-rate; parse defensively and drop anything we
        // don't recognize. Max 64KiB per frame guards against a misbehaving
        // client streaming MBs of data into our event loop.
        if ((raw as Buffer).length > 64 * 1024) return;
        let parsed: any;
        try { parsed = JSON.parse(raw.toString()); } catch { return; }
        if (parsed?.type === 'input' && typeof parsed.data === 'string') {
          writeTerminalInput(sessionId, parsed.data);
        } else if (parsed?.type === 'resize') {
          resizeTerminal(sessionId, Number(parsed.cols), Number(parsed.rows));
        }
      });

      ws.on('close', () => detachTerminal(sessionId, ws));
      ws.on('error', () => detachTerminal(sessionId, ws));
    });
  });
}
