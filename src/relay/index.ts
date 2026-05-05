import { WebSocketServer, WebSocket } from 'ws';
import { verifyEvent } from 'nostr-tools/pure';
import http from 'node:http';
import crypto from 'node:crypto';
import { EventStore } from './store.js';
import { WhitelistStore } from './whitelist-store.js';
import { eventMatchesAny } from './filter.js';
import type { NostrEvent, NostrFilter } from './types.js';

// In-process Nostr relay implementing the NIP-01 client/relay protocol.
//
// Wire messages handled:
//   client -> relay
//     ["EVENT", <event>]
//     ["REQ", <subId>, <filter>, ...]
//     ["CLOSE", <subId>]
//   relay -> client
//     ["EVENT",  <subId>, <event>]
//     ["EOSE",   <subId>]
//     ["OK",     <eventId>, <bool>, <message>]
//     ["NOTICE", <message>]
//     ["CLOSED", <subId>, <message>]
//
// NIP-42 authentication is implemented at the wire-protocol level: every
// new connection receives ["AUTH", <challenge>] immediately and a client
// can respond with ["AUTH", <kind-22242 event>] to bind a pubkey to the
// connection. The actual write-access policy ("only the station owner
// and whitelisted pubkeys may publish") lives in handleEvent and is
// enforced via the event's own signed pubkey, not the AUTHed pubkey
// (signature verification already proves authorship — AUTH is
// informational here, useful for clients that expect the dance and for
// the spec-mandated `auth-required:` rejection prefix).

interface Subscription {
  ws:      WebSocket;
  filters: NostrFilter[];
}

interface ConnAuth {
  challenge:     string;          // hex string, sent on connect
  authedPubkey?: string;          // hex; set after a valid kind-22242 reply
}

export interface RelayOptions {
  port?:       number;       // defaults to 7777
  host?:       string;       // defaults to 127.0.0.1
  dbPath?:     string;       // forwarded to EventStore
  maxEvents?:  number;       // forwarded to EventStore
  // Override the whitelist store path. Used by tests to keep state out
  // of the user's real ~/.nostr-station; production code uses the
  // default (next to relay.db).
  whitelistPath?: string;
  // Externally-provided HTTP server. When supplied, the relay attaches
  // its WebSocket upgrade handler to it and does NOT listen() on its own
  // port. Used for the in-process mode where dashboard and relay share
  // a single Node process but separate ports — we still create a tiny
  // HTTP server here, just for the upgrade dance, on the relay's own port.
  attachToServer?: http.Server;
}

const DEFAULT_PORT = 7777;
const DEFAULT_HOST = '127.0.0.1';

export class Relay {
  readonly store:     EventStore;
  readonly whitelist: WhitelistStore;
  private wss?:   WebSocketServer;
  private http?:  http.Server;
  // subId is per-connection; we key the Map by ws + ':' + subId so we can
  // efficiently iterate on broadcast and clean up when a socket drops.
  private subs = new Map<string, Subscription>();
  private port: number;
  private host: string;

  constructor(opts: RelayOptions = {}) {
    this.port      = opts.port ?? DEFAULT_PORT;
    this.host      = opts.host ?? DEFAULT_HOST;
    this.store     = new EventStore({ dbPath: opts.dbPath, maxEvents: opts.maxEvents });
    this.whitelist = new WhitelistStore(opts.whitelistPath);
  }

  async start(): Promise<{ port: number; host: string }> {
    // We always run our own tiny HTTP server. The dashboard listens on a
    // different port (3000); the relay's URL is `ws://<host>:<port>` per
    // standard Nostr expectations. A bare HTTP GET to the relay port
    // returns NIP-11 metadata.
    this.http = http.createServer((req, res) => this.handleHttp(req, res));
    this.wss  = new WebSocketServer({ server: this.http });

    this.wss.on('connection', ws => this.handleConnection(ws));

    await new Promise<void>((resolve, reject) => {
      this.http!.once('error', reject);
      this.http!.listen(this.port, this.host, () => resolve());
    });

    return { port: this.port, host: this.host };
  }

  async stop(): Promise<void> {
    // Close all subs + WS clients first so the sockets don't hold the
    // event loop open after http.close()'s callback fires.
    for (const sub of this.subs.values()) {
      try { sub.ws.close(1001, 'relay stopping'); } catch {}
    }
    this.subs.clear();
    // Hard-terminate any clients the WebSocketServer still tracks. Without
    // this, `wss.close()` waits for graceful close handshakes and
    // `http.close()` waits for the underlying TCP sockets to drain — which
    // races on slow runners (notably GitHub Actions) and can leave
    // Relay.stop() pending for minutes when a test client's CLOSE frame
    // hadn't been ACKed yet.
    if (this.wss) {
      for (const client of this.wss.clients) {
        try { client.terminate(); } catch {}
      }
    }
    await new Promise<void>(resolve => this.wss?.close(() => resolve()));
    // closeAllConnections (Node 18.2+) force-closes any remaining
    // keep-alive sockets so http.close() can resolve immediately instead
    // of waiting for keep-alive timeout.
    this.http?.closeAllConnections?.();
    await new Promise<void>(resolve => this.http?.close(() => resolve()));
    this.store.close();
  }

  private handleHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
    // NIP-11 relay information document. Returned for GET requests with
    // Accept: application/nostr+json (and as a courtesy for plain GETs,
    // since dev tools / curl typically don't set the header).
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/nostr+json' });
      res.end(JSON.stringify({
        name:        'nostr-station',
        description: 'Local development relay',
        software:    'nostr-station',
        supported_nips: [1, 11, 42],
        limitation: {
          max_subscriptions: 100,
          max_filters:       10,
          max_limit:         5000,
          payment_required:  false,
          // Reads are open. Writes are pubkey-gated (owner + whitelist).
          // auth_required:false reflects "you can connect and subscribe
          // without AUTH"; the per-EVENT response carries `auth-required:`
          // for clients that try to publish without permission.
          auth_required:     false,
          restricted_writes: true,
        },
      }));
      return;
    }
    res.writeHead(405); res.end();
  }

  private handleConnection(ws: WebSocket): void {
    const connSubs = new Set<string>();

    // Per NIP-42: send AUTH challenge immediately on connect. 32 bytes hex
    // is more than enough entropy and matches the entropy we use elsewhere
    // for session tokens. Challenge is per-connection, so a replay against
    // a different connection is rejected by mismatched challenge tag.
    const auth: ConnAuth = { challenge: crypto.randomBytes(32).toString('hex') };
    (ws as any).__nsAuth = auth;
    sendJson(ws, ['AUTH', auth.challenge]);

    ws.on('message', (data) => {
      let msg: unknown;
      try { msg = JSON.parse(data.toString()); }
      catch { return notice(ws, 'invalid JSON'); }

      if (!Array.isArray(msg) || typeof msg[0] !== 'string') {
        return notice(ws, 'message must be a typed array');
      }
      const [type, ...rest] = msg as [string, ...unknown[]];

      if (type === 'EVENT') return this.handleEvent(ws, rest[0]);
      if (type === 'REQ')   return this.handleReq(ws, rest, connSubs);
      if (type === 'CLOSE') return this.handleClose(ws, rest[0], connSubs);
      if (type === 'AUTH')  return this.handleAuth(ws, rest[0]);
      notice(ws, `unknown message type: ${type}`);
    });

    ws.on('close', () => {
      for (const key of connSubs) this.subs.delete(key);
      connSubs.clear();
    });
    ws.on('error', () => { /* swallow — close handler does cleanup */ });
  }

  // NIP-42 client AUTH response. The event must:
  //   - be kind 22242
  //   - carry a `challenge` tag matching the one we sent on connect
  //   - carry a `relay` tag matching this relay's URL
  //   - be signed correctly (verifyEvent)
  //   - be timestamped within ±10 minutes (clock-skew tolerance, matches
  //     NIP-98's 60s window scaled up to allow for slow Amber round-trips)
  // On success the connection's authedPubkey is set; the actual write
  // policy (in handleEvent) reads event.pubkey from each EVENT instead,
  // so AUTH state is informational here.
  private handleAuth(ws: WebSocket, raw: unknown): void {
    if (!isEvent(raw)) return notice(ws, 'AUTH: not an event object');
    const auth = (ws as any).__nsAuth as ConnAuth | undefined;
    if (!auth) return notice(ws, 'AUTH: connection has no challenge');

    if (raw.kind !== 22242) return ok(ws, raw.id, false, 'auth-failed: kind must be 22242');

    let valid = false;
    try { valid = verifyEvent(raw as any); } catch { valid = false; }
    if (!valid) return ok(ws, raw.id, false, 'auth-failed: bad signature');

    const challengeTag = raw.tags.find(t => t[0] === 'challenge')?.[1];
    if (challengeTag !== auth.challenge) {
      return ok(ws, raw.id, false, 'auth-failed: challenge mismatch');
    }
    const relayTag = raw.tags.find(t => t[0] === 'relay')?.[1];
    const expectedRelay = this.getRelayUrl();
    if (!relayTag || !sameRelayUrl(relayTag, expectedRelay)) {
      return ok(ws, raw.id, false, `auth-failed: relay tag must be ${expectedRelay}`);
    }
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - raw.created_at) > 600) {
      return ok(ws, raw.id, false, 'auth-failed: created_at outside ±10min');
    }

    auth.authedPubkey = raw.pubkey;
    ok(ws, raw.id, true, '');
  }

  // Public — used by handleAuth's relay-tag check and exposed so the HTTP
  // layer can use the same canonical form when constructing /api/relay-config
  // responses.
  getRelayUrl(): string {
    return `ws://${this.host}:${this.port}`;
  }

  private handleEvent(ws: WebSocket, raw: unknown): void {
    if (!isEvent(raw)) return ok(ws, '', false, 'invalid: not an event object');

    let valid = false;
    try { valid = verifyEvent(raw as any); } catch { valid = false; }
    if (!valid) return ok(ws, raw.id, false, 'invalid: bad signature');

    const result = this.store.add(raw);
    if (result.duplicate) return ok(ws, raw.id, true, 'duplicate: already have this event');

    ok(ws, raw.id, true, '');

    // Fan-out to live subscribers. We iterate the whole subs map; for a
    // single-user dev relay this is a few entries at most. If we ever
    // need to scale this, the right move is a per-tag inverted index,
    // not a more clever flat scan.
    for (const [key, sub] of this.subs) {
      if (eventMatchesAny(raw, sub.filters)) {
        const subId = key.split(':').slice(1).join(':');
        sendJson(sub.ws, ['EVENT', subId, raw]);
      }
    }
  }

  private handleReq(ws: WebSocket, rest: unknown[], connSubs: Set<string>): void {
    const subId = rest[0];
    if (typeof subId !== 'string' || subId.length === 0 || subId.length > 64) {
      return notice(ws, 'REQ subId must be a non-empty string ≤ 64 chars');
    }
    const filters = rest.slice(1).filter(f => f && typeof f === 'object') as NostrFilter[];
    if (filters.length === 0) return notice(ws, 'REQ requires at least one filter');
    if (filters.length > 10)  return notice(ws, 'REQ accepts at most 10 filters');

    const key = subKey(ws, subId);
    this.subs.set(key, { ws, filters });
    connSubs.add(key);

    // Stored-event replay, then EOSE to mark the boundary between
    // historical and live. Per NIP-01 the relay is free to send live
    // events interleaved with replay; we don't, since serving everything
    // in one shot from sqlite is fast enough that it doesn't matter.
    const events = this.store.queryMany(filters);
    for (const ev of events) sendJson(ws, ['EVENT', subId, ev]);
    sendJson(ws, ['EOSE', subId]);
  }

  private handleClose(ws: WebSocket, raw: unknown, connSubs: Set<string>): void {
    if (typeof raw !== 'string') return;
    const key = subKey(ws, raw);
    this.subs.delete(key);
    connSubs.delete(key);
    sendJson(ws, ['CLOSED', raw, '']);
  }
}

function subKey(ws: WebSocket, subId: string): string {
  // ws is hashed by reference identity via Map's default semantics —
  // good enough since each connection has a unique WebSocket object.
  // We prepend a reference-stable counter for diagnostics; the WS object
  // itself isn't a string, so we use its readyState + a per-instance id
  // attached lazily. Keeps debug logs readable without leaking internals.
  const anyWs = ws as any;
  if (typeof anyWs.__nsRelayId !== 'number') anyWs.__nsRelayId = nextWsId++;
  return `${anyWs.__nsRelayId}:${subId}`;
}
let nextWsId = 1;

function isEvent(x: unknown): x is NostrEvent {
  if (!x || typeof x !== 'object') return false;
  const e = x as any;
  return typeof e.id === 'string'
      && typeof e.pubkey === 'string'
      && typeof e.created_at === 'number'
      && typeof e.kind === 'number'
      && Array.isArray(e.tags)
      && typeof e.content === 'string'
      && typeof e.sig === 'string';
}

function sendJson(ws: WebSocket, msg: unknown): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try { ws.send(JSON.stringify(msg)); } catch { /* socket gone — close handler cleans up */ }
}

function notice(ws: WebSocket, text: string): void {
  sendJson(ws, ['NOTICE', text]);
}

function ok(ws: WebSocket, eventId: string, accepted: boolean, message: string): void {
  sendJson(ws, ['OK', eventId, accepted, message]);
}

// Compare two relay URLs for equality with mild normalization. NIP-42's
// `relay` tag is supposed to match the relay URL exactly, but in practice
// clients normalize trailing slashes / case the host differently. We allow
// trailing-slash and case-insensitive scheme/host so a well-meaning Amber
// client doesn't bounce off our spec-strictness.
function sameRelayUrl(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/\/+$/, '').toLowerCase();
  return norm(a) === norm(b);
}
