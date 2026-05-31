import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidNetworkId,
  buildNvpnNetworkBlock,
  insertNetworkBlockFirst,
  extractAllNetworksSections,
  extractTomlString,
} from '../src/lib/nvpn.ts';

// ── isValidNetworkId ───────────────────────────────────────────────────

test('isValidNetworkId: accepts the id shapes nvpn has shipped', () => {
  for (const v of [
    '7f3a9c2e',                                   // short hex
    'a1b2c3d4-e5f6-7890-abcd-ef1234567890',       // uuid (hyphens must pass)
    'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqsg7tyg',
    'group:family',
    'net_123.v2',
  ]) {
    assert.equal(isValidNetworkId(v), true, `expected ${v} to validate`);
  }
});

test('isValidNetworkId: rejects empty, over-length, and TOML-breaking input', () => {
  assert.equal(isValidNetworkId(''), false);
  assert.equal(isValidNetworkId('   '), false);            // trims to empty
  assert.equal(isValidNetworkId('a'.repeat(201)), false);
  assert.equal(isValidNetworkId('abc"def'), false);        // quote breaks string
  assert.equal(isValidNetworkId('abc\\def'), false);       // backslash
  assert.equal(isValidNetworkId('abc\ndef'), false);       // newline injection
  assert.equal(isValidNetworkId('abc\tdef'), false);       // control char
  assert.equal(isValidNetworkId(null as any), false);
  assert.equal(isValidNetworkId(42 as any), false);
});

// ── buildNvpnNetworkBlock ──────────────────────────────────────────────

test('buildNvpnNetworkBlock: emits a minimal block with empty roster', () => {
  const block = buildNvpnNetworkBlock('abc123', ['wss://a/', 'wss://b/']);
  assert.match(block, /^\[\[networks\]\]\n/);
  assert.match(block, /network_id = "abc123"/);
  assert.match(block, /participants = \[\]/);
  assert.match(block, /admins = \[\]/);
  assert.match(block, /relays = \["wss:\/\/a\/", "wss:\/\/b\/"\]/);
});

test('buildNvpnNetworkBlock: empty relay list renders as []', () => {
  assert.match(buildNvpnNetworkBlock('x', []), /relays = \[\]/);
});

// ── insertNetworkBlockFirst ────────────────────────────────────────────

test('insertNetworkBlockFirst: makes the joined network the active (first) block', () => {
  const toml = `[nostr]
public_key = "npub1x"

[[networks]]
network_id = "existing"
relays = ["wss://r/"]
`;
  const block = buildNvpnNetworkBlock('joined', ['wss://r/']);
  const out = insertNetworkBlockFirst(toml, block);
  const ids = extractAllNetworksSections(out).map(s => extractTomlString(s, 'network_id'));
  assert.deepEqual(ids, ['joined', 'existing']);   // joined is index 0 = active
  // Non-networks section preserved.
  assert.match(out, /\[nostr\][\s\S]*public_key = "npub1x"/);
});

test('insertNetworkBlockFirst: appends when there is no networks block yet', () => {
  const toml = `[nostr]\npublic_key = "npub1x"\n`;
  const block = buildNvpnNetworkBlock('first', []);
  const out = insertNetworkBlockFirst(toml, block);
  const ids = extractAllNetworksSections(out).map(s => extractTomlString(s, 'network_id'));
  assert.deepEqual(ids, ['first']);
  assert.match(out, /public_key = "npub1x"/);
});

test('insertNetworkBlockFirst: handles an empty config', () => {
  const out = insertNetworkBlockFirst('', buildNvpnNetworkBlock('only', []));
  assert.deepEqual(
    extractAllNetworksSections(out).map(s => extractTomlString(s, 'network_id')),
    ['only'],
  );
});
