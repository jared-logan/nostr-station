/**
 * Smoke tests for the mail HTTP surface.
 *
 * Boots the dashboard server on a random port, then verifies the four
 * read-only routes registered in this PR respond with the expected
 * shapes. Disabled side effects: in-process relay, nvpn tailer, and
 * the mail inbox worker (we want the routes only, not a real Amber
 * round trip).
 */

import { useTempHome } from './_home.js';
useTempHome();
process.env.STATION_INPROC_RELAY      = '0';
process.env.STATION_DISABLE_NVPN_TAIL = '1';
process.env.STATION_DISABLE_MAIL      = '1';

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { Server } from 'node:http';

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

function get(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'GET',
        headers: { host: `127.0.0.1:${port}` } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', c => chunks.push(c));
        res.on('end',  () => resolve({
          status: res.statusCode ?? 0,
          body:   Buffer.concat(chunks).toString('utf8'),
        }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

// Same wrapper but issues a request body + sets Origin so the CSRF guard
// lets the mutation through to the handler.
function send(port: number, method: string, path: string, body: any): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = body == null ? '' : JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port, path, method,
        headers: {
          host: `127.0.0.1:${port}`,
          'content-type': 'application/json',
          'origin': `http://127.0.0.1:${port}`,
          'content-length': Buffer.byteLength(payload).toString(),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', c => chunks.push(c));
        res.on('end',  () => resolve({
          status: res.statusCode ?? 0,
          body:   Buffer.concat(chunks).toString('utf8'),
        }));
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('mail-routes: /api/mail/inbox returns an empty thread list initially', async (t) => {
  const { server, port } = await bootOnRandomPort();
  t.after(() => new Promise<void>((r) => server.close(() => r())));

  const r = await get(port, '/api/mail/inbox');
  assert.equal(r.status, 200);
  const parsed = JSON.parse(r.body);
  assert.ok(Array.isArray(parsed.threads), 'response carries a threads array');
  assert.equal(parsed.threads.length, 0, 'no mail yet on a fresh install');
});

test('mail-routes: /api/mail/thread rejects a bad counterparty', async (t) => {
  const { server, port } = await bootOnRandomPort();
  t.after(() => new Promise<void>((r) => server.close(() => r())));

  const r = await get(port, '/api/mail/thread?counterparty=not-hex');
  assert.equal(r.status, 400);
  assert.match(r.body, /64-char hex/);
});

test('mail-routes: /api/mail/thread accepts valid hex and returns empty list', async (t) => {
  const { server, port } = await bootOnRandomPort();
  t.after(() => new Promise<void>((r) => server.close(() => r())));

  const hex = 'a'.repeat(64);
  const r = await get(port, `/api/mail/thread?counterparty=${hex}`);
  assert.equal(r.status, 200);
  const parsed = JSON.parse(r.body);
  assert.equal(parsed.counterparty, hex);
  assert.ok(Array.isArray(parsed.messages));
  assert.equal(parsed.messages.length, 0);
});

test('mail-routes: /api/mail/status returns inbox worker stats', async (t) => {
  const { server, port } = await bootOnRandomPort();
  t.after(() => new Promise<void>((r) => server.close(() => r())));

  const r = await get(port, '/api/mail/status');
  assert.equal(r.status, 200);
  const parsed = JSON.parse(r.body);
  assert.equal(typeof parsed.stats, 'object');
  assert.equal(typeof parsed.stats.relaysConnected, 'number');
  assert.equal(typeof parsed.stats.eventsSeen,      'number');
});

test('mail-routes: GET /api/mail/inbox-relays returns defaults', async (t) => {
  const { server, port } = await bootOnRandomPort();
  t.after(() => new Promise<void>((r) => server.close(() => r())));

  const r = await get(port, '/api/mail/inbox-relays');
  assert.equal(r.status, 200);
  const parsed = JSON.parse(r.body);
  assert.ok(Array.isArray(parsed.relays));
  assert.ok(parsed.relays.length > 0, 'fresh install ships with default inbox relays');
  assert.ok(Array.isArray(parsed.defaults));
});

test('mail-routes: PUT /api/mail/inbox-relays validates entries', async (t) => {
  const { server, port } = await bootOnRandomPort();
  t.after(() => new Promise<void>((r) => server.close(() => r())));

  const bad = await send(port, 'PUT', '/api/mail/inbox-relays',
    { relays: ['http://insecure.example'], publish: false });
  assert.equal(bad.status, 400);
  assert.match(bad.body, /invalid relay url/);

  const empty = await send(port, 'PUT', '/api/mail/inbox-relays',
    { relays: [], publish: false });
  assert.equal(empty.status, 400);
  assert.match(empty.body, /at least one/);
});

test('mail-routes: /api/mail/attachment returns 409 when Blossom is off', async (t) => {
  const { server, port } = await bootOnRandomPort();
  t.after(() => new Promise<void>((r) => server.close(() => r())));

  // Blossom is disabled by default; the route should return a friendly
  // 409 with a hint to enable it in Config → Blossom.
  const r = await send(port, 'POST', '/api/mail/attachment?mime=text/plain', 'hello');
  assert.equal(r.status, 409);
  assert.match(r.body, /Blossom is not running/);
});

test('mail-routes: PUT /api/mail/inbox-relays saves a valid list', async (t) => {
  const { server, port } = await bootOnRandomPort();
  t.after(() => new Promise<void>((r) => server.close(() => r())));

  const want = ['wss://relay.example.test', 'wss://another.example.test'];
  // publish:false to avoid the kind 10050 broadcast attempt (no bunker is paired in tests).
  const r = await send(port, 'PUT', '/api/mail/inbox-relays', { relays: want, publish: false });
  assert.equal(r.status, 200);
  const saved = JSON.parse(r.body);
  assert.deepEqual(saved.relays, want);

  // Re-read to confirm persistence.
  const after = await get(port, '/api/mail/inbox-relays');
  const afterParsed = JSON.parse(after.body);
  assert.deepEqual(afterParsed.relays, want);
});
