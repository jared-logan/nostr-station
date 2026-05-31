import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractNvpnRelays,
  isValidRelayUrl,
  buildSetRelaysArgs,
  rebuildTomlWithRelays,
  RECOMMENDED_NVPN_RELAYS,
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

// ── RECOMMENDED_NVPN_RELAYS ────────────────────────────────────────────

test('RECOMMENDED_NVPN_RELAYS: non-empty and all entries are valid relay URLs', () => {
  // The "Use recommended" button replaces the user's list wholesale,
  // so the curated set must (1) be non-empty (setNvpnRelays would
  // reject otherwise), and (2) contain only URLs that pass our
  // own validator — protects against typos sneaking in via PR.
  assert.ok(RECOMMENDED_NVPN_RELAYS.length > 0, 'curated list must not be empty');
  for (const url of RECOMMENDED_NVPN_RELAYS) {
    assert.equal(isValidRelayUrl(url), true, `not a valid relay URL: ${url}`);
  }
});

test('RECOMMENDED_NVPN_RELAYS: deduplicated', () => {
  // Sanity: don't ship a list that contains the same URL twice. Doesn't
  // strictly cause user-visible bugs (setNvpnRelays de-dups) but a
  // duplicate in source is almost certainly a typo.
  const seen = new Set();
  for (const url of RECOMMENDED_NVPN_RELAYS) {
    assert.equal(seen.has(url), false, `duplicate in recommended set: ${url}`);
    seen.add(url);
  }
});

// ── rebuildTomlWithRelays ──────────────────────────────────────────────

test('rebuildTomlWithRelays: replaces an existing multi-line relays array', () => {
  const toml = `[[networks]]
network_id = "abc"
relays = [
  "wss://old-a/",
  "wss://old-b/",
]
participants = ["a"]

[nat]
enabled = true
`;
  const out = rebuildTomlWithRelays(toml, ['wss://new-a/', 'wss://new-b/']);
  assert.deepEqual(extractNvpnRelays(out), ['wss://new-a/', 'wss://new-b/']);
  // Old entries gone, sibling keys + other sections intact.
  assert.equal(out.includes('old-a'), false);
  assert.match(out, /participants = \["a"\]/);
  assert.match(out, /\[nat\][\s\S]*enabled = true/);
});

test('rebuildTomlWithRelays: inserts relays when the block has none', () => {
  const toml = `[[networks]]
network_id = "abc"
participants = []
`;
  const out = rebuildTomlWithRelays(toml, ['wss://a/']);
  assert.deepEqual(extractNvpnRelays(out), ['wss://a/']);
  assert.match(out, /network_id = "abc"/);
});

test('rebuildTomlWithRelays: only touches the first [[networks]] block', () => {
  const toml = `[[networks]]
network_id = "active"
relays = ["wss://active/"]

[[networks]]
network_id = "inactive"
relays = ["wss://inactive/"]
`;
  const out = rebuildTomlWithRelays(toml, ['wss://changed/']);
  // First block updated…
  assert.match(out, /network_id = "active"[\s\S]*wss:\/\/changed\//);
  // …second block left exactly as-is.
  assert.match(out, /network_id = "inactive"[\s\S]*wss:\/\/inactive\//);
  assert.equal(out.includes('wss://active/'), false);
});

test('rebuildTomlWithRelays: returns input unchanged with no [[networks]] block', () => {
  const toml = `[nostr]\npublic_key = "npub1x"\n`;
  assert.equal(rebuildTomlWithRelays(toml, ['wss://a/']), toml);
});
