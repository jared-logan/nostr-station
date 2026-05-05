import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { useTempHome, resetTempHome } from './_home.js';
const HOME = useTempHome();

// auth-bunker pulls in identity + bunker-storage which both resolve
// ~/.config/nostr-station and ~/.nostr-station at module load. HOME is
// already pinned by the time this dynamic import runs.
const auth = await import('../src/lib/auth-bunker.ts');
const ident = await import('../src/lib/identity.ts');

function configPath(): string { return path.join(HOME, '.config', 'nostr-station', 'identity.json'); }
function bunkerPath(): string { return path.join(HOME, '.nostr-station', 'bunker-client.json'); }

test('signEventWithSavedBunker: tried=false when no station npub configured', async () => {
  resetTempHome(HOME);
  const r = await auth.signEventWithSavedBunker(
    { kind: 1, created_at: 0, tags: [], content: 'x' },
    50,
  );
  assert.equal(r.ok, false);
  assert.equal(r.tried, false);
  assert.match(r.error || '', /no station npub/i);
});

test('signEventWithSavedBunker: tried=false when no saved bunker client', async () => {
  resetTempHome(HOME);
  // Seed identity but NOT the saved bunker client.
  ident.writeIdentity({ npub: 'npub1' + 'a'.repeat(58), readRelays: [] });
  const r = await auth.signEventWithSavedBunker(
    { kind: 1, created_at: 0, tags: [], content: 'x' },
    50,
  );
  assert.equal(r.ok, false);
  assert.equal(r.tried, false);
  assert.match(r.error || '', /no saved bunker/i);
});

test('signEventWithSavedBunker: tried=true with bogus saved bunker (connect fails fast)', async () => {
  resetTempHome(HOME);
  const npub = 'npub1' + 'a'.repeat(58);
  ident.writeIdentity({ npub, readRelays: [] });
  // Plant a saved bunker pointing at an unreachable relay so connect
  // times out quickly. This exercises the tried=true branch without
  // needing a real Amber on the other end.
  const dir = path.dirname(bunkerPath());
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(bunkerPath(), JSON.stringify({
    ownerNpub: npub,
    clientSecretHex: 'a'.repeat(64),
    bunker: {
      relays: ['wss://127.0.0.1:1'],   // reserved + closed; connect fails immediately
      pubkey: 'b'.repeat(64),
      secret: null,
    },
    savedAt: Date.now(),
  }));
  const r = await auth.signEventWithSavedBunker(
    { kind: 1, created_at: 0, tags: [], content: 'x' },
    300,
  );
  assert.equal(r.ok, false);
  assert.equal(r.tried, true);
  // Don't assert on the exact error text — different nostr-tools
  // versions phrase the connect failure differently. Just that some
  // error is reported.
  assert.ok(r.error && r.error.length > 0);
});

test('startSetupAmber: returns QR + ephemeral pubkey + nostrconnect URI', async () => {
  resetTempHome(HOME);
  const start = await auth.startSetupAmber('http://127.0.0.1:3000');
  assert.match(start.ephemeralPubkey, /^[0-9a-f]{64}$/);
  assert.match(start.nostrconnectUri, /^nostrconnect:\/\//);
  assert.ok(start.qrSvg.includes('<svg'), 'qrSvg should contain an SVG');
  assert.ok(start.relays.length > 0, 'relays should be non-empty');
  assert.ok(start.expiresAt > Date.now(), 'expiresAt should be in the future');
});

test('getSetupAmberSession: returns the session created by startSetupAmber', async () => {
  resetTempHome(HOME);
  const start = await auth.startSetupAmber('http://127.0.0.1:3000');
  const s = auth.getSetupAmberSession(start.ephemeralPubkey);
  assert.ok(s, 'session should exist');
  assert.equal(s!.status, 'waiting');
  assert.equal(s!.ephemeralPubkey, start.ephemeralPubkey);
});

test('consumeSetupAmberSession: removes the entry after read', async () => {
  resetTempHome(HOME);
  const start = await auth.startSetupAmber('http://127.0.0.1:3000');
  const consumed = auth.consumeSetupAmberSession(start.ephemeralPubkey);
  assert.ok(consumed, 'first consume returns the session');
  const second = auth.consumeSetupAmberSession(start.ephemeralPubkey);
  assert.equal(second, null, 'second consume returns null');
});
