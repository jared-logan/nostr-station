import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

import { useTempHome, resetTempHome } from './_home.js';
const HOME = useTempHome();

// keychain.ts caches its singleton at module level. We reset between tests
// via the exported _resetKeychainCache so each test gets a fresh selection
// against the env we just set.
// @ts-expect-error — runtime import of .ts; tsx handles the resolution
const kc = await import('../src/lib/keychain.ts');

beforeEach(() => {
  resetTempHome(HOME);
  delete process.env.STATION_MODE;
  delete process.env.KEYCHAIN_DIR;
  kc._resetKeychainCache();
});

test('container mode pins the encrypted-file backend', () => {
  process.env.STATION_MODE = 'container';
  process.env.KEYCHAIN_DIR = path.join(HOME, 'keys');
  const backend = kc.getKeychain();
  assert.match(backend.backendName(), /encrypted file/);
  assert.match(backend.backendName(), /keys[/\\]secrets/);
});

test('container mode round-trips a stored secret', async () => {
  process.env.STATION_MODE = 'container';
  process.env.KEYCHAIN_DIR = path.join(HOME, 'keys');
  const backend = kc.getKeychain();
  await backend.store('watchdog-nsec', 'nsec1deadbeef');
  const out = await backend.retrieve('watchdog-nsec');
  assert.equal(out, 'nsec1deadbeef');
});

test('persisted KEK survives instance recreation (container rebuild simulation)', async () => {
  const dir = path.join(HOME, 'keys');
  process.env.STATION_MODE = 'container';
  process.env.KEYCHAIN_DIR = dir;

  // Round 1: store a secret. KEK is generated and persisted to disk.
  const backend1 = kc.getKeychain();
  await backend1.store('seed-nsec', 'shared-secret-value');

  // Verify the KEK file landed at the expected path (named volume location).
  const kekPath = path.join(dir, '.kek');
  assert.equal(fs.existsSync(kekPath), true);
  assert.equal(fs.statSync(kekPath).size, 32);

  // Round 2: simulate a container rebuild — fresh process, new singleton,
  // same volume. Reset the cached instance so getKeychain() reconstructs
  // the backend from scratch.
  kc._resetKeychainCache();
  const backend2 = kc.getKeychain();
  assert.notEqual(backend1, backend2);

  // The persisted KEK should let backend2 decrypt what backend1 wrote.
  const out = await backend2.retrieve('seed-nsec');
  assert.equal(out, 'shared-secret-value');
});

test('non-container mode does NOT persist a KEK file', async () => {
  // No STATION_MODE set — falls through to platform-default selection.
  // On Linux without secret-tool (the dev container), this picks
  // EncryptedFileBackend in NON-persisted-KEK mode (machine-id derived).
  // We just verify no .kek file is written; we don't care which backend.
  const backend = kc.getKeychain();
  if (backend.backendName().includes('encrypted file')) {
    await backend.store('watchdog-nsec', 'val');
    const expectedKek = path.join(HOME, '.config', 'nostr-station', '.kek');
    assert.equal(fs.existsSync(expectedKek), false,
      'non-container mode must not persist a KEK file');
  }
  // Other backends (macOS Keychain, GNOME Keyring) — nothing to assert here.
});

test('KEYCHAIN_DIR override is honored', () => {
  const customDir = path.join(HOME, 'custom-keys-location');
  process.env.STATION_MODE = 'container';
  process.env.KEYCHAIN_DIR = customDir;
  const backend = kc.getKeychain();
  assert.match(backend.backendName(), new RegExp(customDir.replace(/\//g, '[/\\\\]')));
});
