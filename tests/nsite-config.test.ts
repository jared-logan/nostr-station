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

// ── bookmarks ────────────────────────────────────────────────────────────

test('readNsiteConfig: bookmarks defaults to [] when missing', () => {
  rmCfg();
  const r = readNsiteConfig();
  assert.deepEqual(r.bookmarks, []);
});

test('readNsiteConfig: bookmarks round-trip with full fields', () => {
  rmCfg();
  const pk = 'a'.repeat(64);
  const bm = { pubkey: pk, name: 'titan', addr: 'nsite://titan', display: 'nsite://titan', addedAt: 1700000000 };
  fs.mkdirSync(path.dirname(CFG_FILE), { recursive: true });
  fs.writeFileSync(CFG_FILE, JSON.stringify({ bookmarks: [bm] }));
  const r = readNsiteConfig();
  assert.deepEqual(r.bookmarks, [bm]);
});

test('readNsiteConfig: bookmarks drops malformed entries (bad pubkey, missing addr)', () => {
  rmCfg();
  const pk = 'b'.repeat(64);
  fs.mkdirSync(path.dirname(CFG_FILE), { recursive: true });
  fs.writeFileSync(CFG_FILE, JSON.stringify({
    bookmarks: [
      { pubkey: pk, name: '', addr: 'nsite://x', display: 'x', addedAt: 1700000000 }, // valid
      { pubkey: 'not-hex', name: 'bad', addr: 'nsite://y' },                            // bad pubkey
      { pubkey: pk, name: 'no-addr' },                                                  // missing addr
      'totally-wrong',                                                                  // wrong type
      null,                                                                             // null
    ],
  }));
  const r = readNsiteConfig();
  assert.equal(r.bookmarks.length, 1);
  assert.equal(r.bookmarks[0].pubkey, pk);
});

test('readNsiteConfig: bookmarks dedupe on pubkey+name (different names stay distinct)', () => {
  rmCfg();
  const pk = 'c'.repeat(64);
  fs.mkdirSync(path.dirname(CFG_FILE), { recursive: true });
  fs.writeFileSync(CFG_FILE, JSON.stringify({
    bookmarks: [
      { pubkey: pk, name: 'project-a', addr: 'nsite://project-a', display: 'A', addedAt: 1700000000 },
      { pubkey: pk, name: 'project-a', addr: 'nsite://project-a', display: 'A2', addedAt: 1700000100 }, // dup pubkey+name
      { pubkey: pk, name: 'project-b', addr: 'nsite://project-b', display: 'B',  addedAt: 1700000200 }, // distinct name
    ],
  }));
  const r = readNsiteConfig();
  assert.equal(r.bookmarks.length, 2, 'pubkey+name dedupe collapses same-keyed entries');
  // Sort order: newest first by addedAt — so project-b first.
  assert.equal(r.bookmarks[0].name, 'project-b');
  assert.equal(r.bookmarks[1].name, 'project-a');
});

test('writeNsiteConfig: bookmarks round-trip + sanitization', () => {
  rmCfg();
  const pk = 'd'.repeat(64);
  const w = writeNsiteConfig({
    bookmarks: [
      { pubkey: pk, name: 'site', addr: 'nsite://site', display: 'site', addedAt: 1700000000 },
      { pubkey: 'bad-row', addr: 'x' },  // dropped
    ] as any,
  });
  assert.equal(w.bookmarks.length, 1);
  assert.equal(w.bookmarks[0].pubkey, pk);
  // Re-read confirms persistence.
  assert.equal(readNsiteConfig().bookmarks.length, 1);
});

test('writeNsiteConfig: empty bookmarks array CLEARS the list', () => {
  rmCfg();
  const pk = 'e'.repeat(64);
  writeNsiteConfig({ bookmarks: [{ pubkey: pk, name: '', addr: 'x', display: 'x', addedAt: 0 }] as any });
  const cleared = writeNsiteConfig({ bookmarks: [] });
  assert.deepEqual(cleared.bookmarks, [],
    'passing an empty array must be how a user clears all bookmarks at once');
});

test('writeNsiteConfig: omitting bookmarks preserves the existing list', () => {
  rmCfg();
  const pk = '0'.repeat(64);
  writeNsiteConfig({ bookmarks: [{ pubkey: pk, name: '', addr: 'x', display: 'x', addedAt: 0 }] as any });
  const r = writeNsiteConfig({ contentRelays: ['wss://example'] });
  assert.equal(r.bookmarks.length, 1, 'editing a different field must not clear bookmarks');
});

// ── deploy targets (App / Your model + effective union) ──────────────────────

const {
  effectiveDeployBlossomServers, effectiveDeployRelays,
} = mod;

test('defaultNsiteConfig: deploy lists empty, app toggles on', () => {
  const d = defaultNsiteConfig();
  assert.deepEqual(d.deployBlossomServers, []);
  assert.deepEqual(d.deployRelays, []);
  assert.equal(d.deployBlossomAppEnabled, true);
  assert.equal(d.deployRelayAppEnabled, true);
});

test('effectiveDeployBlossomServers: app defaults when user list empty + toggle on', () => {
  const cfg = defaultNsiteConfig();
  const eff = effectiveDeployBlossomServers(cfg);
  assert.ok(eff.includes('https://blossom.ditto.pub'));
  assert.ok(eff.length >= 3);
});

test('effectiveDeployBlossomServers: user list first, app defaults unioned after', () => {
  const cfg = { ...defaultNsiteConfig(), deployBlossomServers: ['https://my.blossom'] };
  const eff = effectiveDeployBlossomServers(cfg);
  assert.equal(eff[0], 'https://my.blossom');
  assert.ok(eff.includes('https://blossom.ditto.pub'));
});

test('effectiveDeployBlossomServers: toggle off → user list alone', () => {
  const cfg = { ...defaultNsiteConfig(), deployBlossomServers: ['https://my.blossom'], deployBlossomAppEnabled: false };
  assert.deepEqual(effectiveDeployBlossomServers(cfg), ['https://my.blossom']);
});

test('effectiveDeployBlossomServers: toggle off + empty user list → falls back to defaults (never zero targets)', () => {
  const cfg = { ...defaultNsiteConfig(), deployBlossomServers: [], deployBlossomAppEnabled: false };
  const eff = effectiveDeployBlossomServers(cfg);
  assert.ok(eff.length >= 3, 'a deploy must never have zero blossom targets');
});

test('effectiveDeployBlossomServers: dedupes user/app overlap case-insensitively', () => {
  const cfg = { ...defaultNsiteConfig(), deployBlossomServers: ['https://blossom.ditto.pub'] };
  const eff = effectiveDeployBlossomServers(cfg);
  assert.equal(eff.filter(s => s.toLowerCase() === 'https://blossom.ditto.pub').length, 1);
});

test('effectiveDeployRelays: app defaults include the gateway relay', () => {
  const eff = effectiveDeployRelays(defaultNsiteConfig());
  assert.ok(eff.includes('wss://relay.nsite.lol'));
});

test('readNsiteConfig: round-trips deploy fields + toggles', () => {
  rmCfg();
  writeNsiteConfig({
    deployBlossomServers: ['https://a.blossom', 'not-a-url', 'https://b.blossom'],
    deployRelays: ['wss://r.one', 'http://bad'],
    deployBlossomAppEnabled: false,
    deployRelayAppEnabled: true,
  });
  const c = readNsiteConfig();
  assert.deepEqual(c.deployBlossomServers, ['https://a.blossom', 'https://b.blossom']); // bad row dropped
  assert.deepEqual(c.deployRelays, ['wss://r.one']);                                    // non-wss dropped
  assert.equal(c.deployBlossomAppEnabled, false);
  assert.equal(c.deployRelayAppEnabled, true);
});

test('writeNsiteConfig: empty deploy array clears the user list', () => {
  rmCfg();
  writeNsiteConfig({ deployBlossomServers: ['https://x.blossom'] });
  const cleared = writeNsiteConfig({ deployBlossomServers: [] });
  assert.deepEqual(cleared.deployBlossomServers, []);
});
