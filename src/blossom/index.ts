/**
 * In-process Blossom server (BUD-01 + BUD-02).
 *
 * Loopback-bound HTTP. NIP-98 auth for writes; public reads (the
 * sha256-content-addressed URL is the capability — anyone who knows
 * the hash gets the bytes, matching the wider Blossom ecosystem).
 *
 * Routes:
 *   GET    /<sha256>      — stream blob bytes with stored mime
 *   HEAD   /<sha256>      — headers only
 *   PUT    /upload        — NIP-98 auth required; body is raw bytes
 *   DELETE /<sha256>      — NIP-98 auth required; owner OR uploader only
 *   OPTIONS *             — permissive CORS preflight
 *
 * Owner / whitelist / test-identity predicates are injected at start()
 * time so this module stays free of identity / whitelist / test-identity
 * imports (test-identities don't exist until Phase B).
 */

import http from 'http';
import { BlobStore } from './store.js';
import {
  verifyBlossomAuth, classifyUploader, parseAuthHeader,
} from './auth.js';
import type { UploaderKind } from './types.js';

export interface BlossomOptions {
  port:       number;
  host?:      string;
  dataDir?:   string;
  quotaBytes?: number;
  predicates: {
    isOwner:        (hex: string) => boolean;
    isWhitelisted:  (hex: string) => boolean;
    isTestIdentity: (hex: string) => boolean;
  };
  onLog?: (level: 'info' | 'warn' | 'error', text: string) => void;
}

const SHA256_RX = /^[0-9a-f]{64}$/i;

export class BlossomServer {
  private http:  http.Server | null = null;
  private port:  number;
  private host:  string;
  private store: BlobStore;
  private predicates: BlossomOptions['predicates'];
  private onLog: BlossomOptions['onLog'];

  constructor(opts: BlossomOptions) {
    this.port  = opts.port;
    this.host  = opts.host ?? '127.0.0.1';
    this.store = new BlobStore({ dataDir: opts.dataDir, quotaBytes: opts.quotaBytes });
    this.predicates = opts.predicates;
    this.onLog = opts.onLog;
  }

  get blobStore(): BlobStore { return this.store; }

  async start(): Promise<{ port: number; host: string }> {
    if (this.http) return { port: this.port, host: this.host };
    this.http = http.createServer((req, res) => this.handle(req, res).catch(err => {
      this.log('error', `unhandled: ${err?.message || err}`);
      try {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal' }));
      } catch {}
    }));
    await new Promise<void>((resolve, reject) => {
      this.http!.once('error', reject);
      this.http!.listen(this.port, this.host, () => resolve());
    });
    this.log('info', `blossom listening on http://${this.host}:${this.port}`);
    return { port: this.port, host: this.host };
  }

  async stop(): Promise<void> {
    if (!this.http) return;
    this.http.closeAllConnections?.();
    await new Promise<void>(resolve => this.http?.close(() => resolve()));
    this.http = null;
    this.store.close();
  }

  // ── Request handling ────────────────────────────────────────────────────

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // Refuse anything that isn't loopback even if a misconfigured proxy
    // tried to forward an external request. The server binds 127.0.0.1
    // by default; this is belt + suspenders.
    const remote = req.socket.remoteAddress || '';
    if (!isLoopbackAddr(remote)) {
      this.log('warn', `refused non-loopback ${req.method} from ${remote}`);
      res.writeHead(403); res.end('loopback only');
      return;
    }

    // Echo loopback Origin only — was 'Access-Control-Allow-Origin: *'.
    // Goal: a Vite/Next app on a different localhost port keeps full
    // read/write access (it sends Origin: http://localhost:5173 etc.);
    // a cross-origin browser tab from http://evil.com gets no ACAO
    // header back, so the browser's CORS layer refuses to expose the
    // response body to the page even though the byte transfer
    // completes on the wire. CLI clients (no Origin) don't receive
    // the header but also don't care — they're not subject to SOP.
    const reqOrigin = (req.headers.origin as string | undefined) || '';
    if (reqOrigin && isLoopbackOrigin(reqOrigin)) {
      res.setHeader('Access-Control-Allow-Origin', reqOrigin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Content-Sha256');
    res.setHeader('Access-Control-Expose-Headers', 'X-Content-Sha256');

    const method = (req.method || '').toUpperCase();
    if (method === 'OPTIONS') {
      res.writeHead(204); res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://${req.headers.host || `${this.host}:${this.port}`}`);
    const path = url.pathname;

    if (path === '/upload') {
      if (method !== 'PUT') {
        res.writeHead(405, { Allow: 'PUT' }); res.end('use PUT'); return;
      }
      return this.handleUpload(req, res, url);
    }

    // Otherwise the path must be `/<sha256>`.
    const sha = path.replace(/^\//, '');
    if (!SHA256_RX.test(sha)) {
      res.writeHead(404); res.end('not found'); return;
    }
    if (method === 'GET' || method === 'HEAD') {
      return this.handleGet(req, res, sha, method === 'HEAD');
    }
    if (method === 'DELETE') {
      return this.handleDelete(req, res, url, sha);
    }
    res.writeHead(405, { Allow: 'GET, HEAD, PUT, DELETE, OPTIONS' });
    res.end('method not allowed');
  }

  private async handleGet(_req: http.IncomingMessage, res: http.ServerResponse, sha: string, headOnly: boolean): Promise<void> {
    const rec = this.store.get(sha);
    if (!rec) { res.writeHead(404); res.end('not found'); return; }
    res.setHeader('Content-Type',       rec.mime || 'application/octet-stream');
    res.setHeader('Content-Length',     String(rec.size));
    res.setHeader('X-Content-Sha256',   rec.sha256);
    res.setHeader('Cache-Control',      'public, max-age=31536000, immutable');
    if (headOnly) { res.writeHead(200); res.end(); return; }
    res.writeHead(200);
    // For the in-process loopback case we send the whole file at once.
    // Apps can range-request via a future BUD if needed.
    try {
      const fs = await import('fs');
      const data = fs.readFileSync(this.store.blobPath(sha));
      res.end(data);
    } catch (e: any) {
      this.log('error', `failed to read ${sha}: ${e?.message || e}`);
      res.end();
    }
  }

  private async handleUpload(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    // Read the whole body into a buffer up front. Loopback-only +
    // 1 GiB quota cap (enforced on insert) keeps memory bounded.
    const body = await readBody(req);

    // NIP-98 auth event lives in the Authorization header.
    const ev = parseAuthHeader(req.headers['authorization'] as string | undefined);
    const verify = verifyBlossomAuth({
      event: ev,
      method: 'PUT',
      expectedUrl: `http://${this.host}:${this.port}${url.pathname}`,
      // x-tag binds the auth event to the body's sha. Optional from the
      // spec's POV; we require it when the client provides one in
      // X-Content-Sha256, so the auth event can't be replayed against a
      // different body.
      expectedSha: (req.headers['x-content-sha256'] as string | undefined) || null,
    });
    if (!verify.ok) {
      res.writeHead(verify.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: verify.error }));
      return;
    }

    const kind: UploaderKind | null = classifyUploader(verify.pubkey, this.predicates);
    if (!kind) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'uploader pubkey not recognized' }));
      return;
    }

    // Honor an optional X-Content-Sha256 by validating against the body
    // hash. The store recomputes anyway; this is just an early-failure
    // path for clients that want to confirm pre-upload.
    const claimed = (req.headers['x-content-sha256'] as string | undefined) || null;
    if (claimed) {
      const crypto = await import('crypto');
      const got = crypto.createHash('sha256').update(body).digest('hex');
      if (got.toLowerCase() !== claimed.toLowerCase()) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'sha mismatch', expected: claimed, got }));
        return;
      }
    }

    const mime = (req.headers['content-type'] as string | undefined) || 'application/octet-stream';
    const r = this.store.put(body, mime, verify.pubkey, kind);
    if (!r.ok) {
      const status = r.reason === 'quota-exceeded' ? 507 : 400;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: r.reason }));
      return;
    }
    this.log('info', `upload ${r.record.sha256.slice(0, 12)}… (${r.record.size} bytes, ${kind})`);
    const blobUrl = `http://${this.host}:${this.port}/${r.record.sha256}`;
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      sha256: r.record.sha256,
      size:   r.record.size,
      type:   r.record.mime,
      url:    blobUrl,
      uploaded: Math.floor(r.record.createdAt / 1000),
    }));
  }

  private async handleDelete(req: http.IncomingMessage, res: http.ServerResponse, url: URL, sha: string): Promise<void> {
    const rec = this.store.get(sha);
    if (!rec) { res.writeHead(404); res.end('not found'); return; }
    const ev = parseAuthHeader(req.headers['authorization'] as string | undefined);
    const verify = verifyBlossomAuth({
      event: ev,
      method: 'DELETE',
      expectedUrl: `http://${this.host}:${this.port}${url.pathname}`,
    });
    if (!verify.ok) {
      res.writeHead(verify.status); res.end(verify.error); return;
    }
    // Owner can delete anything; uploader can delete their own.
    const isOwner    = this.predicates.isOwner(verify.pubkey);
    const isUploader = verify.pubkey === rec.uploaderPubkey;
    if (!isOwner && !isUploader) {
      res.writeHead(403); res.end('not authorized to delete this blob'); return;
    }
    this.store.delete(sha);
    this.log('info', `delete ${sha.slice(0, 12)}…`);
    res.writeHead(204); res.end();
  }

  private log(level: 'info' | 'warn' | 'error', text: string): void {
    try { this.onLog?.(level, text); } catch {}
  }
}

function isLoopbackAddr(addr: string): boolean {
  if (!addr) return false;
  if (addr === '127.0.0.1') return true;
  if (addr === '::1')       return true;
  if (addr.startsWith('::ffff:127.')) return true;
  return false;
}

// Origin header validator. Mirrors src/relay/index.ts isLoopbackOrigin —
// declared locally so the blossom layer doesn't reach into lib/.
// Port wildcard intentional: scaffolded user apps run at arbitrary
// loopback ports (5173, 8080, …) and must still receive ACAO.
function isLoopbackOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return u.hostname === '127.0.0.1'
        || u.hostname === 'localhost'
        || u.hostname === '[::1]'
        || u.hostname === '::1';
  } catch { return false; }
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(typeof c === 'string' ? Buffer.from(c) : c));
    req.on('end',  () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
