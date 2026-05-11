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
  ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'class', 'id', 'name', 'lang', 'target', 'rel', 'colspan', 'rowspan', 'align'],
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
