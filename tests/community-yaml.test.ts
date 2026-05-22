/**
 * Tests for the GRAIN YAML I/O layer.
 * Exercises:
 *   - atomic writes (no torn files)
 *   - round-trip stability for the typed fields we care about
 *   - quoting of values that look numeric / look like other YAML tokens
 *   - graceful handling of missing optional files (blacklist/whitelist)
 *   - preservation of unknown keys through a read/modify/write cycle
 *     (so a user-managed override isn't clobbered by the dashboard)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  atomicWriteFileSync,
  defaultGrainConfig,
  readGrainConfig, writeGrainConfig,
  readGrainWhitelist, writeGrainWhitelist,
  readGrainBlacklist, writeGrainBlacklist,
  communityConfigPath, communityWhitelistPath, communityBlacklistPath,
  communitiesRoot,
} from '../src/lib/community-yaml.ts';

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'community-yaml-'));
}

test('atomicWriteFileSync writes then renames (no torn file)', () => {
  const dir  = mkTmp();
  const file = path.join(dir, 'config.yml');
  atomicWriteFileSync(file, 'hello: world\n');
  assert.equal(fs.readFileSync(file, 'utf8'), 'hello: world\n');
  // No leftover tmp from the staging step:
  const leftovers = fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('defaultGrainConfig writes the port-only form that GRAIN requires', () => {
  const dir  = mkTmp();
  const file = path.join(dir, 'config.yml');
  const cfg  = defaultGrainConfig({ port: 7778 });
  writeGrainConfig(file, cfg);
  const back = readGrainConfig(file);
  // GRAIN's validator rejects "host:port" outright ("must start with ':'")
  // — pin the format we write to ensure no regression slips back to the
  // pre-fix host:port form, which would brick first-spawn.
  assert.equal(back.server.port, ':7778');
});

test('defaultGrainConfig round-trips an arbitrary port number to ":<port>" form', () => {
  const dir  = mkTmp();
  const file = path.join(dir, 'config.yml');
  for (const port of [7778, 8081, 9000, 65535]) {
    writeGrainConfig(file, defaultGrainConfig({ port }));
    const back = readGrainConfig(file);
    assert.equal(back.server.port, `:${port}`, `port ${port} did not round-trip`);
  }
});

test('readGrainConfig preserves unknown top-level + nested keys', () => {
  const dir  = mkTmp();
  const file = path.join(dir, 'config.yml');
  fs.writeFileSync(file, [
    'server:',
    '  port: ":7778"',
    '  read_timeout: 30',
    'rate_limits:',
    '  events_per_minute: 10',
    'user_override:',
    '  - keep-me',
    '',
  ].join('\n'));
  const back = readGrainConfig(file);
  // Round-trip and check the unknown keys survived.
  const dst = path.join(dir, 'config-out.yml');
  writeGrainConfig(dst, back);
  const back2 = readGrainConfig(dst);
  assert.deepEqual(
    (back2 as any).user_override,
    ['keep-me'],
    'unknown top-level key was dropped on round-trip',
  );
  assert.equal((back2.server as any).read_timeout, 30, 'unknown nested key lost');
  assert.deepEqual(
    (back2 as any).rate_limits,
    { events_per_minute: 10 },
    'unknown rate_limits sibling lost',
  );
});

test('readGrainConfig throws on missing server section (not silent default)', () => {
  const dir  = mkTmp();
  const file = path.join(dir, 'config.yml');
  fs.writeFileSync(file, 'foo: bar\n');
  assert.throws(() => readGrainConfig(file), /server/);
});

test('readGrainWhitelist returns empty list when file absent', () => {
  const dir  = mkTmp();
  const file = path.join(dir, 'whitelist.yml');
  const wl   = readGrainWhitelist(file);
  assert.deepEqual(wl, { pubkeys: [] });
});

test('writeGrainWhitelist + read preserves pubkeys + unknown fields', () => {
  const dir  = mkTmp();
  const file = path.join(dir, 'whitelist.yml');
  writeGrainWhitelist(file, {
    pubkeys: ['aa'.repeat(32), 'bb'.repeat(32)],
    domains: ['example.com'],
  } as any);
  const back = readGrainWhitelist(file);
  assert.deepEqual(back.pubkeys, ['aa'.repeat(32), 'bb'.repeat(32)]);
  assert.deepEqual((back as any).domains, ['example.com']);
});

test('readGrainWhitelist filters non-string pubkey entries (no type confusion)', () => {
  const dir  = mkTmp();
  const file = path.join(dir, 'whitelist.yml');
  fs.writeFileSync(file, 'pubkeys:\n  - "aa"\n  - 1234\n  - "bb"\n');
  const wl = readGrainWhitelist(file);
  assert.deepEqual(wl.pubkeys, ['aa', 'bb']);
});

test('writeGrainBlacklist + read preserves pubkeys + words', () => {
  const dir  = mkTmp();
  const file = path.join(dir, 'blacklist.yml');
  writeGrainBlacklist(file, { pubkeys: ['cc'.repeat(32)], words: ['spam', 'badword'] });
  const back = readGrainBlacklist(file);
  assert.deepEqual(back.pubkeys, ['cc'.repeat(32)]);
  assert.deepEqual(back.words, ['spam', 'badword']);
});

test('readGrainBlacklist returns empty defaults on absent file', () => {
  const dir = mkTmp();
  const back = readGrainBlacklist(path.join(dir, 'blacklist.yml'));
  assert.deepEqual(back, { pubkeys: [], words: [] });
});

test('path helpers compose against the community dir', () => {
  const cdir = '/tmp/community-abc';
  assert.equal(communityConfigPath(cdir),    path.join(cdir, 'config.yml'));
  assert.equal(communityWhitelistPath(cdir), path.join(cdir, 'whitelist.yml'));
  assert.equal(communityBlacklistPath(cdir), path.join(cdir, 'blacklist.yml'));
});

test('communitiesRoot honors NOSTR_STATION_HOME override', () => {
  const prev = process.env.NOSTR_STATION_HOME;
  process.env.NOSTR_STATION_HOME = '/tmp/ns-test-home';
  try {
    assert.equal(communitiesRoot(), '/tmp/ns-test-home/communities');
  } finally {
    if (prev === undefined) delete process.env.NOSTR_STATION_HOME;
    else process.env.NOSTR_STATION_HOME = prev;
  }
});

// ---------------------------------------------------------------------
// relay_metadata.json — NIP-11 face served by GRAIN

import {
  defaultRelayMetadata, readRelayMetadata, writeRelayMetadata,
  communityRelayMetadataPath,
} from '../src/lib/community-yaml.ts';

test('defaultRelayMetadata returns opaque name + empty description', () => {
  const m = defaultRelayMetadata({ adminPubkey: 'aa'.repeat(32) });
  assert.match(m.name, /^private-relay-[0-9a-f]{8}$/,
    'default name must be an opaque private-relay-<hex> identifier');
  assert.equal(m.description, '',
    'default description must be empty so a port-probe leaks nothing');
  assert.equal(m.pubkey, 'aa'.repeat(32),
    'admin pubkey is included (already known via mesh roster — no new leak)');
  assert.equal(m.contact, '',
    'contact must default to empty so the user doesn\'t silently leak an email');
});

test('defaultRelayMetadata normalizes mixed-case admin pubkey to lowercase', () => {
  const m = defaultRelayMetadata({ adminPubkey: 'AB'.repeat(32) });
  assert.equal(m.pubkey, 'ab'.repeat(32));
});

test('write/read relay metadata round-trips faithfully', () => {
  const dir  = mkTmp();
  const file = path.join(dir, 'relay_metadata.json');
  const meta = defaultRelayMetadata({ adminPubkey: 'cd'.repeat(32) });
  writeRelayMetadata(file, meta);
  const back = readRelayMetadata(file);
  assert.deepEqual(back, meta);
});

test('readRelayMetadata returns null when the file is absent', () => {
  const dir = mkTmp();
  assert.equal(readRelayMetadata(path.join(dir, 'nope.json')), null);
});

test('readRelayMetadata returns null on malformed JSON (no throw)', () => {
  const dir  = mkTmp();
  const file = path.join(dir, 'relay_metadata.json');
  fs.writeFileSync(file, '{this is not json');
  assert.equal(readRelayMetadata(file), null);
});

test('communityRelayMetadataPath composes against the community dir', () => {
  assert.equal(
    communityRelayMetadataPath('/tmp/community-xyz'),
    path.join('/tmp/community-xyz', 'relay_metadata.json'),
  );
});

test('defaultRelayMetadata generates a fresh tag per call (entropy)', () => {
  const a = defaultRelayMetadata({ adminPubkey: 'aa'.repeat(32) });
  const b = defaultRelayMetadata({ adminPubkey: 'aa'.repeat(32) });
  assert.notEqual(a.name, b.name, 'two calls should produce two distinct identifiers');
});

// ---------------------------------------------------------------------
// coerceGrainPortValue — migration helper for legacy host:port configs
//
// nostr-station ≤ 0.0.7 wrote config.yml with `port: "127.0.0.1:7778"`
// (host:port form). GRAIN rejects that. The supervisor calls this
// helper on every spawn to auto-migrate; pin every input shape so a
// regression here can't silently brick a community dir at startup.

import { coerceGrainPortValue } from '../src/lib/community-yaml.ts';

test('coerceGrainPortValue: already port-only ":<n>" passes through', () => {
  assert.equal(coerceGrainPortValue(':7778'), ':7778');
  assert.equal(coerceGrainPortValue(':8081'), ':8081');
});

test('coerceGrainPortValue: legacy "host:port" strips host', () => {
  assert.equal(coerceGrainPortValue('127.0.0.1:7778'), ':7778');
  assert.equal(coerceGrainPortValue('10.42.0.5:9000'), ':9000');
});

test('coerceGrainPortValue: bracketed IPv6 + port strips host', () => {
  assert.equal(coerceGrainPortValue('[::1]:7778'),     ':7778');
  assert.equal(coerceGrainPortValue('[fe80::1]:9000'), ':9000');
});

test('coerceGrainPortValue: bare integer becomes ":<n>"', () => {
  assert.equal(coerceGrainPortValue(7778), ':7778');
  assert.equal(coerceGrainPortValue(80),   ':80');
});

test('coerceGrainPortValue: returns null for inputs we cannot parse', () => {
  assert.equal(coerceGrainPortValue(''),             null);
  assert.equal(coerceGrainPortValue('   '),          null);
  assert.equal(coerceGrainPortValue('not-a-port'),   null);
  assert.equal(coerceGrainPortValue(':abc'),         null);
  assert.equal(coerceGrainPortValue(null),           null);
  assert.equal(coerceGrainPortValue(undefined),      null);
  assert.equal(coerceGrainPortValue({}),             null);
  assert.equal(coerceGrainPortValue('127.0.0.1:abc'), null);
});

test('coerceGrainPortValue: rejects out-of-range ports', () => {
  assert.equal(coerceGrainPortValue(0),       null);
  assert.equal(coerceGrainPortValue(-1),      null);
  assert.equal(coerceGrainPortValue(65536),   null);
  assert.equal(coerceGrainPortValue(70000),   null);
  assert.equal(coerceGrainPortValue('1.2.3.4:0'),     null);
  assert.equal(coerceGrainPortValue('1.2.3.4:65536'), null);
});
