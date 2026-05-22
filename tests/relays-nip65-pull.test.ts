// Network-side tests for the NIP-65 pull path. Spin up a tiny in-process
// WebSocket "relay" that answers REQ {kinds:[10002], authors:[<pubkey>]}
// with a hand-crafted kind:10002, so we can exercise fetchKind10002FromOne
// without depending on the public network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import type { AddressInfo } from 'node:net';

async function withTmpHome<T>(fn: () => Promise<T> | T): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-pull-'));
  const prev = process.env.HOME;
  process.env.HOME = dir;
  try { return await fn(); } finally { process.env.HOME = prev; }
}

// Mini fake-relay. Accepts WS, answers a REQ for kind:10002 with the
// provided event (if any), then EOSE. Mode "no-event" sends EOSE
// immediately so the pull path can distinguish "queried and nothing
// was there" from "queried and got a timeout".
function startFakeRelay(opts: { event?: any; mode?: 'normal' | 'silent' | 'eose-only' } = {}): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise(resolve => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        let msg: any;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (!Array.isArray(msg) || msg[0] !== 'REQ') return;
        const subId = msg[1];
        if (opts.mode === 'silent') return; // never answer — exercises timeout path
        if (opts.event && opts.mode !== 'eose-only') {
          ws.send(JSON.stringify(['EVENT', subId, opts.event]));
        }
        ws.send(JSON.stringify(['EOSE', subId]));
      });
    });
    wss.on('listening', () => {
      const addr = wss.address() as AddressInfo;
      resolve({
        url: `ws://127.0.0.1:${addr.port}`,
        close: () => new Promise<void>(r => wss.close(() => r())),
      });
    });
  });
}

// Pre-computed 64-hex pubkey used in the fake events — the npub form
// would require nip19.npubEncode at test time; using hex bypasses that
// and exercises the same npubToHex branch in pullNip65.
const TEST_PUBKEY_HEX = '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20';

function fakeKind10002(rtags: string[][]): any {
  return {
    id:         'a'.repeat(64),
    pubkey:     TEST_PUBKEY_HEX,
    kind:       10002,
    created_at: 1_700_000_000,
    tags:       rtags,
    content:    '',
    sig:        'b'.repeat(128),
  };
}

test('relays: pullNip65 fetches a kind:10002 and parses r tags', async () => {
  await withTmpHome(async () => {
    const ev = fakeKind10002([
      ['r', 'wss://both.example'],
      ['r', 'wss://inbox.example',  'read'],
      ['r', 'wss://outbox.example', 'write'],
    ]);
    const relay = await startFakeRelay({ event: ev });
    try {
      const relays = await import('../src/lib/relays.ts');
      const result = await relays.pullNip65({
        npub:      TEST_PUBKEY_HEX,
        relays:    [relay.url],
        timeoutMs: 2000,
      });
      assert.equal(result.ok, true);
      assert.ok(result.parsed);
      assert.deepEqual(result.parsed!.readRelays.sort(),
        ['wss://both.example', 'wss://inbox.example'].sort());
      assert.deepEqual(result.parsed!.writeRelays.sort(),
        ['wss://both.example', 'wss://outbox.example'].sort());
      assert.equal(result.parsed!.eventId, 'a'.repeat(64));
    } finally {
      await relay.close();
    }
  });
});

test('relays: pullNip65 picks the newest event when relays disagree', async () => {
  await withTmpHome(async () => {
    const oldEv = { ...fakeKind10002([['r', 'wss://old.example']]),                   id: '1'.repeat(64), created_at: 1000 };
    const newEv = { ...fakeKind10002([['r', 'wss://new.example']]),                   id: '2'.repeat(64), created_at: 2000 };
    const r1 = await startFakeRelay({ event: oldEv });
    const r2 = await startFakeRelay({ event: newEv });
    try {
      const relays = await import('../src/lib/relays.ts');
      const result = await relays.pullNip65({
        npub: TEST_PUBKEY_HEX,
        relays: [r1.url, r2.url],
        timeoutMs: 2000,
      });
      assert.equal(result.ok, true);
      assert.equal(result.parsed!.eventId, '2'.repeat(64), 'newer event wins');
      assert.deepEqual(result.parsed!.readRelays, ['wss://new.example']);
    } finally {
      await r1.close();
      await r2.close();
    }
  });
});

test('relays: pullNip65 returns ok=false when no relay has the event', async () => {
  await withTmpHome(async () => {
    const relay = await startFakeRelay({ mode: 'eose-only' });
    try {
      const relays = await import('../src/lib/relays.ts');
      const result = await relays.pullNip65({
        npub: TEST_PUBKEY_HEX,
        relays: [relay.url],
        timeoutMs: 2000,
      });
      assert.equal(result.ok, false);
      assert.match(result.error || '', /no kind:10002/);
      assert.equal(result.parsed, undefined);
      // Per-relay result still reports the relay as OK (it answered EOSE);
      // the failure is at the aggregate-no-event level.
      assert.equal(result.relayResults[0].ok, true);
    } finally {
      await relay.close();
    }
  });
});

test('relays: pullNip65 surfaces a malformed-npub error early', async () => {
  await withTmpHome(async () => {
    const relays = await import('../src/lib/relays.ts');
    const result = await relays.pullNip65({
      npub:   'not-a-real-npub',
      relays: ['ws://127.0.0.1:1'],
      timeoutMs: 100,
    });
    assert.equal(result.ok, false);
    assert.match(result.error || '', /npub|hex/i);
    // No network attempted on a bad npub.
    assert.equal(result.relayResults.length, 0);
  });
});

test('relays: pullNip65 reports timeout per relay when one stays silent', async () => {
  await withTmpHome(async () => {
    const silent  = await startFakeRelay({ mode: 'silent' });
    const ev      = fakeKind10002([['r', 'wss://x.example']]);
    const working = await startFakeRelay({ event: ev });
    try {
      const relays = await import('../src/lib/relays.ts');
      const result = await relays.pullNip65({
        npub: TEST_PUBKEY_HEX,
        relays: [silent.url, working.url],
        timeoutMs: 500,
      });
      assert.equal(result.ok, true, 'one good relay is enough');
      const silentResult  = result.relayResults.find(r => r.relay === silent.url);
      const workingResult = result.relayResults.find(r => r.relay === working.url);
      assert.equal(silentResult?.ok, false);
      assert.equal(silentResult?.reason, 'timeout');
      assert.equal(workingResult?.ok, true);
    } finally {
      await silent.close();
      await working.close();
    }
  });
});

test('relays: pullNip65 ignores invalid r tags inside an otherwise valid event', async () => {
  await withTmpHome(async () => {
    const ev = fakeKind10002([
      ['r', 'wss://valid.example'],
      ['r', 'http://not-a-relay.example'],
      ['r', ''],
      ['r'],                              // truncated tag
      ['e', 'wss://wrong-tag-letter.example'],
      ['r', 'wss://marked-with-junk.example', 'banana'],   // unknown marker → both
    ]);
    const relay = await startFakeRelay({ event: ev });
    try {
      const relays = await import('../src/lib/relays.ts');
      const result = await relays.pullNip65({
        npub: TEST_PUBKEY_HEX,
        relays: [relay.url],
        timeoutMs: 2000,
      });
      assert.equal(result.ok, true);
      assert.ok(result.parsed!.readRelays.includes('wss://valid.example'));
      assert.ok(result.parsed!.readRelays.includes('wss://marked-with-junk.example'));
      assert.ok(!result.parsed!.readRelays.includes('http://not-a-relay.example'));
      assert.ok(!result.parsed!.readRelays.includes(''));
    } finally {
      await relay.close();
    }
  });
});
