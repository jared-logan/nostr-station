import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { useTempHome, resetTempHome } from './_home.js';

const HOME = useTempHome();

// @ts-expect-error — runtime import
const { BlobStore } = await import('../src/blossom/store.ts');
// @ts-expect-error
const { BlossomServer } = await import('../src/blossom/index.ts');
// @ts-expect-error
const { verifyBlossomAuth, parseAuthHeader } = await import('../src/blossom/auth.ts');

beforeEach(() => resetTempHome(HOME));

function dataDir(): string {
  return path.join(HOME, '.nostr-station', 'data', 'blobs');
}

// Build a signed NIP-98 auth event for a given (url, method, sha?) tuple.
function makeAuthEvent(sk: Uint8Array, url: string, method: string, sha?: string): any {
  const tags: string[][] = [['u', url], ['method', method]];
  if (sha) tags.push(['x', sha]);
  return finalizeEvent({
    kind: 27235,
    created_at: Math.floor(Date.now() / 1000),
    tags, content: '',
  }, sk);
}

function authHeader(ev: any): string {
  return `Nostr ${Buffer.from(JSON.stringify(ev), 'utf8').toString('base64')}`;
}

// ── BlobStore ─────────────────────────────────────────────────────────────

test('BlobStore: put + get round-trip', () => {
  const store = new BlobStore({ dataDir: dataDir() });
  const body  = Buffer.from('hello world', 'utf8');
  const sha   = crypto.createHash('sha256').update(body).digest('hex');
  const r = store.put(body, 'text/plain', 'a'.repeat(64), 'owner');
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.record.sha256, sha);
    assert.equal(r.record.size,   body.length);
    assert.equal(r.record.uploaderKind, 'owner');
  }
  const back = store.get(sha);
  assert.ok(back);
  assert.equal(back!.mime, 'text/plain');
  assert.equal(fs.existsSync(store.blobPath(sha)), true);
  store.close();
});

test('BlobStore: quota refusal', () => {
  const store = new BlobStore({ dataDir: dataDir(), quotaBytes: 10 });
  const r = store.put(Buffer.alloc(20), 'application/octet-stream', 'a'.repeat(64), 'owner');
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'quota-exceeded');
  store.close();
});

test('BlobStore: delete removes row + file', () => {
  const store = new BlobStore({ dataDir: dataDir() });
  const body = Buffer.from('bye');
  const sha = crypto.createHash('sha256').update(body).digest('hex');
  store.put(body, 'text/plain', 'a'.repeat(64), 'owner');
  assert.ok(store.get(sha));
  assert.equal(store.delete(sha), true);
  assert.equal(store.get(sha), null);
  assert.equal(fs.existsSync(store.blobPath(sha)), false);
  store.close();
});

test('BlobStore: wipe nukes everything', () => {
  const store = new BlobStore({ dataDir: dataDir() });
  store.put(Buffer.from('a'), 'text/plain', 'a'.repeat(64), 'owner');
  store.put(Buffer.from('b'), 'text/plain', 'a'.repeat(64), 'owner');
  assert.equal(store.stats().blobCount, 2);
  store.wipe();
  assert.equal(store.stats().blobCount, 0);
  store.close();
});

// ── NIP-98 auth ───────────────────────────────────────────────────────────

test('verifyBlossomAuth: accepts a well-formed event', () => {
  const sk = generateSecretKey();
  const url = 'http://127.0.0.1:8081/upload';
  const ev = makeAuthEvent(sk, url, 'PUT');
  const r = verifyBlossomAuth({ event: ev, method: 'PUT', expectedUrl: url });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.pubkey, getPublicKey(sk));
});

test('verifyBlossomAuth: rejects wrong-url events', () => {
  const sk = generateSecretKey();
  const ev = makeAuthEvent(sk, 'http://127.0.0.1:8081/upload', 'PUT');
  const r = verifyBlossomAuth({
    event: ev, method: 'PUT',
    expectedUrl: 'http://127.0.0.1:8081/other',
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /u-tag/);
});

test('verifyBlossomAuth: rejects expired events outside the 5-min window', () => {
  const sk = generateSecretKey();
  const url = 'http://127.0.0.1:8081/upload';
  const stale = finalizeEvent({
    kind: 27235,
    created_at: Math.floor(Date.now() / 1000) - (6 * 60),
    tags: [['u', url], ['method', 'PUT']],
    content: '',
  }, sk);
  const r = verifyBlossomAuth({ event: stale, method: 'PUT', expectedUrl: url });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /window/);
});

test('verifyBlossomAuth: rejects sha-mismatch when expectedSha is set', () => {
  const sk = generateSecretKey();
  const url = 'http://127.0.0.1:8081/upload';
  const ev = makeAuthEvent(sk, url, 'PUT', 'aa'.repeat(32));
  const r = verifyBlossomAuth({
    event: ev, method: 'PUT', expectedUrl: url,
    expectedSha: 'bb'.repeat(32),
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /x-tag/);
});

test('parseAuthHeader: rejects malformed headers', () => {
  assert.equal(parseAuthHeader(undefined), null);
  assert.equal(parseAuthHeader('Bearer 1234'), null);
  assert.equal(parseAuthHeader('Nostr not-base64'), null);
});

// ── BlossomServer end-to-end ──────────────────────────────────────────────

test('BlossomServer: PUT /upload → GET <sha> round-trip', async () => {
  const sk = generateSecretKey();
  const ownerHex = getPublicKey(sk);
  const port = 18180 + Math.floor(Math.random() * 100);
  const server = new BlossomServer({
    port, host: '127.0.0.1',
    dataDir: dataDir(),
    predicates: {
      isOwner:        (h: string) => h === ownerHex,
      isWhitelisted:  () => false,
      isTestIdentity: () => false,
    },
  });
  await server.start();
  try {
    const body = Buffer.from('blossom blob bytes', 'utf8');
    const sha  = crypto.createHash('sha256').update(body).digest('hex');
    const url  = `http://127.0.0.1:${port}/upload`;
    const ev   = makeAuthEvent(sk, url, 'PUT', sha);
    const putRes = await fetch(url, {
      method: 'PUT',
      headers: {
        Authorization: authHeader(ev),
        'Content-Type': 'text/plain',
        'X-Content-Sha256': sha,
      },
      body,
    });
    assert.equal(putRes.status, 201);
    const j = await putRes.json() as any;
    assert.equal(j.sha256, sha);

    const getRes = await fetch(`http://127.0.0.1:${port}/${sha}`);
    assert.equal(getRes.status, 200);
    assert.equal(getRes.headers.get('content-type'), 'text/plain');
    assert.equal(getRes.headers.get('x-content-sha256'), sha);
    const got = Buffer.from(await getRes.arrayBuffer());
    assert.equal(got.toString('utf8'), body.toString('utf8'));
  } finally {
    await server.stop();
  }
});

test('BlossomServer: PUT without auth fails 401/400', async () => {
  const port = 18280 + Math.floor(Math.random() * 100);
  const server = new BlossomServer({
    port, host: '127.0.0.1',
    dataDir: dataDir(),
    predicates: {
      isOwner: () => false, isWhitelisted: () => false, isTestIdentity: () => false,
    },
  });
  await server.start();
  try {
    const r = await fetch(`http://127.0.0.1:${port}/upload`, {
      method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: 'no auth',
    });
    assert.ok(r.status === 401 || r.status === 400, `expected 4xx, got ${r.status}`);
  } finally {
    await server.stop();
  }
});

test('BlossomServer: PUT from unrecognized pubkey is rejected 403', async () => {
  const sk = generateSecretKey();
  const port = 18380 + Math.floor(Math.random() * 100);
  const server = new BlossomServer({
    port, host: '127.0.0.1',
    dataDir: dataDir(),
    predicates: {
      isOwner: () => false, isWhitelisted: () => false, isTestIdentity: () => false,
    },
  });
  await server.start();
  try {
    const body = Buffer.from('x');
    const sha  = crypto.createHash('sha256').update(body).digest('hex');
    const url  = `http://127.0.0.1:${port}/upload`;
    const ev   = makeAuthEvent(sk, url, 'PUT', sha);
    const r = await fetch(url, {
      method: 'PUT',
      headers: { Authorization: authHeader(ev), 'Content-Type': 'text/plain', 'X-Content-Sha256': sha },
      body,
    });
    assert.equal(r.status, 403);
  } finally {
    await server.stop();
  }
});

test('BlossomServer: OPTIONS echoes loopback Origin (refuses cross-origin)', async () => {
  const port = 18480 + Math.floor(Math.random() * 100);
  const server = new BlossomServer({
    port, host: '127.0.0.1',
    dataDir: dataDir(),
    predicates: {
      isOwner: () => false, isWhitelisted: () => false, isTestIdentity: () => false,
    },
  });
  await server.start();
  try {
    // Loopback origin: ACAO is echoed back so a scaffolded app at
    // localhost:5173 can still fetch blobs.
    const okOrigin = `http://localhost:5173`;
    const ok = await fetch(`http://127.0.0.1:${port}/anything`, {
      method: 'OPTIONS', headers: { Origin: okOrigin },
    });
    assert.equal(ok.status, 204);
    assert.equal(ok.headers.get('access-control-allow-origin'), okOrigin);
    assert.equal(ok.headers.get('vary'), 'Origin');

    // Cross-origin attacker: no ACAO header in response → browser CORS
    // layer refuses to expose body to the page.
    const evil = await fetch(`http://127.0.0.1:${port}/anything`, {
      method: 'OPTIONS', headers: { Origin: 'http://evil.com' },
    });
    assert.equal(evil.status, 204);
    assert.equal(evil.headers.get('access-control-allow-origin'), null);

    // No-Origin (CLI client): no ACAO needed; CLI clients aren't
    // subject to SOP.
    const cli = await fetch(`http://127.0.0.1:${port}/anything`, { method: 'OPTIONS' });
    assert.equal(cli.status, 204);
    assert.equal(cli.headers.get('access-control-allow-origin'), null);
  } finally {
    await server.stop();
  }
});

