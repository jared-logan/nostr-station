import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Relay } from '../src/relay/index.ts';
import { Watchdog } from '../src/lib/watchdog.ts';

// We need a test home so the keychain backend writes the watchdog-nsec
// somewhere isolated. _home.useTempHome() pins HOME for the rest of the
// process, so we set it before any keychain code runs.
import { useTempHome } from './_home.js';
useTempHome();

const TEST_PORT_BASE = 20_000 + Math.floor(Math.random() * 500);

function tmpFile(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-wd-'));
  return path.join(dir, name);
}

async function spinUpRelay(port: number) {
  const r = new Relay({
    port,
    dbPath:        tmpFile('r.db'),
    whitelistPath: tmpFile('wl.json'),
    getOwnerHex:   () => null,
  });
  await r.start();
  return r;
}

test('watchdog: start auto-generates nsec and registers in whitelist', async () => {
  const port = TEST_PORT_BASE;
  const relay = await spinUpRelay(port);
  try {
    const wd = new Watchdog({ relay, manualTick: true });
    await wd.start();
    const status = wd.status();
    assert.equal(typeof status.npub, 'string');
    assert.match(status.npub!, /^npub1/);

    // Whitelist should contain the watchdog's hex pubkey.
    const hexes = relay.whitelist.list();
    assert.equal(hexes.length, 1);
    // First heartbeat fires inside start() — lastHeartbeatAt should be set.
    assert.ok(status.lastHeartbeatAt && status.lastHeartbeatAt > 0);

    wd.stop();
  } finally {
    await relay.stop();
  }
});

test('watchdog: heartbeat lands in the relay event store', async () => {
  const port = TEST_PORT_BASE + 1;
  const relay = await spinUpRelay(port);
  try {
    const wd = new Watchdog({ relay, manualTick: true });
    await wd.start();

    // Initial heartbeat already fired during start; trigger another to
    // exercise the explicit path too.
    const ev = await wd.heartbeat();
    assert.equal(ev.kind, 1);
    assert.deepEqual(ev.tags[0], ['client', 'nostr-station-watchdog']);

    const stored = relay.store.query({ ids: [ev.id] });
    assert.equal(stored.length, 1);

    wd.stop();
  } finally {
    await relay.stop();
  }
});

test('watchdog: stop is idempotent', async () => {
  const port = TEST_PORT_BASE + 2;
  const relay = await spinUpRelay(port);
  try {
    const wd = new Watchdog({ relay, manualTick: true });
    await wd.start();
    wd.stop();
    wd.stop();   // no throw
    assert.equal(wd.status().running, false);
  } finally {
    await relay.stop();
  }
});

test('watchdog: nsec persists across instances (same keychain slot)', async () => {
  const port = TEST_PORT_BASE + 3;
  const relay = await spinUpRelay(port);
  try {
    const wd1 = new Watchdog({ relay, manualTick: true });
    await wd1.start();
    const npub1 = wd1.status().npub;
    wd1.stop();

    const wd2 = new Watchdog({ relay, manualTick: true });
    await wd2.start();
    const npub2 = wd2.status().npub;
    wd2.stop();

    assert.equal(npub1, npub2, 'second start should re-use the stored nsec');
  } finally {
    await relay.stop();
  }
});

test('watchdog: status reflects running + lastHeartbeatAt', async () => {
  const port = TEST_PORT_BASE + 4;
  const relay = await spinUpRelay(port);
  try {
    const wd = new Watchdog({ relay, manualTick: true });
    const before = wd.status();
    assert.equal(before.running, false);
    assert.equal(before.lastHeartbeatAt, null);

    await wd.start();
    const after = wd.status();
    assert.ok(after.lastHeartbeatAt);
    // running:false because manualTick=true keeps setInterval inert
    assert.equal(after.running, false);
    wd.stop();
  } finally {
    await relay.stop();
  }
});

test('watchdog: heartbeat without start throws', async () => {
  const port = TEST_PORT_BASE + 5;
  const relay = await spinUpRelay(port);
  try {
    const wd = new Watchdog({ relay, manualTick: true });
    await assert.rejects(() => wd.heartbeat(), /watchdog not started/);
  } finally {
    await relay.stop();
  }
});
