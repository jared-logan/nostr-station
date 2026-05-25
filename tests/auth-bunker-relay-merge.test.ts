import { test } from 'node:test';
import assert from 'node:assert/strict';

import { useTempHome } from './_home.js';
useTempHome();

// @ts-expect-error — runtime .ts import; tsx handles resolution
const { mergeAuthRelays } = await import('../src/lib/auth-bunker.ts');

// The bug this guards against: a user whose identity.readRelays didn't
// include relay.nsec.app (or any Amber-friendly relay) saw their sign-in
// QR fail silently — Amber publishes its connect response to whichever
// relays are listed in the nostrconnect:// URI, and the user's preferred
// archival/caching relays don't reliably route ephemeral NIP-46 events.
// Setup-pairing used SETUP_AMBER_RELAYS unconditionally and worked;
// sign-in inherited a stricter "use only configured" rule and didn't.

test('mergeAuthRelays: always includes the well-known Amber relays even when user list omits them', () => {
  const out = mergeAuthRelays([
    'wss://relay.nostr.band',
    'wss://relay.primal.net',
    'wss://relay.ditto.pub',
  ]);
  assert.ok(out.includes('wss://relay.nsec.app'), 'must include relay.nsec.app');
  assert.ok(out.includes('wss://relay.damus.io'), 'must include relay.damus.io');
  assert.ok(out.includes('wss://nos.lol'),        'must include nos.lol');
});

test('mergeAuthRelays: amber-friendly relays come first so Amber sees them in the URI', () => {
  // Amber may only fully connect to the first few relays in the URI before
  // sending its connect response; putting nsec.app first guarantees the
  // home-relay handshake happens regardless of how many user relays follow.
  const out = mergeAuthRelays(['wss://relay.nostr.band', 'wss://relay.ditto.pub']);
  assert.equal(out[0], 'wss://relay.nsec.app');
});

test('mergeAuthRelays: dedupes user relays already in the Amber set', () => {
  const out = mergeAuthRelays([
    'wss://relay.damus.io',     // duplicate of Amber set
    'wss://relay.damus.io/',    // duplicate w/ trailing slash
    'WSS://relay.nsec.app',     // duplicate w/ uppercase scheme
    'wss://relay.nostr.band',   // user-only
  ]);
  assert.equal(
    out.filter(r => r.toLowerCase().includes('damus')).length, 1,
    'damus.io should appear exactly once',
  );
  assert.equal(
    out.filter(r => r.toLowerCase().includes('nsec.app')).length, 1,
    'relay.nsec.app should appear exactly once',
  );
});

test('mergeAuthRelays: drops non-wss user entries (ws:// would leak NIP-44 plaintext)', () => {
  const out = mergeAuthRelays(['ws://insecure.example.com', 'http://not-a-relay.example']);
  assert.ok(!out.some(r => r.startsWith('ws://')));
  assert.ok(!out.some(r => r.startsWith('http://')));
});

test('mergeAuthRelays: caps the output at 5 relays', () => {
  // Long QR URIs scan unreliably on small phone cameras; cap keeps the
  // URI compact while still leaving room for a couple of user preferences
  // alongside the three Amber-friendly defaults.
  const out = mergeAuthRelays([
    'wss://relay.nostr.band',
    'wss://relay.primal.net',
    'wss://relay.ditto.pub',
    'wss://relay.snort.social',
    'wss://eden.nostr.land',
    'wss://relay.nostr.bg',
  ]);
  assert.ok(out.length <= 5, `expected <= 5, got ${out.length}`);
  // The Amber three are guaranteed; two user slots remain.
  assert.ok(out.includes('wss://relay.nsec.app'));
});

test('mergeAuthRelays: empty / missing user list still returns the Amber defaults', () => {
  assert.deepEqual(mergeAuthRelays([]), [
    'wss://relay.nsec.app',
    'wss://relay.damus.io',
    'wss://nos.lol',
  ]);
});
