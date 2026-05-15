/**
 * NIP-78 settings sync tests (PR 10).
 *
 * Covers the local cache + applySettings merge logic + the
 * applyIncomingSettingsEvent parser path. The publish/sign side runs
 * through Amber and is exercised end-to-end with a paired bunker.
 */

import { useTempHome } from './_home.js';
useTempHome();

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { generateSecretKey, finalizeEvent } from 'nostr-tools/pure';
import { KIND_APP_DATA, APP_DATA_D_SETTINGS } from '../src/lib/mail/types.js';

// Dynamic import so settings-sync.ts loads AFTER useTempHome() has
// taken effect — its LOCAL_CACHE_PATH constant resolves against the
// then-current process.env.HOME. Static `import` statements are
// hoisted above top-level code, which would lock the path to the real
// home before useTempHome runs.
const { applySettings, applyIncomingSettingsEvent, readLocalSettings } =
  await import('../src/lib/mail/settings-sync.js');

// Settings persist to ~/.config/nostr-station/mail-settings.json. The
// module loads that path once at import-time, so even with useTempHome
// the cache file is shared across tests in this file. Reset it before
// each test to keep them order-independent.
function resetCache(): void {
  const p = path.join(os.homedir(), '.config', 'nostr-station', 'mail-settings.json');
  try { fs.rmSync(p, { force: true }); } catch {}
}

// Tests in this file mutate a shared on-disk cache (one file per
// HOME). Wrap them in a describe block so node:test runs them
// sequentially instead of with its default top-level concurrency.
describe('settings-sync', () => {

test('settings: readLocalSettings returns sensible defaults on a fresh install', () => {
  resetCache();
  const s = readLocalSettings();
  assert.equal(s.version, 1);
  assert.deepEqual(s.customFolders, []);
  assert.ok(s.inboxRelays.length > 0, 'fresh install ships with default inbox relays');
  assert.equal(s.updated_at, 0);
});

test('settings: applySettings ignores an older updated_at', () => {
  resetCache();
  applySettings({ customFolders: ['a', 'b'], updated_at: 100 });
  const r = applySettings({ customFolders: ['x'], updated_at: 50 });
  assert.equal(r.changed, false);
  assert.deepEqual(r.settings.customFolders, ['a', 'b']);
});

test('settings: applySettings merges a partial newer patch', () => {
  resetCache();
  applySettings({ customFolders: ['a'], updated_at: 100 });
  const r = applySettings({ inboxRelays: ['wss://example.test'], updated_at: 200 });
  assert.equal(r.changed, true);
  assert.deepEqual(r.settings.customFolders, ['a'], 'unchanged field carries over');
  assert.deepEqual(r.settings.inboxRelays,   ['wss://example.test']);
});

test('settings: applySettings rejects custom folders that collide with defaults', () => {
  resetCache();
  const r = applySettings({
    customFolders: ['archive', 'project-alpha', 'inbox', 'trash', 'my-folder'],
    updated_at: 1000,
  });
  assert.deepEqual(
    r.settings.customFolders.sort(),
    ['my-folder', 'project-alpha'],
    'default folder ids are filtered out of customFolders',
  );
});

test('settings: applySettings rejects ill-formed folder identifiers', () => {
  resetCache();
  const r = applySettings({
    customFolders: ['ok-folder', 'has spaces', 'has/slash', 'has@symbols', 'good_name'],
    updated_at: 2000,
  });
  assert.deepEqual(r.settings.customFolders.sort(), ['good_name', 'ok-folder']);
});

test('settings: applyIncomingSettingsEvent parses a kind 30078 with d=nostr-mail:settings', () => {
  resetCache();
  const sk = generateSecretKey();
  const updatedAt = 3000;
  const payload = {
    version: 1,
    customFolders: ['receipts'],
    inboxRelays: ['wss://inbox.example.test'],
  };
  const tpl = {
    kind: KIND_APP_DATA,
    created_at: updatedAt,
    tags: [['d', APP_DATA_D_SETTINGS]],
    content: JSON.stringify(payload),
  };
  const signed = finalizeEvent(tpl, sk);
  const changed = applyIncomingSettingsEvent(signed as any);
  assert.equal(changed, true);
  const s = readLocalSettings();
  assert.deepEqual(s.customFolders, ['receipts']);
  assert.deepEqual(s.inboxRelays,   ['wss://inbox.example.test']);
  assert.equal(s.updated_at, updatedAt);
});

test('settings: applyIncomingSettingsEvent rejects wrong d-tag', () => {
  resetCache();
  const sk = generateSecretKey();
  const tpl = {
    kind: KIND_APP_DATA,
    created_at: 9000,
    tags: [['d', 'some-other-app:settings']],
    content: JSON.stringify({ customFolders: ['evil'] }),
  };
  const signed = finalizeEvent(tpl, sk);
  const changed = applyIncomingSettingsEvent(signed as any);
  assert.equal(changed, false);
  // The unrelated app's data didn't leak into our cache.
  const s = readLocalSettings();
  assert.equal(s.customFolders.includes('evil'), false);
});

test('settings: applyIncomingSettingsEvent rejects non-30078 kinds', () => {
  resetCache();
  const sk = generateSecretKey();
  const tpl = {
    kind: 1,
    created_at: 9999,
    tags: [['d', APP_DATA_D_SETTINGS]],
    content: JSON.stringify({ customFolders: ['evil'] }),
  };
  const signed = finalizeEvent(tpl, sk);
  assert.equal(applyIncomingSettingsEvent(signed as any), false);
});

test('settings: applyIncomingSettingsEvent handles malformed JSON gracefully', () => {
  resetCache();
  const sk = generateSecretKey();
  const tpl = {
    kind: KIND_APP_DATA,
    created_at: 10_000,
    tags: [['d', APP_DATA_D_SETTINGS]],
    content: 'not json at all',
  };
  const signed = finalizeEvent(tpl, sk);
  assert.equal(applyIncomingSettingsEvent(signed as any), false);
});

test('settings: empty inboxRelays array falls back to defaults', () => {
  resetCache();
  const r = applySettings({ inboxRelays: [], updated_at: Date.now() / 1000 });
  assert.ok(r.settings.inboxRelays.length > 0,
    'empty list is invalid (worker has nothing to subscribe to); defaults restored');
});

}); // describe('settings-sync')
