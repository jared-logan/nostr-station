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
  window.marked.use({
    gfm:    true,
    breaks: false,
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
 * Render a single code block. No syntax highlighting in Phase 1b —
 * Phase 1c will add highlight.js once we have a browser-ready bundle.
 * The escaped <pre><code> output is the standard graceful-degradation
 * shape every git web UI shows when a language tag is unrecognised.
 */
export function renderCodeBlock(code, _lang) {
  if (typeof code !== 'string' || !code) return '';
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
