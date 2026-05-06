import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { useTempHome, resetTempHome } from './_home.js';

const HOME = useTempHome();

// @ts-expect-error — runtime import of .ts; tsx handles resolution
const editor = await import('../src/lib/editor.ts');
const {
  seedStationContext,
  buildStationContextSeed,
  extractUserRegion,
  USER_REGION_BEGIN,
  USER_REGION_END,
} = editor;

const SEED_PATH = path.join(HOME, 'nostr-station', 'projects', 'NOSTR_STATION.md');

test('seedStationContext: writes the slim Nori persona on first run', () => {
  resetTempHome(HOME);
  const written = seedStationContext();
  assert.equal(written, SEED_PATH);
  const body = fs.readFileSync(SEED_PATH, 'utf8');
  // Spot-check identity + structural anchors that callers depend on.
  assert.match(body, /You are Nori/);
  assert.match(body, /## Your role/);
  assert.match(body, /## Nostr \/ NIP reference/);
  assert.match(body, /## Available commands/);
  assert.ok(body.includes(USER_REGION_BEGIN));
  assert.ok(body.includes(USER_REGION_END));
});

test('seedStationContext: idempotent — never overwrites existing file', () => {
  resetTempHome(HOME);
  fs.mkdirSync(path.dirname(SEED_PATH), { recursive: true });
  // Hand-authored body with developer prose inside the user region.
  const handAuthored = [
    '# My custom station context',
    '',
    USER_REGION_BEGIN,
    'Always sign with bunker A.',
    USER_REGION_END,
    '',
  ].join('\n');
  fs.writeFileSync(SEED_PATH, handAuthored);

  const returned = seedStationContext();
  assert.equal(returned, SEED_PATH);
  assert.equal(fs.readFileSync(SEED_PATH, 'utf8'), handAuthored);
});

test('seedStationContext: writes through a missing parent directory', () => {
  resetTempHome(HOME);
  // Parent directory ~/nostr-station/projects does not exist yet.
  assert.equal(fs.existsSync(path.dirname(SEED_PATH)), false);
  seedStationContext();
  assert.equal(fs.existsSync(SEED_PATH), true);
});

test('buildStationContextSeed: empty user region round-trips through extractUserRegion', () => {
  // The seed ships with empty markers so the developer's first edit
  // round-trips cleanly via extractUserRegion (no stray newline that
  // would slowly accumulate on hypothetical future regenerations).
  const body = buildStationContextSeed();
  assert.equal(extractUserRegion(body), '');
});
