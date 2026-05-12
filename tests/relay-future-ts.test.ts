// Future-timestamp ceiling on the in-process relay.
//
// Contract: events whose created_at is more than
// FUTURE_CREATED_AT_SLACK_SEC (15 min) ahead of wall-clock are rejected
// with `invalid:`. Past timestamps are accepted (backfilled imports are
// a first-class use case).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { Relay } from '../src/relay/index.ts';
import type { NostrEvent } from '../src/relay/types.ts';

const TEST_PORT_BASE = 21_500 + Math.floor(Math.random() * 500);

function tmpFile(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-future-ts-'));
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

function signAt(sk: Uint8Array, createdAt: number): NostrEvent {
  return finalizeEvent({
    kind: 1, created_at: createdAt, tags: [], content: 'ts-probe',
  }, sk) as unknown as NostrEvent;
}

test('future-ts: event with created_at == now is accepted', async () => {
  const port    = TEST_PORT_BASE;
  const ownerSk = generateSecretKey();
  const relay = new Relay({
    port, dbPath: tmpFile('r.db'), whitelistPath: tmpFile('w.json'),
    getOwnerHex: () => getPublicKey(ownerSk),
  });
  await relay.start();

  const c = new TestClient(`ws://127.0.0.1:${port}`);
  await c.ready;
  const ev = signAt(ownerSk, Math.floor(Date.now() / 1000));
  c.send(['EVENT', ev]);
  const ok = await c.next(m => m[0] === 'OK' && m[1] === ev.id);
  assert.equal(ok[2], true, 'now is accepted');

  await c.close();
  await relay.stop();
});

test('future-ts: event 14 minutes in future is still accepted', async () => {
  const port    = TEST_PORT_BASE + 1;
  const ownerSk = generateSecretKey();
  const relay = new Relay({
    port, dbPath: tmpFile('r.db'), whitelistPath: tmpFile('w.json'),
    getOwnerHex: () => getPublicKey(ownerSk),
  });
  await relay.start();

  const c = new TestClient(`ws://127.0.0.1:${port}`);
  await c.ready;
  const ev = signAt(ownerSk, Math.floor(Date.now() / 1000) + 14 * 60);
  c.send(['EVENT', ev]);
  const ok = await c.next(m => m[0] === 'OK' && m[1] === ev.id);
  assert.equal(ok[2], true, '14 min in future is within slack');

  await c.close();
  await relay.stop();
});

test('future-ts: event 30 minutes in future is rejected with invalid:', async () => {
  const port    = TEST_PORT_BASE + 2;
  const ownerSk = generateSecretKey();
  const relay = new Relay({
    port, dbPath: tmpFile('r.db'), whitelistPath: tmpFile('w.json'),
    getOwnerHex: () => getPublicKey(ownerSk),
  });
  await relay.start();

  const c = new TestClient(`ws://127.0.0.1:${port}`);
  await c.ready;
  const ev = signAt(ownerSk, Math.floor(Date.now() / 1000) + 30 * 60);
  c.send(['EVENT', ev]);
  const ok = await c.next(m => m[0] === 'OK' && m[1] === ev.id);
  assert.equal(ok[2], false, '30 min ahead is rejected');
  assert.match(String(ok[3]), /^invalid: created_at is more than \d+s in the future/);

  await c.close();
  await relay.stop();
});

test('future-ts: past timestamps are always accepted (backfill)', async () => {
  const port    = TEST_PORT_BASE + 3;
  const ownerSk = generateSecretKey();
  const relay = new Relay({
    port, dbPath: tmpFile('r.db'), whitelistPath: tmpFile('w.json'),
    getOwnerHex: () => getPublicKey(ownerSk),
  });
  await relay.start();

  const c = new TestClient(`ws://127.0.0.1:${port}`);
  await c.ready;
  // One year ago — well outside any past-side window we might add.
  const ev = signAt(ownerSk, Math.floor(Date.now() / 1000) - 365 * 24 * 60 * 60);
  c.send(['EVENT', ev]);
  const ok = await c.next(m => m[0] === 'OK' && m[1] === ev.id);
  assert.equal(ok[2], true, 'past timestamps are accepted');

  await c.close();
  await relay.stop();
});
