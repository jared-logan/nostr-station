import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { generateSecretKey, finalizeEvent } from 'nostr-tools/pure';
import { Relay } from '../src/relay/index.ts';
import type { NostrEvent } from '../src/relay/types.ts';

// Distinct port range from relay-protocol.test.ts to avoid collisions
// when both files run in parallel.
const TEST_PORT_BASE = 18_000 + Math.floor(Math.random() * 500);

function tmpFile(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-nip42-'));
  return path.join(dir, name);
}

class TestClient {
  private ws: WebSocket;
  private buffer: any[][] = [];
  private waiters: Array<{ pred: (m: any[]) => boolean; resolve: (m: any[]) => void }> = [];
  ready: Promise<void>;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on('message', d => {
      const msg = JSON.parse(d.toString());
      const idx = this.waiters.findIndex(w => w.pred(msg));
      if (idx >= 0) { const [w] = this.waiters.splice(idx, 1); w.resolve(msg); }
      else { this.buffer.push(msg); }
    });
    this.ready = new Promise((res, rej) => {
      this.ws.once('open', () => res());
      this.ws.once('error', rej);
    });
  }
  send(msg: any[]): void { this.ws.send(JSON.stringify(msg)); }
  next(pred: (m: any[]) => boolean, timeoutMs = 2000): Promise<any[]> {
    const idx = this.buffer.findIndex(pred);
    if (idx >= 0) return Promise.resolve(this.buffer.splice(idx, 1)[0]);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout (buffer=${JSON.stringify(this.buffer)})`)), timeoutMs);
      this.waiters.push({ pred, resolve: m => { clearTimeout(t); resolve(m); } });
    });
  }
  close(): Promise<void> {
    return new Promise(resolve => { this.ws.once('close', () => resolve()); this.ws.close(); });
  }
}

function signAuth(challenge: string, relayUrl: string, sk: Uint8Array, opts: { skewSec?: number } = {}): NostrEvent {
  const skew = opts.skewSec ?? 0;
  return finalizeEvent({
    kind:       22242,
    created_at: Math.floor(Date.now() / 1000) + skew,
    tags:       [['challenge', challenge], ['relay', relayUrl]],
    content:    '',
  }, sk) as unknown as NostrEvent;
}

test('nip42: server sends AUTH challenge on connect', async () => {
  const port = TEST_PORT_BASE;
  const relay = new Relay({ port, dbPath: tmpFile('relay.db'), whitelistPath: tmpFile('wl.json') });
  await relay.start();

  const c = new TestClient(`ws://127.0.0.1:${port}`);
  await c.ready;
  const auth = await c.next(m => m[0] === 'AUTH');
  assert.equal(typeof auth[1], 'string');
  assert.match(auth[1], /^[0-9a-f]{64}$/, 'challenge should be 32-byte hex');

  await c.close();
  await relay.stop();
});

test('nip42: accepts a valid AUTH response', async () => {
  const port = TEST_PORT_BASE + 1;
  const relay = new Relay({ port, dbPath: tmpFile('relay.db'), whitelistPath: tmpFile('wl.json') });
  await relay.start();

  const sk = generateSecretKey();
  const c = new TestClient(`ws://127.0.0.1:${port}`);
  await c.ready;
  const challengeFrame = await c.next(m => m[0] === 'AUTH');
  const challenge = challengeFrame[1] as string;

  const ev = signAuth(challenge, `ws://127.0.0.1:${port}`, sk);
  c.send(['AUTH', ev]);
  const okFrame = await c.next(m => m[0] === 'OK' && m[1] === ev.id);
  assert.equal(okFrame[2], true, 'AUTH should succeed for matching challenge + relay');

  await c.close();
  await relay.stop();
});

test('nip42: rejects AUTH with mismatched challenge', async () => {
  const port = TEST_PORT_BASE + 2;
  const relay = new Relay({ port, dbPath: tmpFile('relay.db'), whitelistPath: tmpFile('wl.json') });
  await relay.start();

  const sk = generateSecretKey();
  const c = new TestClient(`ws://127.0.0.1:${port}`);
  await c.ready;
  await c.next(m => m[0] === 'AUTH');

  const ev = signAuth('f'.repeat(64), `ws://127.0.0.1:${port}`, sk);
  c.send(['AUTH', ev]);
  const okFrame = await c.next(m => m[0] === 'OK' && m[1] === ev.id);
  assert.equal(okFrame[2], false);
  assert.match(String(okFrame[3]), /challenge/);

  await c.close();
  await relay.stop();
});

test('nip42: rejects AUTH with wrong relay tag', async () => {
  const port = TEST_PORT_BASE + 3;
  const relay = new Relay({ port, dbPath: tmpFile('relay.db'), whitelistPath: tmpFile('wl.json') });
  await relay.start();

  const sk = generateSecretKey();
  const c = new TestClient(`ws://127.0.0.1:${port}`);
  await c.ready;
  const challengeFrame = await c.next(m => m[0] === 'AUTH');
  const challenge = challengeFrame[1] as string;

  const ev = signAuth(challenge, `ws://wrong.example:7777`, sk);
  c.send(['AUTH', ev]);
  const okFrame = await c.next(m => m[0] === 'OK' && m[1] === ev.id);
  assert.equal(okFrame[2], false);
  assert.match(String(okFrame[3]), /relay tag/);

  await c.close();
  await relay.stop();
});

test('nip42: rejects AUTH with stale created_at (>10min skew)', async () => {
  const port = TEST_PORT_BASE + 4;
  const relay = new Relay({ port, dbPath: tmpFile('relay.db'), whitelistPath: tmpFile('wl.json') });
  await relay.start();

  const sk = generateSecretKey();
  const c = new TestClient(`ws://127.0.0.1:${port}`);
  await c.ready;
  const challengeFrame = await c.next(m => m[0] === 'AUTH');
  const challenge = challengeFrame[1] as string;

  const ev = signAuth(challenge, `ws://127.0.0.1:${port}`, sk, { skewSec: -3600 });
  c.send(['AUTH', ev]);
  const okFrame = await c.next(m => m[0] === 'OK' && m[1] === ev.id);
  assert.equal(okFrame[2], false);
  assert.match(String(okFrame[3]), /created_at/);

  await c.close();
  await relay.stop();
});

test('nip42: rejects AUTH with wrong kind', async () => {
  const port = TEST_PORT_BASE + 5;
  const relay = new Relay({ port, dbPath: tmpFile('relay.db'), whitelistPath: tmpFile('wl.json') });
  await relay.start();

  const sk = generateSecretKey();
  const c = new TestClient(`ws://127.0.0.1:${port}`);
  await c.ready;
  const challengeFrame = await c.next(m => m[0] === 'AUTH');
  const challenge = challengeFrame[1] as string;

  // kind 1 instead of 22242
  const ev = finalizeEvent({
    kind: 1, created_at: Math.floor(Date.now() / 1000),
    tags: [['challenge', challenge], ['relay', `ws://127.0.0.1:${port}`]],
    content: '',
  }, sk) as unknown as NostrEvent;
  c.send(['AUTH', ev]);
  const okFrame = await c.next(m => m[0] === 'OK' && m[1] === ev.id);
  assert.equal(okFrame[2], false);
  assert.match(String(okFrame[3]), /kind/);

  await c.close();
  await relay.stop();
});

test('nip42: NIP-11 advertises supported_nips:[1,11,42] and restricted_writes', async () => {
  const port = TEST_PORT_BASE + 6;
  const relay = new Relay({ port, dbPath: tmpFile('relay.db'), whitelistPath: tmpFile('wl.json') });
  await relay.start();

  const res = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(res.status, 200);
  const doc = await res.json() as any;
  assert.deepEqual(doc.supported_nips, [1, 11, 42]);
  assert.equal(doc.limitation.restricted_writes, true);
  assert.equal(doc.limitation.auth_required, false);

  await relay.stop();
});
