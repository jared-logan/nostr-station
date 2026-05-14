/**
 * Client route smoke tests.
 *
 * The route module reads the owner's npub from identity.json + queries
 * relays via nak; we don't need network coverage to verify the request/
 * response contract for the empty-state branches (no npub configured,
 * no read relays, malformed inputs). Those are the paths most likely
 * to regress after a refactor — they live entirely in route code without
 * touching the relay layer.
 *
 * Full feed + notifications behavior is intentionally NOT covered here:
 * those exercise queryRelays(...) which needs `nak` on PATH and a live
 * relay. Hook those into the manual smoke tested via the dashboard.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { useTempHome } from './_home.js';
useTempHome();

// @ts-expect-error — runtime import of .ts; tsx handles the resolution
const client = await import('../src/lib/routes/client.ts');

function fakeRes() {
  const chunks: string[] = [];
  let statusCode = 0;
  let headers: Record<string, string> = {};
  return {
    writeHead(code: number, hdrs: Record<string, string>) { statusCode = code; headers = hdrs; },
    end(body?: string) { if (body) chunks.push(body); },
    getBody(): any {
      const raw = chunks.join('');
      try { return JSON.parse(raw); } catch { return raw; }
    },
    getStatus(): number { return statusCode; },
    getHeaders(): Record<string, string> { return headers; },
  } as any;
}

function fakeReq(method: string, url: string, body?: any): any {
  // Minimal IncomingMessage stand-in. readBody (in _shared.ts) consumes
  // 'data' + 'end' events, so we replay the body via emit-like callbacks
  // gathered in a handlers map.
  const handlers: Record<string, Function[]> = { data: [], end: [], error: [] };
  const req: any = {
    method, url,
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
    on(name: string, cb: Function) { (handlers[name] ||= []).push(cb); return req; },
  };
  if (body !== undefined) {
    queueMicrotask(() => {
      const s = typeof body === 'string' ? body : JSON.stringify(body);
      for (const h of handlers.data) h(s);
      for (const h of handlers.end) h();
    });
  } else {
    queueMicrotask(() => { for (const h of handlers.end) h(); });
  }
  return req;
}

test('handleClient: returns false for non-/api/client/* paths', async () => {
  const res = fakeRes();
  const matched = await client.handleClient(fakeReq('GET', '/api/identity/config'), res, '/api/identity/config', 'GET');
  assert.equal(matched, false);
});

test('handleClient: /api/client/profile rejects malformed pubkey', async () => {
  const res = fakeRes();
  const matched = await client.handleClient(fakeReq('GET', '/api/client/profile?pubkey=nope'), res, '/api/client/profile?pubkey=nope', 'GET');
  assert.equal(matched, true);
  assert.equal(res.getStatus(), 400);
  assert.match(res.getBody().error, /invalid pubkey/);
});

test('handleClient: /api/client/notifications 400s when no owner configured', async () => {
  const res = fakeRes();
  const matched = await client.handleClient(fakeReq('GET', '/api/client/notifications'), res, '/api/client/notifications', 'GET');
  assert.equal(matched, true);
  assert.equal(res.getStatus(), 400);
  assert.match(res.getBody().error, /no station owner/);
});

test('handleClient: /api/client/publish 400s on empty content', async () => {
  const res = fakeRes();
  const matched = await client.handleClient(
    fakeReq('POST', '/api/client/publish', { content: '   ' }),
    res, '/api/client/publish', 'POST',
  );
  assert.equal(matched, true);
  // 400 either for "no station owner" (HOME has no identity.json) or
  // "content required" depending on order; the route checks owner first.
  // The test runs with useTempHome() so npub is empty → "no station owner".
  assert.equal(res.getStatus(), 400);
});

test('handleClient: /api/client/publish 400s on bad JSON', async () => {
  const res = fakeRes();
  const matched = await client.handleClient(
    fakeReq('POST', '/api/client/publish', '{not json'),
    res, '/api/client/publish', 'POST',
  );
  assert.equal(matched, true);
  assert.equal(res.getStatus(), 400);
  assert.match(res.getBody().error, /bad json/);
});

test('handleClient: /api/client/feed returns empty when no owner + no contacts', async () => {
  const res = fakeRes();
  const matched = await client.handleClient(fakeReq('GET', '/api/client/feed'), res, '/api/client/feed', 'GET');
  assert.equal(matched, true);
  // Either the no-read-relays branch or the no-contacts branch — both 200
  // with an `empty` reason. The test home has neither configured.
  assert.equal(res.getStatus(), 200);
  const body = res.getBody();
  assert.deepEqual(body.events, []);
  assert.ok(typeof body.empty === 'string' && body.empty.length > 0);
});

test('handleClient: /api/client/feed accepts authors override with hex filtering', async () => {
  const res = fakeRes();
  const goodHex = 'a'.repeat(64);
  const url = `/api/client/feed?authors=${goodHex},notahex,${goodHex.toUpperCase()}`;
  const matched = await client.handleClient(fakeReq('GET', url), res, url, 'GET');
  assert.equal(matched, true);
  // Test home has no read relays configured, so we hit the "no read relays"
  // branch — but the authors-parsing happened first via the explicit
  // override path. We can't directly inspect parsed authors from the
  // response, but the empty-state message confirms we routed through the
  // override (usingContacts: false).
  assert.equal(res.getStatus(), 200);
  const body = res.getBody();
  assert.equal(body.usingContacts, false);
});
