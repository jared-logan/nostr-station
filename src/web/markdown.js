// Tiny wrapper over the vendored `marked` + `DOMPurify` libraries.
//
// Loaded by app.js for any UI surface that renders user-authored
// markdown — Phase 1c's README block in the Code tab is the first
// caller; Phase 2/3 add patches and issue bodies. Centralising the
// configuration here keeps the sanitization policy uniform across
// every rendering surface.
//
// Why not bundle into app.js?
//   - app.js is a single 5800-line file at HEAD; isolating new
//     concerns into siblings keeps each manageable.
//   - The vendored libs are large (~70 kB combined). Loading them
//     from a separate script tag means a future "lazy on first use"
//     refactor is a one-line change (drop the static <script> tag,
//     add a dynamic import gate).
//
// Globals consumed:
//   - window.marked      (vendor/marked.umd.js)
//   - window.DOMPurify   (vendor/dompurify.min.js)
//   - window.hljs        (vendor/highlight.min.js — optional; absent
//                         means code blocks render as plain <pre><code>)
//
// All exports degrade gracefully when a global is missing — the
// returned HTML is escaped plain-text rather than raw markdown, so
// the dashboard never displays untrusted content unsanitised even
// if a vendor file fails to load.

/**
 * Decide how to render an external image URL.
 *
 * The dashboard's CSP is `img-src 'self' data:`, so raw https:// loads
 * are refused — every external image must route through /api/img-proxy
 * with a server-issued HMAC signature (see src/lib/img-proxy-sign.ts).
 * Two paths emit signed URLs depending on where the URL came from:
 *
 *   - **Server-emitted fields** (profile picture/banner, Ditto theme
 *     bgImage, ProfileLite in /api/profiles). The
 *     server pre-signs at JSON-emission time and the URL arrives at
 *     the browser as `/api/img-proxy?u=…&s=…` already. `proxyImageUrl`
 *     detects the already-signed shape and passes through unchanged.
 *
 *   - **Markdown image hrefs** (README content, kind-30023 articles,
 *     comment bodies). These aren't known to the server at JSON time —
 *     they appear inside markdown text. The marked.js `image()` renderer
 *     emits `<img data-raw-src="…">` with NO `src`, then
 *     `signMarkdownImages()` (scheduled after innerHTML mounts) batches
 *     the raw URLs to POST /api/img-proxy/sign and fills in `src`.
 *
 * Pass-through (no proxy needed):
 *   - data: / blob: URLs (already self-contained)
 *   - Same-origin or relative paths (CSP `'self'` allows)
 *   - Loopback hosts (in-process Blossom, nsite subdomains)
 *   - http:// (proxy refuses; let the image silently fail rather than
 *     return a confusing proxy error)
 *   - Already-signed /api/img-proxy URLs (the server pre-signed)
 */
export function proxyImageUrl(u) {
  if (!u) return u;
  const s = String(u).trim();
  if (!s) return s;
  if (s.startsWith('data:') || s.startsWith('blob:')) return s;
  // Already-signed proxy URL emitted by the server (profile JSON,
  // Ditto theme, etc.) — pass through unchanged.
  if (s.startsWith('/api/img-proxy?')) return s;
  if (s.startsWith('/') && !s.startsWith('//'))       return s;
  try {
    const parsed = new URL(s, (typeof location !== 'undefined' && location.href) || 'http://127.0.0.1');
    if (typeof location !== 'undefined' && parsed.origin === location.origin) return s;
    const h = parsed.hostname;
    if (h === '127.0.0.1' || h === 'localhost' || h === '::1' || h.endsWith('.localhost')) return s;
    if (parsed.protocol !== 'https:') return s;
    // Caller (e.g. legacy app.js render path) handed us a raw https URL.
    // Without a server signature the proxy will 401 the request, so the
    // <img> will show alt text. Surface a console hint once per URL so
    // missing pre-signing sites are easy to spot during development.
    if (typeof console !== 'undefined' && console.warn) {
      warnUnsigned(parsed.toString());
    }
    return `/api/img-proxy?u=${encodeURIComponent(parsed.toString())}`;
  } catch {
    return s;
  }
}

const _warnedUrls = new Set();
function warnUnsigned(u) {
  if (_warnedUrls.size > 200) return;  // bound the dedupe set
  if (_warnedUrls.has(u)) return;
  _warnedUrls.add(u);
  try { console.warn('[img-proxy] unsigned URL, proxy will 401:', u); } catch (_) {}
}

/**
 * Walk a freshly-mounted DOM subtree for `<img data-raw-src>` placeholders
 * emitted by the marked.js image renderer, batch the raw URLs to
 * /api/img-proxy/sign, and fill in `src` with the returned signed URLs.
 *
 * Fire-and-forget: callers do not await this. Image bytes appear with
 * a one-roundtrip delay; alt text shows in the interim. A failed sign
 * call leaves the placeholder unset, so the browser renders the alt
 * text — the same fallback shape as a missing image.
 *
 * Used by app.js wherever renderMarkdown() output is dropped into the
 * DOM (README preview, patch cover letter, issue/comment bodies, mail
 * body). Safe to call multiple times on the same subtree — the
 * `data-signed` flag prevents redundant work.
 */
/**
 * MutationObserver that auto-runs signMarkdownImages on any DOM
 * subtree containing freshly-mounted `<img data-raw-src>` elements.
 * Zero callsite changes: every `renderMarkdown` consumer just drops
 * the HTML into innerHTML the way it did pre-J9, and the observer
 * picks up the pending images on the next microtask.
 *
 * Watches document.body for childList + subtree mutations. Cost is
 * one (cheap) DOM walk per mutation batch; the per-image data-signed
 * flag short-circuits redundant work.
 */
let _markdownObserver = null;
export function startMarkdownImageObserver() {
  if (_markdownObserver) return;
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return;
  if (!document.body) return;
  _markdownObserver = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type !== 'childList') continue;
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;  // Element only
        // Cheap fast-path: only walk subtrees that actually contain a
        // data-raw-src node. querySelector short-circuits on first hit.
        if (node.matches?.('img[data-raw-src]') || node.querySelector?.('img[data-raw-src]')) {
          signMarkdownImages(node.parentNode || node);
        }
      }
    }
  });
  _markdownObserver.observe(document.body, { childList: true, subtree: true });
}

export function signMarkdownImages(rootEl) {
  if (!rootEl || !rootEl.querySelectorAll) return;
  const imgs = rootEl.querySelectorAll('img[data-raw-src]:not([data-signed])');
  if (!imgs.length) return;
  const urls = [];
  const seen = new Set();
  for (const el of imgs) {
    const raw = el.getAttribute('data-raw-src') || '';
    if (raw && !seen.has(raw)) { urls.push(raw); seen.add(raw); }
  }
  if (!urls.length) return;
  const token = (typeof localStorage !== 'undefined'
    ? localStorage.getItem('ns-session-token')
    : '') || '';
  fetch('/api/img-proxy/sign', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ urls }),
  }).then(r => r.ok ? r.json() : null).then(payload => {
    if (!payload || typeof payload.signed !== 'object') return;
    const lookup = payload.signed;
    for (const el of imgs) {
      const raw = el.getAttribute('data-raw-src') || '';
      const signed = lookup[raw];
      if (typeof signed === 'string') {
        el.setAttribute('src', signed);
      }
      el.setAttribute('data-signed', '1');
    }
  }).catch(() => {
    // Network error / 401 — leave placeholders unset, alt text renders.
  });
}

let markedConfigured = false;

function ensureMarkedConfigured() {
  if (markedConfigured) return;
  if (!window.marked || typeof window.marked.use !== 'function') return;
  // GFM = tables, strikethrough, autolinks, fenced code (the
  // de-facto standard most README authors target). `breaks: false`
  // preserves CommonMark behaviour for single newlines (treat as
  // space) — chat clients sometimes flip this on, but a README
  // viewer should mirror what the author sees on github / gitea.
  //
  // The custom renderer.code() routes fenced code through
  // renderCodeBlock so highlight.js (when present) styles README
  // code blocks the same way it styles standalone file previews.
  // Marked v15+ passes an object; we destructure to handle that.
  window.marked.use({
    gfm:    true,
    breaks: false,
    renderer: {
      code({ text, lang }) {
        return renderCodeBlock(text, lang);
      },
      // Emit a placeholder <img> with the RAW URL stashed in
      // data-raw-src. signMarkdownImages() (called by app.js after
      // each renderMarkdown mount) batches these to /api/img-proxy/sign
      // and fills in `src` asynchronously. We can't sign here because
      // the renderer is synchronous; we can't pre-sign server-side
      // because the URL only appears mid-markdown parse. marked v15+
      // passes { href, title, text } for image tokens.
      //
      // URLs that aren't candidates for proxying (data:, blob:,
      // same-origin, loopback) emit a normal <img src=…> via
      // proxyImageUrl's pass-through path — no signing needed.
      image({ href, title, text }) {
        const raw = String(href || '');
        const passthrough = proxyImageUrl(raw);
        const t = title ? ` title="${escapeHtml(title)}"` : '';
        const a = text  ? ` alt="${escapeHtml(text)}"`    : '';
        // If proxyImageUrl returned the raw URL unchanged (pass-through
        // case — data:, loopback, same-origin), drop it straight into
        // src. Otherwise it produced an unsigned proxy URL we can't
        // use; stash the raw URL in data-raw-src for async signing.
        if (passthrough === raw && !raw.startsWith('/api/img-proxy?')) {
          return `<img src="${escapeHtml(passthrough)}"${a}${t}>`;
        }
        return `<img data-raw-src="${escapeHtml(raw)}"${a}${t}>`;
      },
    },
  });
  markedConfigured = true;
}

// URI scheme allowlist for sanitised HTML. We accept the safe-by-
// default web schemes plus `nostr:` and `mailto:`. Drops `javascript:`,
// `data:` (image data URIs would be permitted via a separate img
// allowlist if needed), `vbscript:`, and friends.
const ALLOWED_URI_REGEXP =
  /^(?:(?:https?|mailto|nostr|magnet):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i;

const PURIFY_CONFIG = {
  // `data-raw-src` carries the un-signed external URL through DOMPurify
  // for the async-sign step (see signMarkdownImages). It's a plain
  // string attribute, not a URI-context attribute, so it's not subject
  // to ALLOWED_URI_REGEXP — the URL value is never used until
  // signMarkdownImages re-validates it server-side.
  ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'class', 'id', 'name', 'lang', 'target', 'rel', 'colspan', 'rowspan', 'align', 'data-raw-src'],
  ALLOWED_URI_REGEXP,
  // Keep <table>, <thead>, etc. (GFM tables) — DOMPurify allows them
  // by default; we just need to be sure ALLOWED_ATTR includes the
  // columnar attrs above.
  // FORBID_TAGS deliberately empty — DOMPurify's defaults already
  // strip <script>/<iframe>/<object>/<embed>/<form>/<input> etc.
};

/**
 * Render a markdown string to sanitised HTML. Always safe to drop
 * straight into `.innerHTML`. Returns escaped plain-text when the
 * vendored libraries aren't loaded so a missing script tag never
 * leaves untrusted content rendered raw.
 */
export function renderMarkdown(input) {
  if (typeof input !== 'string' || !input) return '';
  if (!window.marked || !window.DOMPurify) return escapeHtml(input);
  ensureMarkedConfigured();
  let html;
  try {
    html = window.marked.parse(input);
  } catch (_) {
    return escapeHtml(input);
  }
  return window.DOMPurify.sanitize(html, PURIFY_CONFIG);
}

/**
 * Render a single code block, with syntax highlighting via
 * highlight.js when the global is loaded. Three tiers of degradation:
 *   1. hljs + known language  → hljs.highlight (explicit grammar)
 *   2. hljs + unknown language → hljs.highlightAuto (heuristic)
 *   3. no hljs OR hljs throws  → escaped <pre><code>
 *
 * The plain-text escape path is the safety net: if every other branch
 * fails the worst case is a structurally-correct, unhighlighted block —
 * never raw HTML escaping into the page.
 */
export function renderCodeBlock(code, lang) {
  if (typeof code !== 'string' || !code) return '';
  if (window.hljs) {
    try {
      const known = lang && typeof window.hljs.getLanguage === 'function'
        && window.hljs.getLanguage(lang);
      let result;
      let cls = 'hljs';
      if (known) {
        result = window.hljs.highlight(code, { language: lang, ignoreIllegals: true });
        cls = `hljs language-${escapeHtml(lang)}`;
      } else if (typeof window.hljs.highlightAuto === 'function') {
        result = window.hljs.highlightAuto(code);
      }
      if (result && typeof result.value === 'string') {
        return `<pre><code class="${cls}">${result.value}</code></pre>`;
      }
    } catch (_) { /* fall through to plain rendering */ }
  }
  return `<pre><code>${escapeHtml(code)}</code></pre>`;
}

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
