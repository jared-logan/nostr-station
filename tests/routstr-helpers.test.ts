import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useTempHome } from './_home.js';

// Pin a tmp HOME so the routes module's transitive ai-config import
// doesn't reach the real ~/.nostr-station when its module-level
// constants resolve at load time.
useTempHome();

const {
  detectRoutstrKeyType,
  walletInfoUrl,
  // @ts-expect-error — imported at runtime, not checked against .d.ts
} = await import('../src/lib/routes/ai.ts');

// ── detectRoutstrKeyType ──────────────────────────────────────────────────
//
// The classifier is intentionally simple: prefix-only. Used both for
// (a) the row badge in the Config panel and (b) auto-storing the type
// in ai-config.json at save time. Worst-case mis-classification is
// cosmetic — chat-time auth works for both formats via Bearer.

test('detectRoutstrKeyType: sk- prefix → managed', () => {
  assert.equal(detectRoutstrKeyType('sk-abc123'), 'sk');
  assert.equal(detectRoutstrKeyType('sk-XYZ'), 'sk');
});

test('detectRoutstrKeyType: case-insensitive on the prefix', () => {
  // routstr-core has emitted both lowercase 'sk-' and uppercase 'SK-'
  // historically. Normalise so a user pasting either path lands on the
  // same row affordances.
  assert.equal(detectRoutstrKeyType('SK-abc'), 'sk');
});

test('detectRoutstrKeyType: whitespace tolerated', () => {
  // Paste-from-clipboard sometimes brings trailing newlines.
  assert.equal(detectRoutstrKeyType('  sk-abc\n'), 'sk');
});

test('detectRoutstrKeyType: anything else → cashu', () => {
  assert.equal(detectRoutstrKeyType('cashuAeyJ0b2tlbiI6'), 'cashu');
  assert.equal(detectRoutstrKeyType('cashuB...'), 'cashu');
  // Even garbage falls through to cashu — the server's /wallet/info
  // call against the key is the authoritative reject path.
  assert.equal(detectRoutstrKeyType('not-a-key'), 'cashu');
  assert.equal(detectRoutstrKeyType(''), 'cashu');
});

// ── walletInfoUrl ─────────────────────────────────────────────────────────
//
// The base URL field accepts both `https://api.routstr.com` and
// `https://api.routstr.com/v1` — the user shouldn't have to remember
// which one upstream documents. The same normalisation already lives in
// completionsUrl for the chat path; this helper mirrors it.

test('walletInfoUrl: appends /v1/wallet/info when base lacks /v1', () => {
  assert.equal(
    walletInfoUrl('https://api.routstr.com'),
    'https://api.routstr.com/v1/wallet/info',
  );
});

test('walletInfoUrl: appends /wallet/info when base already ends with /v1', () => {
  assert.equal(
    walletInfoUrl('https://api.routstr.com/v1'),
    'https://api.routstr.com/v1/wallet/info',
  );
});

test('walletInfoUrl: strips a trailing slash before joining', () => {
  // The Config-panel input doesn't normalise trailing slashes — users
  // paste both forms. Without the strip, we'd end up with a double-slash
  // path like /v1//wallet/info which some node implementations 404 on.
  assert.equal(
    walletInfoUrl('https://api.routstr.com/v1/'),
    'https://api.routstr.com/v1/wallet/info',
  );
  assert.equal(
    walletInfoUrl('https://api.routstr.com/'),
    'https://api.routstr.com/v1/wallet/info',
  );
});

test('walletInfoUrl: works for non-canonical nodes', () => {
  // Routstr is a federation — the canonical api.routstr.com is just
  // one of many. Make sure the helper isn't accidentally hardcoded to
  // that hostname.
  assert.equal(
    walletInfoUrl('https://privateprovider.xyz/v1'),
    'https://privateprovider.xyz/v1/wallet/info',
  );
});
