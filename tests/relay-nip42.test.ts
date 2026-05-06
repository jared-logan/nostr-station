import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
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

function signNote(sk: Uint8Array): NostrEvent {
  return finalizeEvent({
    kind: 1, created_at: Math.floor(Date.now() / 1000),
    tags: [], content: 'hello',
  }, sk) as unknown as NostrEvent;
}

// Trigger an on-demand AUTH challenge by publishing as a non-whitelisted
// pubkey. Server replies with ["OK", id, false, "auth-required: ..."]
// followed by ["AUTH", challenge]. Returns the challenge string.
async function triggerAuthChallenge(c: TestClient, sk: Uint8Array): Promise<string> {
  const ev = signNote(sk);
  c.send(['EVENT', ev]);
  await c.next(m => m[0] === 'OK' && m[1] === ev.id);
  const auth = await c.next(m => m[0] === 'AUTH');
  return auth[1] as string;
}

test('nip42: no AUTH challenge is sent unprompted on connect', async () => {
  // Pre-fix the relay sent ["AUTH", challenge] immediately on every
  // connect. NIP-42-aware clients (notably fiatjaf/nak) interpreted
  // the unsolicited challenge as "AUTH is required first," tried to
  // auto-respond without a configured signer, and never got around to
  // publishing their EVENT. We send the challenge on demand instead.
  const port = TEST_PORT_BASE;
  const relay = new Relay({ port, dbPath: tmpFile('relay.db'), whitelistPath: tmpFile('wl.json') });
  await relay.start();

  const c = new TestClient(`ws://127.0.0.1:${port}`);
  await c.ready;
  await assert.rejects(
    c.next(m => m[0] === 'AUTH', 200),
    /timeout/,
    'expected NO AUTH frame within 200ms of connect',
  );

  await c.close();
  await relay.stop();
});

test('nip42: AUTH challenge is sent alongside an auth-required EVENT rejection', async () => {
  const port = TEST_PORT_BASE + 1;
  const relay = new Relay({ port, dbPath: tmpFile('relay.db'), whitelistPath: tmpFile('wl.json') });
  await relay.start();

  const sk = generateSecretKey();
  const c = new TestClient(`ws://127.0.0.1:${port}`);
  await c.ready;
  const ev = signNote(sk);
  c.send(['EVENT', ev]);
  // OK with auth-required: prefix.
  const okFrame = await c.next(m => m[0] === 'OK' && m[1] === ev.id);
  assert.equal(okFrame[2], false);
  assert.match(String(okFrame[3]), /^auth-required:/);
  // AUTH challenge follows so the client has something to sign with.
  const auth = await c.next(m => m[0] === 'AUTH');
  assert.match(String(auth[1]), /^[0-9a-f]{64}$/);

  await c.close();
  await relay.stop();
});

test('nip42: accepts a valid AUTH response', async () => {
  const port = TEST_PORT_BASE + 2;
  const relay = new Relay({ port, dbPath: tmpFile('relay.db'), whitelistPath: tmpFile('wl.json') });
  await relay.start();

  const sk = generateSecretKey();
  const c = new TestClient(`ws://127.0.0.1:${port}`);
  await c.ready;
  const challenge = await triggerAuthChallenge(c, sk);

  const authEv = signAuth(challenge, `ws://127.0.0.1:${port}`, sk);
  c.send(['AUTH', authEv]);
  const okFrame = await c.next(m => m[0] === 'OK' && m[1] === authEv.id);
  assert.equal(okFrame[2], true, 'AUTH should succeed for matching challenge + relay');

  await c.close();
  await relay.stop();
});

test('nip42: rejects AUTH with mismatched challenge', async () => {
  const port = TEST_PORT_BASE + 3;
  const relay = new Relay({ port, dbPath: tmpFile('relay.db'), whitelistPath: tmpFile('wl.json') });
  await relay.start();

  const sk = generateSecretKey();
  const c = new TestClient(`ws://127.0.0.1:${port}`);
  await c.ready;
  await triggerAuthChallenge(c, sk);

  const authEv = signAuth('f'.repeat(64), `ws://127.0.0.1:${port}`, sk);
  c.send(['AUTH', authEv]);
  const okFrame = await c.next(m => m[0] === 'OK' && m[1] === authEv.id);
  assert.equal(okFrame[2], false);
  assert.match(String(okFrame[3]), /challenge/);

  await c.close();
  await relay.stop();
});

test('nip42: rejects AUTH with wrong relay tag', async () => {
  const port = TEST_PORT_BASE + 4;
  const relay = new Relay({ port, dbPath: tmpFile('relay.db'), whitelistPath: tmpFile('wl.json') });
  await relay.start();

  const sk = generateSecretKey();
  const c = new TestClient(`ws://127.0.0.1:${port}`);
  await c.ready;
  const challenge = await triggerAuthChallenge(c, sk);

  const authEv = signAuth(challenge, `ws://wrong.example:7777`, sk);
  c.send(['AUTH', authEv]);
  const okFrame = await c.next(m => m[0] === 'OK' && m[1] === authEv.id);
  assert.equal(okFrame[2], false);
  assert.match(String(okFrame[3]), /relay tag/);

  await c.close();
  await relay.stop();
});

test('nip42: rejects AUTH with stale created_at (>10min skew)', async () => {
  const port = TEST_PORT_BASE + 5;
  const relay = new Relay({ port, dbPath: tmpFile('relay.db'), whitelistPath: tmpFile('wl.json') });
  await relay.start();

  const sk = generateSecretKey();
  const c = new TestClient(`ws://127.0.0.1:${port}`);
  await c.ready;
  const challenge = await triggerAuthChallenge(c, sk);

  const authEv = signAuth(challenge, `ws://127.0.0.1:${port}`, sk, { skewSec: -3600 });
  c.send(['AUTH', authEv]);
  const okFrame = await c.next(m => m[0] === 'OK' && m[1] === authEv.id);
  assert.equal(okFrame[2], false);
  assert.match(String(okFrame[3]), /created_at/);

  await c.close();
  await relay.stop();
});

test('nip42: rejects AUTH with wrong kind', async () => {
  const port = TEST_PORT_BASE + 6;
  const relay = new Relay({ port, dbPath: tmpFile('relay.db'), whitelistPath: tmpFile('wl.json') });
  await relay.start();

  const sk = generateSecretKey();
  const c = new TestClient(`ws://127.0.0.1:${port}`);
  await c.ready;
  const challenge = await triggerAuthChallenge(c, sk);

  // kind 1 instead of 22242
  const authEv = finalizeEvent({
    kind: 1, created_at: Math.floor(Date.now() / 1000),
    tags: [['challenge', challenge], ['relay', `ws://127.0.0.1:${port}`]],
    content: '',
  }, sk) as unknown as NostrEvent;
  c.send(['AUTH', authEv]);
  const okFrame = await c.next(m => m[0] === 'OK' && m[1] === authEv.id);
  assert.equal(okFrame[2], false);
  assert.match(String(okFrame[3]), /kind/);

  await c.close();
  await relay.stop();
});

test('nip42: NIP-11 advertises supported_nips:[1,11,42] and restricted_writes', async () => {
  const port = TEST_PORT_BASE + 7;
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
