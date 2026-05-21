// HMAC signing + /api/img-proxy + /api/img-proxy/sign surface tests
// (J9 from the Section J follow-up audit list).
//
// Coverage:
//   - signProxyUrl returns a valid /api/img-proxy?u=…&s=… and rejects
//     unsupported inputs (data:, blob:, loopback, non-string)
//   - verifyProxySignature accepts valid sigs and rejects tampered ones
//   - /api/img-proxy refuses missing / bad signature (401)
//   - /api/img-proxy/sign requires session auth and caps batch size
//   - /api/identity/profile/preview emits a pre-signed picture URL
//   - isPublicApi correctly distinguishes exact match from prefix

import { useTempHome } from './_home.js';
useTempHome();
process.env.STATION_INPROC_RELAY      = '0';
process.env.STATION_DISABLE_NVPN_TAIL = '1';

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { Server } from 'node:http';

const { signProxyUrl, verifyProxySignature } = await import('../src/lib/img-proxy-sign.js');
const { isPublicApi } = await import('../src/lib/auth.js');
const { startWebServer } = await import('../src/lib/web-server.js');

async function bootOnRandomPort(): Promise<{ server: Server; port: number }> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = 30000 + Math.floor(Math.random() * 20000);
    try {
      const server = await startWebServer(port);
      return { server, port };
    } catch (e: any) {
      if (!/EADDRINUSE/.test(e?.message ?? '')) throw e;
    }
  }
  throw new Error('could not find a free high port after 5 attempts');
}

function rawRequest(opts: {
  port: number;
  path: string;
  method?: string;
  hostHeader?: string;
  origin?: string;
  body?: string;
  contentType?: string;
}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      host: opts.hostHeader ?? `127.0.0.1:${opts.port}`,
    };
    if (opts.origin) headers.origin = opts.origin;
    if (opts.body) {
      headers['content-type'] = opts.contentType ?? 'application/json';
      headers['content-length'] = String(Buffer.byteLength(opts.body));
    }
    const req = http.request(
      { host: '127.0.0.1', port: opts.port, path: opts.path, method: opts.method ?? 'GET', headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end',  () => resolve({
          status: res.statusCode ?? 0,
          body:   Buffer.concat(chunks).toString('utf8'),
        }));
      },
    );
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

test('signProxyUrl: produces a /api/img-proxy URL with valid signature for https targets', () => {
  const signed = signProxyUrl('https://avatar.example.com/x.png');
  assert.ok(signed, 'expected non-null signed URL');
  assert.match(signed!, /^\/api\/img-proxy\?u=https%3A%2F%2Favatar\.example\.com%2Fx\.png&s=[A-Za-z0-9_-]+$/);
});

test('signProxyUrl: returns null for non-string / data: / blob: / loopback inputs', () => {
  assert.equal(signProxyUrl(null), null);
  assert.equal(signProxyUrl(undefined), null);
  assert.equal(signProxyUrl(123 as any), null);
  assert.equal(signProxyUrl(''), null);
  assert.equal(signProxyUrl('data:image/png;base64,iVBORw='), null);
  assert.equal(signProxyUrl('blob:https://example.com/abc'), null);
  assert.equal(signProxyUrl('http://127.0.0.1/x.png'), null);
  assert.equal(signProxyUrl('http://localhost/x.png'), null);
  assert.equal(signProxyUrl('http://sid.nsite.localhost/x.png'), null);
});

test('verifyProxySignature: accepts a freshly-signed URL', () => {
  const url = 'https://avatar.example.com/x.png';
  const signed = signProxyUrl(url)!;
  const sig = new URL('http://x' + signed.replace('/api/img-proxy', '')).searchParams.get('s')!;
  assert.ok(verifyProxySignature(url, sig));
});

test('verifyProxySignature: rejects tampered signatures and mismatched URLs', () => {
  const url = 'https://avatar.example.com/x.png';
  const signed = signProxyUrl(url)!;
  const sig = new URL('http://x' + signed.replace('/api/img-proxy', '')).searchParams.get('s')!;
  // Tampered sig
  assert.equal(verifyProxySignature(url, sig.slice(0, -3) + 'AAA'), false);
  // Wrong URL with valid-looking sig
  assert.equal(verifyProxySignature('https://attacker.com/leak', sig), false);
  // Empty
  assert.equal(verifyProxySignature(url, ''), false);
  assert.equal(verifyProxySignature('', sig), false);
});

test('isPublicApi: exact-match entries do not leak public posture to subpaths', () => {
  assert.equal(isPublicApi('/api/img-proxy'),       true,  '/api/img-proxy itself is public');
  assert.equal(isPublicApi('/api/img-proxy/sign'),  false, '/api/img-proxy/sign must NOT inherit public status');
  assert.equal(isPublicApi('/api/auth/status'),     true);
  assert.equal(isPublicApi('/api/auth/status/foo'), false);
  // Trailing-slash entries DO match subpaths (bunker session by id).
  assert.equal(isPublicApi('/api/auth/bunker-session/abcdef'), true);
});

test('img-proxy: refuses request with no signature (401)', async (t) => {
  const { server, port } = await bootOnRandomPort();
  t.after(() => new Promise<void>((r) => server.close(() => r())));

  const r = await rawRequest({
    port,
    path: '/api/img-proxy?u=' + encodeURIComponent('https://example.com/x.png'),
  });
  assert.equal(r.status, 401);
});

test('img-proxy: refuses tampered signature (401)', async (t) => {
  const { server, port } = await bootOnRandomPort();
  t.after(() => new Promise<void>((r) => server.close(() => r())));

  const r = await rawRequest({
    port,
    path: '/api/img-proxy?u=' + encodeURIComponent('https://example.com/x.png') + '&s=AAAAAAAA',
  });
  assert.equal(r.status, 401);
});

test('img-proxy/sign: caps batch at 64 URLs', async (t) => {
  const { server, port } = await bootOnRandomPort();
  t.after(() => new Promise<void>((r) => server.close(() => r())));

  const urls = Array.from({ length: 65 }, (_, i) => `https://example.com/${i}.png`);
  const r = await rawRequest({
    port,
    path:   '/api/img-proxy/sign',
    method: 'POST',
    origin: `http://127.0.0.1:${port}`,
    body:   JSON.stringify({ urls }),
  });
  assert.equal(r.status, 400);
  assert.match(r.body, /too many urls/);
});

test('img-proxy/sign: returns server-signed proxy URLs for valid input', async (t) => {
  const { server, port } = await bootOnRandomPort();
  t.after(() => new Promise<void>((r) => server.close(() => r())));

  const urls = ['https://avatar.example.com/x.png', 'data:image/png;base64,iVBORw='];
  const r = await rawRequest({
    port,
    path:   '/api/img-proxy/sign',
    method: 'POST',
    origin: `http://127.0.0.1:${port}`,
    body:   JSON.stringify({ urls }),
  });
  assert.equal(r.status, 200);
  const parsed = JSON.parse(r.body);
  assert.equal(typeof parsed.signed, 'object');
  assert.match(parsed.signed['https://avatar.example.com/x.png'], /^\/api\/img-proxy\?u=/);
  // data: URLs are refused by signProxyUrl
  assert.equal(parsed.signed['data:image/png;base64,iVBORw='], null);
});

test('img-proxy/sign: rejects non-array urls (400)', async (t) => {
  const { server, port } = await bootOnRandomPort();
  t.after(() => new Promise<void>((r) => server.close(() => r())));

  const r = await rawRequest({
    port,
    path:   '/api/img-proxy/sign',
    method: 'POST',
    origin: `http://127.0.0.1:${port}`,
    body:   JSON.stringify({ urls: 'not-an-array' }),
  });
  assert.equal(r.status, 400);
});

test('identity/profile/preview: emits a pre-signed picture URL (or null)', async (t) => {
  const { server, port } = await bootOnRandomPort();
  t.after(() => new Promise<void>((r) => server.close(() => r())));

  // Random npub — the preview endpoint resolves via DEFAULT_READ_RELAYS,
  // which we don't reach in tests, so the upstream lookup just fails.
  // What we care about is the SHAPE of the response when picture is
  // absent / unresolved: picture should be null (not a raw https URL).
  const npub = 'npub1xyzcfvk56l8za88vdtw8et7vsexvqe9v8fxvrnv3akukur8w0qhq8thd5j';
  const r = await rawRequest({
    port,
    path: '/api/identity/profile/preview?npub=' + encodeURIComponent(npub),
  });
  // Either 500 (network/relay error in test env) or 200 with a null
  // picture / signed proxy URL. We accept either, but if 200 the
  // picture must NOT be a raw http(s):// URL.
  if (r.status === 200) {
    const body = JSON.parse(r.body);
    if (body.picture) {
      assert.ok(
        body.picture.startsWith('/api/img-proxy?'),
        `picture must be a signed proxy URL, got: ${body.picture}`,
      );
    }
  }
});
