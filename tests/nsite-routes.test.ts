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
const {
  rewriteHtmlAbsolutePaths, rewriteCssAbsoluteUrls, STRICT_NSITE_CSP,
  handleNsite, _internal,
} = mod;

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
  // Find the fetch shim specifically — head now contains importmap +
  // fetch shim + reporter, in that order. The fetch shim is the one
  // whose body declares `var P=` (the prefix constant); the reporter
  // declares `var S=` (the siteId). Pick by content rather than
  // position so test stays robust to ordering changes.
  const blocks = out.match(/<script>\(function\(\)\{[\s\S]*?\}\)\(\);<\/script>/g) ?? [];
  const fetchScript = blocks.find(b => b.includes('var P='));
  assert.ok(fetchScript, 'fetch shim should be present');
  const shimBlock = fetchScript!.replace(/^<script>/, '').replace(/<\/script>$/, '');

  type Capture = { url: string };
  const captured: Capture[] = [];
  const fakeWindow: any = {
    fetch: (u: any) => { captured.push({ url: typeof u === 'string' ? u : u.url }); return Promise.resolve(); },
    EventSource: undefined,
    // The reporter (separate script block) calls addEventListener for
    // securitypolicyviolation / error / unhandledrejection. The fetch
    // shim itself doesn't, but the same fake window is reused if a
    // future test runs both blocks together — provide a stub.
    addEventListener: () => {},
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

test('CSP: bracketed-IPv6 source dropped (Chrome rejects ws://[::1]:* as invalid)', () => {
  // The CSP3 source-expression grammar doesn't accept bracketed IPv6 hosts;
  // browsers log "invalid source ... will be ignored" 15+ times per page if
  // we ship it. The IPv4 and `localhost` forms already cover the in-process
  // relay, so the IPv6 line just produced noise — removed.
  assert.ok(!STRICT_NSITE_CSP.includes('[::1]'),
    'CSP must not contain bracketed-IPv6 host (parser-invalid in all major browsers)');
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

// ── CSP-violation reporter shim ───────────────────────────────────────────

test('reporter: injected into <head> alongside the fetch shim', () => {
  const out = dec(rewriteHtmlAbsolutePaths(enc(`<html><head></head></html>`), SID));
  // The reporter shim is the one whose body declares `var S=` (the
  // siteId) — the fetch shim uses `var P=` (the prefix).
  assert.match(out, /var S=/, 'reporter script should be present');
  assert.match(out, /var P=/, 'fetch shim should still be present');
});

test('reporter: forwards securitypolicyviolation + error events', () => {
  const out = dec(rewriteHtmlAbsolutePaths(enc(`<html><head></head></html>`), SID));
  assert.match(out, /securitypolicyviolation/);
  assert.match(out, /unhandledrejection/);
  // The reporter calls window.addEventListener with three event names.
  // Spot-check that "error" is one of them (we add it with capture phase).
  assert.match(out, /addEventListener\("error",/);
});

test('reporter: postMessage payload includes type + siteId', () => {
  const out = dec(rewriteHtmlAbsolutePaths(enc(`<html><head></head></html>`), SID));
  // Reporter executes `parent.postMessage(Object.assign({type:t,siteId:S},p),"*")`
  // — verify both type and siteId appear in the assignment.
  assert.match(out, /parent\.postMessage\(Object\.assign\(\{type:t,siteId:S/);
});

test('reporter: behaves correctly when run against a fake window', () => {
  const out = dec(rewriteHtmlAbsolutePaths(enc(`<html><head></head></html>`), SID));
  // Pick the reporter (var S=...) not the fetch shim (var P=...).
  const blocks = out.match(/<script>\(function\(\)\{[\s\S]*?\}\)\(\);<\/script>/g) ?? [];
  const reporter = blocks.find(b => b.includes('var S='));
  assert.ok(reporter, 'reporter block must be present');
  const body = reporter!.replace(/^<script>/, '').replace(/<\/script>$/, '');

  // Run the reporter in a sandboxed window. Capture postMessage calls
  // and the registered listeners so we can simulate events.
  const listeners: Record<string, Function[]> = {};
  const posted: any[] = [];
  const fakeWindow: any = {
    addEventListener: (name: string, fn: Function) => {
      (listeners[name] ||= []).push(fn);
    },
  };
  const fakeParent: any = {
    postMessage: (msg: any) => { posted.push(msg); },
  };
  // The reporter reads `location.href` once at boot for the "loaded"
  // payload. Stub it so the script doesn't ReferenceError under Node.
  const fakeLocation: any = { href: `http://127.0.0.1:3000/nsite-content/${SID}/index.html` };
  new Function('window', 'parent', 'location', body)(fakeWindow, fakeParent, fakeLocation);

  // The reporter immediately sends a "loaded" message so the panel
  // knows the iframe successfully booted.
  const loaded = posted.find((p) => p.type === 'nsite-loaded');
  assert.ok(loaded, 'should immediately post nsite-loaded');
  assert.equal(loaded.siteId, SID, 'loaded message carries siteId');

  // Simulate a CSP violation event.
  const cspListener = (listeners['securitypolicyviolation'] || [])[0];
  assert.ok(cspListener, 'CSP listener should be registered');
  cspListener({
    blockedURI:        'https://image.nostr.build/foo.jpg',
    violatedDirective: 'img-src',
    effectiveDirective:'img-src',
    disposition:       'enforce',
    sourceFile:        '',
    lineNumber:        0,
  });
  const csp = posted.find((p) => p.type === 'nsite-csp-violation');
  assert.ok(csp, 'CSP violation should be posted');
  assert.equal(csp.blockedURI, 'https://image.nostr.build/foo.jpg');
  assert.equal(csp.effectiveDirective, 'img-src');
  assert.equal(csp.siteId, SID);

  // Simulate an uncaught script error.
  const errListener = (listeners['error'] || [])[0];
  assert.ok(errListener, 'error listener should be registered');
  errListener({ message: 'TypeError: bad', filename: 'main.js', lineno: 42, colno: 10 });
  const err = posted.find((p) => p.type === 'nsite-script-error');
  assert.ok(err, 'script error should be posted');
  assert.equal(err.message, 'TypeError: bad');
  assert.equal(err.filename, 'main.js');
  assert.equal(err.lineno, 42);
});

// ── CORS on /nsite-content/* ──────────────────────────────────────────────
// Module-script loads (`<script type="module" src="/main.js">`, common in
// Vite/Rollup/Webpack ESM output) always trigger a CORS check, even when
// same-host. The panel's iframe sandbox produces an opaque (`null`) origin,
// so without `Access-Control-Allow-Origin` the browser blocks the load with
// "from origin 'null' has been blocked by CORS policy" — Shakespeare-style
// SPAs then never boot. ACAO `*` is safe because /nsite-content/* is
// content-addressed, public, and uncredentialed.

function makeMockRes() {
  const headers: Record<string, string> = {};
  let statusCode = 0;
  let body: string | Uint8Array = '';
  let ended = false;
  return {
    setHeader(k: string, v: string) { headers[k.toLowerCase()] = v; },
    getHeader(k: string)            { return headers[k.toLowerCase()]; },
    writeHead(code: number, h?: Record<string, string>) {
      statusCode = code;
      if (h) for (const k of Object.keys(h)) headers[k.toLowerCase()] = h[k];
    },
    end(chunk?: any) { if (chunk != null) body = chunk; ended = true; },
    get headers()    { return headers; },
    get statusCode() { return statusCode; },
    get body()       { return body; },
    get ended()      { return ended; },
  };
}

test('serveContent: ACAO `*` on 410 (snapshot missing) so the iframe can read the error', async () => {
  const sid = '0000000000000001';
  // Ensure nothing is in the snapshot map for this sid.
  _internal.sites.delete(sid);
  const res = makeMockRes();
  const handled = await handleNsite(
    {} as any,
    res as any,
    `/nsite-content/${sid}/index.html`,
    'GET',
  );
  assert.equal(handled, true);
  assert.equal(res.statusCode, 410);
  assert.equal(res.headers['access-control-allow-origin'], '*',
    'ACAO must be set even on error responses — otherwise the browser surfaces a generic CORS error instead of the actual 410');
});

test('serveContent: ACAO `*` on 200 success (the actual fix for module-script loads)', async () => {
  const sid = '0000000000000002';
  const sha = 'a'.repeat(64);
  // Prime the cache: a snapshot that knows about main.js, and the blob
  // bytes so the handler doesn't try to fetch from Blossom.
  _internal.sites.set(sid, {
    pubkey:  'b'.repeat(64),
    display: 'mock',
    index: {
      files: new Map([['main.js', sha]]),
      latestAt: 0, oldestAt: 0, entries: [],
      totalEventsSeen: 0, format: 'v1', manifestServers: [],
    },
    blossomServers: [],
    createdAt: Date.now(),
  });
  _internal.blobs.set(sha, {
    bytes: new TextEncoder().encode('console.log("hi");'),
    mime:  'application/javascript; charset=utf-8',
  });
  const res = makeMockRes();
  const handled = await handleNsite(
    { method: 'GET' } as any,
    res as any,
    `/nsite-content/${sid}/main.js`,
    'GET',
  );
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['access-control-allow-origin'], '*');
  assert.equal(res.headers['vary'], 'Origin',
    'Vary: Origin lets caching proxies serve different responses to different origins safely');
  // The original Content-Type is preserved (CSP fix above didn't accidentally
  // strip it).
  assert.match(String(res.headers['content-type']), /application\/javascript/);
  // Cleanup so the snapshot doesn't leak into other tests.
  _internal.sites.delete(sid);
  _internal.blobs.delete(sha);
});

test('serveContent: 404 (file missing inside an existing snapshot) also carries ACAO', async () => {
  const sid = '0000000000000003';
  _internal.sites.set(sid, {
    pubkey:  'c'.repeat(64),
    display: 'mock',
    // Note: NO index.html — and the requested path is a .bin (asset
    // extension), so the SPA-fallback to index.html is skipped and we
    // get a real 404 instead.
    index: {
      files: new Map([['other.txt', 'd'.repeat(64)]]),
      latestAt: 0, oldestAt: 0, entries: [],
      totalEventsSeen: 0, format: 'v1', manifestServers: [],
    },
    blossomServers: [],
    createdAt: Date.now(),
  });
  const res = makeMockRes();
  await handleNsite(
    { method: 'GET' } as any,
    res as any,
    `/nsite-content/${sid}/missing.bin`,
    'GET',
  );
  assert.equal(res.statusCode, 404);
  assert.equal(res.headers['access-control-allow-origin'], '*');
  _internal.sites.delete(sid);
});
