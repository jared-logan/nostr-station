import { test } from 'node:test';
import assert from 'node:assert/strict';

// No HOME isolation needed — this module is pure.
// @ts-expect-error — runtime import of .ts; tsx handles the resolution
const { safeHttpUrl } = await import('../src/lib/url-safety.ts');

// ── Accepted shapes ───────────────────────────────────────────────────────

test('safeHttpUrl: passes http URLs through unchanged', () => {
  assert.equal(safeHttpUrl('http://example.com/foo'), 'http://example.com/foo');
});

test('safeHttpUrl: passes https URLs with path/query/fragment', () => {
  const u = 'https://example.com/foo?q=1&r=2#section';
  assert.equal(safeHttpUrl(u), u);
});

test('safeHttpUrl: accepts uppercase scheme', () => {
  // WHATWG URL lowercases parsed.protocol internally; the original string
  // is returned as-is. Browsers accept either casing, so we should too.
  assert.equal(safeHttpUrl('HTTPS://Example.COM'), 'HTTPS://Example.COM');
});

test('safeHttpUrl: strips only outer whitespace', () => {
  assert.equal(safeHttpUrl('  https://example.com  '), 'https://example.com');
});

// ── Scheme-based rejections ───────────────────────────────────────────────

test('safeHttpUrl: blocks javascript: scheme', () => {
  assert.equal(safeHttpUrl('javascript:alert(1)'), null);
});

test('safeHttpUrl: blocks uppercase JAVASCRIPT: scheme', () => {
  assert.equal(safeHttpUrl('JAVASCRIPT:alert(1)'), null);
});

test('safeHttpUrl: blocks mixed-case Javascript: scheme', () => {
  assert.equal(safeHttpUrl('JaVaScRiPt:alert(1)'), null);
});

test('safeHttpUrl: blocks leading-tab javascript: (the scheme-poisoning trick)', () => {
  // Some renderers trim whitespace before following the link. `trim()` on
  // our side matches that behavior so attackers can't hide behind a tab.
  assert.equal(safeHttpUrl('\tjavascript:alert(1)'), null);
});

test('safeHttpUrl: blocks leading-space javascript:', () => {
  assert.equal(safeHttpUrl(' javascript:alert(1)'), null);
});

test('safeHttpUrl: blocks leading-newline javascript:', () => {
  assert.equal(safeHttpUrl('\njavascript:alert(1)'), null);
});

test('safeHttpUrl: blocks javascript: with embedded tab (whatwg URL parser)', () => {
  // Browsers ignore embedded whitespace in URLs, so `java\tscript:` can
  // still execute as `javascript:`. `new URL` accepts this in some
  // implementations; either it parses as javascript: (blocked by
  // protocol check) or it fails to parse (blocked by catch).
  assert.equal(safeHttpUrl('java\tscript:alert(1)'), null);
});

test('safeHttpUrl: blocks data: text/html', () => {
  assert.equal(safeHttpUrl('data:text/html,<script>1</script>'), null);
});

test('safeHttpUrl: blocks data: image/svg+xml (svg-based XSS vector)', () => {
  assert.equal(safeHttpUrl('data:image/svg+xml;base64,PHN2Zy8+'), null);
});

test('safeHttpUrl: blocks vbscript:', () => {
  assert.equal(safeHttpUrl('vbscript:msgbox(1)'), null);
});

test('safeHttpUrl: blocks file://', () => {
  assert.equal(safeHttpUrl('file:///etc/passwd'), null);
});

test('safeHttpUrl: blocks ftp://', () => {
  assert.equal(safeHttpUrl('ftp://host/file'), null);
});

test('safeHttpUrl: blocks ws:// and wss:// (wrong context)', () => {
  assert.equal(safeHttpUrl('ws://host/'), null);
  assert.equal(safeHttpUrl('wss://host/'), null);
});

// ── Non-URL inputs ────────────────────────────────────────────────────────

test('safeHttpUrl: rejects protocol-relative URL', () => {
  // `new URL('//example.com')` throws without a base — so these land in
  // the catch branch. Good: protocol-relative is context-dependent and
  // we don't want to guess.
  assert.equal(safeHttpUrl('//example.com/foo'), null);
});

test('safeHttpUrl: rejects bare path', () => {
  assert.equal(safeHttpUrl('/local/path'), null);
});

test('safeHttpUrl: rejects empty string', () => {
  assert.equal(safeHttpUrl(''), null);
});

test('safeHttpUrl: rejects whitespace-only string', () => {
  assert.equal(safeHttpUrl('   \t\n  '), null);
});

test('safeHttpUrl: rejects non-string inputs', () => {
  assert.equal(safeHttpUrl(null), null);
  assert.equal(safeHttpUrl(undefined), null);
  assert.equal(safeHttpUrl(123), null);
  assert.equal(safeHttpUrl({}), null);
  assert.equal(safeHttpUrl([]), null);
  assert.equal(safeHttpUrl(true), null);
});

test('safeHttpUrl: rejects malformed URL shapes', () => {
  // Plain garbage — `new URL` throws → caught → null.
  assert.equal(safeHttpUrl('not a url'), null);
  assert.equal(safeHttpUrl('http:'), null);
  assert.equal(safeHttpUrl(':::'), null);
});

test('safeHttpUrl: `http://` without host — observed behavior pinned', () => {
  // WHATWG URL actually REJECTS `http://` (no host) — documenting the
  // observation here so if Node ever changes the parser, the regression
  // surfaces immediately instead of hiding behind a permissive test.
  assert.equal(safeHttpUrl('http://'), null);
});

test('safeHttpUrl: returns same-type null (no empty string confusion)', () => {
  // Contract with callers: they check `x === null` or truthy, not
  // `x.length === 0`. An accidental empty-string return would bypass
  // the `r.web ? ... : ''` guard in the dashboard.
  const r = safeHttpUrl('javascript:alert(1)');
  assert.equal(r, null);
  assert.notEqual(r, '');
});
