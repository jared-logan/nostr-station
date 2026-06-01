import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidFipsEndpoint, rebuildTomlWithNamedTable, extractAliasMap, extractNamedTableSection,
} from '../src/lib/nvpn.ts';

test('isValidFipsEndpoint: accepts host:port (IPv4 / hostname / [IPv6])', () => {
  assert.equal(isValidFipsEndpoint('203.0.113.7:51820'), true);
  assert.equal(isValidFipsEndpoint('relay.example.com:443'), true);
  assert.equal(isValidFipsEndpoint('[2001:db8::1]:51820'), true);
  assert.equal(isValidFipsEndpoint('a.b:1'), true);
});

test('isValidFipsEndpoint: rejects malformed / out-of-range', () => {
  for (const bad of ['', 'no-port', '203.0.113.7', ':51820', '203.0.113.7:0', '203.0.113.7:70000', 'host:port', 'a b:51820', null as any]) {
    assert.equal(isValidFipsEndpoint(bad), false, String(bad));
  }
});

test('rebuildTomlWithNamedTable: inserts a new [fips_peer_endpoints] table, preserving other sections', () => {
  const toml = '[[networks]]\nnetwork_id = "abc"\n\n[peer_aliases]\nnpub1x = "laptop"\n';
  const out = rebuildTomlWithNamedTable(toml, 'fips_peer_endpoints', { npub1x: '203.0.113.7:51820' });
  assert.match(out, /\[fips_peer_endpoints\]\nnpub1x = "203\.0\.113\.7:51820"/);
  // didn't clobber the other tables
  assert.match(out, /network_id = "abc"/);
  assert.match(out, /\[peer_aliases\]\nnpub1x = "laptop"/);
  // round-trips through the reader
  assert.deepEqual(extractAliasMap(extractNamedTableSection(out, 'fips_peer_endpoints')), { npub1x: '203.0.113.7:51820' });
});

test('rebuildTomlWithNamedTable: replaces an existing table in place', () => {
  const toml = '[fips_peer_endpoints]\nnpub1x = "1.1.1.1:1"\n\n[nat]\nenabled = true\n';
  const out = rebuildTomlWithNamedTable(toml, 'fips_peer_endpoints', { npub1x: '2.2.2.2:2', npub1y: '3.3.3.3:3' });
  assert.deepEqual(extractAliasMap(extractNamedTableSection(out, 'fips_peer_endpoints')), { npub1x: '2.2.2.2:2', npub1y: '3.3.3.3:3' });
  assert.match(out, /\[nat\]\nenabled = true/);            // adjacent section intact
  assert.equal(out.includes('1.1.1.1'), false);            // old value gone
});

test('rebuildTomlWithNamedTable: empty map leaves a bare table header (no stale rows)', () => {
  const toml = '[fips_peer_endpoints]\nnpub1x = "1.1.1.1:1"\n';
  const out = rebuildTomlWithNamedTable(toml, 'fips_peer_endpoints', {});
  assert.deepEqual(extractAliasMap(extractNamedTableSection(out, 'fips_peer_endpoints')), {});
  assert.equal(out.includes('1.1.1.1'), false);
});
