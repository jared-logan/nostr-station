import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { Relay } from '../src/relay/index.ts';
import type { NostrEvent } from '../src/relay/types.ts';

// Distinct port range from the other relay test files.
const TEST_PORT_BASE = 19_000 + Math.floor(Math.random() * 500);

function tmpFile(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-gate-'));
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

function signNote(sk: Uint8Array, content = 'hello'): NostrEvent {
  return finalizeEvent({
    kind: 1, created_at: Math.floor(Date.now() / 1000),
    tags: [], content,
  }, sk) as unknown as NostrEvent;
}

test('gating: station owner is allowed to publish', async () => {
  const port    = TEST_PORT_BASE;
  const ownerSk = generateSecretKey();
  const relay = new Relay({
    port, dbPath: tmpFile('r.db'), whitelistPath: tmpFile('w.json'),
    getOwnerHex: () => getPublicKey(ownerSk),
  });
  await relay.start();

  const c = new TestClient(`ws://127.0.0.1:${port}`);
  await c.ready;
  const ev = signNote(ownerSk, 'from-owner');
  c.send(['EVENT', ev]);
  const ok = await c.next(m => m[0] === 'OK' && m[1] === ev.id);
  assert.equal(ok[2], true, 'owner publish should succeed');

  await c.close();
  await relay.stop();
});

test('gating: whitelisted pubkey is allowed to publish', async () => {
  const port = TEST_PORT_BASE + 1;
  const ownerSk = generateSecretKey();
  const guestSk = generateSecretKey();
  const guestHex = getPublicKey(guestSk);
  const relay = new Relay({
    port, dbPath: tmpFile('r.db'), whitelistPath: tmpFile('w.json'),
    getOwnerHex: () => getPublicKey(ownerSk),
  });
  await relay.start();
  relay.whitelist.add(guestHex);

  const c = new TestClient(`ws://127.0.0.1:${port}`);
  await c.ready;
  const ev = signNote(guestSk, 'from-guest');
  c.send(['EVENT', ev]);
  const ok = await c.next(m => m[0] === 'OK' && m[1] === ev.id);
  assert.equal(ok[2], true, 'whitelisted publish should succeed');

  await c.close();
  await relay.stop();
});

test('gating: non-owner non-whitelist gets auth-required prefix', async () => {
  const port    = TEST_PORT_BASE + 2;
  const ownerSk = generateSecretKey();
  const strangerSk = generateSecretKey();
  const relay = new Relay({
    port, dbPath: tmpFile('r.db'), whitelistPath: tmpFile('w.json'),
    getOwnerHex: () => getPublicKey(ownerSk),
  });
  await relay.start();

  const c = new TestClient(`ws://127.0.0.1:${port}`);
  await c.ready;
  const ev = signNote(strangerSk, 'from-stranger');
  c.send(['EVENT', ev]);
  const ok = await c.next(m => m[0] === 'OK' && m[1] === ev.id);
  assert.equal(ok[2], false, 'stranger publish should be rejected');
  assert.match(String(ok[3]), /^auth-required:/, 'reject message should use NIP-42 prefix');

  await c.close();
  await relay.stop();
});

test('gating: with no owner configured, only whitelist can publish', async () => {
  const port    = TEST_PORT_BASE + 3;
  const guestSk = generateSecretKey();
  const guestHex = getPublicKey(guestSk);
  const otherSk = generateSecretKey();
  const relay = new Relay({
    port, dbPath: tmpFile('r.db'), whitelistPath: tmpFile('w.json'),
    getOwnerHex: () => null,  // no owner — wizard mid-flight or fresh install
  });
  await relay.start();
  relay.whitelist.add(guestHex);

  const c = new TestClient(`ws://127.0.0.1:${port}`);
  await c.ready;

  const guestEv = signNote(guestSk, 'whitelisted');
  c.send(['EVENT', guestEv]);
  const okG = await c.next(m => m[0] === 'OK' && m[1] === guestEv.id);
  assert.equal(okG[2], true);

  const otherEv = signNote(otherSk, 'not whitelisted');
  c.send(['EVENT', otherEv]);
  const okO = await c.next(m => m[0] === 'OK' && m[1] === otherEv.id);
  assert.equal(okO[2], false);
  assert.match(String(okO[3]), /^auth-required:/);

  await c.close();
  await relay.stop();
});

test('gating: lock-down (no owner, empty whitelist) rejects everything', async () => {
  const port = TEST_PORT_BASE + 4;
  const sk   = generateSecretKey();
  const relay = new Relay({
    port, dbPath: tmpFile('r.db'), whitelistPath: tmpFile('w.json'),
    getOwnerHex: () => null,
  });
  await relay.start();

  const c = new TestClient(`ws://127.0.0.1:${port}`);
  await c.ready;
  const ev = signNote(sk);
  c.send(['EVENT', ev]);
  const ok = await c.next(m => m[0] === 'OK' && m[1] === ev.id);
  assert.equal(ok[2], false);

  await c.close();
  await relay.stop();
});

test('gating: bad signature still rejected with invalid: prefix (not auth-required)', async () => {
  const port    = TEST_PORT_BASE + 5;
  const ownerSk = generateSecretKey();
  const relay = new Relay({
    port, dbPath: tmpFile('r.db'), whitelistPath: tmpFile('w.json'),
    getOwnerHex: () => getPublicKey(ownerSk),
  });
  await relay.start();

  const c = new TestClient(`ws://127.0.0.1:${port}`);
  await c.ready;
  const ev = signNote(ownerSk, 'original');
  // Tamper after signing — gating should NOT be reached because the
  // signature check fires first.
  const tampered = { ...ev, content: 'tampered' };
  c.send(['EVENT', tampered]);
  const ok = await c.next(m => m[0] === 'OK');
  assert.equal(ok[2], false);
  assert.match(String(ok[3]), /^invalid:/, 'sig check runs before gating');

  await c.close();
  await relay.stop();
});

test('gating: REQ subscriptions remain open to anyone (read access not gated)', async () => {
  const port    = TEST_PORT_BASE + 6;
  const ownerSk = generateSecretKey();
  const relay = new Relay({
    port, dbPath: tmpFile('r.db'), whitelistPath: tmpFile('w.json'),
    getOwnerHex: () => getPublicKey(ownerSk),
  });
  await relay.start();

  // Owner publishes one event so there's something to read.
  const owner = new TestClient(`ws://127.0.0.1:${port}`);
  await owner.ready;
  const ev = signNote(ownerSk, 'public');
  owner.send(['EVENT', ev]);
  await owner.next(m => m[0] === 'OK' && m[1] === ev.id);
  await owner.close();

  // Stranger client subscribes — should still receive historical events.
  const stranger = new TestClient(`ws://127.0.0.1:${port}`);
  await stranger.ready;
  const subId = 'sub-public';
  stranger.send(['REQ', subId, { kinds: [1] }]);
  const got = await stranger.next(m => m[0] === 'EVENT' && m[1] === subId);
  assert.equal((got[2] as NostrEvent).content, 'public');
  await stranger.next(m => m[0] === 'EOSE' && m[1] === subId);

  await stranger.close();
  await relay.stop();
});
