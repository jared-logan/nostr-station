// End-to-end smoke for src/lib/web-server.ts.
//
// Boots the server in-process on a random high port and verifies:
//   1. the socket binds and a GET on a public endpoint returns 200 JSON,
//   2. the DNS-rebinding guard rejects requests with a non-loopback Host,
//   3. the CSRF guard rejects mutations with no Origin/Referer.
//
// In-process relay and nvpn log tailer are disabled via env so the test
// doesn't touch ports 7777 or the nvpn log file. A fresh HOME via
// useTempHome() isolates ~/.nostr-station state.

import { useTempHome } from './_home.js';
useTempHome();
process.env.STATION_INPROC_RELAY     = '0';
process.env.STATION_DISABLE_NVPN_TAIL = '1';

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { Server } from 'node:http';

const { startWebServer } = await import('../src/lib/web-server.js');

// Bind retry: most of the time the random port is free, but a busy CI
// host can collide. Bounded retry keeps the suite fast.
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

// http.request wrapper that lets us override Host (which Node's fetch /
// undici quietly rewrites to match the URL). Returns { status, body }.
function rawRequest(opts: {
  port: number;
  path: string;
  method?: string;
  hostHeader?: string;
  extraHeaders?: Record<string, string>;
  body?: string;
}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host:    '127.0.0.1',
        port:    opts.port,
        path:    opts.path,
        method:  opts.method ?? 'GET',
        headers: {
          host: opts.hostHeader ?? `127.0.0.1:${opts.port}`,
          ...(opts.extraHeaders ?? {}),
        },
      },
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

test('web-server: boots on a random port and serves /api/auth/status', async (t) => {
  const { server, port } = await bootOnRandomPort();
  t.after(() => new Promise<void>((r) => server.close(() => r())));

  const r = await rawRequest({ port, path: '/api/auth/status' });
  assert.equal(r.status, 200);
  const parsed = JSON.parse(r.body);
  assert.equal(typeof parsed, 'object', '/api/auth/status returns JSON');
});

test('web-server: rejects non-loopback Host header with 400', async (t) => {
  const { server, port } = await bootOnRandomPort();
  t.after(() => new Promise<void>((r) => server.close(() => r())));

  const r = await rawRequest({
    port,
    path:       '/api/auth/status',
    hostHeader: 'evil.example.com',
  });
  assert.equal(r.status, 400);
  assert.equal(r.body.trim(), 'bad host');
});

test('web-server: rejects mutations with no Origin or Referer with 403', async (t) => {
  const { server, port } = await bootOnRandomPort();
  t.after(() => new Promise<void>((r) => server.close(() => r())));

  // Pick an endpoint we KNOW exists as a POST handler so the request
  // makes it through routing — without Origin/Referer, the H2 CSRF
  // guard should short-circuit before the route runs.
  const r = await rawRequest({
    port,
    path:   '/api/auth/challenge',
    method: 'POST',
    body:   '{}',
    extraHeaders: { 'content-type': 'application/json' },
  });
  assert.equal(r.status, 403);
  assert.equal(r.body.trim(), 'bad origin');
});

test('web-server: /api/status returns the expected schema (cached path)', async (t) => {
  const { server, port } = await bootOnRandomPort();
  t.after(() => new Promise<void>((r) => server.close(() => r())));

  // Two back-to-back requests inside the 3s TTL should both return the
  // same payload. We don't assert timing (flaky) — only that the cache
  // doesn't corrupt the response shape.
  const a = await rawRequest({ port, path: '/api/status' });
  const b = await rawRequest({ port, path: '/api/status' });
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);

  const parsedA = JSON.parse(a.body);
  const parsedB = JSON.parse(b.body);
  assert.ok(Array.isArray(parsedA), '/api/status returns an array');
  assert.deepEqual(parsedA, parsedB, 'cache yields identical successive responses');

  // Schema: each row has the documented shape.
  for (const row of parsedA) {
    assert.equal(typeof row.id,    'string');
    assert.equal(typeof row.label, 'string');
    assert.equal(typeof row.value, 'string');
    assert.equal(typeof row.ok,    'boolean');
    assert.equal(typeof row.state, 'string');
    assert.equal(typeof row.kind,  'string');
  }
});

// ── Nsite per-origin subdomain dispatch ────────────────────────────────────
//
// *.nsite.localhost subdomains resolve to 127.0.0.1 client-side (RFC 6761)
// and reach our loopback socket the same as `localhost`. The dispatcher
// recognizes them as the per-nsite origin model from PR-B, routes them to
// the nsite content handler, and refuses any /api/* path on that host so
// a hostile nsite payload (rendered in a sibling browser context) can't
// probe the dashboard's private surface.

test('web-server: accepts <16hex>.nsite.localhost:<port> Host with 410 (unknown sid)', async (t) => {
  const { server, port } = await bootOnRandomPort();
  t.after(() => new Promise<void>((r) => server.close(() => r())));

  // Random sid that was never resolved → snapshot not in the cache →
  // 410 from serveContent. The point is the Host gate ACCEPTS this
  // hostname instead of returning the 400 "bad host" we'd get for
  // evil.example.com.
  const r = await rawRequest({
    port,
    path:       '/index.html',
    hostHeader: `aabbccddeeff0011.nsite.localhost:${port}`,
  });
  assert.equal(r.status, 410, 'unknown sid should fall through to serveContent and 410');
  assert.match(r.body, /session expired/);
});

test('web-server: refuses /api/* paths on nsite subdomains with 404', async (t) => {
  const { server, port } = await bootOnRandomPort();
  t.after(() => new Promise<void>((r) => server.close(() => r())));

  // Even if a hostile nsite payload tries to fetch the dashboard API
  // by way of its own origin (e.g. `fetch('/api/status')` from inside
  // the iframe), the dispatcher must 404 on the nsite subdomain. This
  // is belt-and-braces — the auth gate would refuse anyway, but the
  // 404 keeps the existence of the API surface invisible from the
  // iframe origin.
  const r = await rawRequest({
    port,
    path:       '/api/status',
    hostHeader: `00112233aabbccdd.nsite.localhost:${port}`,
  });
  assert.equal(r.status, 404);
  assert.match(r.body, /not exposed on nsite subdomain/);
});

test('web-server: nsite host with malformed sid (not 16 hex) → bad host', async (t) => {
  const { server, port } = await bootOnRandomPort();
  t.after(() => new Promise<void>((r) => server.close(() => r())));

  // The regex only matches exactly 16 lowercase hex chars. Anything else
  // falls through to the regular allowedHosts gate → 400 "bad host".
  // Without this guard a DNS-rebinding attacker could pick a hostname
  // that LOOKS gateway-shaped but doesn't decode to a snapshot, and use
  // it as a probe vector. We just refuse.
  const r = await rawRequest({
    port,
    path:       '/index.html',
    hostHeader: `not-hex.nsite.localhost:${port}`,
  });
  assert.equal(r.status, 400);
  assert.match(r.body.trim(), /bad host/);
});

test('web-server: nsite host with wrong port → bad host', async (t) => {
  const { server, port } = await bootOnRandomPort();
  t.after(() => new Promise<void>((r) => server.close(() => r())));

  // Belt-and-braces: even if the hostname is shaped right, the port
  // must match the listening port. Otherwise a Host header forged
  // with the wrong port would bypass intent.
  const wrongPort = port === 1 ? 2 : port - 1;
  const r = await rawRequest({
    port,
    path:       '/index.html',
    hostHeader: `aabbccddeeff0011.nsite.localhost:${wrongPort}`,
  });
  assert.equal(r.status, 400);
  assert.match(r.body.trim(), /bad host/);
});
