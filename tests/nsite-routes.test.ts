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
const { rewriteHtmlAbsolutePaths, rewriteCssAbsoluteUrls } = mod;

const dec = (b: Uint8Array) => new TextDecoder('utf-8').decode(b);
const enc = (s: string) => new TextEncoder().encode(s);

const SID = 'abcdef0123456789';
const PREFIX = `/nsite-content/${SID}`;

// ── HTML ──────────────────────────────────────────────────────────────────

test('rewriteHtml: src="/..." attributes get the siteId prefix', () => {
  const out = dec(rewriteHtmlAbsolutePaths(enc(`<script src="/main.js"></script>`), SID));
  assert.equal(out, `<script src="${PREFIX}/main.js"></script>`);
});

test('rewriteHtml: href="/..." attributes get the siteId prefix', () => {
  const out = dec(rewriteHtmlAbsolutePaths(enc(`<link rel="stylesheet" href="/style.css">`), SID));
  assert.equal(out, `<link rel="stylesheet" href="${PREFIX}/style.css">`);
});

test('rewriteHtml: protocol-relative //host/foo is NOT rewritten', () => {
  const html = `<script src="//cdn.example.com/lib.js"></script>`;
  const out = dec(rewriteHtmlAbsolutePaths(enc(html), SID));
  assert.equal(out, html, 'cross-origin protocol-relative URLs must pass through unchanged');
});

test('rewriteHtml: absolute URL https://... is NOT rewritten', () => {
  const html = `<a href="https://example.com/page">link</a>`;
  const out = dec(rewriteHtmlAbsolutePaths(enc(html), SID));
  assert.equal(out, html);
});

test('rewriteHtml: relative paths (./foo, foo) untouched', () => {
  const html = `<img src="./relative.png"><img src="another.jpg">`;
  const out = dec(rewriteHtmlAbsolutePaths(enc(html), SID));
  assert.equal(out, html);
});

test('rewriteHtml: single-quoted attributes also rewritten', () => {
  const out = dec(rewriteHtmlAbsolutePaths(enc(`<img src='/a.png'>`), SID));
  assert.equal(out, `<img src='${PREFIX}/a.png'>`);
});

test('rewriteHtml: srcset with multiple candidates rewritten per-URL', () => {
  const out = dec(rewriteHtmlAbsolutePaths(enc(
    `<img srcset="/a.png 1x, /b.png 2x, ./relative.png 3x">`,
  ), SID));
  assert.equal(out,
    `<img srcset="${PREFIX}/a.png 1x, ${PREFIX}/b.png 2x, ./relative.png 3x">`,
    'absolute candidates rewritten, relative left alone');
});

test('rewriteHtml: inline <style> url(/...) rewritten', () => {
  const out = dec(rewriteHtmlAbsolutePaths(enc(
    `<style>.bg { background: url(/img/bg.png); }</style>`,
  ), SID));
  assert.match(out, new RegExp(`url\\(${PREFIX}/img/bg\\.png\\)`));
});

test('rewriteHtml: lez/nsite README example (img + js + css) all rewritten', () => {
  // From github.com/lez/nsite README — verbatim style.
  const html = `<img src="/img/avatar.jpg">
<script src="/app.js"></script>
<link rel="stylesheet" href="/style.css">`;
  const out = dec(rewriteHtmlAbsolutePaths(enc(html), SID));
  assert.ok(out.includes(`src="${PREFIX}/img/avatar.jpg"`));
  assert.ok(out.includes(`src="${PREFIX}/app.js"`));
  assert.ok(out.includes(`href="${PREFIX}/style.css"`));
});

test('rewriteHtml: empty input returns empty output (does not crash)', () => {
  assert.equal(dec(rewriteHtmlAbsolutePaths(enc(''), SID)), '');
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
