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
