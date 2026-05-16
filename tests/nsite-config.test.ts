/**
 * nsite-config — read/write JSON config at ~/.config/nostr-station/nsite.json.
 * Covers default fill-in, sanitization on read, validation on write, and
 * the env-var-precedence semantics that the route layer relies on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { useTempHome } from './_home.js';
const HOME = useTempHome();

// @ts-expect-error — runtime .ts import
const mod = await import('../src/lib/nsite-config.ts');
const {
  readNsiteConfig, writeNsiteConfig, defaultNsiteConfig, nsiteConfigPath,
} = mod;

const CFG_DIR  = path.join(HOME, '.config', 'nostr-station');
const CFG_FILE = path.join(CFG_DIR, 'nsite.json');

function writeRaw(content: string) {
  fs.mkdirSync(CFG_DIR, { recursive: true });
  fs.writeFileSync(CFG_FILE, content);
}
function rmCfg() { try { fs.unlinkSync(CFG_FILE); } catch {} }

test('defaultNsiteConfig: includes Titan-mirrored content fallback', () => {
  const d = defaultNsiteConfig();
  assert.ok(d.contentRelays.includes('wss://relay.westernbtc.com'),
    'content fallback should include Titan’s primary content relay');
  assert.match(d.nsitIndexerPubkey, /^[0-9a-f]{64}$/);
});

test('readNsiteConfig: returns defaults when file is missing', () => {
  rmCfg();
  const cfg = readNsiteConfig();
  const def = defaultNsiteConfig();
  assert.deepEqual(cfg.contentRelays, def.contentRelays);
  assert.equal(cfg.nsitIndexerPubkey, def.nsitIndexerPubkey);
});

test('readNsiteConfig: tolerates malformed JSON without throwing', () => {
  writeRaw('{not valid json');
  const cfg = readNsiteConfig();
  // Should be defaults — corruption doesn't kill the resolve endpoint.
  assert.deepEqual(cfg, defaultNsiteConfig());
});

test('readNsiteConfig: sanitizes bad relay rows out of the array', () => {
  writeRaw(JSON.stringify({
    contentRelays: [
      'wss://good.example',
      'https://wrong-scheme.example',  // dropped — not wss
      '',                              // dropped — empty
      42,                              // dropped — not a string
      'wss://also-good.example',
    ],
  }));
  const cfg = readNsiteConfig();
  assert.deepEqual(cfg.contentRelays, [
    'wss://good.example',
    'wss://also-good.example',
  ]);
});

test('readNsiteConfig: trailing slash stripped on relay URLs', () => {
  writeRaw(JSON.stringify({
    contentRelays: ['wss://x.example/', 'wss://y.example////'],
  }));
  const cfg = readNsiteConfig();
  assert.deepEqual(cfg.contentRelays, ['wss://x.example', 'wss://y.example']);
});

test('readNsiteConfig: missing fields fall back to defaults individually', () => {
  writeRaw(JSON.stringify({
    contentRelays: ['wss://only-this.example'],
  }));
  const cfg = readNsiteConfig();
  const def = defaultNsiteConfig();
  assert.deepEqual(cfg.contentRelays, ['wss://only-this.example']);
  // Other fields default since not specified.
  assert.deepEqual(cfg.discoveryRelays, def.discoveryRelays);
  assert.deepEqual(cfg.blossomServers, def.blossomServers);
});

test('readNsiteConfig: invalid pubkey is replaced with default', () => {
  writeRaw(JSON.stringify({ nsitIndexerPubkey: 'not-hex-no-no' }));
  const cfg = readNsiteConfig();
  assert.equal(cfg.nsitIndexerPubkey, defaultNsiteConfig().nsitIndexerPubkey);
});

test('writeNsiteConfig: round-trips a full update', () => {
  rmCfg();
  const written = writeNsiteConfig({
    contentRelays:     ['wss://a.example'],
    discoveryRelays:   ['wss://b.example'],
    blossomServers:    ['https://c.example'],
    nsitIndexerPubkey: 'a'.repeat(64),
    nsitIndexerRelays: ['wss://d.example'],
  });
  assert.deepEqual(written.contentRelays, ['wss://a.example']);
  // File on disk matches.
  const reread = readNsiteConfig();
  assert.deepEqual(reread, written);
});

test('writeNsiteConfig: bad relay rows are silently dropped (forgiving)', () => {
  rmCfg();
  const written = writeNsiteConfig({
    contentRelays: ['wss://ok.example', 'not a url', 'https://wrong.example'],
  });
  // The bad rows drop; the good one survives.
  assert.deepEqual(written.contentRelays, ['wss://ok.example']);
});

test('writeNsiteConfig: malformed pubkey throws (loud failure)', () => {
  rmCfg();
  assert.throws(
    () => writeNsiteConfig({ nsitIndexerPubkey: 'definitely-not-hex' }),
    /64-hex/,
  );
});

test('writeNsiteConfig: "disabled" pubkey accepted to turn NSIT off', () => {
  rmCfg();
  const w = writeNsiteConfig({ nsitIndexerPubkey: 'disabled' });
  assert.equal(w.nsitIndexerPubkey, 'disabled');
});

test('writeNsiteConfig: empty pubkey accepted (re-enables default)', () => {
  rmCfg();
  const w = writeNsiteConfig({ nsitIndexerPubkey: '' });
  assert.equal(w.nsitIndexerPubkey, '');
});

test('nsiteConfigPath: lives under ~/.config/nostr-station', () => {
  assert.equal(nsiteConfigPath(), CFG_FILE);
});

// ── trustedExternalNsites ───────────────────────────────────────────────
//
// Per-pubkey allowlist for relaxing the iframe CSP so external HTTPS
// loads (esm.sh modules, nostr.build images, fonts, etc.) work for
// nsites the user has explicitly opted into. Lives alongside the relay/
// blossom config since it's the same nsite.json file and the same
// "things the user decides about how nsite browsing works" surface.

test('readNsiteConfig: trustedExternalNsites defaults to [] when missing', () => {
  rmCfg();
  const r = readNsiteConfig();
  assert.deepEqual(r.trustedExternalNsites, []);
});

test('readNsiteConfig: trustedExternalNsites accepts well-formed 64-hex pubkeys', () => {
  rmCfg();
  const pk = 'a'.repeat(64);
  fs.mkdirSync(path.dirname(CFG_FILE), { recursive: true });
  fs.writeFileSync(CFG_FILE, JSON.stringify({ trustedExternalNsites: [pk] }));
  const r = readNsiteConfig();
  assert.deepEqual(r.trustedExternalNsites, [pk]);
});

test('readNsiteConfig: trustedExternalNsites lowercases + dedupes + drops malformed rows', () => {
  rmCfg();
  const pkA = 'a'.repeat(64);
  const pkB = 'b'.repeat(64);
  fs.mkdirSync(path.dirname(CFG_FILE), { recursive: true });
  fs.writeFileSync(CFG_FILE, JSON.stringify({
    trustedExternalNsites: [
      pkA.toUpperCase(),  // upper-case → lowercased
      pkA,                // duplicate → dropped
      'not-hex',          // malformed → dropped
      pkB,                // valid → kept
      '',                 // empty → dropped
    ],
  }));
  const r = readNsiteConfig();
  assert.deepEqual(r.trustedExternalNsites, [pkA, pkB],
    'output is lowercased, deduplicated, with malformed rows silently dropped');
});

test('writeNsiteConfig: trustedExternalNsites round-trips through the file', () => {
  rmCfg();
  const pk = 'c'.repeat(64);
  const w = writeNsiteConfig({ trustedExternalNsites: [pk] });
  assert.deepEqual(w.trustedExternalNsites, [pk]);
  const r = readNsiteConfig();
  assert.deepEqual(r.trustedExternalNsites, [pk]);
});

test('writeNsiteConfig: trustedExternalNsites drops malformed rows like other arrays', () => {
  // Same shape as the relay rows — we forgive bad input rather than
  // throwing on the array as a whole, so the user doesn't lose every
  // good entry just because one is malformed.
  rmCfg();
  const pk = 'd'.repeat(64);
  const w = writeNsiteConfig({
    trustedExternalNsites: ['nope', pk, 123 as any, ''],
  });
  assert.deepEqual(w.trustedExternalNsites, [pk]);
});

test('writeNsiteConfig: empty trustedExternalNsites array CLEARS the list', () => {
  rmCfg();
  const pk = 'e'.repeat(64);
  writeNsiteConfig({ trustedExternalNsites: [pk] });
  const cleared = writeNsiteConfig({ trustedExternalNsites: [] });
  assert.deepEqual(cleared.trustedExternalNsites, [],
    'passing an empty array must be how a user revokes all trust at once');
});

test('writeNsiteConfig: omitting trustedExternalNsites preserves the existing list', () => {
  // Same shape as the other fields: undefined = leave alone, array = replace.
  rmCfg();
  const pk = 'f'.repeat(64);
  writeNsiteConfig({ trustedExternalNsites: [pk] });
  const r = writeNsiteConfig({ contentRelays: ['wss://example/'] });
  assert.deepEqual(r.trustedExternalNsites, [pk],
    'editing a different field must not clear the trust list');
});
