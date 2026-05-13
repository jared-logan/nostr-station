import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidParticipant,
  extractFirstNetworksSection,
  extractAllNetworksSections,
  extractTomlList,
  extractTomlString,
} from '../src/lib/nvpn.ts';

// ── isValidParticipant ────────────────────────────────────────────────

test('isValidParticipant accepts well-formed npub1', () => {
  assert.equal(
    isValidParticipant('npub1veu0rf9xmd5k8fv3l4cm7tl09ns4gghxcg0tsr3nuyfg997x722shlnyem'),
    true,
  );
});

test('isValidParticipant accepts 64-char hex (any case)', () => {
  assert.equal(isValidParticipant('a'.repeat(64)), true);
  assert.equal(isValidParticipant('A'.repeat(64)), true);
  assert.equal(isValidParticipant('6678f1a4a6db6963a591fd71bf2fef2ce15422e6c21eb80e33e1128297c6f295'), true);
});

test('isValidParticipant rejects empty / wrong length / non-hex', () => {
  assert.equal(isValidParticipant(''), false);
  assert.equal(isValidParticipant('npub1'), false);
  assert.equal(isValidParticipant('a'.repeat(63)), false);   // hex too short
  assert.equal(isValidParticipant('a'.repeat(65)), false);   // hex too long
  assert.equal(isValidParticipant('zz'.repeat(32)), false);  // non-hex chars
});

test('isValidParticipant rejects nsec / random strings', () => {
  // nsec1 prefix should never validate as a participant pubkey.
  assert.equal(
    isValidParticipant('nsec17rrkehmvq85r44ntp863qal0w283h8x59nl8es5fy28w3cxnyzcqwls6nq'),
    false,
  );
  assert.equal(isValidParticipant('hello world'), false);
});

// ── TOML extraction (nvpn config.toml shape) ──────────────────────────

const SAMPLE_TOML = `
node_name = "vm"
autoconnect = true

[[networks]]
id = "network-1"
name = "Network 1"
enabled = true
network_id = "30888794e905e677"
participants = ["npub1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "npub1bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"]
admins = ["npub1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]
shared_roster_updated_at = 1778076106

[peer_aliases]
npub1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa = "alice"

[nat]
enabled = true
`;

test('extractFirstNetworksSection isolates only the first [[networks]] block', () => {
  const section = extractFirstNetworksSection(SAMPLE_TOML);
  assert.match(section, /network_id = "30888794e905e677"/);
  // Must not bleed into [peer_aliases] or [nat].
  assert.equal(section.includes('[peer_aliases]'), false);
  assert.equal(section.includes('[nat]'), false);
  assert.equal(section.includes('enabled = true\n'), true); // network-level enabled survives
});

test('extractFirstNetworksSection returns whole file when no [[networks]] header', () => {
  const txt = 'node_name = "x"\n[other]\nfoo = "bar"\n';
  assert.equal(extractFirstNetworksSection(txt), txt);
});

test('extractTomlList parses a single-line array of strings', () => {
  const section = extractFirstNetworksSection(SAMPLE_TOML);
  const parts = extractTomlList(section, 'participants');
  assert.equal(parts.length, 2);
  assert.equal(parts[0], 'npub1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  const admins = extractTomlList(section, 'admins');
  assert.deepEqual(admins, ['npub1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']);
});

test('extractTomlList parses a multi-line array', () => {
  const txt = `
participants = [
  "npub1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "npub1bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
]
`;
  const parts = extractTomlList(txt, 'participants');
  assert.equal(parts.length, 2);
});

test('extractTomlList returns empty when key missing', () => {
  assert.deepEqual(extractTomlList('node_name = "x"\n', 'participants'), []);
});

test('extractTomlString picks up scalar string values', () => {
  const section = extractFirstNetworksSection(SAMPLE_TOML);
  assert.equal(extractTomlString(section, 'network_id'), '30888794e905e677');
  assert.equal(extractTomlString(section, 'name'), 'Network 1');
  assert.equal(extractTomlString(section, 'missing'), null);
});

// ── extractAllNetworksSections — multi-network awareness ──────────────

const MULTI_NETWORK_TOML = `
node_name = "vm"
autoconnect = true

[[networks]]
name = "Home"
network_id = "11111111"
participants = ["npub1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]
admins = ["npub1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]

[[networks]]
name = "Work"
network_id = "22222222"
participants = [
  "npub1bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "npub1ccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
]
admins = []

[[networks]]
network_id = "33333333"
participants = []
admins = []

[peer_aliases]
npub1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa = "alice"
`;

test('extractAllNetworksSections returns every [[networks]] block in order', () => {
  const sections = extractAllNetworksSections(MULTI_NETWORK_TOML);
  assert.equal(sections.length, 3);
  assert.equal(extractTomlString(sections[0], 'network_id'), '11111111');
  assert.equal(extractTomlString(sections[1], 'network_id'), '22222222');
  assert.equal(extractTomlString(sections[2], 'network_id'), '33333333');
});

test('extractAllNetworksSections bounds each block at the next table header', () => {
  const sections = extractAllNetworksSections(MULTI_NETWORK_TOML);
  // The last block must not bleed into [peer_aliases].
  assert.equal(sections[2].includes('[peer_aliases]'), false);
  assert.equal(sections[2].includes('alice'), false);
});

test('extractAllNetworksSections returns single block for single-network config', () => {
  const sections = extractAllNetworksSections(SAMPLE_TOML);
  assert.equal(sections.length, 1);
  assert.equal(extractTomlString(sections[0], 'network_id'), '30888794e905e677');
});

test('extractAllNetworksSections returns [] when no [[networks]] header', () => {
  assert.deepEqual(extractAllNetworksSections('node_name = "x"\n[nat]\nenabled = true\n'), []);
});
