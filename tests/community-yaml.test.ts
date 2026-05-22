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

test('writeGrainConfig + readGrainConfig round-trip a host:port bind', () => {
  const dir  = mkTmp();
  const file = path.join(dir, 'config.yml');
  const cfg  = defaultGrainConfig({ bindHostPort: '127.0.0.1:7778' });
  writeGrainConfig(file, cfg);
  const back = readGrainConfig(file);
  assert.equal(back.server.port, '127.0.0.1:7778');
});

test('writeGrainConfig + readGrainConfig preserves IPv6 + leading-colon port', () => {
  const dir  = mkTmp();
  const file = path.join(dir, 'config.yml');
  for (const bind of ['[::1]:7778', ':8181', '10.42.0.5:7778']) {
    writeGrainConfig(file, defaultGrainConfig({ bindHostPort: bind }));
    const back = readGrainConfig(file);
    assert.equal(back.server.port, bind, `${bind} did not round-trip`);
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
