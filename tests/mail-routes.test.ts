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
