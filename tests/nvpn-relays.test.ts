import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractNvpnRelays,
  isValidRelayUrl,
  buildSetRelaysArgs,
} from '../src/lib/nvpn.ts';

// ── extractNvpnRelays ──────────────────────────────────────────────────

test('extractNvpnRelays: pulls relays from [[networks]] block', () => {
  const toml = `
[[networks]]
network_id = "abc"
relays = [
  "wss://relay.snort.social/",
  "wss://temp.iris.to/",
]
participants = ["a"]
`;
  assert.deepEqual(
    extractNvpnRelays(toml),
    ['wss://relay.snort.social/', 'wss://temp.iris.to/'],
  );
});

test('extractNvpnRelays: falls back to [nostr] section when [[networks]] has none', () => {
  const toml = `
[[networks]]
network_id = "abc"
participants = []

[nostr]
relays = ["wss://nostr.example/"]
`;
  assert.deepEqual(extractNvpnRelays(toml), ['wss://nostr.example/']);
});

test('extractNvpnRelays: prefers [[networks]] over [nostr]', () => {
  // If both are present (transition / mixed config), the [[networks]]
  // entry wins because that's where current nvpn writes.
  const toml = `
[[networks]]
relays = ["wss://primary/"]

[nostr]
relays = ["wss://legacy/"]
`;
  assert.deepEqual(extractNvpnRelays(toml), ['wss://primary/']);
});

test('extractNvpnRelays: returns [] when neither section has relays', () => {
  const toml = `[[networks]]\nnetwork_id = "x"\n`;
  assert.deepEqual(extractNvpnRelays(toml), []);
});

test('extractNvpnRelays: handles empty / missing config gracefully', () => {
  assert.deepEqual(extractNvpnRelays(''), []);
  assert.deepEqual(extractNvpnRelays('# only comments\n'), []);
});

// ── isValidRelayUrl ────────────────────────────────────────────────────

test('isValidRelayUrl accepts wss:// and ws:// URLs', () => {
  assert.equal(isValidRelayUrl('wss://relay.snort.social/'), true);
  assert.equal(isValidRelayUrl('ws://localhost:7777/'), true);
  assert.equal(isValidRelayUrl('wss://relay.example.com:8443/path?x=1'), true);
});

test('isValidRelayUrl rejects non-WebSocket URLs and junk', () => {
  assert.equal(isValidRelayUrl(''), false);
  assert.equal(isValidRelayUrl('https://relay.example.com/'), false);
  assert.equal(isValidRelayUrl('relay.example.com'), false);
  assert.equal(isValidRelayUrl(null as any), false);
  assert.equal(isValidRelayUrl(undefined as any), false);
  assert.equal(isValidRelayUrl(42 as any), false);
});

test('isValidRelayUrl rejects unreasonably long URLs', () => {
  // Defends against DoS via huge string allocations on the toml writer.
  const huge = 'wss://' + 'a'.repeat(300) + '/';
  assert.equal(isValidRelayUrl(huge), false);
});

// ── buildSetRelaysArgs ─────────────────────────────────────────────────

test('buildSetRelaysArgs: emits one --relay per URL plus --json', () => {
  assert.deepEqual(
    buildSetRelaysArgs(['wss://a/', 'wss://b/']),
    ['set', '--relay', 'wss://a/', '--relay', 'wss://b/', '--json'],
  );
});

test('buildSetRelaysArgs: empty list still produces a valid set call shape', () => {
  // The lib layer (setNvpnRelays) refuses an empty list before we get
  // here, but the pure builder shouldn't crash on empty input —
  // separation lets a future "reset" code path use this if needed.
  assert.deepEqual(buildSetRelaysArgs([]), ['set', '--json']);
});
