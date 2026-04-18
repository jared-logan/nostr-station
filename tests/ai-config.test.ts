import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { useTempHome, resetTempHome } from './_home.js';

// Must set HOME BEFORE importing ai-config — that module caches
// CONFIG_DIR/CONFIG_FILE as module-level constants at load time.
const HOME = useTempHome();
const CONFIG_FILE = path.join(HOME, '.nostr-station', 'ai-config.json');

const {
  readAiConfig,
  writeAiConfig,
  setProviderEntry,
  setDefault,
  migrateIfNeeded,
  // @ts-expect-error — imported at runtime, not checked against .d.ts
} = await import('../src/lib/ai-config.ts');

beforeEach(() => resetTempHome(HOME));

// ── read / write round-trip ───────────────────────────────────────────────

test('readAiConfig: returns empty config when file is missing', () => {
  const cfg = readAiConfig();
  assert.deepEqual(cfg, { providers: {}, defaults: {} });
});

test('readAiConfig: returns empty config on malformed JSON', () => {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, '{ not json');
  const cfg = readAiConfig();
  // Defensive parse — corrupt files must never throw to callers.
  assert.deepEqual(cfg, { providers: {}, defaults: {} });
});

test('readAiConfig: fills in missing fields from partial shapes', () => {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ providers: { anthropic: { model: 'x' } } }));
  const cfg = readAiConfig();
  assert.deepEqual(cfg.providers, { anthropic: { model: 'x' } });
  assert.deepEqual(cfg.defaults, {});
});

test('writeAiConfig: round-trip preserves structure', () => {
  writeAiConfig({
    providers: { anthropic: { model: 'claude-opus-4', keyRef: 'keychain:ai:anthropic' } },
    defaults: { chat: 'anthropic', terminal: 'claude-code' },
  });
  const cfg = readAiConfig();
  assert.equal(cfg.providers.anthropic.model, 'claude-opus-4');
  assert.equal(cfg.defaults.chat, 'anthropic');
  assert.equal(cfg.defaults.terminal, 'claude-code');
});

test('writeAiConfig: atomic write leaves no .tmp stragglers', () => {
  writeAiConfig({ providers: {}, defaults: {} });
  const dir = path.dirname(CONFIG_FILE);
  const leftovers = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
  assert.equal(leftovers.length, 0);
});

// ── setProviderEntry ──────────────────────────────────────────────────────

test('setProviderEntry: creates a new provider entry', () => {
  const cfg = setProviderEntry('anthropic', { keyRef: 'keychain:ai:anthropic' });
  assert.equal(cfg.providers.anthropic.keyRef, 'keychain:ai:anthropic');
});

test('setProviderEntry: merges into existing without clobbering', () => {
  setProviderEntry('anthropic', { keyRef: 'keychain:ai:anthropic', model: 'claude-opus-4' });
  // A second call that only supplies `knownModels` must NOT drop the
  // keyRef — user-facing regression: Config panel "Fetch models" used
  // to wipe the API key. Guard that contract here.
  const cfg = setProviderEntry('anthropic', { knownModels: ['claude-opus-4', 'claude-sonnet-4'] });
  assert.equal(cfg.providers.anthropic.keyRef, 'keychain:ai:anthropic');
  assert.equal(cfg.providers.anthropic.model, 'claude-opus-4');
  assert.deepEqual(cfg.providers.anthropic.knownModels, ['claude-opus-4', 'claude-sonnet-4']);
});

test('setProviderEntry: passing null deletes the entry', () => {
  setProviderEntry('anthropic', { keyRef: 'keychain:ai:anthropic' });
  setProviderEntry('openrouter', { keyRef: 'keychain:ai:openrouter' });
  const cfg = setProviderEntry('anthropic', null);
  assert.equal(cfg.providers.anthropic, undefined);
  assert.ok(cfg.providers.openrouter);
});

// ── setDefault ────────────────────────────────────────────────────────────

test('setDefault: sets chat and terminal independently', () => {
  setDefault('chat', 'anthropic');
  const cfg = setDefault('terminal', 'claude-code');
  assert.equal(cfg.defaults.chat, 'anthropic');
  assert.equal(cfg.defaults.terminal, 'claude-code');
});

test('setDefault: null unsets the default', () => {
  setDefault('chat', 'anthropic');
  const cfg = setDefault('chat', null);
  assert.equal(cfg.defaults.chat, undefined);
});

// ── migrateIfNeeded ───────────────────────────────────────────────────────

test('migrateIfNeeded: returns {migrated:false} when ai-config.json already exists', async () => {
  // Any existing file — even empty — counts as "user owns this state"
  // and must short-circuit the migration probe. Regressing this turns
  // every dashboard boot into a re-migration that could overwrite user
  // edits when the probe's inference differs from reality.
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, '{"providers":{},"defaults":{}}');
  const mtimeBefore = fs.statSync(CONFIG_FILE).mtimeMs;

  const r = await migrateIfNeeded();
  assert.equal(r.migrated, false);

  // And critically: must NOT rewrite the file (no mtime change).
  const mtimeAfter = fs.statSync(CONFIG_FILE).mtimeMs;
  assert.equal(mtimeBefore, mtimeAfter);
});

// NOTE: full-migration coverage (legacy ~/.claude_env + keychain → new
// per-provider layout) is deferred because it requires mocking
// getKeychain() — on macOS dev machines the MacOSKeychain backend shells
// out to `security`, which can surface or pollute the real user keychain.
// Making the keychain injectable is the cleanest way to test this path;
// filed as a follow-up.
