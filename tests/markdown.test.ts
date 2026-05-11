import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// markdown.js is a browser ES module that consumes window.marked +
// window.DOMPurify globals. We load it once into a stubbed window
// for the test run; each test resets the globals to its own scenario.
//
// Why test the fallback path so carefully:
//   - The helper is the ONLY place the dashboard sanitises arbitrary
//     content from relays (READMEs, future patch cover letters,
//     issue bodies, comments). A regression here is XSS.
//   - We pin the "vendor unloaded → escaped plain text" behaviour as
//     a hard contract: a missing script tag must never silently
//     pass markdown through unescaped.

const g: any = globalThis as any;
if (typeof g.window === 'undefined') g.window = g;

const { renderMarkdown, renderCodeBlock, escapeHtml } =
  await import('../src/web/markdown.js' as any);

beforeEach(() => {
  delete g.window.marked;
  delete g.window.DOMPurify;
});
afterEach(() => {
  delete g.window.marked;
  delete g.window.DOMPurify;
});

// ── escapeHtml ──────────────────────────────────────────────────────────

test('escapeHtml: encodes the standard five XML entities', () => {
  assert.equal(
    escapeHtml(`<script>alert("x" & 'y')</script>`),
    '&lt;script&gt;alert(&quot;x&quot; &amp; &#039;y&#039;)&lt;/script&gt;',
  );
});

test('escapeHtml: ampersand encoded first (no double-encoding)', () => {
  // The classic regression — encoding `<` first then `&` would
  // produce `&amp;lt;`. We encode `&` first.
  assert.equal(escapeHtml('a & b < c'), 'a &amp; b &lt; c');
});

test('escapeHtml: numeric / non-string inputs coerced via String()', () => {
  assert.equal(escapeHtml(42 as any),         '42');
  assert.equal(escapeHtml(null as any),       'null');
  assert.equal(escapeHtml(undefined as any),  'undefined');
});

// ── renderMarkdown: degraded paths ──────────────────────────────────────

test('renderMarkdown: returns empty string for empty / non-string input', () => {
  assert.equal(renderMarkdown(''),               '');
  assert.equal(renderMarkdown(null as any),      '');
  assert.equal(renderMarkdown(undefined as any), '');
  assert.equal(renderMarkdown(42 as any),        '');
});

test('renderMarkdown: escapes input when marked global is missing', () => {
  // Pretend DOMPurify loaded but marked didn't.
  g.window.DOMPurify = { sanitize: (s: string) => s };
  assert.equal(
    renderMarkdown('<script>alert(1)</script>'),
    '&lt;script&gt;alert(1)&lt;/script&gt;',
  );
});

test('renderMarkdown: escapes input when DOMPurify global is missing', () => {
  // Marked alone is not enough — we never emit unsanitised HTML even
  // if the markdown parser succeeds.
  g.window.marked = {
    use:   () => {},
    parse: (s: string) => `<p>${s}</p>`,
  };
  assert.equal(
    renderMarkdown('<script>alert(1)</script>'),
    '&lt;script&gt;alert(1)&lt;/script&gt;',
  );
});

test('renderMarkdown: escapes input when marked.parse throws', () => {
  // A malformed input that crashes marked falls through to the
  // escape path rather than bubbling an exception into the UI.
  g.window.marked = {
    use:   () => {},
    parse: () => { throw new Error('boom'); },
  };
  g.window.DOMPurify = { sanitize: (s: string) => s };
  assert.equal(renderMarkdown('# heading'), '# heading');
});

// ── renderMarkdown: happy path with stubs ───────────────────────────────

test('renderMarkdown: pipes marked output through DOMPurify.sanitize', () => {
  // Stubs assert that parse → sanitize order is preserved AND that
  // PURIFY_CONFIG is passed (we just confirm the call signature; the
  // policy itself is exercised by the upstream DOMPurify test suite).
  let parseInput  = '';
  let sanitizeIn  = '';
  let sanitizeCfg: any = null;
  g.window.marked = {
    use:   () => {},
    parse: (s: string) => { parseInput = s; return `<p>${s}</p>`; },
  };
  g.window.DOMPurify = {
    sanitize: (html: string, cfg: any) => {
      sanitizeIn  = html;
      sanitizeCfg = cfg;
      return html.replace('script', 'noscript');  // stand-in transformation
    },
  };
  const out = renderMarkdown('hello script');
  assert.equal(parseInput,    'hello script');
  assert.equal(sanitizeIn,    '<p>hello script</p>');
  // Config object is passed (tells us downstream policy applies).
  assert.ok(sanitizeCfg && Array.isArray(sanitizeCfg.ALLOWED_ATTR));
  assert.equal(out, '<p>hello noscript</p>');
});

// ── renderCodeBlock ─────────────────────────────────────────────────────

test('renderCodeBlock: wraps escaped code in <pre><code>', () => {
  // No highlight.js in Phase 1b — output is structural only.
  // Pinning the markup so the next phase's hljs swap is a deliberate
  // change, not a silent transformation.
  assert.equal(
    renderCodeBlock(`const x = "<b>"`, 'js'),
    '<pre><code>const x = &quot;&lt;b&gt;&quot;</code></pre>',
  );
});

test('renderCodeBlock: empty input produces empty string', () => {
  assert.equal(renderCodeBlock('',  'js'),         '');
  assert.equal(renderCodeBlock(undefined as any),  '');
});
