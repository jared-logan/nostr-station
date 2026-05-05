import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { Relay } from '../src/relay/index.ts';
import type { NostrEvent } from '../src/relay/types.ts';

// Random port per test file so parallel test runs don't collide.
const TEST_PORT = 17_000 + Math.floor(Math.random() * 1000);

function tmpDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-relay-'));
  return path.join(dir, 'relay.db');
}

// Tiny WS client that buffers messages until the caller asks for the
// next one matching `predicate`. The relay sends EVENT/EOSE/OK/CLOSED in
// orderings that depend on store state, so tests can't rely on a
// fixed sequence — they wait for the message they care about.
class TestClient {
  private ws: WebSocket;
  private buffer: any[][] = [];
  private waiters: Array<{ pred: (m: any[]) => boolean; resolve: (m: any[]) => void }> = [];
  ready: Promise<void>;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on('message', d => {
      const msg = JSON.parse(d.toString());
      // Try to satisfy a pending waiter first; otherwise buffer.
      const idx = this.waiters.findIndex(w => w.pred(msg));
      if (idx >= 0) {
        const [w] = this.waiters.splice(idx, 1);
        w.resolve(msg);
      } else {
        this.buffer.push(msg);
      }
    });
    this.ready = new Promise((res, rej) => {
      this.ws.once('open',  () => res());
      this.ws.once('error', rej);
    });
  }

  send(msg: any[]): void { this.ws.send(JSON.stringify(msg)); }

  // Wait up to `timeoutMs` for a message matching `pred`.
  next(pred: (m: any[]) => boolean, timeoutMs = 2000): Promise<any[]> {
    const idx = this.buffer.findIndex(pred);
    if (idx >= 0) return Promise.resolve(this.buffer.splice(idx, 1)[0]);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        const i = this.waiters.findIndex(w => w.pred === pred);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error(`timeout waiting for relay message matching predicate (buffer=${JSON.stringify(this.buffer)})`));
      }, timeoutMs);
      this.waiters.push({
        pred,
        resolve: (m) => { clearTimeout(t); resolve(m); },
      });
    });
  }

  close(): Promise<void> {
    return new Promise(resolve => {
      this.ws.once('close', () => resolve());
      this.ws.close();
    });
  }
}

function signNote(text: string, sk: Uint8Array): NostrEvent {
  return finalizeEvent({
    kind:       1,
    created_at: Math.floor(Date.now() / 1000),
    tags:       [],
    content:    text,
  }, sk) as unknown as NostrEvent;
}

test('relay: accepts a signed event and acks with OK true', async () => {
  const port = TEST_PORT;
  const relay = new Relay({ port, dbPath: tmpDb() });
  await relay.start();

  const sk = generateSecretKey();
  const ev = signNote('hello world', sk);

  const c = new TestClient(`ws://127.0.0.1:${port}`);
  await c.ready;
  c.send(['EVENT', ev]);
  const ok = await c.next(m => m[0] === 'OK' && m[1] === ev.id);
  assert.equal(ok[2], true, 'relay should accept a valid signed event');

  await c.close();
  await relay.stop();
});

test('relay: rejects events with bad signatures', async () => {
  const port = TEST_PORT + 1;
  const relay = new Relay({ port, dbPath: tmpDb() });
  await relay.start();

  const sk = generateSecretKey();
  const ev = signNote('hello', sk);
  // Tamper with content after signing — sig now invalid for the event id.
  const tampered = { ...ev, content: 'tampered' };

  const c = new TestClient(`ws://127.0.0.1:${port}`);
  await c.ready;
  c.send(['EVENT', tampered]);
  const ok = await c.next(m => m[0] === 'OK');
  assert.equal(ok[2], false);

  await c.close();
  await relay.stop();
});

test('relay: REQ replays stored events and ends with EOSE', async () => {
  const port = TEST_PORT + 2;
  const relay = new Relay({ port, dbPath: tmpDb() });
  await relay.start();

  const sk = generateSecretKey();
  const e1 = signNote('first',  sk);
  const e2 = signNote('second', sk);

  const a = new TestClient(`ws://127.0.0.1:${port}`);
  await a.ready;
  a.send(['EVENT', e1]);
  a.send(['EVENT', e2]);
  await a.next(m => m[0] === 'OK' && m[1] === e1.id);
  await a.next(m => m[0] === 'OK' && m[1] === e2.id);
  await a.close();

  // Fresh client subscribes — should get both events historically.
  const b = new TestClient(`ws://127.0.0.1:${port}`);
  await b.ready;
  const subId = 'sub-1';
  b.send(['REQ', subId, { authors: [getPublicKey(sk)] }]);

  const got: string[] = [];
  for (let i = 0; i < 2; i++) {
    const msg = await b.next(m => m[0] === 'EVENT' && m[1] === subId);
    got.push((msg[2] as NostrEvent).content);
  }
  await b.next(m => m[0] === 'EOSE' && m[1] === subId);
  assert.deepEqual(got.sort(), ['first', 'second']);

  await b.close();
  await relay.stop();
});

test('relay: live fan-out delivers new events to active subscribers', async () => {
  const port = TEST_PORT + 3;
  const relay = new Relay({ port, dbPath: tmpDb() });
  await relay.start();

  const sk = generateSecretKey();

  const sub = new TestClient(`ws://127.0.0.1:${port}`);
  await sub.ready;
  const subId = 'live-1';
  sub.send(['REQ', subId, { kinds: [1] }]);
  await sub.next(m => m[0] === 'EOSE' && m[1] === subId);

  // Now publish from a separate connection and expect it to land on the
  // subscriber within the timeout.
  const pub = new TestClient(`ws://127.0.0.1:${port}`);
  await pub.ready;
  const ev = signNote('live-message', sk);
  pub.send(['EVENT', ev]);

  const live = await sub.next(m => m[0] === 'EVENT' && m[1] === subId);
  assert.equal((live[2] as NostrEvent).content, 'live-message');

  await pub.close();
  await sub.close();
  await relay.stop();
});

test('relay: CLOSE stops fan-out for that subscription', async () => {
  const port = TEST_PORT + 4;
  const relay = new Relay({ port, dbPath: tmpDb() });
  await relay.start();

  const sk = generateSecretKey();

  const sub = new TestClient(`ws://127.0.0.1:${port}`);
  await sub.ready;
  const subId = 'sub-x';
  sub.send(['REQ', subId, { kinds: [1] }]);
  await sub.next(m => m[0] === 'EOSE' && m[1] === subId);

  sub.send(['CLOSE', subId]);
  await sub.next(m => m[0] === 'CLOSED' && m[1] === subId);

  // Publish; subscriber must NOT receive an EVENT for this sub.
  const pub = new TestClient(`ws://127.0.0.1:${port}`);
  await pub.ready;
  pub.send(['EVENT', signNote('after-close', sk)]);

  // Wait briefly and assert no EVENT for our sub arrived.
  await new Promise(r => setTimeout(r, 200));
  await assert.rejects(
    sub.next(m => m[0] === 'EVENT' && m[1] === subId, 100),
    /timeout/,
  );

  await pub.close();
  await sub.close();
  await relay.stop();
});

test('relay: GET / returns NIP-11 metadata', async () => {
  const port = TEST_PORT + 5;
  const relay = new Relay({ port, dbPath: tmpDb() });
  await relay.start();

  const res  = await fetch(`http://127.0.0.1:${port}/`);
  const body = await res.json();
  assert.equal(res.headers.get('content-type'), 'application/nostr+json');
  assert.equal(body.software, 'nostr-station');
  assert.ok(Array.isArray(body.supported_nips));
  assert.ok(body.supported_nips.includes(1));

  await relay.stop();
});
