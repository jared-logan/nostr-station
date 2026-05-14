/**
 * App Relays / effective read-relay tests.
 *
 * Covers identity.ts's new shape:
 *   - getEffectiveReadRelays() returns the union of App Relays + Your Relays
 *     when the toggle is on
 *   - the same helper drops App Relays when the toggle is off
 *   - setAppRelaysEnabled() persists the flag
 *   - readIdentity() defaults the flag to true (so brand-new installs get
 *     the curated defaults without flipping a switch)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { useTempHome } from './_home.js';
const HOME = useTempHome();

// @ts-expect-error — runtime import of .ts; tsx handles the resolution
const identity = await import('../src/lib/identity.ts');

function writeIdentityJson(partial: any): void {
  const dir = path.join(HOME, '.config', 'nostr-station');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'identity.json'), JSON.stringify(partial), 'utf8');
}

test('identity: appRelaysEnabled defaults to true on fresh install', () => {
  // No identity.json — readIdentity falls through to the empty default.
  const ident = identity.readIdentity();
  // Fresh installs hit the catch branch, which seeds appRelaysEnabled: true.
  assert.equal(ident.appRelaysEnabled, true);
});

test('identity: getEffectiveReadRelays merges App Relays + Your Relays', () => {
  writeIdentityJson({
    npub: '',
    readRelays: ['wss://my-relay.example'],
    appRelaysEnabled: true,
  });
  const eff = identity.getEffectiveReadRelays();
  assert.ok(eff.includes('wss://my-relay.example'), 'user relay must be present');
  for (const r of identity.DEFAULT_READ_RELAYS) {
    assert.ok(eff.includes(r), `app relay ${r} must be present when toggle is on`);
  }
});

test('identity: getEffectiveReadRelays excludes App Relays when toggled off', () => {
  writeIdentityJson({
    npub: '',
    readRelays: ['wss://my-relay.example'],
    appRelaysEnabled: false,
  });
  const eff = identity.getEffectiveReadRelays();
  assert.deepEqual(eff, ['wss://my-relay.example']);
});

test('identity: getEffectiveReadRelays dedupes overlap between App + Your', () => {
  writeIdentityJson({
    npub: '',
    readRelays: ['wss://relay.damus.io'],  // also in DEFAULT_READ_RELAYS
    appRelaysEnabled: true,
  });
  const eff = identity.getEffectiveReadRelays();
  const occurrences = eff.filter((r: string) => r === 'wss://relay.damus.io').length;
  assert.equal(occurrences, 1);
});

test('identity: setAppRelaysEnabled persists and round-trips', () => {
  writeIdentityJson({
    npub: '',
    readRelays: ['wss://x.example'],
    appRelaysEnabled: true,
  });
  identity.setAppRelaysEnabled(false);
  assert.equal(identity.readIdentity().appRelaysEnabled, false);
  identity.setAppRelaysEnabled(true);
  assert.equal(identity.readIdentity().appRelaysEnabled, true);
});

test('identity: empty Your Relays + App Relays off → empty effective list', () => {
  writeIdentityJson({
    npub: '',
    readRelays: [],
    appRelaysEnabled: false,
  });
  const eff = identity.getEffectiveReadRelays();
  assert.deepEqual(eff, []);
});

test('identity: getEffectiveReadRelays caps at 12 entries', () => {
  const many = Array.from({ length: 30 }, (_, i) => `wss://relay-${i}.example`);
  writeIdentityJson({ npub: '', readRelays: many, appRelaysEnabled: true });
  const eff = identity.getEffectiveReadRelays();
  assert.ok(eff.length <= 12, `expected <=12 effective relays, got ${eff.length}`);
});

test('identity: invalid relay urls are filtered from Your Relays', () => {
  writeIdentityJson({
    npub: '',
    readRelays: ['not-a-url', 'wss://valid.example', 42 as any, ''],
    appRelaysEnabled: false,
  });
  const eff = identity.getEffectiveReadRelays();
  assert.deepEqual(eff, ['wss://valid.example']);
});
