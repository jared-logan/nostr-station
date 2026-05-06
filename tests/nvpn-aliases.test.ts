import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidAliasValue,
  extractPeerAliasesSection,
  extractAliasMap,
  rebuildTomlWithAliases,
} from '../src/lib/nvpn.ts';

// ── isValidAliasValue ─────────────────────────────────────────────────

test('isValidAliasValue: accepts realistic labels', () => {
  for (const v of ['alice', 'Alice', 'laptop-1', 'vps-frankfurt', 'Bob 2',
                   'node_a', 'a.b', 'X', 'abc-DEF.123 _99']) {
    assert.equal(isValidAliasValue(v), true, `expected ${v} to validate`);
  }
});

test('isValidAliasValue: rejects empty / over-length / bad chars', () => {
  assert.equal(isValidAliasValue(''), false);
  assert.equal(isValidAliasValue('a'.repeat(65)), false);
  // Disallowed characters: quotes, slashes, backticks, control chars,
  // any Unicode confusables.
  assert.equal(isValidAliasValue('alice"'), false);
  assert.equal(isValidAliasValue('a/b'),    false);
  assert.equal(isValidAliasValue('a\\b'),   false);
  assert.equal(isValidAliasValue('a\nb'),   false);
  assert.equal(isValidAliasValue('алиса'),  false);  // Cyrillic
});

// ── extractPeerAliasesSection / extractAliasMap ───────────────────────

const FULL_TOML = `
node_name = "vm"
[[networks]]
network_id = "abc"

[peer_aliases]
npub1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa = "alice"
npub1bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb = "bob"

[nat]
enabled = true
`;

test('extractPeerAliasesSection isolates the [peer_aliases] body', () => {
  const body = extractPeerAliasesSection(FULL_TOML);
  assert.match(body, /alice/);
  assert.match(body, /bob/);
  // Must not bleed into [nat].
  assert.equal(body.includes('[nat]'), false);
  assert.equal(body.includes('enabled = true'), false);
});

test('extractPeerAliasesSection returns empty when section missing', () => {
  assert.equal(extractPeerAliasesSection('node_name = "vm"\n'), '');
});

test('extractAliasMap parses npub key/value pairs', () => {
  const m = extractAliasMap(extractPeerAliasesSection(FULL_TOML));
  assert.equal(Object.keys(m).length, 2);
  assert.equal(m['npub1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'], 'alice');
  assert.equal(m['npub1bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'], 'bob');
});

test('extractAliasMap handles escaped quotes in values', () => {
  const m = extractAliasMap('npub1xxx = "with \\"quote\\""\n');
  assert.equal(m['npub1xxx'], 'with "quote"');
});

// ── rebuildTomlWithAliases ────────────────────────────────────────────

test('rebuildTomlWithAliases replaces existing [peer_aliases] section', () => {
  const out = rebuildTomlWithAliases(FULL_TOML, {
    npub1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: 'alice-renamed',
    // bob removed; ccc added.
    npub1cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc: 'carol',
  });
  // New entries present.
  assert.match(out, /npub1aaa[a]+ = "alice-renamed"/);
  assert.match(out, /npub1ccc[c]+ = "carol"/);
  // Removed entry gone.
  assert.equal(out.includes('npub1bbb'), false);
  // Other sections intact.
  assert.match(out, /\[\[networks\]\][\s\S]*network_id = "abc"/);
  assert.match(out, /\[nat\][\s\S]*enabled = true/);
});

test('rebuildTomlWithAliases appends section when missing', () => {
  const before = `node_name = "vm"
[[networks]]
network_id = "abc"
`;
  const out = rebuildTomlWithAliases(before, {
    npub1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: 'alice',
  });
  assert.match(out, /\[peer_aliases\]\nnpub1aaa[a]+ = "alice"/);
  // Original content is preserved.
  assert.match(out, /node_name = "vm"/);
  assert.match(out, /network_id = "abc"/);
});

test('rebuildTomlWithAliases keeps an empty section when map is empty', () => {
  // Better than deleting the section entirely — preserves user intent
  // and avoids formatting drift if they re-add aliases later.
  const out = rebuildTomlWithAliases(FULL_TOML, {});
  assert.match(out, /\[peer_aliases\]/);
  assert.equal(out.includes('alice'), false);
  assert.equal(out.includes('bob'), false);
  // Other sections still intact.
  assert.match(out, /\[nat\]/);
});

test('rebuildTomlWithAliases escapes backslash + quotes in values', () => {
  // Defensive even though our validator rejects these — the file may
  // have been hand-edited before we touched it.
  const out = rebuildTomlWithAliases('', {
    npub1xxx: 'a"b\\c',
  });
  assert.match(out, /npub1xxx = "a\\"b\\\\c"/);
});

test('rebuildTomlWithAliases sorts keys for deterministic output', () => {
  const out = rebuildTomlWithAliases('', {
    npub1z: 'zoe',
    npub1a: 'al',
    npub1m: 'mo',
  });
  const lines = out.split('\n').filter(l => l.includes('='));
  assert.deepEqual(lines, [
    'npub1a = "al"',
    'npub1m = "mo"',
    'npub1z = "zoe"',
  ]);
});
