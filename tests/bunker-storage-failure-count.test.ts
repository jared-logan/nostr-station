import { test } from 'node:test';
import assert from 'node:assert/strict';

import { useTempHome, resetTempHome } from './_home.js';
const HOME = useTempHome();

// @ts-expect-error — runtime .ts import; tsx handles resolution
const storage = await import('../src/lib/bunker-storage.ts');

const NPUB = 'npub10000000000000000000000000000000000000000000000000000000000000';

function seed(): void {
  storage.writeSavedBunkerClient({
    ownerNpub: NPUB,
    clientSecretHex: 'a'.repeat(64),
    bunker: { relays: ['wss://relay.nsec.app'], pubkey: 'b'.repeat(64), secret: null },
    savedAt: Date.now(),
  });
}

test('recordSilentFailure: first two failures bump counter but keep pairing', () => {
  resetTempHome(HOME);
  seed();

  const r1 = storage.recordSilentFailure(NPUB);
  assert.equal(r1.cleared, false);
  assert.equal(storage.readSavedBunkerClient(NPUB)?.failureCount, 1);

  const r2 = storage.recordSilentFailure(NPUB);
  assert.equal(r2.cleared, false);
  assert.equal(storage.readSavedBunkerClient(NPUB)?.failureCount, 2);

  // Pairing still readable — the bug we're guarding against was a single
  // flaky-wifi failure permanently nuking the saved client.
  assert.ok(storage.readSavedBunkerClient(NPUB));
});

test('recordSilentFailure: third consecutive failure clears the pairing', () => {
  resetTempHome(HOME);
  seed();

  storage.recordSilentFailure(NPUB);
  storage.recordSilentFailure(NPUB);
  const r3 = storage.recordSilentFailure(NPUB);

  assert.equal(r3.cleared, true);
  assert.equal(storage.readSavedBunkerClient(NPUB), null);
});

test('recordSilentSuccess: zeroes the counter mid-streak', () => {
  resetTempHome(HOME);
  seed();

  storage.recordSilentFailure(NPUB);
  storage.recordSilentFailure(NPUB);
  assert.equal(storage.readSavedBunkerClient(NPUB)?.failureCount, 2);

  storage.recordSilentSuccess(NPUB);
  assert.equal(storage.readSavedBunkerClient(NPUB)?.failureCount, 0);

  // Counter reset → the next failure starts the streak from 1, not 3.
  const r = storage.recordSilentFailure(NPUB);
  assert.equal(r.cleared, false);
  assert.equal(storage.readSavedBunkerClient(NPUB)?.failureCount, 1);
});

test('recordSilentSuccess / recordSilentFailure: no-op when no saved pairing', () => {
  resetTempHome(HOME);
  // No seed — file does not exist.

  // Neither should throw, and neither should create the file.
  storage.recordSilentSuccess(NPUB);
  storage.recordSilentFailure(NPUB);
  assert.equal(storage.readSavedBunkerClient(NPUB), null);
});

test('legacy saves (no failureCount field) survive a successful re-auth', () => {
  resetTempHome(HOME);
  // Pre-feature payloads omit failureCount entirely. recordSilentSuccess
  // must NOT rewrite the file just to set failureCount: 0 — that would
  // bump the mtime + atomic-rename on every login for no value, and
  // readSavedBunkerClient must keep returning the entry unchanged.
  storage.writeSavedBunkerClient({
    ownerNpub: NPUB,
    clientSecretHex: 'c'.repeat(64),
    bunker: { relays: ['wss://relay.damus.io'], pubkey: 'd'.repeat(64), secret: null },
    savedAt: 1,
  });
  const before = storage.readSavedBunkerClient(NPUB);
  assert.ok(before);
  assert.equal(before!.failureCount, undefined);

  storage.recordSilentSuccess(NPUB);
  const after = storage.readSavedBunkerClient(NPUB);
  assert.equal(after?.failureCount, undefined);
  assert.equal(after?.savedAt, 1);
});
