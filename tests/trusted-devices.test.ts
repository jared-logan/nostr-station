import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hexToNpub } from '../src/lib/identity.ts';
import {
  normalizeTrustedPubkey, readTrustedDevices, addTrustedDevice, removeTrustedDevice,
} from '../src/lib/trusted-devices.ts';
import { trustedDevicePubkeys, _resetDashboardBindingCacheForTests } from '../src/lib/dashboard-binding.ts';

// Synthetic keys only (minted from the backend encoder) — never a real pubkey.
const HEX_A = 'aa'.repeat(32);
const HEX_B = 'bb'.repeat(32);
const NPUB_A = hexToNpub(HEX_A);
const NPUB_B = hexToNpub(HEX_B);

// Point $HOME at a throwaway dir so the allowlist file is isolated per test
// (os.homedir() honors $HOME on POSIX).
function freshHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trusted-dev-'));
  process.env.HOME = dir;
  _resetDashboardBindingCacheForTests();
  return dir;
}

test('normalizeTrustedPubkey: hex passthrough, npub→hex, rejects junk', () => {
  assert.equal(normalizeTrustedPubkey(HEX_A), HEX_A);
  assert.equal(normalizeTrustedPubkey(HEX_A.toUpperCase()), HEX_A);
  assert.equal(normalizeTrustedPubkey(NPUB_A), HEX_A);
  for (const j of ['', 'nope', 'npub1zzz', 'deadbeef', '  ', null as any]) {
    assert.equal(normalizeTrustedPubkey(j), null, String(j));
  }
});

test('add: stores canonical hex (from npub), dedups, no-ops on repeat', () => {
  freshHome();
  assert.deepEqual(readTrustedDevices().pubkeys, []);
  const r1 = addTrustedDevice(NPUB_A);
  assert.equal(r1.ok, true);
  assert.deepEqual(r1.pubkeys, [HEX_A]);            // npub normalized to hex
  // adding the same key (in hex this time) is a no-op, not a duplicate
  const r2 = addTrustedDevice(HEX_A);
  assert.equal(r2.detail, 'already trusted');
  assert.deepEqual(readTrustedDevices().pubkeys, [HEX_A]);
});

test('add: rejects an invalid pubkey without storing it', () => {
  freshHome();
  const r = addTrustedDevice('not-a-key');
  assert.equal(r.ok, false);
  assert.match(r.detail, /valid npub or 64-char hex/);
  assert.deepEqual(readTrustedDevices().pubkeys, []);
});

test('remove: drops the key (either encoding); missing key is a benign no-op', () => {
  freshHome();
  addTrustedDevice(HEX_A);
  addTrustedDevice(HEX_B);
  // remove by npub even though it was added by hex
  const r = removeTrustedDevice(NPUB_A);
  assert.equal(r.ok, true);
  assert.deepEqual(r.pubkeys, [HEX_B]);
  const r2 = removeTrustedDevice(HEX_A);
  assert.equal(r2.detail, 'not in the list');
});

test('read: re-validates on load, dropping hand-edited junk (fail safe)', () => {
  const home = freshHome();
  const file = path.join(home, '.nostr-station', 'trusted-devices.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // A file someone hand-edited: one good key, plus junk + a dup.
  fs.writeFileSync(file, JSON.stringify({ pubkeys: [HEX_A, 'garbage', HEX_A, 123] }));
  assert.deepEqual(readTrustedDevices().pubkeys, [HEX_A]);
});

test('read: 0600 file / 0700 dir (only the owner can change who is trusted)', () => {
  const home = freshHome();
  addTrustedDevice(HEX_A);
  const file = path.join(home, '.nostr-station', 'trusted-devices.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
});

test('trustedDevicePubkeys: includes explicitly-added devices (the #240 gate now admits them)', () => {
  freshHome(); // no identity.json → owner is null, isolating the allowlist contribution
  assert.equal(trustedDevicePubkeys().has(HEX_A), false);
  addTrustedDevice(NPUB_A);
  addTrustedDevice(HEX_B);
  _resetDashboardBindingCacheForTests();
  const set = trustedDevicePubkeys();
  assert.equal(set.has(HEX_A), true);
  assert.equal(set.has(HEX_B), true);
});
