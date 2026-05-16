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
  injectReporterOnly, handleNsite, handleNsiteSubdomain, _internal,
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
  // 'unsafe-eval' on its own must remain blocked.
  assert.ok(!/\b'unsafe-eval'/.test(STRICT_NSITE_CSP),
    "CSP must not allow 'unsafe-eval' on its own — blocks dynamic code synthesis");
});

test('CSP: WebAssembly compilation allowed via wasm-unsafe-eval', () => {
  // CSP3 gates WebAssembly.compile / .instantiate / .compileStreaming /
  // .instantiateStreaming behind script-src 'wasm-unsafe-eval'. Without
  // it, WASM-shipping nsites (e.g. Nostrord, which publishes 6+ MB of
  // .wasm + .wasm.br + .wasm.gz alongside its JS shell) hang on their
  // loading splash forever — the instantiation call throws CompileError
  // synchronously and the bundle's load-promise never resolves.
  //
  // 'wasm-unsafe-eval' is strictly narrower than 'unsafe-eval': it
  // allows WASM only, NOT arbitrary eval() / new Function(). Those
  // still need 'unsafe-eval' which we deliberately don't grant. So
  // adding this token unblocks WASM nsites without weakening the JS
  // dynamic-code-synthesis lockdown.
  assert.match(STRICT_NSITE_CSP, /script-src[^;]*'wasm-unsafe-eval'/);
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
  // Reporter builds the payload as `Object.assign({type:t,siteId:S},p)` and
  // hands it to `window.parent.postMessage(msg,"*")`. Verify both halves
  // of the contract — the payload assembly and the delivery target.
  assert.match(out, /Object\.assign\(\{type:t,siteId:S\}/);
  assert.match(out, /window\.parent\.postMessage\(msg,"\*"\)/);
});

test('reporter: logs a boot line at script entry (silent-failure diagnostic)', () => {
  // The boot line is the canary: a single console.info at the very top
  // of the IIFE. If a future inline-script CSP-block / injection regex
  // miss takes the reporter out, the absence of this line in an
  // iframe-context devtools is the smoking gun. Wrapped in its own
  // try/catch so the script keeps running even if console is null.
  const out = dec(rewriteHtmlAbsolutePaths(enc(`<html><head></head></html>`), SID));
  assert.match(out, /console\.info\("\[nsite-report\] boot",S\)/);
});

test('reporter: dual-path delivery (window.parent + window.top fallback)', () => {
  // The previous reporter used a bare `parent.postMessage` wrapped in a
  // silent try/catch. Field repro across three nsites showed the panel
  // never receiving any messages — the catch swallowed the failure path.
  // Now we attempt window.parent AND window.top, and log a console.warn
  // if either throws + if neither delivers anything. The test confirms
  // both paths exist in the emitted script.
  const out = dec(rewriteHtmlAbsolutePaths(enc(`<html><head></head></html>`), SID));
  assert.match(out, /window\.parent\.postMessage\(msg,"\*"\)/, 'parent path must remain');
  assert.match(out, /window\.top\.postMessage\(msg,"\*"\)/,    'top fallback path must be present');
  assert.match(out, /parent\.postMessage threw/,    'parent failure path must log');
  assert.match(out, /top\.postMessage threw/,       'top failure path must log');
});

test('reporter: behaves correctly when run against a fake window', () => {
  const out = dec(rewriteHtmlAbsolutePaths(enc(`<html><head></head></html>`), SID));
  // Pick the reporter (var S=...) not the fetch shim (var P=...).
  const blocks = out.match(/<script>\(function\(\)\{[\s\S]*?\}\)\(\);<\/script>/g) ?? [];
  const reporter = blocks.find(b => b.includes('var S='));
  assert.ok(reporter, 'reporter block must be present');
  const body = reporter!.replace(/^<script>/, '').replace(/<\/script>$/, '');

  // Run the reporter in a sandboxed window. The reporter now references
  // `window.parent` / `window.top` (not bare `parent` / `top`), so the
  // fake window object must expose both. parent === top here mirrors a
  // single-level iframe (no nesting); the reporter handles that
  // explicitly (`window.top !== window.parent` check) so we expect
  // only one delivery per message.
  const listeners: Record<string, Function[]> = {};
  const posted: any[] = [];
  const postFn = (msg: any) => { posted.push(msg); };
  const fakeWindow: any = {
    addEventListener: (name: string, fn: Function) => {
      (listeners[name] ||= []).push(fn);
    },
  };
  fakeWindow.parent = { postMessage: postFn };
  fakeWindow.top    = fakeWindow.parent;        // typical iframe shape
  // The reporter reads `location.href` once at boot for the "loaded"
  // payload. Stub it so the script doesn't ReferenceError under Node.
  const fakeLocation: any = { href: `http://127.0.0.1:3000/nsite-content/${SID}/index.html` };
  // Silence the console.info / console.warn lines the reporter emits at
  // boot; failures get re-raised so a regression is loud, not silent.
  const fakeConsole: any = { info: () => {}, warn: () => {} };
  new Function('window', 'location', 'console', body)(fakeWindow, fakeLocation, fakeConsole);

  // The reporter immediately sends a "loaded" message so the panel
  // knows the iframe successfully booted.
  const loaded = posted.find((p) => p.type === 'nsite-loaded');
  assert.ok(loaded, 'should immediately post nsite-loaded');
  assert.equal(loaded.siteId, SID, 'loaded message carries siteId');
  // parent === top in the fake → only one delivery (top branch's
  // `window.top !== window.parent` guard skips the dup).
  assert.equal(posted.filter(p => p.type === 'nsite-loaded').length, 1,
    'duplicate-target dedup: top falls back only when distinct from parent');

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

test('reporter: parent.postMessage throwing does not skip top fallback', () => {
  // The previous shape wrapped one combined try/catch around the whole
  // send. If parent.postMessage threw, top never got a chance. The new
  // shape uses two separate try/catch blocks so a parent failure still
  // tries top — and logs the failure to the iframe console.
  const out = dec(rewriteHtmlAbsolutePaths(enc(`<html><head></head></html>`), SID));
  const blocks = out.match(/<script>\(function\(\)\{[\s\S]*?\}\)\(\);<\/script>/g) ?? [];
  const reporter = blocks.find(b => b.includes('var S='));
  const body = reporter!.replace(/^<script>/, '').replace(/<\/script>$/, '');

  const posted: any[] = [];
  const fakeWindow: any = { addEventListener: () => {} };
  // Parent throws; top is distinct and succeeds.
  fakeWindow.parent = { postMessage: () => { throw new Error('parent blocked'); } };
  fakeWindow.top    = { postMessage: (msg: any) => { posted.push(msg); } };
  const fakeLocation: any = { href: 'http://test/' };
  const warnings: any[] = [];
  const fakeConsole: any = {
    info: () => {},
    warn: (...args: any[]) => { warnings.push(args); },
  };
  new Function('window', 'location', 'console', body)(fakeWindow, fakeLocation, fakeConsole);

  // The "loaded" message was delivered via the top fallback even though
  // parent.postMessage threw.
  assert.equal(posted.length, 1, 'top should still receive the message when parent throws');
  assert.equal(posted[0].type, 'nsite-loaded');
  // And the parent failure was logged to the iframe console (not
  // silently swallowed) so a "still silent" debug is a one-line read.
  assert.ok(warnings.some(w => String(w[0]).includes('parent.postMessage threw')),
    'parent failure must surface as a console.warn');
});

test('reporter: zero-delivery (no parent, no top) logs but does not throw', () => {
  // Edge case: a top-level (non-iframed) document somehow served from
  // /nsite-content/* — `window.parent === window` and `window.top ===
  // window` so neither send path delivers. The reporter must not throw
  // (otherwise it tanks the page), and it must log the no-delivery
  // case so it doesn't look identical to "everything worked silently".
  const out = dec(rewriteHtmlAbsolutePaths(enc(`<html><head></head></html>`), SID));
  const blocks = out.match(/<script>\(function\(\)\{[\s\S]*?\}\)\(\);<\/script>/g) ?? [];
  const reporter = blocks.find(b => b.includes('var S='));
  const body = reporter!.replace(/^<script>/, '').replace(/<\/script>$/, '');

  const warnings: any[] = [];
  const fakeWindow: any = { addEventListener: () => {} };
  fakeWindow.parent = fakeWindow;   // === window → branch skipped
  fakeWindow.top    = fakeWindow;   // === window → branch skipped
  const fakeLocation: any = { href: 'http://test/' };
  const fakeConsole: any = {
    info: () => {},
    warn: (...args: any[]) => { warnings.push(args); },
  };
  assert.doesNotThrow(() => {
    new Function('window', 'location', 'console', body)(fakeWindow, fakeLocation, fakeConsole);
  });
  assert.ok(warnings.some(w => String(w[0]).includes('no parent/top reachable')),
    'no-delivery case must log so absence-of-Diagnostics is diagnosable');
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

// ── injectReporterOnly (subdomain mode) ───────────────────────────────────
//
// In subdomain mode the per-nsite origin makes <img src="/foo"> resolve
// natively — no static rewriter needed, no importmap needed, no
// fetch/XHR/EventSource shim needed. We still want the diagnostic
// reporter for the panel's Diagnostics block, so a separate inject path
// drops just that one <script> in.

test('injectReporterOnly: reporter <script> is the ONLY thing injected', () => {
  const out = dec(injectReporterOnly(enc(`<html><head></head><body></body></html>`), SID));
  // The reporter is identifiable by `var S=` (the siteId-baked block).
  assert.match(out, /<script>\(function\(\)\{var S=/, 'reporter must be present');
  // The full-shim hallmarks must NOT be present.
  assert.ok(!out.includes('importmap'), 'importmap must be skipped in subdomain mode');
  assert.ok(!out.includes('var P='),    'fetch shim (var P=...) must be skipped — paths resolve natively');
  assert.ok(!out.includes('XMLHttpRequest.prototype.open'),
    'XHR patch must be skipped in subdomain mode');
});

test('injectReporterOnly: lands right after <head> opening tag', () => {
  const out = dec(injectReporterOnly(enc(
    `<html><head><title>x</title></head><body>hi</body></html>`,
  ), SID));
  const headIdx     = out.indexOf('<head>');
  const reporterIdx = out.indexOf('<script>(function()');
  const titleIdx    = out.indexOf('<title>');
  assert.ok(headIdx >= 0 && reporterIdx > headIdx && reporterIdx < titleIdx,
    'reporter must come right after <head> and before any user content');
});

test('injectReporterOnly: falls back to <html> when <head> missing', () => {
  const out = dec(injectReporterOnly(enc(`<html><body>hi</body></html>`), SID));
  assert.ok(out.indexOf('<script>') > out.indexOf('<html>'),
    'reporter must follow <html> opening tag when <head> is absent');
});

test('injectReporterOnly: prepended when neither <head> nor <html> exist', () => {
  const out = dec(injectReporterOnly(enc(`<p>fragment</p>`), SID));
  assert.ok(out.startsWith('<script>(function()'),
    'reporter must be the first content for fragment HTML');
});

test('injectReporterOnly: does not double-rewrite absolute paths (subdomain mode == natural resolution)', () => {
  // Critical contract: in subdomain mode, <img src="/foo.jpg"> must reach
  // the browser UNCHANGED — the per-nsite origin resolves it naturally.
  // If we accidentally rewrite to /nsite-content/<sid>/foo.jpg, the
  // subdomain handler tries to look up "nsite-content/<sid>/foo.jpg"
  // inside the manifest, which doesn't exist, and the asset 404s.
  const html = `<html><head></head><body><img src="/img/avatar.jpg"><script src="/main.js"></script></body></html>`;
  const out  = dec(injectReporterOnly(enc(html), SID));
  assert.ok(out.includes('src="/img/avatar.jpg"'), 'absolute img src must NOT be rewritten');
  assert.ok(out.includes('src="/main.js"'),        'absolute script src must NOT be rewritten');
  assert.ok(!out.includes(`/nsite-content/${SID}/`),
    'subdomain mode must NEVER emit a /nsite-content/<sid>/ path');
});

// ── handleNsiteSubdomain (per-origin entry point) ─────────────────────────

test('handleNsiteSubdomain: serves index.html with no path rewriting, no X-Frame-Options', async () => {
  const sid = '0000000000000010';
  const sha = '7'.repeat(64);
  _internal.sites.set(sid, {
    pubkey: '8'.repeat(64), display: 'mock',
    index: {
      files: new Map([['index.html', sha]]),
      latestAt: 0, oldestAt: 0, entries: [],
      totalEventsSeen: 0, format: 'v2-named', manifestServers: [],
    },
    blossomServers: [], createdAt: Date.now(),
  });
  _internal.blobs.set(sha, {
    bytes: new TextEncoder().encode(`<html><head></head><body><img src="/logo.png"></body></html>`),
    mime:  'text/html; charset=utf-8',
  });
  const res = makeMockRes();
  const req = { method: 'GET', headers: { host: `${sid}.nsite.localhost:3000` } } as any;
  await handleNsiteSubdomain(req, res, sid, '/');

  assert.equal(res.statusCode, 200);
  // X-Frame-Options must be ABSENT in subdomain mode (would block the
  // cross-origin dashboard from embedding via SAMEORIGIN).
  assert.equal(res.headers['x-frame-options'], undefined,
    'subdomain mode must omit X-Frame-Options — frame-ancestors handles embedding');
  // CSP must allow the dashboard origin as a frame-ancestor.
  const csp = String(res.headers['content-security-policy'] || '');
  assert.match(csp, /frame-ancestors http:\/\/localhost:3000/,
    'CSP frame-ancestors must grant the dashboard loopback origin');
  assert.match(csp, /http:\/\/127\.0\.0\.1:3000/,
    'CSP frame-ancestors must grant 127.0.0.1 dashboard origin');
  // Regression guard: CSP3's host-source grammar doesn't accept
  // bracketed IPv6 hosts. Chromium silently invalidates the WHOLE
  // frame-ancestors directive when one is present and falls back to
  // `'self'` — and since the iframe origin (<sid>.nsite.localhost) is
  // cross-origin to the dashboard parent (localhost), that effectively
  // blocks every embed. Same fix shape as #118's `ws://[::1]:*` drop
  // from connect-src. Confirmed in Brave field test: bracketed-IPv6
  // present → ERR_BLOCKED_BY_RESPONSE on every iframe load; absent →
  // all five test nsites render.
  assert.ok(!/\[::1\]/.test(csp),
    'CSP must not contain bracketed-IPv6 host in any directive — Chromium rejects the source and may invalidate the directive');
  // Body must contain the original /logo.png reference unchanged.
  // res.body is a Uint8Array — decode before string-matching.
  const body = res.body instanceof Uint8Array
    ? new TextDecoder('utf-8').decode(res.body)
    : String(res.body);
  assert.ok(body.includes('src="/logo.png"'),
    'absolute paths must reach the browser unchanged in subdomain mode');
  assert.ok(!body.includes(`/nsite-content/${sid}/`),
    'no /nsite-content/<sid>/ prefix should leak into the served HTML');
  // ACAO + Vary unchanged from path-prefix mode.
  assert.equal(res.headers['access-control-allow-origin'], '*');
  _internal.sites.delete(sid);
  _internal.blobs.delete(sha);
});

test('handleNsiteSubdomain: rejects non-GET/HEAD with 405', async () => {
  const sid = '0000000000000011';
  const res = makeMockRes();
  const req = { method: 'POST', headers: { host: `${sid}.nsite.localhost:3000` } } as any;
  await handleNsiteSubdomain(req, res, sid, '/');
  assert.equal(res.statusCode, 405);
});

test('handleNsiteSubdomain: strips query and hash from path lookup', async () => {
  // Manifest paths are content-addressed — no query / hash semantics.
  // The lookup must therefore strip them, otherwise legitimate paths
  // with a cache-busting `?v=...` (which some SPAs append) would 404.
  const sid = '0000000000000012';
  const sha = '9'.repeat(64);
  _internal.sites.set(sid, {
    pubkey: 'a'.repeat(64), display: 'mock',
    index: {
      files: new Map([['style.css', sha]]),
      latestAt: 0, oldestAt: 0, entries: [],
      totalEventsSeen: 0, format: 'v2-named', manifestServers: [],
    },
    blossomServers: [], createdAt: Date.now(),
  });
  _internal.blobs.set(sha, {
    bytes: new TextEncoder().encode('body{color:red}'),
    mime:  'text/css; charset=utf-8',
  });
  const res = makeMockRes();
  const req = { method: 'GET', headers: { host: `${sid}.nsite.localhost:3000` } } as any;
  await handleNsiteSubdomain(req, res, sid, '/style.css?v=abc123#frag');
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['content-type']), /text\/css/);
  _internal.sites.delete(sid);
  _internal.blobs.delete(sha);
});

test('handleNsiteSubdomain: 410 when snapshot is expired/missing', async () => {
  const sid = '0000000000000013';
  _internal.sites.delete(sid);
  const res = makeMockRes();
  const req = { method: 'GET', headers: { host: `${sid}.nsite.localhost:3000` } } as any;
  await handleNsiteSubdomain(req, res, sid, '/index.html');
  assert.equal(res.statusCode, 410);
  assert.equal(res.headers['access-control-allow-origin'], '*');
});

test('handleNsiteSubdomain: 200-response CSP does NOT contain the path-prefix \'self\' frame-ancestors literal', async () => {
  // Regression guard for the CSP rewrite. If the substitution misfires
  // and we ship STRICT_NSITE_CSP verbatim on a subdomain 200, the
  // dashboard (cross-origin parent) cannot embed the iframe — silent
  // black box from the user's perspective. This catches that early.
  const sid = '0000000000000014';
  const sha = 'b'.repeat(64);
  _internal.sites.set(sid, {
    pubkey: 'c'.repeat(64), display: 'mock',
    index: {
      files: new Map([['index.html', sha]]),
      latestAt: 0, oldestAt: 0, entries: [],
      totalEventsSeen: 0, format: 'v2-named', manifestServers: [],
    },
    blossomServers: [], createdAt: Date.now(),
  });
  _internal.blobs.set(sha, {
    bytes: new TextEncoder().encode('<html><head></head><body></body></html>'),
    mime:  'text/html; charset=utf-8',
  });
  const res = makeMockRes();
  const req = { method: 'GET', headers: { host: `${sid}.nsite.localhost:3000` } } as any;
  await handleNsiteSubdomain(req, res, sid, '/');
  const csp = String(res.headers['content-security-policy'] || '');
  assert.ok(!/frame-ancestors 'self'/.test(csp),
    "subdomain mode must replace 'self' in frame-ancestors with explicit loopback origins");
  _internal.sites.delete(sid);
  _internal.blobs.delete(sha);
});

// ── Per-site trust toggle ──────────────────────────────────────────────
//
// nsite.json's trustedExternalNsites list lets the user grant a single
// nsite the ability to load external HTTPS resources (esm.sh modules,
// nostr.build images, fonts, etc.) without loosening the strict CSP
// for everyone else. The route layer reads the list at resolve time
// and freezes a per-snapshot `trusted` flag; the served CSP gets
// `https:` added to the network-loading directives when that flag is
// set.

test('serveContent: untrusted snapshot keeps strict CSP (no https: in script-src)', async () => {
  const sid = '0000000000000020';
  const sha = '1'.repeat(64);
  _internal.sites.set(sid, {
    pubkey: '2'.repeat(64), display: 'mock',
    index: {
      files: new Map([['index.html', sha]]),
      latestAt: 0, oldestAt: 0, entries: [],
      totalEventsSeen: 0, format: 'v2-named', manifestServers: [],
    },
    blossomServers: [], createdAt: Date.now(),
    trusted: false,
  });
  _internal.blobs.set(sha, {
    bytes: new TextEncoder().encode('<html><head></head><body></body></html>'),
    mime:  'text/html; charset=utf-8',
  });
  const res = makeMockRes();
  const req = { method: 'GET', headers: { host: `${sid}.nsite.localhost:3000` } } as any;
  await handleNsiteSubdomain(req, res, sid, '/');
  const csp = String(res.headers['content-security-policy'] || '');
  // No `https:` token added to any -src directive.
  assert.ok(!/script-src[^;]*\bhttps:/.test(csp),  'untrusted: script-src must NOT contain https:');
  assert.ok(!/img-src[^;]*\bhttps:/.test(csp),    'untrusted: img-src must NOT contain https:');
  assert.ok(!/connect-src[^;]*\bhttps:/.test(csp), 'untrusted: connect-src must NOT contain https:');
  _internal.sites.delete(sid);
  _internal.blobs.delete(sha);
});

test('serveContent: trusted snapshot adds https: to network-loading directives', async () => {
  const sid = '0000000000000021';
  const sha = '3'.repeat(64);
  _internal.sites.set(sid, {
    pubkey: '4'.repeat(64), display: 'mock',
    index: {
      files: new Map([['index.html', sha]]),
      latestAt: 0, oldestAt: 0, entries: [],
      totalEventsSeen: 0, format: 'v2-named', manifestServers: [],
    },
    blossomServers: [], createdAt: Date.now(),
    trusted: true,
  });
  _internal.blobs.set(sha, {
    bytes: new TextEncoder().encode('<html><head></head><body></body></html>'),
    mime:  'text/html; charset=utf-8',
  });
  const res = makeMockRes();
  const req = { method: 'GET', headers: { host: `${sid}.nsite.localhost:3000` } } as any;
  await handleNsiteSubdomain(req, res, sid, '/');
  const csp = String(res.headers['content-security-policy'] || '');
  // Each network-loading directive must now carry `https:`.
  assert.match(csp, /script-src[^;]*\bhttps:/,  'trusted: script-src must include https: so esm.sh modules load');
  assert.match(csp, /img-src[^;]*\bhttps:/,     'trusted: img-src must include https: for nostr.build images etc.');
  assert.match(csp, /connect-src[^;]*\bhttps:/, 'trusted: connect-src must include https: for fetch/XHR');
  assert.match(csp, /font-src[^;]*\bhttps:/,    'trusted: font-src must include https: for Google Fonts');
  assert.match(csp, /style-src[^;]*\bhttps:/,   'trusted: style-src must include https: for external stylesheets');
  assert.match(csp, /media-src[^;]*\bhttps:/,   'trusted: media-src must include https: for hosted audio/video');
  // Trust DOES add 'unsafe-eval' to script-src — required by modern
  // bundle loaders (Next.js / Turbopack / SWC) that synthesize chunk
  // loader code at runtime. Field-confirmed against nsite://titan,
  // whose Turbopack runtime throws `EvalError: Evaluating a string as
  // JavaScript violates the following Content Security Policy directive`
  // when 'unsafe-eval' is absent. This isn't a meaningful blast-radius
  // expansion: 'unsafe-inline' is already granted everywhere, so an
  // author can already ship arbitrary inline JS in their bundle.
  assert.match(csp, /script-src[^;]*'unsafe-eval'/,
    "trusted: script-src must include 'unsafe-eval' for Next.js / Turbopack-style runtime bundle loaders");
  // What STILL stays blocked even with trust: object-src + frame-ancestors.
  // Plugins (Flash/etc.) and clickjacking surface are categorically
  // distinct from "running the author's code in the author's origin."
  assert.match(csp, /object-src 'none'/,
    'trusted: object-src none must remain to keep plugins disabled');
  _internal.sites.delete(sid);
  _internal.blobs.delete(sha);
});

test('POST /api/nsite/trust: adds a pubkey to the allowlist', async () => {
  const pk = '5'.repeat(64);
  const res = makeMockRes();
  const req = {
    method: 'POST',
    headers: { host: 'localhost:3000', 'content-type': 'application/json' },
    // Mock the readBody stream: return a JSON body when readBody pulls it.
    on: (event: string, cb: any) => {
      if (event === 'data') cb(Buffer.from(JSON.stringify({ pubkey: pk, allow: true })));
      if (event === 'end')  cb();
      return req;
    },
  } as any;
  const handled = await handleNsite(req, res, '/api/nsite/trust', 'POST');
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(String(res.body));
  assert.equal(body.pubkey, pk);
  assert.equal(body.trusted, true);
  assert.ok(body.trustedExternalNsites.includes(pk),
    'response must list the trusted pubkey for the panel to update from');
});

test('POST /api/nsite/trust: removes a pubkey when allow=false', async () => {
  const pk = '6'.repeat(64);
  // First add it via the same endpoint so we don't depend on test order.
  let res = makeMockRes();
  let req = {
    method: 'POST',
    headers: { host: 'localhost:3000', 'content-type': 'application/json' },
    on: (event: string, cb: any) => {
      if (event === 'data') cb(Buffer.from(JSON.stringify({ pubkey: pk, allow: true })));
      if (event === 'end')  cb();
      return req;
    },
  } as any;
  await handleNsite(req, res, '/api/nsite/trust', 'POST');
  // Now remove.
  res = makeMockRes();
  req = {
    method: 'POST',
    headers: { host: 'localhost:3000', 'content-type': 'application/json' },
    on: (event: string, cb: any) => {
      if (event === 'data') cb(Buffer.from(JSON.stringify({ pubkey: pk, allow: false })));
      if (event === 'end')  cb();
      return req;
    },
  } as any;
  await handleNsite(req, res, '/api/nsite/trust', 'POST');
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(String(res.body));
  assert.equal(body.trusted, false);
  assert.ok(!body.trustedExternalNsites.includes(pk),
    'revoking must remove the pubkey from the list');
});

test('POST /api/nsite/trust: rejects malformed pubkey with 400', async () => {
  const res = makeMockRes();
  const req = {
    method: 'POST',
    headers: { host: 'localhost:3000', 'content-type': 'application/json' },
    on: (event: string, cb: any) => {
      if (event === 'data') cb(Buffer.from(JSON.stringify({ pubkey: 'not-hex', allow: true })));
      if (event === 'end')  cb();
      return req;
    },
  } as any;
  await handleNsite(req, res, '/api/nsite/trust', 'POST');
  assert.equal(res.statusCode, 400);
  const body = JSON.parse(String(res.body));
  assert.equal(body.error, 'invalid_pubkey');
});

test('POST /api/nsite/trust: clears snapshot cache so re-resolve gets new posture', async () => {
  // Add a fake snapshot to the cache, call trust, verify cache is cleared.
  // Important so the panel's re-resolve-after-toggle reflects the new
  // posture instead of returning a cached snapshot with the old `trusted`
  // flag.
  const pk = '7'.repeat(64);
  _internal.sites.set('cachedsid0000001', {
    pubkey: 'd'.repeat(64), display: 'mock',
    index: {
      files: new Map([['index.html', 'e'.repeat(64)]]),
      latestAt: 0, oldestAt: 0, entries: [],
      totalEventsSeen: 0, format: 'v2-named', manifestServers: [],
    },
    blossomServers: [], createdAt: Date.now(),
    trusted: false,
  });
  assert.ok(_internal.sites.has('cachedsid0000001'));
  const res = makeMockRes();
  const req = {
    method: 'POST',
    headers: { host: 'localhost:3000', 'content-type': 'application/json' },
    on: (event: string, cb: any) => {
      if (event === 'data') cb(Buffer.from(JSON.stringify({ pubkey: pk, allow: true })));
      if (event === 'end')  cb();
      return req;
    },
  } as any;
  await handleNsite(req, res, '/api/nsite/trust', 'POST');
  assert.equal(_internal.sites.size, 0,
    'trust write must clear the snapshot cache so re-resolve sees the new posture');
});
