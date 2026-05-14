import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  RelayHealthAggregator,
  classifyLine,
  extractRelayUrl,
} from '../src/lib/nvpn-relay-health.js';
import { LogBuffer } from '../src/lib/log-buffer.js';

// ── extractRelayUrl ───────────────────────────────────────────────────

test('extractRelayUrl: pulls bare wss URL', () => {
  assert.equal(
    extractRelayUrl('connecting to wss://nos.lol'),
    'wss://nos.lol',
  );
});

test('extractRelayUrl: strips trailing punctuation', () => {
  assert.equal(
    extractRelayUrl('Impossible to send event to wss://relay.damus.io/: rate-limited'),
    'wss://relay.damus.io',
  );
});

test('extractRelayUrl: handles wss:// with path', () => {
  // Path bytes are part of the URL but we trim trailing punctuation only.
  assert.equal(
    extractRelayUrl('event sent to wss://example.com/v1/relay'),
    'wss://example.com/v1/relay',
  );
});

test('extractRelayUrl: returns null when no URL', () => {
  assert.equal(extractRelayUrl('something happened, no url here'), null);
});

// ── classifyLine ──────────────────────────────────────────────────────

test('classifyLine: rate-limited', () => {
  assert.equal(
    classifyLine('event not published: rate-limited: you are noting too much'),
    'rate_limited',
  );
});

test('classifyLine: 504 Gateway Timeout', () => {
  assert.equal(
    classifyLine('relay.snort.social: HTTP error: 504 Gateway Timeout'),
    'http_5xx',
  );
});

test('classifyLine: 403 Forbidden', () => {
  assert.equal(
    classifyLine('nostr.wine: 403 Forbidden'),
    'http_4xx',
  );
});

test('classifyLine: web-of-trust rejection', () => {
  assert.equal(
    classifyLine('event not published: Policy violated and pubkey is not in our web of trust'),
    'wot_reject',
  );
});

test('classifyLine: connect timeout', () => {
  assert.equal(
    classifyLine('relay.nostr.band: Impossible to connect: timeout'),
    'connect_failed',
  );
});

test('classifyLine: recv timeout / not connected', () => {
  assert.equal(
    classifyLine('wss://relay.nostr.band: recv message response timeout'),
    'timeout',
  );
});

test('classifyLine: noise returns null', () => {
  assert.equal(
    classifyLine('STUN succeeded via stun.l.google.com: 1.2.3.4:51820'),
    null,
  );
});

// ── Aggregator end-to-end ─────────────────────────────────────────────

test('RelayHealthAggregator: counts errors per URL', () => {
  const agg = new RelayHealthAggregator();
  const buf = new LogBuffer();
  agg.attach(buf);

  buf.error('event not published to wss://relay.damus.io/: rate-limited: you are noting too much');
  buf.error('event not published to wss://relay.damus.io/: rate-limited: you are noting too much');
  buf.warn('wss://relay.snort.social: HTTP error: 504 Gateway Timeout');

  const snap = agg.snapshot();
  const damus = snap.find(s => s.url === 'wss://relay.damus.io');
  const snort = snap.find(s => s.url === 'wss://relay.snort.social');

  assert.ok(damus,  'damus row exists');
  assert.equal(damus!.errCount, 2);
  assert.equal(damus!.lastError?.kind, 'rate_limited');

  assert.ok(snort,  'snort row exists');
  assert.equal(snort!.errCount, 1);
  assert.equal(snort!.lastError?.kind, 'http_5xx');
});

test('RelayHealthAggregator: ignores lines with no recognizable relay URL or kind', () => {
  const agg = new RelayHealthAggregator();
  const buf = new LogBuffer();
  agg.attach(buf);
  buf.info('STUN succeeded via stun.l.google.com: 1.2.3.4:51820');
  buf.info('tunnel: failed to flush linux route cache: Permission denied');
  assert.equal(agg.snapshot().length, 0);
});

test('RelayHealthAggregator: sliding window drops old events', async () => {
  const agg = new RelayHealthAggregator(50);  // 50ms window
  const buf = new LogBuffer();
  agg.attach(buf);

  buf.error('event not published to wss://relay.damus.io/: rate-limited');
  assert.equal(agg.snapshot().length, 1);

  await new Promise(r => setTimeout(r, 80));
  // snapshot's gc() runs on read, so the old event should be evicted.
  assert.equal(agg.snapshot().length, 0);
});
