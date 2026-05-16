/**
 * nsite route helpers — focused tests for the absolute-path HTML / CSS
 * rewriter. The route handler itself is covered by smoke testing, but
 * the rewrite has enough regex edge cases to deserve its own unit pass.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { useTempHome } from './_home.js';
useTempHome();

// @ts-expect-error — runtime .ts import
const mod = await import('../src/lib/routes/nsite.ts');
const { rewriteHtmlAbsolutePaths, rewriteCssAbsoluteUrls, STRICT_NSITE_CSP } = mod;

const dec = (b: Uint8Array) => new TextDecoder('utf-8').decode(b);
const enc = (s: string) => new TextEncoder().encode(s);

const SID = 'abcdef0123456789';
const PREFIX = `/nsite-content/${SID}`;

// The HTML rewriter now ALSO injects a runtime shim (importmap +
// fetch/XHR/EventSource monkey-patch). Existing static-rewrite tests
// don't care about the shim; this helper strips it so the assertions
// stay focused.
function stripShim(out: string): string {
  return out
    .replace(/<script type="importmap">[^<]*<\/script>/g, '')
    .replace(/<script>\(function\(\)\{[\s\S]*?\}\)\(\);<\/script>/g, '');
}

// ── HTML ──────────────────────────────────────────────────────────────────

test('rewriteHtml: src="/..." attributes get the siteId prefix', () => {
  const out = stripShim(dec(rewriteHtmlAbsolutePaths(enc(`<script src="/main.js"></script>`), SID)));
  assert.equal(out, `<script src="${PREFIX}/main.js"></script>`);
});

test('rewriteHtml: href="/..." attributes get the siteId prefix', () => {
  const out = stripShim(dec(rewriteHtmlAbsolutePaths(enc(`<link rel="stylesheet" href="/style.css">`), SID)));
  assert.equal(out, `<link rel="stylesheet" href="${PREFIX}/style.css">`);
});

test('rewriteHtml: protocol-relative //host/foo is NOT rewritten', () => {
  const html = `<script src="//cdn.example.com/lib.js"></script>`;
  const out = stripShim(dec(rewriteHtmlAbsolutePaths(enc(html), SID)));
  assert.equal(out, html, 'cross-origin protocol-relative URLs must pass through unchanged');
});

test('rewriteHtml: absolute URL https://... is NOT rewritten', () => {
  const html = `<a href="https://example.com/page">link</a>`;
  const out = stripShim(dec(rewriteHtmlAbsolutePaths(enc(html), SID)));
  assert.equal(out, html);
});

test('rewriteHtml: relative paths (./foo, foo) untouched', () => {
  const html = `<img src="./relative.png"><img src="another.jpg">`;
  const out = stripShim(dec(rewriteHtmlAbsolutePaths(enc(html), SID)));
  assert.equal(out, html);
});

test('rewriteHtml: single-quoted attributes also rewritten', () => {
  const out = stripShim(dec(rewriteHtmlAbsolutePaths(enc(`<img src='/a.png'>`), SID)));
  assert.equal(out, `<img src='${PREFIX}/a.png'>`);
});

test('rewriteHtml: srcset with multiple candidates rewritten per-URL', () => {
  const out = stripShim(dec(rewriteHtmlAbsolutePaths(enc(
    `<img srcset="/a.png 1x, /b.png 2x, ./relative.png 3x">`,
  ), SID)));
  assert.equal(out,
    `<img srcset="${PREFIX}/a.png 1x, ${PREFIX}/b.png 2x, ./relative.png 3x">`,
    'absolute candidates rewritten, relative left alone');
});

test('rewriteHtml: inline <style> url(/...) rewritten', () => {
  const out = stripShim(dec(rewriteHtmlAbsolutePaths(enc(
    `<style>.bg { background: url(/img/bg.png); }</style>`,
  ), SID)));
  assert.match(out, new RegExp(`url\\(${PREFIX}/img/bg\\.png\\)`));
});

test('rewriteHtml: lez/nsite README example (img + js + css) all rewritten', () => {
  // From github.com/lez/nsite README — verbatim style.
  const html = `<img src="/img/avatar.jpg">
<script src="/app.js"></script>
<link rel="stylesheet" href="/style.css">`;
  const out = stripShim(dec(rewriteHtmlAbsolutePaths(enc(html), SID)));
  assert.ok(out.includes(`src="${PREFIX}/img/avatar.jpg"`));
  assert.ok(out.includes(`src="${PREFIX}/app.js"`));
  assert.ok(out.includes(`href="${PREFIX}/style.css"`));
});

test('rewriteHtml: empty input returns empty output (does not crash)', () => {
  assert.equal(stripShim(dec(rewriteHtmlAbsolutePaths(enc(''), SID))), '');
});

// ── CSS ───────────────────────────────────────────────────────────────────

test('rewriteCss: url(/path) rewritten with siteId prefix', () => {
  const out = dec(rewriteCssAbsoluteUrls(enc(`.x { background: url(/a.png); }`), SID));
  assert.match(out, new RegExp(`url\\(${PREFIX}/a\\.png\\)`));
});

test('rewriteCss: url("/path") with quotes preserved', () => {
  const out = dec(rewriteCssAbsoluteUrls(enc(`.x { background: url("/a.png"); }`), SID));
  assert.match(out, new RegExp(`url\\("${PREFIX}/a\\.png"\\)`));
});

test('rewriteCss: relative url(./foo) untouched', () => {
  const css = `.x { background: url(./a.png); }`;
  assert.equal(dec(rewriteCssAbsoluteUrls(enc(css), SID)), css);
});

test('rewriteCss: protocol-relative url(//cdn/...) untouched', () => {
  const css = `.x { background: url(//cdn.example.com/a.png); }`;
  assert.equal(dec(rewriteCssAbsoluteUrls(enc(css), SID)), css);
});

test('rewriteCss: @import "/x.css" rewritten', () => {
  const out = dec(rewriteCssAbsoluteUrls(enc(`@import "/themes/dark.css";`), SID));
  assert.equal(out, `@import "${PREFIX}/themes/dark.css";`);
});

test('rewriteCss: @import absolute URL untouched', () => {
  const css = `@import "https://fonts.example.com/x.css";`;
  assert.equal(dec(rewriteCssAbsoluteUrls(enc(css), SID)), css);
});

// ── Runtime shim (importmap + fetch/XHR patch) ───────────────────────────

test('shim: injected at the top of <head> when present', () => {
  const out = dec(rewriteHtmlAbsolutePaths(enc(
    `<html><head><title>x</title></head><body>hi</body></html>`,
  ), SID));
  // Order matters — shim must precede any other <script> so it patches
  // fetch before user code runs.
  const headIdx = out.indexOf('<head>');
  const importMapIdx = out.indexOf('<script type="importmap">');
  const fetchShimIdx = out.indexOf('<script>(function()');
  const titleIdx = out.indexOf('<title>');
  assert.ok(headIdx >= 0 && importMapIdx > headIdx && fetchShimIdx > importMapIdx,
    'importmap + fetch shim should both follow <head> opening tag');
  assert.ok(fetchShimIdx < titleIdx, 'fetch shim must run BEFORE existing head content');
});

test('shim: falls back to <html> when <head> is missing', () => {
  const out = dec(rewriteHtmlAbsolutePaths(enc(`<html><body>hi</body></html>`), SID));
  const htmlIdx = out.indexOf('<html>');
  const shimIdx = out.indexOf('<script type="importmap">');
  assert.ok(shimIdx > htmlIdx && shimIdx < out.indexOf('<body>'),
    'shim should land between <html> and <body>');
});

test('shim: prepended when neither <head> nor <html> exist', () => {
  const out = dec(rewriteHtmlAbsolutePaths(enc(`<p>just a fragment</p>`), SID));
  assert.ok(out.startsWith('<script type="importmap">'),
    'shim should be the very first content');
});

test('shim: import map maps the "/" prefix to /nsite-content/<siteId>/', () => {
  const out = dec(rewriteHtmlAbsolutePaths(enc(`<html><head></head><body></body></html>`), SID));
  const m = out.match(/<script type="importmap">([^<]+)<\/script>/);
  assert.ok(m, 'import map block should be present');
  const parsed = JSON.parse(m![1]);
  assert.deepEqual(parsed, { imports: { '/': `${PREFIX}/` } },
    'absolute-path ES module specifiers must map under the site prefix');
});

test('shim: fetch patch wraps strings, Requests, and same-origin already-prefixed URLs', () => {
  // We don't have a JSDOM here; instead verify the shim's behavior by
  // running it in a Function() scope with a fake window. The shim is
  // small enough that this is straightforward.
  const out = dec(rewriteHtmlAbsolutePaths(enc(`<html><head></head></html>`), SID));
  // Capture the full `(function(){...})();` IIFE body to run in a sandbox.
  const m = out.match(/<script>([\s\S]*?)<\/script>/g);
  assert.ok(m, 'shim <script> blocks should be present');
  // The shim script is the second <script> in head (after the importmap).
  const shimBlock = m![m!.length - 1].replace(/^<script>/, '').replace(/<\/script>$/, '');

  type Capture = { url: string };
  const captured: Capture[] = [];
  const fakeWindow: any = {
    fetch: (u: any) => { captured.push({ url: typeof u === 'string' ? u : u.url }); return Promise.resolve(); },
    EventSource: undefined,
  };
  const fakeXHR: any = function () {};
  fakeXHR.prototype = { open: function (_m: string, u: string) { captured.push({ url: u }); } };
  // Build a sandbox window/XMLHttpRequest pair and run the shim against it.
  const runner = new Function('window', 'XMLHttpRequest', 'Request', shimBlock);
  runner(fakeWindow, fakeXHR, function FakeReq(this: any, url: string) { this.url = url; });

  // Absolute path → prefixed.
  fakeWindow.fetch('/api/data');
  assert.equal(captured.pop()!.url, `${PREFIX}/api/data`);

  // Protocol-relative → untouched.
  fakeWindow.fetch('//cdn.example.com/lib.js');
  assert.equal(captured.pop()!.url, '//cdn.example.com/lib.js');

  // Already-prefixed → idempotent (no double-prefix).
  fakeWindow.fetch(`${PREFIX}/foo`);
  assert.equal(captured.pop()!.url, `${PREFIX}/foo`);

  // Relative → untouched.
  fakeWindow.fetch('./foo');
  assert.equal(captured.pop()!.url, './foo');

  // Cross-origin URL → untouched.
  fakeWindow.fetch('https://example.com/x');
  assert.equal(captured.pop()!.url, 'https://example.com/x');

  // XHR open absolute path → prefixed.
  const xhr = new fakeXHR();
  xhr.open('GET', '/data.json');
  assert.equal(captured.pop()!.url, `${PREFIX}/data.json`);
});

// ── B-strict CSP ──────────────────────────────────────────────────────────

test('CSP: default-src locked to self', () => {
  assert.match(STRICT_NSITE_CSP, /default-src 'self'/);
});

test('CSP: WebSocket connect allowed (Nostr relays need wss)', () => {
  assert.match(STRICT_NSITE_CSP, /connect-src[^;]*wss:/);
  assert.match(STRICT_NSITE_CSP, /connect-src[^;]*ws:\/\/127\.0\.0\.1:\*/,
    'loopback ws should be allowed for the in-process relay');
});

test('CSP: external HTTPS images are NOT allowed (no `https:` in img-src)', () => {
  const imgSrc = STRICT_NSITE_CSP.match(/img-src ([^;]+)/)?.[1] ?? '';
  assert.ok(imgSrc.includes("'self'"),  'img-src must allow self');
  assert.ok(imgSrc.includes('data:'),   'img-src must allow data: URIs');
  assert.ok(imgSrc.includes('blob:'),   'img-src must allow blob: URIs');
  assert.ok(!imgSrc.includes('https:'),
    'img-src must NOT allow https: — that defeats the lockdown (nostr.build, trackers, etc.)');
});

test('CSP: external HTTPS scripts/styles/fonts blocked too', () => {
  for (const directive of ['script-src', 'style-src', 'font-src']) {
    const value = STRICT_NSITE_CSP.match(new RegExp(`${directive} ([^;]+)`))?.[1] ?? '';
    assert.ok(!value.includes('https:'),
      `${directive} must NOT allow https: (would let external CDNs / Google Fonts / etc. through)`);
  }
});

test('CSP: object/embed/applet completely disabled', () => {
  assert.match(STRICT_NSITE_CSP, /object-src 'none'/);
});

test('CSP: clickjacking + base-rebase protections', () => {
  assert.match(STRICT_NSITE_CSP, /frame-ancestors 'self'/);
  assert.match(STRICT_NSITE_CSP, /base-uri 'self'/);
  assert.match(STRICT_NSITE_CSP, /form-action 'self'/);
});

test('CSP: inline scripts/styles allowed (covers runtime shim + bundled HTML)', () => {
  // 'unsafe-inline' is intentional here — modern bundlers and the
  // runtime shim both rely on inline scripts. We do NOT allow
  // 'unsafe-eval' (no `eval()`/`new Function()` from inside the nsite).
  assert.match(STRICT_NSITE_CSP, /script-src[^;]*'unsafe-inline'/);
  assert.match(STRICT_NSITE_CSP, /style-src[^;]*'unsafe-inline'/);
  assert.ok(!STRICT_NSITE_CSP.includes("'unsafe-eval'"),
    'CSP must not allow unsafe-eval — blocks dynamic code synthesis');
});
