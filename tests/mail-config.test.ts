/**
 * Tests for the PR 11 Mail Config additions:
 *   - identity.mailEnabled persistence + default
 *   - PUT /api/mail/enabled hot-toggle + persistence
 *   - PUT /api/mail/settings { readStateSync } accepted
 *   - GET /api/mail/status exposes `enabled` flag
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
const { readIdentity, setMailEnabled } = await import('../src/lib/identity.js');

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

function send(port: number, method: string, path: string, body?: any): Promise<{ status: number; body: string }> {
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

test('identity.mailEnabled defaults to true on a fresh install', () => {
  const id = readIdentity();
  assert.equal(id.mailEnabled, true, 'mail is on by default — opt-out, not opt-in');
});

test('setMailEnabled(false) persists across reads', () => {
  setMailEnabled(false);
  assert.equal(readIdentity().mailEnabled, false);
  setMailEnabled(true);
  assert.equal(readIdentity().mailEnabled, true);
});

test('GET /api/mail/status returns the enabled flag', async (t) => {
  const { server, port } = await bootOnRandomPort();
  t.after(() => new Promise<void>((r) => server.close(() => r())));

  const r = await get(port, '/api/mail/status');
  assert.equal(r.status, 200);
  const parsed = JSON.parse(r.body);
  assert.equal(typeof parsed.enabled, 'boolean');
  assert.equal(parsed.enabled, true, 'mailEnabled default propagates to /status');
});

test('PUT /api/mail/enabled persists the choice', async (t) => {
  const { server, port } = await bootOnRandomPort();
  t.after(() => new Promise<void>((r) => server.close(() => r())));

  // Disable.
  const off = await send(port, 'PUT', '/api/mail/enabled', { enabled: false });
  assert.equal(off.status, 200);
  const offParsed = JSON.parse(off.body);
  assert.equal(offParsed.ok, true);
  assert.equal(offParsed.enabled, false);
  assert.equal(readIdentity().mailEnabled, false);

  // Status reflects the new state.
  const status = await get(port, '/api/mail/status');
  assert.equal(JSON.parse(status.body).enabled, false);

  // Re-enable.
  const on = await send(port, 'PUT', '/api/mail/enabled', { enabled: true });
  assert.equal(on.status, 200);
  assert.equal(readIdentity().mailEnabled, true);
});

test('PUT /api/mail/settings accepts readStateSync', async (t) => {
  const { server, port } = await bootOnRandomPort();
  t.after(() => new Promise<void>((r) => server.close(() => r())));

  // Disable read-state sync.
  const r = await send(port, 'PUT', '/api/mail/settings', { readStateSync: false });
  assert.equal(r.status, 200);
  const parsed = JSON.parse(r.body);
  assert.equal(parsed.settings.readStateSync, false);

  // Read it back via GET — the cache persists immediately even when
  // publish fails (no bunker paired in tests).
  const g = await get(port, '/api/mail/settings');
  assert.equal(JSON.parse(g.body).settings.readStateSync, false);
});

test('PUT /api/mail/settings preserves other fields when toggling readStateSync', async (t) => {
  const { server, port } = await bootOnRandomPort();
  t.after(() => new Promise<void>((r) => server.close(() => r())));

  // Seed customFolders.
  await send(port, 'PUT', '/api/mail/settings', { customFolders: ['project-alpha'] });
  // Toggle the read-sync flag.
  await send(port, 'PUT', '/api/mail/settings', { readStateSync: false });
  // customFolders survived.
  const g = await get(port, '/api/mail/settings');
  const s = JSON.parse(g.body).settings;
  assert.deepEqual(s.customFolders, ['project-alpha']);
  assert.equal(s.readStateSync, false);
});
