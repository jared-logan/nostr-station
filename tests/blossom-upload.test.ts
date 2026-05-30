import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { generateSecretKey, getPublicKey, finalizeEvent, verifyEvent } from 'nostr-tools/pure';
import { useTempHome, resetTempHome } from './_home.js';

const HOME = useTempHome();

const {
  sha256Hex,
  buildUploadAuthTemplate,
  encodeAuthHeader,
  uploadBlobs,
  UPLOAD_AUTH_TTL_S,
  // @ts-expect-error — runtime import of .ts
} = await import('../src/lib/blossom-upload.ts');

beforeEach(() => resetTempHome(HOME));

// ── A throwaway BUD-02 Blossom server ──────────────────────────────────────
// Speaks the kind:24242 dialect (NOT the in-process server's NIP-98 27235).
// Validates: Authorization header decodes to a 24242 event, signature
// verifies, the body's sha appears in an `x` tag, and expiration is in the
// future. Stores accepted blobs in-memory so HEAD can report existence.

interface MockServer {
  url: string;
  store: Map<string, Buffer>;
  /** Per-method call counts keyed by `${method} ${shaOrUpload}`. */
  calls: { head: number; put: number };
  /** If set, every PUT responds with this status (to simulate a dead server). */
  failPutStatus?: number;
  close: () => Promise<void>;
}

function decodeAuth(header: string | undefined): any | null {
  if (!header) return null;
  const m = header.match(/^Nostr\s+([A-Za-z0-9+/=]+)$/i);
  if (!m) return null;
  try { return JSON.parse(Buffer.from(m[1], 'base64').toString('utf8')); }
  catch { return null; }
}

function authorizesSha(ev: any, sha: string): boolean {
  if (!ev || ev.kind !== 24242) return false;
  if (!verifyEvent(ev)) return false;
  const tags: string[][] = Array.isArray(ev.tags) ? ev.tags : [];
  const exp = tags.find(t => t[0] === 'expiration');
  if (!exp || Number(exp[1]) < Math.floor(Date.now() / 1000)) return false;
  return tags.some(t => t[0] === 'x' && (t[1] || '').toLowerCase() === sha.toLowerCase());
}

async function startMock(opts?: { failPutStatus?: number; preload?: Buffer[] }): Promise<MockServer> {
  const store = new Map<string, Buffer>();
  for (const b of opts?.preload || []) store.set(sha256Hex(b), b);
  const calls = { head: 0, put: 0 };

  const server = http.createServer((req, res) => {
    const path = (req.url || '/').replace(/^\//, '');

    if (req.method === 'HEAD') {
      calls.head++;
      res.writeHead(store.has(path) ? 200 : 404);
      res.end();
      return;
    }

    if (req.method === 'PUT' && path === 'upload') {
      calls.put++;
      const chunks: Buffer[] = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        if (mock.failPutStatus) { res.writeHead(mock.failPutStatus); res.end('forced failure'); return; }
        const body = Buffer.concat(chunks);
        const sha  = sha256Hex(body);
        const ev   = decodeAuth(req.headers['authorization'] as string | undefined);
        if (!authorizesSha(ev, sha)) { res.writeHead(401); res.end('bad auth'); return; }
        store.set(sha, body);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ sha256: sha, size: body.length, url: `${mock.url}/${sha}` }));
      });
      return;
    }

    res.writeHead(405); res.end();
  });

  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address() as any;
  const mock: MockServer = {
    url: `http://127.0.0.1:${addr.port}`,
    store, calls,
    failPutStatus: opts?.failPutStatus,
    close: () => new Promise<void>(r => server.close(() => r())),
  };
  return mock;
}

let servers: MockServer[] = [];
afterEach(async () => { await Promise.all(servers.map(s => s.close())); servers = []; });

// Sign a 24242 token authorizing the given blob hashes.
function signAuth(sk: Uint8Array, hashes: string[]): any {
  return finalizeEvent(buildUploadAuthTemplate(hashes) as any, sk);
}

function blob(text: string, mime = 'text/plain') {
  const bytes = Buffer.from(text, 'utf8');
  return { sha256: sha256Hex(bytes), bytes, mime, path: `/${text}.txt` };
}

// ── buildUploadAuthTemplate ─────────────────────────────────────────────────

test('buildUploadAuthTemplate: one x-tag per unique hash + t/expiration', () => {
  const a = 'aa'.repeat(32), b = 'bb'.repeat(32);
  const tpl = buildUploadAuthTemplate([a, b, a], { now: 1000 });
  assert.equal(tpl.kind, 24242);
  assert.equal(tpl.created_at, 1000);
  assert.equal(tpl.content, 'Upload blobs');
  const xs = tpl.tags.filter((t: string[]) => t[0] === 'x').map((t: string[]) => t[1]);
  assert.deepEqual(xs, [a, b]); // deduped, order-preserving
  assert.ok(tpl.tags.some((t: string[]) => t[0] === 't' && t[1] === 'upload'));
  const exp = tpl.tags.find((t: string[]) => t[0] === 'expiration');
  assert.equal(exp[1], String(1000 + UPLOAD_AUTH_TTL_S));
});

test('buildUploadAuthTemplate: drops malformed hashes, throws when none valid', () => {
  const good = 'cc'.repeat(32);
  const tpl = buildUploadAuthTemplate(['nope', good, '', 'AA']);
  const xs = tpl.tags.filter((t: string[]) => t[0] === 'x');
  assert.equal(xs.length, 1);
  assert.equal(xs[0][1], good);
  assert.throws(() => buildUploadAuthTemplate(['nope', 'also-bad']), /no valid sha256/);
});

test('buildUploadAuthTemplate: lowercases hashes', () => {
  const upper = 'AB'.repeat(32);
  const tpl = buildUploadAuthTemplate([upper]);
  assert.equal(tpl.tags.find((t: string[]) => t[0] === 'x')[1], upper.toLowerCase());
});

test('encodeAuthHeader: round-trips through base64 JSON', () => {
  const sk = generateSecretKey();
  const ev = signAuth(sk, ['dd'.repeat(32)]);
  const header = encodeAuthHeader(ev);
  const back = decodeAuth(header);
  assert.equal(back.id, ev.id);
  assert.equal(back.pubkey, getPublicKey(sk));
});

// ── uploadBlobs end-to-end ──────────────────────────────────────────────────

test('uploadBlobs: PUTs to all servers and reports per-server ok', async () => {
  const sk = generateSecretKey();
  const s1 = await startMock(); const s2 = await startMock(); servers.push(s1, s2);
  const blobs = [blob('alpha'), blob('beta')];
  const auth  = signAuth(sk, blobs.map(b => b.sha256));

  const results = await uploadBlobs({ servers: [s1.url, s2.url], blobs, authEvent: auth });

  assert.equal(results.length, 2);
  for (const r of results) {
    assert.equal(r.ok, true);
    assert.equal(r.servers.length, 2);
    assert.ok(r.servers.every((o: any) => o.ok && !o.skipped));
  }
  // Bytes actually landed on both servers.
  for (const b of blobs) { assert.ok(s1.store.has(b.sha256)); assert.ok(s2.store.has(b.sha256)); }
});

test('uploadBlobs: HEAD-skips blobs already present (no PUT)', async () => {
  const sk = generateSecretKey();
  const existing = Buffer.from('alpha', 'utf8');
  const s1 = await startMock({ preload: [existing] }); servers.push(s1);
  const blobs = [blob('alpha')]; // same content → same sha → already on server
  const auth  = signAuth(sk, blobs.map(b => b.sha256));

  const results = await uploadBlobs({ servers: [s1.url], blobs, authEvent: auth });

  assert.equal(results[0].ok, true);
  assert.equal(results[0].servers[0].skipped, true);
  assert.equal(s1.calls.put, 0);   // never issued a PUT
  assert.equal(s1.calls.head, 1);  // HEAD probe only
});

test('uploadBlobs: blob ok when ≥1 server succeeds (partial failure tolerated)', async () => {
  const sk = generateSecretKey();
  const good = await startMock();
  const bad  = await startMock({ failPutStatus: 500 });
  servers.push(good, bad);
  const blobs = [blob('gamma')];
  const auth  = signAuth(sk, blobs.map(b => b.sha256));

  const results = await uploadBlobs({ servers: [good.url, bad.url], blobs, authEvent: auth });

  assert.equal(results[0].ok, true); // landed on `good`
  const goodOutcome = results[0].servers.find((o: any) => o.server === good.url);
  const badOutcome  = results[0].servers.find((o: any) => o.server === bad.url);
  assert.equal(goodOutcome.ok, true);
  assert.equal(badOutcome.ok, false);
  assert.equal(badOutcome.status, 500);
});

test('uploadBlobs: blob fails when every server rejects', async () => {
  const sk = generateSecretKey();
  const bad1 = await startMock({ failPutStatus: 500 });
  const bad2 = await startMock({ failPutStatus: 403 });
  servers.push(bad1, bad2);
  const blobs = [blob('delta')];
  const auth  = signAuth(sk, blobs.map(b => b.sha256));

  const results = await uploadBlobs({ servers: [bad1.url, bad2.url], blobs, authEvent: auth });
  assert.equal(results[0].ok, false);
  assert.ok(results[0].servers.every((o: any) => !o.ok));
});

test('uploadBlobs: server rejects auth that does not cover the blob hash', async () => {
  const sk = generateSecretKey();
  const s1 = await startMock(); servers.push(s1);
  const blobs = [blob('epsilon')];
  // Sign a token for a DIFFERENT hash — server's authorizesSha() must reject.
  const auth = signAuth(sk, ['ff'.repeat(32)]);

  const results = await uploadBlobs({ servers: [s1.url], blobs, authEvent: auth });
  assert.equal(results[0].ok, false);
  assert.equal(results[0].servers[0].status, 401);
});

test('uploadBlobs: fires onProgress once per blob with cumulative index', async () => {
  const sk = generateSecretKey();
  const s1 = await startMock(); servers.push(s1);
  const blobs = [blob('a'), blob('b'), blob('c')];
  const auth  = signAuth(sk, blobs.map(b => b.sha256));
  const seen: number[] = [];

  await uploadBlobs({
    servers: [s1.url], blobs, authEvent: auth, concurrency: 1,
    onProgress: (p) => { seen.push(p.index); assert.equal(p.total, 3); },
  });
  assert.deepEqual(seen, [1, 2, 3]);
});

test('uploadBlobs: throws when no servers configured', async () => {
  const sk = generateSecretKey();
  const blobs = [blob('z')];
  await assert.rejects(
    uploadBlobs({ servers: [], blobs, authEvent: signAuth(sk, blobs.map(b => b.sha256)) }),
    /no Blossom servers/,
  );
});

test('uploadBlobs: tolerates trailing slashes on server URLs', async () => {
  const sk = generateSecretKey();
  const s1 = await startMock(); servers.push(s1);
  const blobs = [blob('slash')];
  const auth  = signAuth(sk, blobs.map(b => b.sha256));

  const results = await uploadBlobs({ servers: [`${s1.url}/`], blobs, authEvent: auth });
  assert.equal(results[0].ok, true);
  assert.ok(s1.store.has(blobs[0].sha256));
});
