/**
 * Identity-routes relay-sync smoke test.
 *
 * `POST /api/identity/relays/sync` performs the NIP-65 outbox sync of the
 * owner's read relays — replaces the pre-#311 `/api/client/sync-relays`
 * endpoint, kept alive through the embedded-client removal because it
 * mutates `identity.readRelays`, not any client surface.
 *
 * Full relay-query behavior isn't covered here: it exercises queryRelays
 * against a live network. The empty-state branch (no station owner
 * configured) lives entirely in route code and is the most likely
 * regression after a refactor, so that's what this guards.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { useTempHome } from './_home.js';
useTempHome();

// @ts-expect-error — runtime import of .ts; tsx handles the resolution
const identity = await import('../src/lib/routes/identity.ts');

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

test('handleIdentity: /api/identity/relays/sync 400s without owner', async () => {
  const res = fakeRes();
  const matched = await identity.handleIdentity(
    fakeReq('POST', '/api/identity/relays/sync', {}),
    res, '/api/identity/relays/sync', 'POST',
  );
  assert.equal(matched, true);
  assert.equal(res.getStatus(), 400);
  assert.match(res.getBody().error, /no station owner/);
});
