// nostr-station dashboard — single-file client.
// No framework, no build step. Organized as per-panel modules + shared
// utilities (toast, modal, copy-button) at the bottom.

import { previewRetryDecision } from './preview-retry.js';
import { renderMarkdown, renderCodeBlock } from './markdown.js';

const $  = (id) => document.getElementById(id);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const PANELS = ['status', 'chat', 'relay', 'blossom', 'projects', 'vpn', 'logs', 'client', 'nsite', 'mail', 'config'];

// ── Shared utilities (toast, modal, copy, api) ───────────────────────────

function escapeHtml(s) {
  return String(s ?? '')
    .replaceAll('&',  '&amp;')
    .replaceAll('<',  '&lt;')
    .replaceAll('>',  '&gt;')
    .replaceAll('"',  '&quot;')
    .replaceAll("'", '&#39;');
}

function stateClass(s) { return s === 'ok' ? 'ok' : s === 'warn' ? 'warn' : 'err'; }

// ── Accent theme ────────────────────────────────────────────────────────
// The accent color (purple by default) is themable via [data-theme] on
// <html>. The early boot script in index.html applies the persisted
// choice before paint; this module owns reads/writes after load and
// renders the Config → Appearance picker.
const THEMES = [
  { id: 'purple', label: 'Purple', swatch: '#7B68EE' },
  { id: 'green',  label: 'Green',  swatch: '#3DDC84' },
  { id: 'red',    label: 'Red',    swatch: '#E85555' },
  { id: 'blue',   label: 'Blue',   swatch: '#4A9EFF' },
  { id: 'white',  label: 'White',  swatch: '#FFFFFF' },
];
const THEME_STORAGE_KEY       = 'nostr-station:theme';
const DITTO_THEME_STORAGE_KEY = 'nostr-station:ditto-theme';
// Theme ids that are valid in localStorage. "ditto" is dynamic — its
// colors come from a separately-stored JSON blob (see DITTO_THEME_*).
const VALID_THEME_IDS = new Set([...THEMES.map(t => t.id), 'ditto']);

function getTheme() {
  try {
    const t = localStorage.getItem(THEME_STORAGE_KEY);
    if (t && VALID_THEME_IDS.has(t)) return t;
  } catch (_) { /* ignore */ }
  return 'purple';
}
function setTheme(id) {
  if (!VALID_THEME_IDS.has(id)) return;
  if (id === 'purple') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', id);
  }
  if (id === 'ditto') applyDittoStyleBlock(getDittoTheme());
  else                clearDittoStyleBlock();
  try { localStorage.setItem(THEME_STORAGE_KEY, id); } catch (_) { /* ignore */ }
}

// ── Ditto theme storage + dynamic style injection ───────────────────────
// Ditto themes carry user-published colors (kind 16767), so they can't
// live as static :root[data-theme="..."] blocks in app.css. Instead we
// inject a <style id="ditto-theme-style"> at runtime whose contents are
// derived from the stored { primary, background } pair.
function getDittoTheme() {
  try {
    const raw = localStorage.getItem(DITTO_THEME_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch (_) { /* ignore */ }
  return null;
}
function saveDittoTheme(theme) {
  try { localStorage.setItem(DITTO_THEME_STORAGE_KEY, JSON.stringify(theme)); } catch (_) {}
}
function clearDittoTheme() {
  try { localStorage.removeItem(DITTO_THEME_STORAGE_KEY); } catch (_) {}
}
// CSS hex color literal — `#` + 3/4/6/8 hex digits. Mirrors the server-side
// regex so we don't trust whatever survived the API boundary.
const HEX_RE = /^#[0-9a-fA-F]{3,8}$/;
// `url("…")` is the only place the user's string lands inside CSS, and
// safeHttpUrl already enforced an http(s) URL — we just need to escape
// the two characters that can break out of a double-quoted CSS string.
function escCssUrl(u) { return String(u).replace(/\\/g, '\\\\').replace(/"/g, '\\"'); }
function isSafeImageUrl(u) {
  try {
    const p = new URL(u);
    return p.protocol === 'http:' || p.protocol === 'https:';
  } catch { return false; }
}
function applyDittoStyleBlock(theme) {
  if (!theme || (!theme.primary && !theme.background && !theme.bgImage)) {
    clearDittoStyleBlock();
    return;
  }
  // Sanitize. The server already validated, but localStorage is
  // attacker-writable from any same-origin XSS, so re-check before we
  // shove user-provided strings into a <style> tag.
  const primary    = HEX_RE.test(theme.primary || '')    ? theme.primary    : '';
  const background = HEX_RE.test(theme.background || '') ? theme.background : '';
  const bgImage    = theme.bgImage && isSafeImageUrl(theme.bgImage) ? theme.bgImage : '';
  const bgMode     = (theme.bgMode === 'contain' || theme.bgMode === 'tile') ? theme.bgMode : 'cover';

  const rootDecls = [];
  // Text ramp — matches Ditto's neutral-grey foreground scheme
  // (foreground 100% / muted-foreground 70%). Applies in both Ditto
  // sub-modes; the slightly purple-tinted defaults from :root were
  // dropping below readable contrast over either a user-chosen --bg
  // color or the dimmed image overlay.
  rootDecls.push(`--text-bright: #ffffff;`);
  rootDecls.push(`--text:        #e8e8e8;`);
  rootDecls.push(`--text-dim:    #b3b3b3;`);
  rootDecls.push(`--muted:       #7a7a7a;`);
  if (primary) {
    rootDecls.push(`--accent: ${primary};`);
    rootDecls.push(`--accent-bright: color-mix(in srgb, ${primary} 65%, #ffffff);`);
    rootDecls.push(`--accent-dim:    color-mix(in srgb, ${primary} 65%, #000000);`);
    rootDecls.push(`--info:          color-mix(in srgb, ${primary} 70%, #ffffff);`);
  }

  let css = '';
  if (bgImage) {
    // Image mode: the user's image becomes the body background, and the
    // card surfaces switch to translucent dark overlays so text stays
    // legible (mirrors what Ditto does in their own client). A
    // linear-gradient is layered above the image to dim high-contrast
    // photos uniformly — without it, bright spots (clouds, sky, etc.)
    // bleed through cards and chat text.
    const size   = bgMode === 'tile' ? 'auto' : bgMode;        // cover | contain | auto
    const repeat = bgMode === 'tile' ? 'repeat' : 'no-repeat';
    const fallback = background || '#0a0a0a';
    rootDecls.push(`--bg: ${fallback};`);
    rootDecls.push(`--bg-elev:       rgba(0, 0, 0, 0.85);`);
    rootDecls.push(`--bg-card:       rgba(0, 0, 0, 0.78);`);
    rootDecls.push(`--bg-hover:      rgba(255, 255, 255, 0.08);`);
    rootDecls.push(`--border:        rgba(255, 255, 255, 0.16);`);
    rootDecls.push(`--border-strong: rgba(255, 255, 255, 0.28);`);
    const bodyCss =
      `:root[data-theme="ditto"] body {` +
      // First layer: a flat 72% black tint that sits *above* the image
      // and dims it uniformly. Second layer: the user's image. Tuned
      // to match Ditto's own "image as faint backdrop" feel — without
      // a strong overlay, high-contrast photos make chat text (which
      // renders directly on body, no card) illegible.
      `  background-image: linear-gradient(rgba(0,0,0,0.72), rgba(0,0,0,0.72)), url("${escCssUrl(bgImage)}");` +
      `  background-color: ${fallback};` +
      `  background-size: 100% 100%, ${size};` +
      `  background-position: center center, center center;` +
      `  background-repeat: no-repeat, ${repeat};` +
      `  background-attachment: fixed, fixed;` +
      `}`;
    // The header has a hardcoded dark gradient in app.css that would
    // hide the image strip under it. Replace with a translucent gradient
    // in image mode so the photo bleeds through (matches the card recipe).
    const headerCss =
      `:root[data-theme="ditto"] .header {` +
      `  background: linear-gradient(180deg, rgba(0,0,0,0.7) 0%, rgba(0,0,0,0.45) 100%);` +
      `}`;
    css = `:root[data-theme="ditto"] { ${rootDecls.join(' ')} } ${bodyCss} ${headerCss}`;
  } else if (background) {
    // Color-only mode: derive the elevation ramp lighter than --bg so
    // cards still stand out (standard dark-UI layering).
    rootDecls.push(`--bg: ${background};`);
    rootDecls.push(`--bg-elev:       color-mix(in srgb, ${background} 95%, #ffffff);`);
    rootDecls.push(`--bg-card:       color-mix(in srgb, ${background} 92%, #ffffff);`);
    rootDecls.push(`--bg-hover:      color-mix(in srgb, ${background} 88%, #ffffff);`);
    rootDecls.push(`--border:        color-mix(in srgb, ${background} 88%, #ffffff);`);
    rootDecls.push(`--border-strong: color-mix(in srgb, ${background} 80%, #ffffff);`);
    css = `:root[data-theme="ditto"] { ${rootDecls.join(' ')} }`;
  } else {
    css = `:root[data-theme="ditto"] { ${rootDecls.join(' ')} }`;
  }

  let el = document.getElementById('ditto-theme-style');
  if (!el) {
    el = document.createElement('style');
    el.id = 'ditto-theme-style';
    document.head.appendChild(el);
  }
  el.textContent = css;
}
function clearDittoStyleBlock() {
  const el = document.getElementById('ditto-theme-style');
  if (el) el.remove();
}
function renderThemePicker() {
  const current = getTheme();
  return `<div class="theme-picker" id="cfg-theme-picker">${
    THEMES.map(t => `
      <button type="button"
              class="theme-swatch ${t.id === current ? 'active' : ''}"
              data-theme-id="${t.id}"
              style="--swatch:${t.swatch}">
        <span class="dot"></span>
        <span>${escapeHtml(t.label)}</span>
        ${t.id === current ? '<span class="check">✓</span>' : ''}
      </button>
    `).join('')
  }</div>`;
}
function wireThemePicker() {
  const root = $('cfg-theme-picker');
  if (!root) return;
  root.addEventListener('click', (e) => {
    const btn = e.target.closest('.theme-swatch');
    if (!btn) return;
    const id = btn.dataset.themeId;
    if (!id || id === getTheme()) return;
    setTheme(id);
    // Re-render swatches in place — cheaper than reloading the whole
    // panel and keeps focus state on the picker. Also re-render the
    // Ditto card since its "active" badge depends on getTheme().
    root.outerHTML = renderThemePicker();
    wireThemePicker();
    refreshDittoCard();
  });
}

// ── Ditto theme card ─────────────────────────────────────────────────────
function fmtAgo(tsMs) {
  if (!tsMs) return '';
  const s = Math.floor((Date.now() - tsMs) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
function renderDittoCard() {
  const theme  = getDittoTheme();
  const active = getTheme() === 'ditto';
  if (!theme) {
    return `
      <div class="ditto-theme" id="cfg-ditto-card">
        <div class="ditto-theme-head">
          <div class="ditto-theme-title">Ditto theme sync</div>
        </div>
        <div class="ditto-theme-empty">
          Pull your published Ditto profile theme (kind 16767) from your read relays
          and apply its primary color + background. No theme synced yet.
        </div>
        <div class="ditto-theme-actions">
          <button class="primary" id="cfg-ditto-sync">Sync from relays</button>
        </div>
      </div>
    `;
  }
  const swatches = [];
  if (theme.primary)    swatches.push({ role: 'primary',    hex: theme.primary });
  if (theme.background) swatches.push({ role: 'background', hex: theme.background });
  const safeBgImage = theme.bgImage && isSafeImageUrl(theme.bgImage) ? theme.bgImage : '';
  const imagePreview = safeBgImage
    ? `<div class="ditto-theme-image">
         <img src="${escapeHtml(safeBgImage)}" alt="" loading="lazy">
         <div class="ditto-theme-image-meta">
           <span style="color:var(--muted)">bg image</span>
           <span>${escapeHtml(theme.bgMode || 'cover')}</span>
         </div>
       </div>`
    : '';
  return `
    <div class="ditto-theme ${active ? 'active' : ''}" id="cfg-ditto-card">
      <div class="ditto-theme-head">
        <div class="ditto-theme-title">${escapeHtml(theme.title || 'Ditto theme')}</div>
        <div class="ditto-theme-status ${active ? 'ok' : ''}">
          ${active ? '● applied' : 'synced ' + escapeHtml(fmtAgo(theme.syncedAt))}
        </div>
      </div>
      ${imagePreview}
      <div class="ditto-theme-preview">
        ${swatches.map(s => `
          <span class="swatch">
            <span class="chip" style="background:${escapeHtml(s.hex)}"></span>
            <code>${escapeHtml(s.hex)}</code>
            <span style="color:var(--muted)">${escapeHtml(s.role)}</span>
          </span>
        `).join('')}
      </div>
      <div class="ditto-theme-actions">
        ${active
          ? `<button id="cfg-ditto-resync">Re-sync</button>`
          : `<button class="primary" id="cfg-ditto-apply">Apply</button>
             <button id="cfg-ditto-resync">Re-sync</button>`
        }
        <button class="danger" id="cfg-ditto-clear">Clear</button>
      </div>
    </div>
  `;
}
function refreshDittoCard() {
  const root = $('cfg-ditto-card');
  if (!root) return;
  root.outerHTML = renderDittoCard();
  wireDittoCard();
}
async function syncDittoTheme() {
  const btns = $$('#cfg-ditto-card button');
  btns.forEach(b => b.disabled = true);
  try {
    const r = await api('/api/ditto/theme');
    if (!r || !r.found) {
      const reason = r?.reason === 'no-npub'   ? 'No npub configured.'
                  : r?.reason === 'no-relays'  ? 'Add a read relay first.'
                  : r?.reason === 'no-event'   ? 'No kind-16767 theme on your relays. Publish one in Ditto first.'
                  : r?.reason === 'no-colors'  ? 'Found a theme event but it had no usable colors.'
                  :                              'Could not find a Ditto theme.';
      toast('No Ditto theme', reason, 'warn');
      btns.forEach(b => b.disabled = false);
      return;
    }
    const theme = {
      title:      r.title || 'Ditto theme',
      primary:    r.primary    || '',
      background: r.background || '',
      bgImage:    r.bgImage    || '',
      bgMode:     r.bgMode     || '',
      syncedAt:   Date.now(),
    };
    saveDittoTheme(theme);
    setTheme('ditto');
    toast('Ditto theme applied', theme.title, 'ok');
    refreshDittoCard();
    // Picker swatches need to drop their "active" highlight too.
    const picker = $('cfg-theme-picker');
    if (picker) {
      picker.outerHTML = renderThemePicker();
      wireThemePicker();
    }
  } catch (e) {
    toast('Sync failed', String(e.message || e), 'err');
    btns.forEach(b => b.disabled = false);
  }
}
function wireDittoCard() {
  $('cfg-ditto-sync')?.addEventListener('click', syncDittoTheme);
  $('cfg-ditto-resync')?.addEventListener('click', syncDittoTheme);
  $('cfg-ditto-apply')?.addEventListener('click', () => {
    setTheme('ditto');
    refreshDittoCard();
    const picker = $('cfg-theme-picker');
    if (picker) { picker.outerHTML = renderThemePicker(); wireThemePicker(); }
  });
  $('cfg-ditto-clear')?.addEventListener('click', () => {
    clearDittoTheme();
    if (getTheme() === 'ditto') setTheme('purple');
    refreshDittoCard();
    const picker = $('cfg-theme-picker');
    if (picker) { picker.outerHTML = renderThemePicker(); wireThemePicker(); }
    toast('Ditto theme cleared', '', 'ok');
  });
}

const toast = (() => {
  const host = () => $('toasts');
  return function toast(title, body, kind = 'ok') {
    const el = document.createElement('div');
    el.className = 'toast ' + kind;
    el.innerHTML = `<div class="title">${escapeHtml(title)}</div>${body ? `<div class="body">${escapeHtml(body)}</div>` : ''}`;
    host().appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity 200ms';
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 220);
    }, 5000);
    el.addEventListener('click', () => el.remove());
  };
})();

// Toast helper for relay-config / whitelist saves. The in-process relay
// applies changes immediately so the success copy is unconditional;
// `restartHint` is legacy and kept here only so older response shapes
// don't crash the toast rendering.
function relayApplyToast(title, response, hostFallbackBody = 'Relay updated') {
  if (response && response.restartHint) {
    toast(title, `Saved · run on host: ${response.restartHint}`, 'warn');
  } else {
    toast(title, hostFallbackBody, 'ok');
  }
}

// Session token lives in localStorage so it survives tab close and browser
// re-launch — the 8h server-side TTL (with 30m sliding window) is the
// authoritative expiry, and forcing a bunker re-auth on every refresh was
// burning through Amber approvals for no security win. Dashboard is bound
// to 127.0.0.1 only, and the trust boundary is "local user" already; any
// XSS in the dashboard page would also have access to the keychain via the
// /api endpoints it's calling. Tabs sharing the token is a feature — one
// sign-in covers every tab you open.
//
// When the server-side session does expire (or you sign out explicitly),
// clearSessionToken() wipes localStorage and the auth screen shows.
const SESSION_KEY         = 'ns-session-token';
const SESSION_EXPIRES_KEY = 'ns-session-expires';
// Tracks WHICH signer the user authenticated with so subsequent
// signing requests (publish, etc.) route to the matching signer:
//   'nip07'  → window.nostr (Alby, nos2x, …) — sign in browser
//   'bunker' → saved NIP-46 pairing (Amber)  — server signs
// Set at sign-in time by completeSignIn(); read at publish time by
// the Client-panel handlers. Cleared on sign-out.
const SESSION_SOURCE_KEY  = 'ns-session-source';

function getSessionToken() { return localStorage.getItem(SESSION_KEY); }
function getSessionSource() { return localStorage.getItem(SESSION_SOURCE_KEY); }
function setSessionToken(token, expiresAt, source) {
  localStorage.setItem(SESSION_KEY, token);
  localStorage.setItem(SESSION_EXPIRES_KEY, String(expiresAt));
  if (source) localStorage.setItem(SESSION_SOURCE_KEY, source);
}
function clearSessionToken() {
  localStorage.removeItem(SESSION_KEY);
  localStorage.removeItem(SESSION_EXPIRES_KEY);
  localStorage.removeItem(SESSION_SOURCE_KEY);
}

// Drop-in fetch wrapper that surfaces non-2xx + network errors as toasts.
// Adds the Bearer session token on every call (unauthenticated requests to
// public /api/auth/* paths still work — the server ignores the header).
// On 401, clears the token and shows the auth screen without a page reload.
async function api(path, init, opts) {
  const token = getSessionToken();
  const headers = new Headers(init?.headers || {});
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  let res;
  try { res = await fetch(path, { ...init, headers }); }
  catch (e) { if (!opts?.silent) toast('Network error', path, 'err'); throw e; }

  if (res.status === 401 && !path.startsWith('/api/auth/')) {
    // Session expired or token revoked — drop back to the auth screen
    // without surfacing a red toast (the auth screen itself is the cue).
    clearSessionToken();
    AuthScreen?.show?.();
    throw new Error(`${path} 401`);
  }

  if (!res.ok) {
    let body = '';
    try { body = (await res.text()).slice(0, 180); } catch {}
    // `silent` is for fire-and-forget background fetches whose failure
    // is expected / non-actionable for the user (e.g. an auto-fire
    // netcheck against a flaky relay set will time out for as long as
    // the relays stay bad — toasting every time would be noise).
    // Caller still gets the throw and decides what to do.
    if (!opts?.silent) toast(`${path} → ${res.status}`, body, 'err');
    throw new Error(`${path} ${res.status}`);
  }
  const ct = res.headers.get('content-type') || '';
  return ct.includes('json') ? res.json() : res.text();
}

// Short-TTL GET cache shared across panels. Several panels (header chip,
// dashboard cards, Config) all want the same identity / profile / config
// data; without coalescing, navigating around or rebuilding the Config
// panel fans out 3-4 duplicate fetches that hammer the local server and
// (for /api/identity/profile) the user's read-relays. apiCached() dedupes
// concurrent calls and returns the cached value within ttlMs. `force`
// invalidates and refetches; mutators should call apiInvalidate(path).
const __apiCache = new Map(); // path -> { value, at }
const __apiInflight = new Map(); // path -> Promise
async function apiCached(path, ttlMs, opts = {}) {
  const now = Date.now();
  if (!opts.force) {
    const hit = __apiCache.get(path);
    if (hit && (now - hit.at) < ttlMs) return hit.value;
    const inflight = __apiInflight.get(path);
    if (inflight) return inflight;
  }
  const p = api(path, undefined, opts).then(value => {
    __apiCache.set(path, { value, at: Date.now() });
    __apiInflight.delete(path);
    return value;
  }).catch(e => {
    __apiInflight.delete(path);
    throw e;
  });
  __apiInflight.set(path, p);
  return p;
}
function apiInvalidate(path) {
  __apiCache.delete(path);
  __apiInflight.delete(path);
}

// Forward declaration: assigned below once AuthScreen is defined. api() needs
// to reference it during 401 handling but AuthScreen itself uses api().
let AuthScreen = null;

// Tiny clipboard helper — used by copy buttons + paste fields.
async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback: textarea-select hack (for non-secure contexts if any).
    const t = document.createElement('textarea');
    t.value = text; t.style.position = 'fixed'; t.style.opacity = '0';
    document.body.appendChild(t); t.select();
    try { document.execCommand('copy'); document.body.removeChild(t); return true; }
    catch { document.body.removeChild(t); return false; }
  }
}

// Build a copy button <button> element for the given text. Replaces its
// icon briefly on success. Used in Config, help cards, and toast chains.
function copyBtn(text, title = 'copy') {
  const btn = document.createElement('button');
  btn.className = 'copy-btn';
  btn.title = title;
  btn.innerHTML = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="4" y="4" width="9" height="9" rx="1.5"/><path d="M3 10V3.5A1.5 1.5 0 0 1 4.5 2h6"/></svg>`;
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const ok = await copyToClipboard(text);
    if (ok) {
      btn.classList.add('ok');
      btn.innerHTML = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 8l4 4 7-8"/></svg>`;
      setTimeout(() => {
        btn.classList.remove('ok');
        btn.innerHTML = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="4" y="4" width="9" height="9" rx="1.5"/><path d="M3 10V3.5A1.5 1.5 0 0 1 4.5 2h6"/></svg>`;
      }, 1200);
    } else {
      toast('Copy failed', '', 'err');
    }
  });
  return btn;
}

// ── Modal primitives ─────────────────────────────────────────────────────

function openModal({ title, subtitle, body, footer }) {
  const root = $('modal-root');
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal" role="dialog" aria-label="${escapeHtml(title)}">
      <div class="modal-head">
        <div>
          <div class="title">${escapeHtml(title)}</div>
          ${subtitle ? `<div class="subtitle">${escapeHtml(subtitle)}</div>` : ''}
        </div>
        <button class="modal-close">close</button>
      </div>
      <div class="modal-body"></div>
      <div class="modal-foot"></div>
    </div>
  `;
  const modal = backdrop.querySelector('.modal');
  const bodyEl = backdrop.querySelector('.modal-body');
  const footEl = backdrop.querySelector('.modal-foot');
  if (body instanceof Node) bodyEl.appendChild(body);
  else bodyEl.innerHTML = body ?? '';
  if (footer instanceof Node) footEl.appendChild(footer);
  else if (footer) footEl.innerHTML = footer;
  const close = () => backdrop.remove();
  backdrop.querySelector('.modal-close').addEventListener('click', close);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  root.appendChild(backdrop);
  return { root: modal, body: bodyEl, foot: footEl, close };
}

// Destructive action confirmation. Returns a promise resolving true/false.
function confirmDestructive({ title, description, typeToConfirm, confirmLabel = 'Confirm' }) {
  return new Promise((resolve) => {
    const body = document.createElement('div');
    body.innerHTML = `
      <div style="color:var(--text);margin-bottom:8px">${escapeHtml(description)}</div>
      ${typeToConfirm ? `<div style="font-size:11px;color:var(--text-dim);margin-top:12px">Type <code style="color:var(--error)">${escapeHtml(typeToConfirm)}</code> to confirm:</div>
       <input class="confirm-input" id="confirm-input" autocomplete="off">` : ''}
    `;
    const foot = document.createElement('div');
    foot.style.display = 'flex'; foot.style.gap = '8px';
    const cancel = document.createElement('button'); cancel.textContent = 'Cancel';
    const ok = document.createElement('button'); ok.textContent = confirmLabel; ok.className = 'danger';
    if (typeToConfirm) ok.disabled = true;
    foot.appendChild(cancel); foot.appendChild(ok);

    const modal = openModal({ title, body, footer: foot });
    cancel.addEventListener('click', () => { modal.close(); resolve(false); });
    ok.addEventListener('click',    () => { modal.close(); resolve(true);  });
    if (typeToConfirm) {
      const input = body.querySelector('#confirm-input');
      input.addEventListener('input', () => { ok.disabled = input.value !== typeToConfirm; });
      input.focus();
    }
  });
}

// Reusable terminal-output modal for streaming SSE from any POST endpoint
// (/api/exec/:cmd, /api/projects/:id/git/push, …). Resolves when the stream
// emits `done`. The footer button is enabled on done; the header × prompts
// before force-closing a running operation.
function openExecModal({ title, subtitle, endpoint, body }) {
  const bodyEl = document.createElement('div');
  bodyEl.className = 'exec-body';
  bodyEl.innerHTML = `
    <div class="exec-bar">
      <div class="note">Streaming from <code>${escapeHtml(endpoint)}</code></div>
      <label class="autoscroll-toggle">
        <input type="checkbox" class="autoscroll" checked>
        auto-scroll
      </label>
    </div>
    <div class="term exec-term"><span class="line sys">starting…</span><span class="cursor"></span></div>
  `;
  const statusPill = document.createElement('span');
  statusPill.className = 'status-pill running';
  statusPill.innerHTML = '<span class="spinner"></span>running';

  const foot = document.createElement('div');
  foot.style.display = 'flex'; foot.style.alignItems = 'center'; foot.style.width = '100%';
  const statusWrap = document.createElement('div'); statusWrap.style.flex = '1';
  statusWrap.appendChild(statusPill);
  const closeBtn = document.createElement('button'); closeBtn.textContent = 'close'; closeBtn.disabled = true;
  foot.appendChild(statusWrap); foot.appendChild(closeBtn);

  const modal = openModal({ title, subtitle, body: bodyEl, footer: foot });
  modal.root.classList.add('exec-modal');

  const term = bodyEl.querySelector('.exec-term');
  const cursor = term.querySelector('.cursor');
  const autoscrollCb = bodyEl.querySelector('.autoscroll');

  let running = true;
  let reader = null;

  const addLine = (text, cls = '') => {
    const span = document.createElement('span');
    span.className = 'line ' + cls;
    span.textContent = text + '\n';
    // Cursor gets removed once the stream ends. After that, insertBefore
    // throws (cursor isn't a child of term anymore). Fall back to append.
    if (cursor.parentNode === term) {
      term.insertBefore(span, cursor);
    } else {
      term.appendChild(span);
    }
    if (autoscrollCb.checked) term.scrollTop = term.scrollHeight;
  };

  // Re-wire the modal's close × to prompt while running.
  const origClose = modal.root.querySelector('.modal-close');
  if (origClose) {
    const newCloser = origClose.cloneNode(true);
    origClose.parentNode.replaceChild(newCloser, origClose);
    newCloser.addEventListener('click', async () => {
      if (!running) { modal.close(); return; }
      const ok = await confirmDestructive({
        title: 'Close while running?',
        description: 'Operation is still running. Close anyway?',
        confirmLabel: 'Close',
      });
      if (ok) {
        try { reader?.cancel(); } catch {}
        modal.close();
      }
    });
  }
  closeBtn.addEventListener('click', () => modal.close());

  return new Promise((resolve) => {
    const headers = { 'Authorization': `Bearer ${getSessionToken() || ''}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    fetch(endpoint, {
      method: 'POST',
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }).then(async (res) => {
      if (!res.ok) {
        addLine(`HTTP ${res.status} — ${await res.text().catch(() => '')}`, 'err');
        running = false;
        statusPill.className = 'status-pill error'; statusPill.textContent = 'error';
        closeBtn.disabled = false;
        resolve({ ok: false, code: -1 });
        return;
      }
      reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let doneCode = null;
      const info = {};
      outer: while (true) {
        let read;
        try { read = await reader.read(); }
        catch { break outer; }
        if (read.done) break;
        buf += dec.decode(read.value, { stream: true });
        const lines = buf.split('\n'); buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (!raw) continue;
          try {
            const msg = JSON.parse(raw);
            if (msg.done) { doneCode = msg.code ?? 0; break outer; }
            // Info frames carry side-channel metadata (e.g. the resolved
            // path from /api/ngit/clone). They don't render in the log —
            // we stash them and surface via the resolved promise.
            if (msg.info) { info[msg.info] = msg.value; continue; }
            const cls = msg.stream === 'stderr' ? 'err' : '';
            const clean = (msg.line || '').replace(/\x1b\[[0-9;]*m/g, '');
            addLine(clean, cls);
          } catch {}
        }
      }
      cursor.remove();
      running = false;
      if (doneCode === 0) {
        addLine('— done —', 'ok');
        statusPill.className = 'status-pill done'; statusPill.textContent = 'done';
      } else {
        addLine(`— exit ${doneCode} —`, 'err');
        statusPill.className = 'status-pill error'; statusPill.textContent = `exit ${doneCode}`;
      }
      closeBtn.disabled = false;
      resolve({ ok: doneCode === 0, code: doneCode, info });
    }).catch((e) => {
      addLine(String(e.message || e), 'err');
      running = false;
      statusPill.className = 'status-pill error'; statusPill.textContent = 'error';
      closeBtn.disabled = false;
      resolve({ ok: false, code: -1 });
    });
  });
}

// ── Router ───────────────────────────────────────────────────────────────

function currentPanel() {
  let hash = (location.hash || '#status').slice(1);
  // Strip any sub-route after the panel name so `#nsite/<addr>` deep-links
  // (used by the in-Ditto "Visit" handoff and `nostr-station nsite publish`)
  // still resolve to the nsite panel. Without this the hash falls through
  // to 'status' and the panel's maybeConsumeDeepLink() never fires.
  const slash = hash.indexOf('/');
  if (slash >= 0) hash = hash.slice(0, slash);
  // Old #git bookmarks land on the new Projects panel.
  if (hash === 'git') return 'projects';
  return PANELS.includes(hash) ? hash : 'status';
}

// Parse `#chat/s/<sessionId>` → { sessionId }. Returns null sessionId for
// the bare `#chat` (= station session). Used by ChatPanel.onEnter() to
// resolve which session to surface.
function currentChatSubroute() {
  const hash = (location.hash || '').slice(1);
  const m = hash.match(/^chat\/s\/([\w:-]+)$/);
  return { sessionId: m ? m[1] : null };
}

function activatePanel(name) {
  $$('.panel').forEach(el => el.classList.toggle('active', el.dataset.panel === name));
  $$('#nav a').forEach(a => a.classList.toggle('active', a.dataset.panel === name));
  // If the active link lives inside a collapsed sidebar group, open it
  // so the user can see what's selected.
  const activeLink = document.querySelector('#nav a.active');
  if (activeLink) {
    const group = activeLink.closest('details.sidebar-group');
    if (group && !group.open) group.open = true;
  }
  if (name === 'logs') clearLogsBadge();
  Panels[name]?.onEnter?.();
}

window.addEventListener('hashchange', () => activatePanel(currentPanel()));

// ── Mobile sidebar toggle ────────────────────────────────────────────────
// On screens ≤900px the sidebar collapses into an off-canvas drawer driven
// by `body.sidebar-open`. The hamburger in the header flips the state; tapping
// a nav link or the scrim — or hitting Escape — closes it. The CSS does all
// the layout work; this just toggles the class and ARIA state.
(function initSidebarToggle() {
  const body   = document.body;
  const btn    = document.getElementById('sidebar-toggle');
  const scrim  = document.getElementById('sidebar-scrim');
  const nav    = document.getElementById('nav');
  if (!btn || !scrim || !nav) return;

  const setOpen = (open) => {
    body.classList.toggle('sidebar-open', open);
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    scrim.setAttribute('aria-hidden', open ? 'false' : 'true');
  };

  btn.addEventListener('click', () => setOpen(!body.classList.contains('sidebar-open')));
  scrim.addEventListener('click', () => setOpen(false));
  // Hash navigation already triggers activatePanel; we just need to close
  // the drawer when the user picks a destination.
  nav.addEventListener('click', (e) => {
    if (e.target.closest('a')) setOpen(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && body.classList.contains('sidebar-open')) setOpen(false);
  });
  // If the viewport grows past the breakpoint (rotation, devtools resize),
  // make sure we don't leave the body in sidebar-open state — the CSS hides
  // the toggle there but the class would still apply transforms.
  const mq = window.matchMedia('(min-width: 901px)');
  const onChange = () => { if (mq.matches) setOpen(false); };
  mq.addEventListener ? mq.addEventListener('change', onChange) : mq.addListener(onChange);
})();

// Persist sidebar group open/closed state to localStorage so the user's
// preference survives page reloads. Each <details class="sidebar-group">
// gets its own key under its id.
(function setupSidebarGroups() {
  document.querySelectorAll('details.sidebar-group').forEach(g => {
    if (!g.id) return;
    const key = `sidebar-group:${g.id}`;
    const saved = localStorage.getItem(key);
    if (saved === 'closed') g.open = false;
    else if (saved === 'open') g.open = true;
    g.addEventListener('toggle', () => {
      try { localStorage.setItem(key, g.open ? 'open' : 'closed'); } catch {}
    });
  });
})();

// ── Providers (mirrors src/lib/ai-providers.ts PROVIDERS) ────────────────
// Display labels + per-provider default model lists for the chat/config
// switcher. Curated list — Anthropic + Nostr-native paid relays + a
// Custom escape hatch. Anyone wanting OpenAI / OpenRouter / Groq /
// Gemini / Ollama / LM Studio / Maple sets up a Custom Provider with
// the relevant baseUrl + model id.
//
// Custom has no curated model list — users type their own model name in
// the model field; the dropdown collapses to a free-text input.
//
// IDs must match the ai-providers.ts registry exactly.
const PROVIDER_LIST = [
  { value: 'anthropic',    label: 'Anthropic',     models: ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5'] },
  { value: 'opencode-zen', label: 'OpenCode Zen',  models: ['claude-opus-4-6', 'claude-sonnet-4-6', 'gpt-4o', 'gemini-2.5-pro'] },
  // OpenCode Go ships a different (cheaper) model roster than Zen.
  // Curated list left empty on purpose so the dropdown collapses to
  // free-text until the user clicks Fetch Models — opencode.ai/zen/go/v1
  // returns the live list at /v1/models.
  { value: 'opencode-go',  label: 'OpenCode Go',   models: [] },
  { value: 'payperq',      label: 'PayPerQ ⚡',     models: ['claude-sonnet-4', 'gpt-4o', 'llama-3.3-70b'] },
  { value: 'routstr',      label: 'Routstr ⚡',     models: ['claude-sonnet-4', 'gpt-4o', 'llama-3.3-70b'] },
  { value: 'custom',       label: 'Custom Provider', models: [] },
];

// ai-config cache — read-once per ~3s to avoid refetching when Chat
// switches providers in rapid succession. invalidateAiCfg() forces a
// refresh after writes (adding / removing providers, fetching models).
const _aiCfgCache = { data: null, at: 0 };
async function getAiCfg() {
  const now = Date.now();
  if (_aiCfgCache.data && (now - _aiCfgCache.at) < 3000) return _aiCfgCache.data;
  const cfg = await api('/api/ai/config').catch(() => null);
  _aiCfgCache.data = cfg;
  _aiCfgCache.at   = now;
  return cfg;
}
function invalidateAiCfg() { _aiCfgCache.data = null; }

async function modelsFor(provider) {
  // 1. Live-fetched list cached in ai-config wins — that's what the
  //    user's key is actually entitled to, not our stale hardcoded list.
  let configuredModel = null;
  try {
    const cfg = await getAiCfg();
    const entry = cfg?.providers?.[provider];
    const known = entry?.knownModels;
    if (Array.isArray(known) && known.length) return known;
    // Fall through, but stash the user's saved model id so we can
    // surface it as a single-item list when there's no curated set
    // (Custom Provider in particular ships with empty PROVIDER_LIST
    // models — without this, the dropdown stays empty and the user's
    // configured model can't be picked).
    if (typeof entry?.model === 'string' && entry.model) configuredModel = entry.model;
  } catch {}
  // 2. Hand-curated fallback from PROVIDER_LIST.
  const p = PROVIDER_LIST.find(x => x.value === provider);
  const curated = p ? p.models : [];
  if (curated.length) return curated;
  // 3. Last resort — the user's configured model id, if any.
  return configuredModel ? [configuredModel] : [];
}

// ── Header (AI config chips removed — identity chip + relay dot only) ────

async function refreshHeader() {
  try {
    const cfg = await api('/api/config');
    const parts = [];
    if (!cfg.configured) parts.push('⚠ AI not configured');
    parts.push(describeContext(cfg));
    parts.push(`${cfg.provider} · ${cfg.model}`);
    $('chat-subtitle').textContent = parts.join(' · ');
    window.__lastConfig = cfg;
  } catch {}
  refreshIdentityChip();
}

// Header reflects ai-config.json `defaults.chat` + the resolved key/model.
// Any code path that mutates that state — Config panel provider edits,
// setup-wizard key entry, Chat-pane provider/model dropdown changes —
// dispatches `api-config-changed`, so listening here keeps the header
// in sync without each call site having to remember to call us.
document.addEventListener('api-config-changed', () => { refreshHeader(); });

// Coarse cache invalidation: any config-shaped mutation drops the cached
// snapshots so the next panel render sees fresh data. This is the contract
// that lets apiCached() use a long TTL — readers stay cheap, writers stay
// authoritative. Keep this list in sync with apiCached() callers.
document.addEventListener('api-config-changed', () => {
  apiInvalidate('/api/identity/config');
  apiInvalidate('/api/identity/profile');
  apiInvalidate('/api/config');
  apiInvalidate('/api/config?scope=global');
  apiInvalidate('/api/relay-config');
  apiInvalidate('/api/auth/session');
  apiInvalidate('/api/ngit/account');
  apiInvalidate('/api/ai/providers');
  apiInvalidate('/api/git-identity/global');
});

// Single source of truth for the human-readable context label used by the
// chat header and the Config panel row. The /api/config response carries
// a `contextSource` of 'project' | 'station' plus a `hasContextFile`
// flag for the legacy ~/nostr-station/projects/NOSTR_STATION.md seed.
function describeContext(cfg) {
  if (!cfg.hasContext) return '⚠ no context';
  if (cfg.contextSource === 'project' && cfg.contextProject) {
    return `project: ${cfg.contextProject}`;
  }
  return cfg.hasContextFile ? 'NOSTR_STATION.md loaded' : 'station context (built-in)';
}

// ── Identity: chip renderer + pixel-art fallback ─────────────────────────
//
// Avatar fallback is deterministic from the hex pubkey — 4×4 symmetric
// pattern (like Ethereum jazzicons) keyed off the first 4 bytes. No
// dependency; ~40 lines of SVG generated at render time.

function pixelAvatar(hex, size = 22) {
  // Accept either hex or npub (we don't decode npub client-side, so fall
  // back to hashing the string). For proper hex we get a clean seed; for
  // npub we get a stable-per-string seed which is fine for a placeholder.
  const src = /^[0-9a-f]{64}$/.test(hex || '') ? hex : (hex || 'default');
  const h = (() => {
    let x = 0;
    for (let i = 0; i < src.length; i++) x = (x * 31 + src.charCodeAt(i)) >>> 0;
    return x;
  })();
  const hue  = h % 360;
  const hue2 = (hue + 137) % 360;
  const bg   = `hsl(${hue2}, 22%, 18%)`;
  const fg   = `hsl(${hue}, 72%, 64%)`;

  const GRID = 5;          // 5×5 grid, mirror columns 0-1 → 3-4 for symmetry
  const cell = 100 / GRID;
  const rects = [];
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < 3; x++) {
      // Seed each cell via a separate hash step so the pattern varies.
      const bit = (h >> ((y * 3 + x) % 24)) & 1;
      if (!bit) continue;
      rects.push(`<rect x="${(x * cell).toFixed(2)}" y="${(y * cell).toFixed(2)}" width="${cell.toFixed(2)}" height="${cell.toFixed(2)}"/>`);
      if (x < 2) {
        // mirror to right side
        const mx = (GRID - 1 - x) * cell;
        rects.push(`<rect x="${mx.toFixed(2)}" y="${(y * cell).toFixed(2)}" width="${cell.toFixed(2)}" height="${cell.toFixed(2)}"/>`);
      }
    }
  }
  return `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges" width="${size}" height="${size}">
    <rect width="100" height="100" fill="${bg}"/>
    <g fill="${fg}">${rects.join('')}</g>
  </svg>`;
}

function truncNpub(npub) {
  if (!npub) return '';
  if (npub.length <= 16) return npub;
  return `${npub.slice(0, 8)}…${npub.slice(-4)}`;
}

// Used by both the header chip and the drawer — resolves against profile
// cache if any, else falls back to truncated npub + pixel avatar.
let __identity = null;
let __profile  = null;

// ── nsite discovery cache ───────────────────────────────────────────────
//
// Shared between the Identity drawer NSITE section and the Status panel
// nsite card so both render consistent state without duplicate fetches.
// /api/nsite/discover is cheap but blocks on a nak relay query (up to 8s),
// so we cache results for 60s per spec.
let __nsite = null;     // last payload from /api/nsite/discover
let __nsiteAt = 0;      // ms timestamp of last successful fetch
let __nsiteInflight = null;
const NSITE_TTL_MS = 60_000;

async function getNsiteDiscover({ force } = {}) {
  if (!force && __nsite && (Date.now() - __nsiteAt) < NSITE_TTL_MS) {
    return __nsite;
  }
  if (__nsiteInflight) return __nsiteInflight;
  __nsiteInflight = (async () => {
    try {
      const r = await api('/api/nsite/discover');
      __nsite = r;
      __nsiteAt = Date.now();
      return r;
    } finally {
      __nsiteInflight = null;
    }
  })();
  return __nsiteInflight;
}

// Seed payload for ProjectDrawer.openAddPrefilled when "Add to Projects"
// is clicked from the NSITE section or card. A specific `site` picks
// that deployment's d-tag/title as the project name; otherwise we fall
// back to the discover payload's primary URL (or the predicted npubUrl
// when nothing is deployed yet).
function buildNsiteSeed(discover, npub, site) {
  const url = site?.url || discover?.url || discover?.npubUrl || '';
  const lastDeployTs = site?.publishedAt ?? discover?.relayEvent?.created_at;
  let name = site?.d || '';
  if (!name) {
    try {
      if (url) {
        const host = new URL(url).hostname;
        // Raw npub-based hostnames (npub1…63chars.nsite.lol) are too long
        // for a readable project name — fall through to truncNpub. Custom
        // hostnames (e.g. user-chosen .nsite.pub) are kept as-is.
        if (!host.endsWith('.nsite.lol') && host.length < 48) {
          name = host;
        }
      }
    } catch {}
  }
  if (!name) name = truncNpub(npub || '');
  return {
    name,
    capabilities: { nsite: true },
    nsite: {
      url,
      lastDeploy: lastDeployTs ? new Date(lastDeployTs * 1000).toISOString() : null,
    },
  };
}

async function refreshIdentityChip() {
  const chip = $('identity-chip');
  const avatar = $('identity-avatar');
  const nameEl = $('identity-name');
  const subEl  = $('identity-sub');

  let cfg;
  try { cfg = await apiCached('/api/identity/config', 30_000); } catch { return; }
  __identity = cfg;

  if (!cfg.npub) {
    chip.classList.add('missing');
    avatar.innerHTML = '!';
    nameEl.textContent = 'no identity';
    subEl.textContent  = 'click to set up';
    chip.removeAttribute('title');
    return;
  }
  chip.classList.remove('missing');

  // Session expiry tooltip — refreshed on each chip repaint. Silent when
  // there's no active session (localhost exemption, for example).
  const exp = Number(localStorage.getItem(SESSION_EXPIRES_KEY) || 0);
  if (exp > 0) {
    const rem = exp - Date.now();
    if (rem > 0) {
      const mins = Math.floor(rem / 60000);
      const hrs  = Math.floor(mins / 60);
      chip.title = hrs > 0
        ? `Session expires in ${hrs}h ${mins % 60}m`
        : `Session expires in ${mins}m`;
    } else {
      chip.title = 'Session expired';
    }
  } else {
    chip.removeAttribute('title');
  }

  // Render placeholder avatar/name immediately so the chip never blanks.
  const fallback = truncNpub(cfg.npub);
  avatar.innerHTML = pixelAvatar(cfg.npub);
  nameEl.textContent = fallback;
  subEl.textContent  = '';

  // Kick off profile fetch (served from cache when warm) to populate the
  // richer name + picture asynchronously. Silent on failure.
  try {
    const p = await apiCached('/api/identity/profile', 30_000);
    if (p && !p.empty) {
      __profile = p;
      if (p.picture) {
        avatar.innerHTML = `<img src="${escapeHtml(p.picture)}" alt="">`;
        // If the image 404s, fall back to the pixel art.
        const img = avatar.querySelector('img');
        img.addEventListener('error', () => { avatar.innerHTML = pixelAvatar(cfg.npub); });
      }
      nameEl.textContent = p.name || fallback;
      subEl.textContent  = p.nip05 ? (p.nip05Verified ? `✓ ${p.nip05}` : p.nip05) : fallback;
    }
  } catch {}
}

// ── Identity drawer ─────────────────────────────────────────────────────

const IdentityDrawer = (() => {
  const root = $('identity-drawer');
  const scrim = $('drawer-scrim');
  const body = $('drawer-body');

  function open() {
    root.classList.add('open');
    root.setAttribute('aria-hidden', 'false');
    scrim.classList.add('open');
    render();
  }
  function close() {
    root.classList.remove('open');
    root.setAttribute('aria-hidden', 'true');
    scrim.classList.remove('open');
  }

  scrim.addEventListener('click', close);
  $('drawer-close').addEventListener('click', close);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && root.classList.contains('open')) close();
  });

  async function render() {
    const cfg = __identity || await api('/api/identity/config').catch(() => null);
    if (!cfg) { body.innerHTML = '<div class="muted">failed to load identity</div>'; return; }

    if (!cfg.npub) { renderSetup(); return; }

    // Profile (served from cache; we re-show last render while refreshing)
    body.innerHTML = '';
    const profileCard = document.createElement('div');
    profileCard.className = 'profile-card';
    profileCard.innerHTML = profileMarkup(__profile, cfg.npub);
    body.appendChild(profileCard);
    wireProfileCard(profileCard, cfg.npub);

    // Sync row
    const sync = document.createElement('div');
    sync.className = 'sync-row';
    sync.innerHTML = `<span id="sync-when">${__profile ? `Last synced ${fmtAgo(__profile.cachedAt)}` : 'not yet synced'}</span>`;
    const syncBtn = document.createElement('button');
    syncBtn.textContent = 'sync profile';
    syncBtn.addEventListener('click', () => syncProfile(profileCard, syncBtn));
    sync.appendChild(syncBtn);
    body.appendChild(sync);

    // Updates row — quick access to the same flow as Config → About,
    // mirroring the sync-row layout (status text left, button right).
    // Forces a server-side re-poll on click so the user doesn't wait
    // for the 30-min background tick; hands off to Updates.openModal
    // when an update is available so the install UX is identical to
    // the header pill + Config button.
    const updRow = document.createElement('div');
    updRow.className = 'sync-row drawer-update-row';
    const updMsg = document.createElement('span');
    updMsg.className = 'drawer-update-msg';
    updMsg.textContent = 'Updates';
    const updBtn = document.createElement('button');
    updBtn.textContent = 'check for updates';
    updBtn.addEventListener('click', async () => {
      updBtn.disabled = true;
      const prev = updBtn.textContent;
      updBtn.textContent = 'checking…';
      updMsg.className = 'drawer-update-msg';
      try {
        const status = await Updates.refresh(true);
        if (!status) {
          updMsg.textContent = 'check failed';
          updMsg.classList.add('err');
        } else if (!status.supported) {
          updMsg.textContent = 'self-update unavailable';
          updMsg.classList.add('warn');
        } else if (status.lastError) {
          updMsg.textContent = `check failed: ${status.lastError}`;
          updMsg.classList.add('err');
        } else if (Updates.anyAvailable(status)) {
          // Combined count: nostr-station commits + pinned-binary tool
          // upgrades. The modal renders each section separately and
          // drains tools first, then the self-update.
          const n = Updates.totalCount(status);
          updMsg.textContent = `${n} update${n === 1 ? '' : 's'} available`;
          updMsg.classList.add('ok');
          // Replace the check button with Install so the row stays
          // single-action and minimal.
          updBtn.textContent = 'install';
          updBtn.disabled = false;
          updBtn.onclick = () => Updates.openModal(status);
          return;
        } else {
          updMsg.textContent = 'up to date';
          updMsg.classList.add('ok');
        }
      } finally {
        if (updBtn.textContent === 'checking…') {
          updBtn.disabled = false;
          updBtn.textContent = prev;
        }
      }
    });
    updRow.appendChild(updMsg);
    updRow.appendChild(updBtn);
    body.appendChild(updRow);

    // Signing
    const signing = document.createElement('div');
    signing.className = 'drawer-section';
    signing.innerHTML = `
      <h4>Signing</h4>
      <div class="body">Bunker URL: <span class="muted" id="signing-bunker">managed by ngit</span></div>
      <div class="muted" style="margin-top:6px">
        Amber pairing happens in the setup wizard; ngit stores the bunker URL after that. nostr-station does not read or modify it.
      </div>
    `;
    body.appendChild(signing);

    // NSITE — hydrated asynchronously from /api/nsite/discover. The
    // section slot is rendered immediately so the drawer doesn't jump
    // when results arrive.
    const nsiteSec = document.createElement('div');
    nsiteSec.className = 'drawer-section nsite-section';
    nsiteSec.innerHTML = `
      <h4>NSITE</h4>
      <div class="nsite-body"><span class="spinner"></span><span class="muted" style="margin-left:8px">Checking read relays…</span></div>
    `;
    body.appendChild(nsiteSec);
    renderNsiteSection(nsiteSec, cfg.npub);

    // Session — only shown when we have an actual session (i.e. not the
    // localhost exemption path, where there's nothing to sign out of).
    if (getSessionToken()) {
      const sessionSec = document.createElement('div');
      sessionSec.className = 'drawer-section';
      const exp = Number(localStorage.getItem(SESSION_EXPIRES_KEY) || 0);
      const remaining = exp ? formatRemaining(exp - Date.now()) : '—';
      sessionSec.innerHTML = `
        <h4>Session</h4>
        <div class="body">Expires in <span class="muted">${escapeHtml(remaining)}</span></div>
      `;
      const signOutBtn = document.createElement('button');
      signOutBtn.textContent = 'sign out';
      signOutBtn.className = 'danger';
      signOutBtn.style.marginTop = '8px';
      signOutBtn.addEventListener('click', signOut);
      sessionSec.appendChild(signOutBtn);
      body.appendChild(sessionSec);
    }

    // Fetch live profile if we haven't yet
    if (!__profile) {
      try {
        const p = await api('/api/identity/profile');
        if (p && !p.empty) { __profile = p; render(); refreshIdentityChip(); }
      } catch {}
    }
  }

  function renderSetup() {
    body.innerHTML = `
      <div class="drawer-section">
        <h4>Set up identity</h4>
        <div class="body" style="margin-bottom:10px">
          nostr-station uses your Nostr identity for relay auth and ngit signing. Your
          <code>nsec</code> never touches this machine — signing happens via Amber on your phone.
        </div>
        <div class="setup-block">
          <label>Your npub</label>
          <input id="setup-npub" placeholder="npub1…" autocomplete="off" spellcheck="false">
          <div class="actions">
            <button id="setup-paste">paste</button>
            <button class="primary" id="setup-save">save</button>
          </div>
        </div>
        <div class="muted" style="margin-top:10px">
          Prefer the full first-run flow? Visit <code>/setup</code> for the Amber QR pairing wizard.
        </div>
      </div>
    `;
    $('setup-paste').addEventListener('click', async () => {
      try { $('setup-npub').value = (await navigator.clipboard.readText()).trim(); }
      catch { toast('Clipboard blocked', 'paste manually', 'warn'); }
    });
    $('setup-save').addEventListener('click', saveNpub);
    $('setup-npub').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveNpub(); });
  }

  async function saveNpub() {
    const val = $('setup-npub').value.trim();
    if (!val) return;
    try {
      const r = await api('/api/identity/set', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ npub: val }),
      });
      if (!r.ok) throw new Error(r.error || 'save failed');
      toast('Identity saved', val, 'ok');
      __identity = null; __profile = null; __nsite = null; __nsiteAt = 0;
      document.dispatchEvent(new CustomEvent('identity-changed'));
      await refreshIdentityChip();
      render();
    } catch (e) {
      toast('Save failed', e.message, 'err');
    }
  }

  function profileMarkup(p, npub) {
    const avatarHtml = p && p.picture
      ? `<img src="${escapeHtml(p.picture)}" alt="">`
      : pixelAvatar(npub, 48);
    const nameHtml = p && p.name ? escapeHtml(p.name) : escapeHtml(truncNpub(npub));
    const nip05Html = p && p.nip05
      ? `<div class="nip05">${escapeHtml(p.nip05)}${p.nip05Verified ? `<span class="ok">✓ verified</span>` : `<span class="no">unverified</span>`}</div>`
      : '';
    const about = p && p.about ? `<div class="about">${escapeHtml(p.about)}</div>` : '';
    return `
      <div class="top">
        <div class="avatar-lg">${avatarHtml}</div>
        <div class="name-block">
          <div class="display-name">${nameHtml}</div>
          ${nip05Html}
        </div>
      </div>
      ${about}
      <div class="kv" id="kv-npub">
        <span class="k">npub</span>
        <span class="v">${escapeHtml(npub)}</span>
      </div>
      <div class="kv collapsed" id="kv-hex">
        <span class="k">hex</span>
        <span class="v">${escapeHtml(p?.hex || '(resolve via sync)')}</span>
        <button class="expand">expand</button>
      </div>
    `;
  }

  function wireProfileCard(card, npub) {
    card.querySelector('#kv-npub').appendChild(copyBtn(npub));
    const hex = card.querySelector('#kv-hex');
    const hexVal = hex.querySelector('.v').textContent;
    if (hexVal && /^[0-9a-f]{64}$/.test(hexVal)) hex.appendChild(copyBtn(hexVal));
    const expand = hex.querySelector('.expand');
    if (expand) {
      expand.addEventListener('click', () => {
        const collapsed = hex.classList.toggle('collapsed');
        expand.textContent = collapsed ? 'expand' : 'collapse';
      });
    }
  }

  async function syncProfile(card, btn) {
    btn.disabled = true;
    const orig = btn.textContent;
    btn.innerHTML = '<span class="spinner"></span>';
    try {
      const p = await api('/api/identity/profile/sync', { method: 'POST' });
      if (p.empty) throw new Error('no npub configured');
      __profile = p;
      toast('Profile synced', '', 'ok');
      render();
      refreshIdentityChip();
    } catch (e) { toast('Sync failed', e.message, 'err'); }
    btn.disabled = false;
    btn.textContent = orig;
  }

  function fmtAgo(ts) {
    if (!ts) return 'never';
    const mins = Math.round((Date.now() - ts) / 60000);
    if (mins < 1)  return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.round(mins / 60);
    return `${hrs}h ago`;
  }

  function formatRemaining(ms) {
    if (!ms || ms < 0) return 'expired';
    const mins = Math.floor(ms / 60000);
    const hrs  = Math.floor(mins / 60);
    const remMins = mins % 60;
    if (hrs > 0) return `${hrs}h ${remMins}m`;
    return `${mins}m`;
  }

  async function signOut() {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
    clearSessionToken();
    __identity = null; __profile = null; __nsite = null; __nsiteAt = 0;
    close();
    AuthScreen.show();
  }

  async function renderNsiteSection(section, npub) {
    const bodyEl = section.querySelector('.nsite-body');
    let d;
    try {
      d = await getNsiteDiscover();
    } catch (e) {
      bodyEl.innerHTML = `<div class="muted">Could not reach read relays.</div>`;
      return;
    }
    // The endpoint returns all-null when identity isn't configured, but
    // this function only runs when cfg.npub is set. If that ever changes
    // (e.g. identity revoked mid-session), hide the section entirely.
    if (!d || !d.npubUrl) { section.style.display = 'none'; return; }

    const sites = Array.isArray(d.sites) ? d.sites : [];

    if (sites.length > 0) {
      section.classList.add('deployed');
      const multiLabel = sites.length > 1 ? `${sites.length} sites deployed` : null;
      bodyEl.innerHTML = `
        ${multiLabel ? `<div class="muted nsite-count">${escapeHtml(multiLabel)}</div>` : ''}
        <div class="nsite-list"></div>
      `;
      const listEl = bodyEl.querySelector('.nsite-list');
      for (const site of sites) {
        const row = document.createElement('div');
        row.className = 'nsite-row';
        const whenMs = site.publishedAt ? site.publishedAt * 1000 : null;
        const when = whenMs ? fmtAgoMs(whenMs) : 'just now';
        const labelDiffers = site.title && site.title !== site.d;
        row.innerHTML = `
          <div class="nsite-row-head">
            <span class="nsite-title">${escapeHtml(site.title || site.d)}</span>
            ${labelDiffers ? `<span class="nsite-dtag muted">d=${escapeHtml(site.d)}</span>` : ''}
          </div>
          <div class="nsite-url-row">
            <a href="${escapeHtml(site.url)}" target="_blank" rel="noreferrer" class="nsite-url-primary">${escapeHtml(site.url)}</a>
            <button class="open-nsite" title="Open in new tab">Open ↗</button>
          </div>
          <div class="muted nsite-meta">Deployed ${escapeHtml(when)}</div>
          <div class="nsite-actions">
            <button class="primary add-to-projects">Add to Projects</button>
          </div>
        `;
        row.querySelector('.open-nsite').addEventListener('click', () => {
          window.open(site.url, '_blank', 'noopener');
        });
        row.querySelector('.add-to-projects').addEventListener('click', () => {
          close();
          ProjectDrawer.openAddPrefilled(buildNsiteSeed(d, npub, site));
        });
        listEl.appendChild(row);
      }
    } else {
      section.classList.remove('deployed');
      bodyEl.innerHTML = `
        <div class="nsite-url-row">
          <code class="nsite-predicted">${escapeHtml(d.npubUrl)}</code>
          <span class="copy-slot"></span>
        </div>
        <div class="muted nsite-meta">Predicted URL — no deployment detected on read relays</div>
        <div class="nsite-actions">
          <button class="primary add-to-projects">Add to Projects</button>
        </div>
        <div class="muted nsite-hint">
          Deploy via a project's nsite tab or <code>nostr-station nsite deploy</code>.
        </div>
      `;
      bodyEl.querySelector('.copy-slot').appendChild(copyBtn(d.npubUrl));
      bodyEl.querySelector('.add-to-projects').addEventListener('click', () => {
        close();
        ProjectDrawer.openAddPrefilled(buildNsiteSeed(d, npub));
      });
    }
  }

  $('identity-chip').addEventListener('click', open);

  return { open, close, render };
})();

function healthTooltip(s) {
  if (s.state === 'err') return `${s.label} not installed`;
  if (s.state === 'warn') {
    if (s.id === 'relay')   return 'Relay installed but not running — start it in the Relay panel';
    if (s.id === 'blossom') return 'Blossom is bundled but not enabled — turn it on in Config → Blossom';
    if (s.id === 'vpn')     return 'nostr-vpn installed but not connected';
    return `${s.label}: ${s.value}`;
  }
  // state === 'ok'
  if (/^v?\d/.test(s.value)) return `${s.label} ${s.value}`;
  if (s.value) return `${s.label} · ${s.value}`;
  return `${s.label} running`;
}

// Cheap signature for the sidebar rebuild guard. The set of services and
// their states is what we render; if neither changes between ticks we
// can skip the full innerHTML rebuild (which was tearing through ~20 DOM
// nodes every 5s for no visible reason and competing with the terminal
// for main-thread time during heavy scrollback).
function statusSignature(status) {
  let sig = '';
  for (const s of status) sig += s.id + ':' + s.state + ':' + (s.value || '') + '|';
  return sig;
}
let __lastHealthSig = '';

async function refreshHealth() {
  try {
    const status = await api('/api/status');
    const relay = status.find(s => s.id === 'relay');
    $('hdr-relay-dot').className = 'dot ' + stateClass(relay?.state || 'err');
    $('hdr-relay').textContent   = relay?.state === 'ok' ? 'relay up' : relay?.state === 'warn' ? 'relay down' : 'not installed';

    const sig = statusSignature(status);
    if (sig === __lastHealthSig) {
      // Nothing visible changed since the last tick — skip the sidebar
      // rebuild. Status panel signature-checks separately at line ~1700.
      if (currentPanel() === 'status') Panels.status.render(status);
      window.__lastStatus = status;
      return;
    }
    __lastHealthSig = sig;

    const health = $('health');
    health.innerHTML = '';

    // Group the same way the Status panel does: services first, binaries
    // second, each under a subtle section header. Keeps the two surfaces
    // visually parallel so users building a mental model ("Services are
    // daemons, Binaries are tools") learn it once and see it everywhere.
    const services = status.filter(s => s.kind === 'service');
    const binaries = status.filter(s => s.kind === 'binary');

    const addSectionHeader = (title) => {
      const h = document.createElement('div');
      h.className = 'health-section-head';
      h.textContent = title;
      health.appendChild(h);
    };
    const addRow = (s) => {
      const row = document.createElement('div');
      const interactive = s.state === 'warn' || s.state === 'err';
      row.className = 'row' + (interactive ? ' interactive' : '');
      row.dataset.service = s.id;
      row.title = healthTooltip(s);
      // Sidebar uses the same indicator convention as the Status panel:
      // dots for services, ✓/✗/! glyphs for binaries. Keeps the grammar
      // consistent across the two lists.
      const indicator = s.kind === 'binary'
        ? `<span class="bin-indicator bin-indicator-${stateClass(s.state)}">${
            s.state === 'ok' ? '✓' : s.state === 'warn' ? '!' : '✗'
          }</span>`
        : `<span class="dot ${stateClass(s.state)}"></span>`;
      row.innerHTML = `${indicator}<span class="name">${escapeHtml(s.label)}</span>`;
      if (interactive) {
        row.addEventListener('click', () => {
          location.hash = '#status';
          // Defer until the Status panel is rendered.
          setTimeout(() => {
            // Match either the new .status-row layout or the legacy .card
            // (nsite still renders as a card; relay/vpn/etc. are rows).
            const card = document.querySelector(`#status-cards [data-service="${CSS.escape(s.id)}"]`);
            if (card) {
              card.scrollIntoView({ behavior: 'smooth', block: 'center' });
              card.classList.add('highlight');
              setTimeout(() => card.classList.remove('highlight'), 1400);
              // Expand the row if collapsed so the click-to-jump surfaces
              // the detail content too.
              if (card.tagName === 'DETAILS' && !card.hasAttribute('open')) {
                card.setAttribute('open', '');
              }
            }
          }, 60);
        });
      }
      health.appendChild(row);
    };

    if (services.length) { addSectionHeader('Services'); services.forEach(addRow); }
    if (binaries.length) { addSectionHeader('Binaries'); binaries.forEach(addRow); }

    if (currentPanel() === 'status') Panels.status.render(status);
    window.__lastStatus = status;
  } catch {}
}

setInterval(refreshHealth, 5000);

// ── Panel: Status ────────────────────────────────────────────────────────

// Per-service CTA + install slug mapping. Matches src/lib/web-server.ts
// INSTALL_TARGETS on the server. If `installSlug` is present, clicking
// Install streams `/api/exec/install/<slug>` into the terminal modal.

// installSlug points at a /api/exec/install/<slug> handler that runs
// installTool() from src/lib/tools.ts. Only the optional CLI tools
// have one (ngit / nak / stacks). Built-in services (relay / watchdog),
// the nvpn installer (lives at /api/setup/nvpn/install, wizard-only),
// and externally-installed tools (claude) get a configHint instead —
// surfaced as a "run: …" line in warn state. err state with no slug
// shows just the row's error text and any panel link.
const SERVICE_CTAS = {
  'relay':     { installSlug: null,    configHint: 'use the Relay panel start/restart buttons' },
  // vpn has dedicated start/stop buttons (rendered inline below) — no
  // generic configHint, since every common case is one click away in
  // the dashboard now.
  'vpn':       { installSlug: null,    configHint: null },
  'watchdog':  { installSlug: null,    configHint: 'POST /api/watchdog/start to restart the heartbeat loop' },
  'ngit':      { installSlug: 'ngit',  configHint: null /* inline-form handled below */ },
  // claude-code + opencode have official curl|bash bootstraps wired
  // through installTool() (src/lib/tools.ts) — the Install button fires
  // the SSE modal like ngit/nak/stacks. We keep the upstream one-liner
  // in configHint too so the row shows "or run: <curl>" underneath the
  // button: gives users who'd rather paste into a real terminal a
  // copy-able command without forcing them to click through the modal.
  'claude':    { installSlug: 'claude-code', configHint: 'curl -fsSL https://claude.ai/install.sh | bash' },
  'opencode':  { installSlug: 'opencode',    configHint: 'curl -fsSL https://opencode.ai/install | bash' },
  'nak':       { installSlug: 'nak',   configHint: null },
  'stacks':    { installSlug: 'stacks', configHint: null },
};

// Human-friendly summary + deep-link target for each service. The summary
// is a sentence-level restatement of what `s.value` already says, pitched
// at what the user would want to do next. `panelLink` shows up as a
// follow-through hint so the expanded card is actionable without the user
// having to remember which sidebar item to click.
const SERVICE_DETAILS = {
  'relay': {
    summaryOk:   s => `Running at <code class="cmd-inline">${s.value.replace(/\s*✓\s*$/, '')}</code>. WebSocket publishing is live.`,
    summaryWarn: _ => 'Relay isn\'t listening. Use the Relay panel\'s start/restart buttons.',
    summaryErr:  _ => 'In-process relay didn\'t start. Check the Logs panel for the underlying error.',
    panel: { hash: '#relay', label: 'Open Relay panel' },
  },
  'vpn': {
    summaryOk:   s => `Connected to the nostr-mesh. Your tunnel IP is <code class="cmd-inline">${escapeHtml(s.value)}</code>. Use Stop / Restart on this row.`,
    summaryWarn: _ => 'nvpn binary is installed but the mesh tunnel isn\'t up. Click Start on this row, or open the nostr-vpn panel for the daemon\'s log + diagnostics.',
    summaryErr:  _ => 'nostr-vpn isn\'t installed. Click Install nvpn on this row to download + register the daemon.',
    panel: { hash: '#vpn', label: 'Open nostr-vpn panel' },
  },
  'blossom': {
    summaryOk:   s => `Running at <code class="cmd-inline">${s.value.replace(/\s*✓\s*$/, '')}</code>. Use Stop / Restart on this row, or open the Blossom panel to browse + manage stored blobs.`,
    summaryWarn: _ => 'Bundled in-process — no install needed. Click Start on this row to launch the local Blossom server, or use the Blossom panel\'s enable button.',
    summaryErr:  _ => 'Blossom is bundled with nostr-station and starts in-process — no install required. If you\'re seeing this state, something went wrong booting it; check the Logs panel.',
    panel: { hash: '#blossom', label: 'Open Blossom panel' },
  },
  'ngit': {
    summaryOk:   s => `Git-over-Nostr ready. <code class="cmd-inline">${escapeHtml(s.value)}</code>.`,
    summaryErr:  _ => 'ngit isn\'t installed. It lets you push signed git commits to Nostr relays instead of a central host.',
    panel: { hash: '#config', label: 'Open Config → ngit' },
  },
  'claude': {
    summaryOk:   s => `Installed: <code class="cmd-inline">${escapeHtml(s.value)}</code>. Launch from project cards or the sidebar Terminal.`,
    summaryErr:  _ => 'Claude Code is Anthropic\'s CLI agent. Install with the command below to wire it up as the default AI editor for your projects.',
    panel: { hash: '#projects', label: 'Open Projects' },
  },
  'opencode': {
    summaryOk:   s => `Installed: <code class="cmd-inline">${escapeHtml(s.value)}</code>. Pick OpenCode as your terminal-native AI in Config → AI to launch it from project cards.`,
    summaryErr:  _ => 'OpenCode is an open-source terminal-native AI coding agent — an alternative to Claude Code. Install with the command below, then enable it under Config → AI.',
    panel: { hash: '#config', label: 'Open Config → AI' },
  },
  'nak': {
    summaryOk:   s => `Installed: <code class="cmd-inline">${escapeHtml(s.value)}</code>. Used by <em>seed</em>, <em>watchdog</em>, and the whitelist helpers.`,
    summaryErr:  _ => '<code class="cmd-inline">nak</code> is the Go CLI for signing, publishing, and querying Nostr events. The seed and watchdog flows depend on it.',
  },
  'watchdog': {
    summaryOk:   _ => 'In-Node heartbeat loop is firing every 5 minutes. Each heartbeat publishes a kind-1 event signed by the watchdog keypair to your local relay.',
    summaryWarn: _ => 'Last heartbeat is older than expected. The dashboard process may have been paused or the watchdog stopped manually — check the Logs panel.',
    summaryErr:  _ => 'Watchdog isn\'t running. Restart it from <code class="cmd-inline">/api/watchdog/start</code> or the Logs panel banner.',
    panel: { hash: '#logs', label: 'Open Logs → watchdog' },
  },
  'stacks': {
    summaryOk:   s => `Installed: <code class="cmd-inline">${escapeHtml(s.value)}</code>. Scaffold a Nostr React app with <code class="cmd-inline">stacks mkstack &lt;name&gt;</code>.`,
    summaryErr:  _ => 'Stacks is Soapbox\'s Nostr app scaffolding CLI (ships the mkstack React template). Optional — install adds the <code class="cmd-inline">stacks</code> command to <code class="cmd-inline">~/.cargo/bin</code>.',
    panel: { hash: '#projects', label: 'Open Projects' },
  },
};

// ── nvpn controls (shared by dashboard Status row + nostr-vpn panel) ──
//
// Buttons that POST /api/nvpn/{start,stop,restart}. Disabled while the
// request is in flight so a double-click doesn't queue redundant
// systemctl/launchctl calls. Refreshes the dashboard health snapshot on
// success so the row colour + tunnel IP land right away.

async function callNvpnAction(action, label) {
  try {
    const r = await api(`/api/nvpn/${action}`, { method: 'POST' });
    toast(`nvpn ${label}`, r?.detail || '', 'ok');
    refreshHealth();
    // Status takes a moment to settle (daemon socket binds, peer
    // discovery starts) — re-poll once shortly after so the user
    // sees the green tunnel-ip row without clicking refresh.
    setTimeout(refreshHealth, 1500);
    setTimeout(refreshHealth, 5000);
    return r;
  } catch (e) {
    toast(`nvpn ${label} failed`, e?.message || '', 'err');
    return null;
  }
}

// Same shape as appendNvpnControls — Start when warn (off), Stop +
// Restart when ok (running). POSTs route through the persisted
// /api/blossom/{start,stop,restart} handlers (which also invalidate
// the /api/status cache so the row refreshes immediately).
function appendBlossomControls(ctaRow, s) {
  const callBlossomAction = async (verb) => {
    try {
      await api(`/api/blossom/${verb}`, { method: 'POST' });
      apiInvalidate('/api/blossom-config');
      apiInvalidate('/api/status');
      await refreshHealth();
      try { await StatusPanel?._fillBlossomCard?.(); } catch {}
      try { await ConfigPanel?.refreshBlossomSection?.(); } catch {}
    } catch (e) {
      toast(`Blossom ${verb} failed`, e?.message || '', 'err');
    }
  };
  if (s.state === 'ok') {
    const restartBtn = document.createElement('button');
    restartBtn.textContent = 'Restart';
    restartBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      restartBtn.disabled = true;
      await callBlossomAction('restart');
      restartBtn.disabled = false;
    });
    ctaRow.appendChild(restartBtn);
    const stopBtn = document.createElement('button');
    stopBtn.className = 'danger';
    stopBtn.textContent = 'Stop';
    stopBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      stopBtn.disabled = true;
      await callBlossomAction('stop');
      stopBtn.disabled = false;
    });
    ctaRow.appendChild(stopBtn);
  } else if (s.state === 'warn') {
    const startBtn = document.createElement('button');
    startBtn.className = 'primary';
    startBtn.textContent = 'Start';
    startBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      startBtn.disabled = true;
      await callBlossomAction('start');
      startBtn.disabled = false;
    });
    ctaRow.appendChild(startBtn);
  }
}

function appendNvpnControls(ctaRow, s) {
  // Running (state==='ok'): Stop + Restart. Rendered in green-side
  // ordering — Stop is the dangerous one so it goes last.
  // Stopped-but-installed (state==='warn'): Start.
  if (s.state === 'ok') {
    const restartBtn = document.createElement('button');
    restartBtn.textContent = 'Restart';
    restartBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      restartBtn.disabled = true;
      await callNvpnAction('restart', 'restarting');
      restartBtn.disabled = false;
    });
    ctaRow.appendChild(restartBtn);

    const stopBtn = document.createElement('button');
    stopBtn.className = 'danger';
    stopBtn.textContent = 'Stop';
    stopBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      stopBtn.disabled = true;
      await callNvpnAction('stop', 'stopped');
      stopBtn.disabled = false;
    });
    ctaRow.appendChild(stopBtn);
  } else if (s.state === 'warn') {
    const startBtn = document.createElement('button');
    startBtn.className = 'primary';
    startBtn.textContent = 'Start';
    startBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      startBtn.disabled = true;
      await callNvpnAction('start', 'started');
      startBtn.disabled = false;
    });
    ctaRow.appendChild(startBtn);
  }
}

// nvpn install streams NDJSON from /api/setup/nvpn/install (the same
// endpoint the setup wizard's vpn step drives). We pipe lines into the
// shared exec modal so the user gets the same UI as a cargo-install
// run, even though the wire format differs.
async function runNvpnInstall() {
  const bodyEl = document.createElement('div');
  bodyEl.className = 'exec-body';
  bodyEl.innerHTML = `
    <div class="exec-bar">
      <div class="note">Streaming from <code>/api/setup/nvpn/install</code></div>
      <label class="autoscroll-toggle">
        <input type="checkbox" class="autoscroll" checked>
        auto-scroll
      </label>
    </div>
    <div class="term exec-term"><span class="line sys">starting…</span><span class="cursor"></span></div>
  `;
  const statusPill = document.createElement('span');
  statusPill.className = 'status-pill running';
  statusPill.innerHTML = '<span class="spinner"></span>running';
  const foot = document.createElement('div');
  foot.style.display = 'flex'; foot.style.alignItems = 'center'; foot.style.width = '100%';
  const statusWrap = document.createElement('div'); statusWrap.style.flex = '1';
  statusWrap.appendChild(statusPill);
  const closeBtn = document.createElement('button'); closeBtn.textContent = 'close'; closeBtn.disabled = true;
  foot.appendChild(statusWrap); foot.appendChild(closeBtn);
  const modal = openModal({ title: 'Install nostr-vpn', subtitle: 'Downloading + installing nvpn…', body: bodyEl, footer: foot });
  modal.root.classList.add('exec-modal');
  closeBtn.addEventListener('click', () => modal.close());

  const term   = bodyEl.querySelector('.exec-term');
  const cursor = term.querySelector('.cursor');
  const auto   = bodyEl.querySelector('.autoscroll');
  const addLine = (text, cls = '') => {
    const span = document.createElement('span');
    span.className = 'line ' + cls;
    span.textContent = text + '\n';
    if (cursor.parentNode === term) term.insertBefore(span, cursor);
    else term.appendChild(span);
    if (auto.checked) term.scrollTop = term.scrollHeight;
  };

  try {
    const res = await fetch('/api/setup/nvpn/install', {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${getSessionToken() || ''}`, 'content-type': 'application/json' },
      body:    '{}',
    });
    if (!res.ok) {
      addLine(`HTTP ${res.status} — ${await res.text().catch(() => '')}`, 'err');
      statusPill.className = 'status-pill error'; statusPill.textContent = 'error';
      closeBtn.disabled = false;
      return;
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let finalDetail = '';
    let finalOk = false;
    let finalWarn = false;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop();
      for (const line of lines) {
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.type === 'progress' && msg.step) addLine(msg.step);
          if (msg.type === 'done') {
            finalOk     = !!msg.ok;
            finalWarn   = !!msg.warn;
            finalDetail = msg.detail || '';
          }
        } catch { addLine(line); }
      }
    }
    if (finalOk) {
      addLine(finalDetail || 'install complete', 'ok');
      statusPill.className = 'status-pill success'; statusPill.textContent = 'done';
      toast('nvpn installed', finalDetail, 'ok');
    } else if (finalWarn) {
      addLine(finalDetail || 'partial install', 'warn');
      statusPill.className = 'status-pill warn'; statusPill.textContent = 'warn';
      toast('nvpn partial install', finalDetail, 'warn');
    } else {
      addLine(finalDetail || 'install failed', 'err');
      statusPill.className = 'status-pill error'; statusPill.textContent = 'error';
      toast('nvpn install failed', finalDetail, 'err');
    }
  } catch (e) {
    addLine('error: ' + (e?.message || e), 'err');
    statusPill.className = 'status-pill error'; statusPill.textContent = 'error';
  } finally {
    closeBtn.disabled = false;
    refreshHealth();
    [3_000, 10_000, 30_000].forEach(ms => setTimeout(refreshHealth, ms));
  }
}

// ── Dashboard card helpers ───────────────────────────────────────────
// Compact display formatters used by the at-a-glance cards on the
// Dashboard panel. Kept at module scope so StatusPanel (a plain object
// literal, not an IIFE) can reach them without ceremony.
function fmtDashCount(n) {
  if (n == null) return '—';
  if (n < 1000) return String(n);
  if (n < 10_000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  if (n < 1_000_000) return Math.round(n / 1000) + 'K';
  return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
}
function formatBytesDashboard(n) {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

const StatusPanel = {
  // Signature of the last payload we rendered. refreshHealth() ticks every
  // 5s; the status rarely changes between ticks, and re-rendering on every
  // tick was blowing away the user's <details> open state. Comparing
  // signatures lets us short-circuit when the payload is unchanged — the
  // DOM stays untouched, expanded rows stay expanded.
  _sig: null,
  // Cache for the follower/following lookup powering the Identity card.
  // The query hits 3-5 read-relays per call, so we hold the result for
  // a few minutes to keep dashboard refreshes cheap.
  _idStats: null,
  _idStatsAt: 0,
  async onEnter() {
    // Dashboard cards render independently of /api/status — kick them
    // off in parallel so a slow /api/status doesn't blank out the rest
    // of the panel.
    this.renderDashboardCards();
    try {
      const status = await api('/api/status');
      this.render(status);
    } catch (e) {
      $('status-cards').innerHTML = `<div class="empty-state">failed to load status: ${escapeHtml(e.message)}</div>`;
    }
  },

  // ── Quick-glance dashboard cards ────────────────────────────────────
  //
  // Four cards: Identity, Projects, Relay, AI default. Each one renders
  // a "loading" placeholder synchronously then resolves in the background
  // and patches its content. Clicking any card jumps to the relevant
  // panel via the existing hash-router.
  async renderDashboardCards() {
    const root = $('dashboard-cards');
    if (!root) return;
    // First render — emit the four card frames if they aren't there yet.
    // We keep the frames stable across refreshes so re-renders don't
    // flash the entire grid (panels feel jerky when the DOM rebuilds).
    if (!root.firstChild) {
      root.innerHTML = `
        <a class="dash-card" href="#config" data-card="identity">
          <div class="dash-card-head">
            <span class="dash-card-label">Identity</span>
            <span class="dash-card-cta">Profile →</span>
          </div>
          <div class="dash-card-body" id="dash-card-identity">
            <span class="muted">loading…</span>
          </div>
        </a>
        <a class="dash-card" href="#projects" data-card="projects">
          <div class="dash-card-head">
            <span class="dash-card-label">Projects</span>
            <span class="dash-card-cta">Open →</span>
          </div>
          <div class="dash-card-body" id="dash-card-projects">
            <span class="muted">loading…</span>
          </div>
        </a>
        <a class="dash-card" href="#relay" data-card="relay">
          <div class="dash-card-head">
            <span class="dash-card-label">Relay</span>
            <span class="dash-card-cta">Stream →</span>
          </div>
          <div class="dash-card-body" id="dash-card-relay">
            <span class="muted">loading…</span>
          </div>
        </a>
        <a class="dash-card" href="#config" data-card="blossom" title="Local Blossom — bundled in-process. Manage in Config → Blossom.">
          <div class="dash-card-head">
            <span class="dash-card-label">Blossom</span>
            <span class="dash-card-cta">Manage →</span>
          </div>
          <div class="dash-card-body" id="dash-card-blossom">
            <span class="muted">loading…</span>
          </div>
        </a>
        <a class="dash-card" href="#chat" data-card="ai">
          <div class="dash-card-head">
            <span class="dash-card-label">AI · Chat</span>
            <span class="dash-card-cta">Chat →</span>
          </div>
          <div class="dash-card-body" id="dash-card-ai">
            <span class="muted">loading…</span>
          </div>
        </a>
      `;
    }
    // Fan out the four lookups in parallel. Each card patches its own
    // body when it resolves; failures degrade gracefully.
    this._fillIdentityCard();
    this._fillProjectsCard();
    this._fillRelayCard();
    this._fillBlossomCard();
    this._fillAiCard();
  },

  async _fillIdentityCard() {
    const el = $('dash-card-identity');
    if (!el) return;
    try {
      const [ident, profile] = await Promise.all([
        apiCached('/api/identity/config', 30_000),
        apiCached('/api/identity/profile', 30_000).catch(() => null),
      ]);
      if (!ident?.npub) {
        el.innerHTML = `<span class="warn">no identity configured</span>`;
        return;
      }
      const name = profile?.name || truncNpub(ident.npub);
      const avatar = profile?.picture
        ? `<img src="${escapeHtml(profile.picture)}" alt="" class="dash-avatar">`
        : `<span class="dash-avatar">${pixelAvatar(ident.npub, 36)}</span>`;
      const nip05 = profile?.nip05
        ? `<div class="dash-sub ${profile.nip05Verified ? 'ok' : ''}">${escapeHtml(profile.nip05)}${profile.nip05Verified ? ' ✓' : ''}</div>`
        : '';
      el.innerHTML = `
        <div class="dash-id-row">
          ${avatar}
          <div class="dash-id-text">
            <div class="dash-id-name">${escapeHtml(name)}</div>
            ${nip05}
            <div class="dash-id-stats" id="dash-id-stats">
              <span class="muted">looking up stats…</span>
            </div>
          </div>
        </div>
      `;
      // Stats reuse the helper from the Config panel; the helper itself
      // memoises by (pubkey, relay-set) for 5 min, so dashboard reloads
      // and Config panel opens share one round-trip across the user's
      // read-relays instead of re-querying both surfaces independently.
      if (profile?.hex && Array.isArray(ident.readRelays) && ident.readRelays.length) {
        const statsEl = $('dash-id-stats');
        ConfigPanel.fetchProfileStats(profile.hex, ident.readRelays).then(({ followers, following }) => {
          if (!statsEl) return;
          if (followers == null && following == null) {
            statsEl.innerHTML = `<span class="muted">stats unavailable</span>`;
            return;
          }
          statsEl.innerHTML = `
            <span><b>${fmtDashCount(following)}</b> following</span>
            <span class="sep">·</span>
            <span><b>${fmtDashCount(followers)}</b> followers</span>
          `;
        }).catch(() => {
          if (statsEl) statsEl.innerHTML = `<span class="muted">stats unavailable</span>`;
        });
      } else {
        const statsEl = $('dash-id-stats');
        if (statsEl) statsEl.innerHTML = `<span class="muted">add read relays to see stats</span>`;
      }
    } catch {
      el.innerHTML = `<span class="muted">identity unavailable</span>`;
    }
  },

  async _fillProjectsCard() {
    const el = $('dash-card-projects');
    if (!el) return;
    try {
      const r = await api('/api/projects');
      const projects = Array.isArray(r) ? r : (Array.isArray(r?.projects) ? r.projects : []);
      if (projects.length === 0) {
        el.innerHTML = `<div class="dash-big">0</div><div class="dash-sub">add your first project →</div>`;
        return;
      }
      // Most-recently-updated wins as the leading bullet. Projects
      // payload doesn't always carry an updatedAt, so fall back to the
      // server's insertion order (already sorted recent-first today).
      const recent = [...projects]
        .sort((a, b) => (b.updatedAt || b.lastOpenedAt || 0) - (a.updatedAt || a.lastOpenedAt || 0))
        .slice(0, 3);
      const recentList = recent
        .map(p => `<li>${escapeHtml(p.name || p.id || 'untitled')}</li>`)
        .join('');
      el.innerHTML = `
        <div class="dash-big">${projects.length}</div>
        <ul class="dash-recent">${recentList}</ul>
      `;
    } catch {
      el.innerHTML = `<span class="muted">projects unavailable</span>`;
    }
  },

  async _fillRelayCard() {
    const el = $('dash-card-relay');
    if (!el) return;
    try {
      const [rc, dbStats] = await Promise.all([
        api('/api/relay-config').catch(() => null),
        api('/api/relay/database/stats').catch(() => null),
      ]);
      const url = rc?.url || 'ws://localhost:7777';
      const size = dbStats?.exists ? formatBytesDashboard(dbStats.sizeBytes) : 'empty';
      el.innerHTML = `
        <div class="dash-relay-url" title="${escapeHtml(url)}">${escapeHtml(url)}</div>
        <div class="dash-sub">DB size: <b>${escapeHtml(size)}</b></div>
      `;
    } catch {
      el.innerHTML = `<span class="muted">relay unavailable</span>`;
    }
  },

  // Blossom dashboard card — mirrors the Relay card. Three render
  // states match the bundled-but-opt-in lifecycle:
  //   - off       → "not enabled" + hint pointing at Config → Blossom
  //   - running   → URL + blob count + total/quota bytes
  //   - error     → unavailable banner (config endpoint unreachable)
  async _fillBlossomCard() {
    const el = $('dash-card-blossom');
    if (!el) return;
    try {
      const cfg = await api('/api/blossom-config');
      if (!cfg?.running) {
        el.innerHTML = `
          <div class="dash-sub warn">not enabled</div>
          <div class="dash-sub muted">bundled in-process · no install required</div>
          <button class="dash-card-inline-btn" data-action="enable">Enable</button>
        `;
      } else {
        const stats = cfg.stats || { blobCount: 0, totalBytes: 0, quotaBytes: 0 };
        el.innerHTML = `
          <div class="dash-relay-url" title="${escapeHtml(cfg.url || '')}">${escapeHtml(cfg.url || '')}</div>
          <div class="dash-sub"><b>${stats.blobCount}</b> blob${stats.blobCount === 1 ? '' : 's'} · <b>${escapeHtml(formatBytesDashboard(stats.totalBytes))}</b>${stats.quotaBytes ? ` of ${escapeHtml(formatBytesDashboard(stats.quotaBytes))}` : ''}</div>
          <button class="dash-card-inline-btn" data-action="disable">Stop</button>
        `;
      }
      // Wire the inline button. The whole card is an <a href="#config">,
      // so we have to swallow propagation + default to keep clicks here
      // from navigating to Config. After the action returns, fan out a
      // refresh to all three Blossom-aware surfaces (this card, sidebar
      // Health, Config section if visible) so they update in lockstep —
      // the server already invalidated the /api/status cache.
      const btn = el.querySelector('.dash-card-inline-btn');
      if (btn) {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          e.preventDefault();
          const action = btn.dataset.action;
          const origLabel = btn.textContent;
          btn.disabled = true;
          btn.textContent = action === 'enable' ? 'Enabling…' : 'Stopping…';
          try {
            await api(`/api/blossom/${action === 'enable' ? 'start' : 'stop'}`, { method: 'POST' });
            apiInvalidate('/api/blossom-config');
            apiInvalidate('/api/status');
            await Promise.all([
              this._fillBlossomCard(),
              refreshHealth?.(),
            ]);
            // Repaint the Config section if it's mounted — keeps the
            // three surfaces visually in sync even when the user
            // toggled from the Dashboard. Exposed via ConfigPanel's
            // public API so this closure doesn't reach into ConfigPanel's
            // private scope.
            try { await ConfigPanel?.refreshBlossomSection?.(); } catch {}
          } catch (err) {
            toast(`Blossom ${action} failed`, err?.message || '', 'err');
            btn.disabled = false;
            btn.textContent = origLabel;
          }
        });
      }
    } catch {
      el.innerHTML = `<span class="muted">blossom config unavailable</span>`;
    }
  },

  async _fillAiCard() {
    const el = $('dash-card-ai');
    if (!el) return;
    try {
      const list = await api('/api/ai/providers');
      const providers = Array.isArray(list?.providers) ? list.providers : [];
      const configured = providers.filter(p => p.configured);
      const chatDefault = configured.find(p => p.isDefault?.chat);
      const termDefault = configured.find(p => p.isDefault?.terminal);
      if (configured.length === 0) {
        el.innerHTML = `<span class="warn">no providers configured</span>
          <div class="dash-sub">add one in Config → AI</div>`;
        return;
      }
      const chatLine = chatDefault
        ? `<div class="dash-sub">Chat: <b>${escapeHtml(chatDefault.displayName)}</b>${chatDefault.model ? ` · <span class="muted">${escapeHtml(chatDefault.model)}</span>` : ''}</div>`
        : `<div class="dash-sub muted">no chat default set</div>`;
      const termLine = termDefault
        ? `<div class="dash-sub">Terminal: <b>${escapeHtml(termDefault.displayName)}</b></div>`
        : '';
      el.innerHTML = `
        <div class="dash-big">${configured.length}</div>
        <div class="dash-sub">provider${configured.length !== 1 ? 's' : ''} configured</div>
        ${chatLine}
        ${termLine}
      `;
    } catch {
      el.innerHTML = `<span class="muted">AI providers unavailable</span>`;
    }
  },

  render(status) {
    const cards = $('status-cards');
    // Signature now includes kind so a future hotfix that re-categorizes
    // an entry does force a re-render instead of silently sticking.
    const nextSig = status.map(s => {
      const pluginSig = Array.isArray(s.plugins)
        ? s.plugins.map(p => `${p.id}=${p.installed ? p.version || 'yes' : 'no'}`).join(',')
        : '';
      return `${s.id}:${s.kind}:${s.state}:${s.value}:${pluginSig}`;
    }).join('|');
    if (nextSig === this._sig && cards.childElementCount > 0) return;
    this._sig = nextSig;

    // Preserve which rows the user had expanded. Capture before wipe,
    // reapply after the fresh build. Any new services (rare — payload
    // shape is mostly static) just render collapsed.
    const wasOpen = new Set(
      Array.from(cards.querySelectorAll('.status-row[open]'))
        .map(el => el.dataset.service)
        .filter(Boolean)
    );

    cards.innerHTML = '';
    // Group by kind: services first (daemons, scheduled jobs), binaries
    // second (CLI tools). Server already emits in this order today but
    // the client enforces the split so the sections are stable even if
    // the payload's sort drifts.
    const services = status.filter(s => s.kind === 'service');
    const binaries = status.filter(s => s.kind === 'binary');

    if (services.length) {
      cards.appendChild(buildSectionHeader('Services', 'Daemons + scheduled jobs — runtime state'));
      for (const s of services) {
        const row = buildStatusRow(s);
        if (wasOpen.has(s.id)) row.setAttribute('open', '');
        cards.appendChild(row);
      }
    }
    if (binaries.length) {
      cards.appendChild(buildSectionHeader('Binaries', 'CLI tools — installed or not'));
      for (const s of binaries) {
        const row = buildStatusRow(s);
        if (wasOpen.has(s.id)) row.setAttribute('open', '');
        cards.appendChild(row);
      }
    }
    // The nsite row sits alongside the gatherStatus() services but is
    // driven by its own endpoint (kind 34128 relay query), so we append
    // it after the main loop. It hydrates asynchronously; the 60s cache
    // inside getNsiteDiscover keeps refreshHealth() ticks cheap.
    appendNsiteStatusCard(cards);
  },
};

function buildSectionHeader(title, subtitle) {
  const h = document.createElement('div');
  h.className = 'status-section-head';
  h.innerHTML = `
    <span class="status-section-title">${escapeHtml(title)}</span>
    <span class="status-section-sub">${escapeHtml(subtitle)}</span>
  `;
  return h;
}

// Build one expandable row. Summary line stays visible at all times
// (matches the sidebar Service Health chip); the details panel drops a
// service-specific blurb plus any CTAs the user would act on next.
function buildStatusRow(s) {
  const cta = SERVICE_CTAS[s.id] || {};
  const detail = SERVICE_DETAILS[s.id] || {};
  const row = document.createElement('details');
  row.className = `status-row status-row-${s.kind || 'service'} ${stateClass(s.state)}`;
  row.dataset.service = s.id;

  // Services get a colored dot (ok/warn/err). Binaries get ✓ (installed +
  // configured), ✗ (not installed), or ! (installed but warn — today only
  // ngit with a missing relay config). Glyph-vs-dot makes the at-a-glance
  // "am I missing a tool" vs "is a daemon healthy" call out visually.
  const indicator = s.kind === 'binary'
    ? `<span class="bin-indicator bin-indicator-${stateClass(s.state)}">${
        s.state === 'ok' ? '✓' : s.state === 'warn' ? '!' : '✗'
      }</span>`
    : `<span class="dot ${stateClass(s.state)}"></span>`;

  const summary = document.createElement('summary');
  summary.innerHTML = `
    ${indicator}
    <div class="status-main">
      <div class="status-label">${escapeHtml(s.label)}</div>
      <div class="status-value">${escapeHtml(s.value)}</div>
    </div>
  `;
  row.appendChild(summary);

  const details = document.createElement('div');
  details.className = 'status-details';

  const summaryFn = s.state === 'ok'   ? detail.summaryOk
                  : s.state === 'warn' ? detail.summaryWarn
                                       : detail.summaryErr;
  if (summaryFn) {
    const p = document.createElement('p');
    p.innerHTML = summaryFn(s);
    details.appendChild(p);
  }

  // CTA row — preserve every existing action path so clicking Install /
  // Configure / Copy Hint behaves exactly as it did in the old grid.
  const ctaRow = document.createElement('div');
  ctaRow.className = 'status-cta';

  // nvpn row gets its own action block — Start / Stop / Restart wired
  // directly to /api/nvpn/* so the user never has to drop into a
  // terminal for normal lifecycle ops. Install on err state is handled
  // below in the general err branch (the nvpn installer streams via
  // /api/setup/nvpn/install — different shape than the cargo-install
  // SSE flow used for ngit/nak/stacks).
  if (s.id === 'vpn' && s.state !== 'err') {
    appendNvpnControls(ctaRow, s);
  }
  if (s.id === 'blossom' && s.state !== 'err') {
    appendBlossomControls(ctaRow, s);
  }

  if (s.state === 'err' && s.id === 'vpn') {
    const btn = document.createElement('button');
    btn.className = 'primary';
    btn.textContent = 'Install nvpn';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      runNvpnInstall();
    });
    ctaRow.appendChild(btn);
  } else if (s.state === 'err' && cta.installSlug) {
    const btn = document.createElement('button');
    btn.className = 'primary';
    btn.textContent = 'Install';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      // SSE modal is the only path: the backend's /api/exec/install/<slug>
      // streams progress lines from installTool() (cargo install / npm
      // install -g / curl|bash — see src/lib/tools.ts). Health refresh
      // schedule is tuned for the long-tail cargo compile (5min upper
      // bound); user can also click Refresh manually once the modal closes.
      openExecModal({
        title:    `Install ${s.label}`,
        subtitle: `Installing ${cta.installSlug}…`,
        endpoint: `/api/exec/install/${cta.installSlug}`,
      }).then(r => {
        if (r.ok) toast(`${s.label} install finished`, '', 'ok');
        else      toast(`${s.label} install exited ${r.code}`, '', 'err');
        // Bust the cached /api/status so any open Config panel rebuild
        // (or a later navigation to Config) reflects the new install
        // state immediately instead of waiting out the 30s apiCached
        // TTL. refreshHealth uses raw api() so the sidebar + Status
        // panel are already on a fresh fetch.
        apiInvalidate('/api/status');
        refreshHealth();
        [30_000, 120_000, 300_000].forEach(ms => setTimeout(refreshHealth, ms));
      });
    });
    ctaRow.appendChild(btn);
  }
  // Manual command hint — surfaced alongside the Install button for
  // claude-code/opencode so users who'd rather paste the curl one-liner
  // into their own terminal don't have to dig for it. Also handles the
  // warn-state-with-configHint case for relay/watchdog (no installSlug
  // there, so the button branch above didn't fire).
  if ((s.state === 'warn' || s.state === 'err') && cta.configHint) {
    const meta = document.createElement('span');
    meta.className = 'meta';
    const prefix = cta.installSlug ? 'or run' : 'run';
    meta.innerHTML = `${prefix}: <span class="cmd-inline">${escapeHtml(cta.configHint)}</span>`;
    ctaRow.appendChild(meta);
    ctaRow.appendChild(copyBtn(cta.configHint));
  }

  if (detail.panel) {
    const link = document.createElement('a');
    link.href = detail.panel.hash;
    link.textContent = detail.panel.label + ' →';
    link.style.marginLeft = ctaRow.childElementCount > 0 ? 'auto' : '0';
    ctaRow.appendChild(link);
  }

  if (ctaRow.childElementCount > 0) details.appendChild(ctaRow);

  // Claude Code plugins are nested here rather than promoted to top-level
  // Status rows / sidebar dots. They're only usable inside a Claude Code
  // session, so "is claude installed" is the precondition — surfacing them
  // underneath keeps the sidebar lean and makes the nesting self-evident.
  if (s.id === 'claude' && Array.isArray(s.plugins) && s.plugins.length > 0) {
    details.appendChild(buildPluginsBlock(s.plugins));
  }

  row.appendChild(details);
  return row;
}

function buildPluginsBlock(plugins) {
  const block = document.createElement('div');
  block.className = 'status-plugins';

  const head = document.createElement('div');
  head.className = 'status-plugins-head';
  head.textContent = 'Plugins';
  block.appendChild(head);

  const list = document.createElement('div');
  list.className = 'status-plugins-list';
  for (const p of plugins) {
    const row = document.createElement('div');
    row.className = 'status-plugin ' + (p.installed ? 'ok' : 'err');

    const glyph = p.installed ? '✓' : '✗';
    const indicator = `<span class="bin-indicator bin-indicator-${p.installed ? 'ok' : 'err'}">${glyph}</span>`;
    const versionChip = p.installed && p.version
      ? `<span class="status-plugin-version">v${escapeHtml(p.version)}</span>`
      : '';
    const about = p.about
      ? `<div class="status-plugin-about">${escapeHtml(p.about)}</div>`
      : '';

    row.innerHTML = `
      ${indicator}
      <div class="status-plugin-main">
        <div class="status-plugin-head">
          <span class="status-plugin-name">${escapeHtml(p.name)}</span>
          ${versionChip}
        </div>
        ${about}
      </div>
    `;

    if (!p.installed && p.installHint) {
      const hint = document.createElement('div');
      hint.className = 'status-plugin-hint';
      const label = document.createElement('span');
      label.className = 'muted';
      label.textContent = 'run: ';
      const code = document.createElement('code');
      code.className = 'cmd-inline';
      code.textContent = p.installHint;
      hint.appendChild(label);
      hint.appendChild(code);
      hint.appendChild(copyBtn(p.installHint));
      row.querySelector('.status-plugin-main').appendChild(hint);
    }

    list.appendChild(row);
  }
  block.appendChild(list);
  return block;
}

async function appendNsiteStatusCard(container) {
  const card = document.createElement('div');
  card.className = 'card nsite-card';
  card.dataset.service = 'nsite';
  card.innerHTML = `
    <div class="label">NSITE</div>
    <div class="value"><span class="spinner"></span></div>
  `;
  container.appendChild(card);

  let d = null;
  try { d = await getNsiteDiscover(); } catch {}

  // Identity not configured — endpoint returns all-null payload.
  if (!d || !d.npubUrl) {
    card.className = 'card nsite-card';
    card.innerHTML = `
      <div class="label">NSITE</div>
      <div class="value muted">Configure identity to detect nsite</div>
    `;
    return;
  }

  const sites = Array.isArray(d.sites) ? d.sites : [];

  if (sites.length > 0) {
    card.className = 'card nsite-card ok';
    const primary = sites[0];
    const moreCount = sites.length - 1;
    card.innerHTML = `
      <div class="label">NSITE${sites.length > 1 ? ` · ${sites.length} sites` : ''}</div>
      <div class="value"><a href="${escapeHtml(primary.url)}" target="_blank" rel="noreferrer">${escapeHtml(primary.url)}</a></div>
      ${moreCount > 0 ? `<div class="hint">+${moreCount} more — see Identity drawer</div>` : ''}
    `;
    // Only offer "Add to Projects" when no existing project has the
    // nsite capability enabled — avoids nagging once the user has
    // already linked the deployment.
    let hasNsiteProject = false;
    try {
      const projects = await api('/api/projects');
      hasNsiteProject = Array.isArray(projects) && projects.some(p => p.capabilities?.nsite);
    } catch {}
    if (!hasNsiteProject) {
      const cta = document.createElement('div');
      cta.className = 'cta';
      const btn = document.createElement('button');
      btn.className = 'primary';
      btn.textContent = 'Add to Projects';
      btn.addEventListener('click', () => {
        ProjectDrawer.openAddPrefilled(buildNsiteSeed(d, __identity?.npub, primary));
      });
      cta.appendChild(btn);
      card.appendChild(cta);
    }
  } else {
    card.className = 'card nsite-card';
    card.innerHTML = `
      <div class="label">NSITE</div>
      <div class="value muted">${escapeHtml(d.npubUrl)}</div>
      <div class="hint">Not yet deployed</div>
    `;
  }
}

$('status-refresh').addEventListener('click', () => {
  refreshHealth();
  // Bust the identity-stats cache so the user gets a true refresh of
  // follower/following counts when they hit the button (otherwise the
  // 5-min memoize would mask whatever they wanted to re-check). The
  // cache moved into ConfigPanel so both panels share one round-trip;
  // the explicit refresh button is the only path that needs to bust it.
  ConfigPanel.clearProfileStatsCache?.();
  apiInvalidate('/api/identity/config');
  apiInvalidate('/api/identity/profile');
  StatusPanel.renderDashboardCards();
});

// ── SessionStore: client-side chat session persistence ──────────────────
//
// Owns the list of chat sessions (one fixed 'station' session + many
// project sessions). Sessions persist to localStorage so an agent's
// accumulated context survives page reloads. Subscribers (ChatPanel,
// NavSessions) re-render when sessions change.
//
// v1 uses deterministic ids ('station' for the global chat, 'p:<projectId>'
// for project chats — one per project). Phase 4 will introduce multiple
// sessions per project via uuid ids; the data shape already supports it
// (lastOpenByProject + openOrder are arrays/maps, not scalars).
const SessionStore = (() => {
  const KEY = 'ns:chat-sessions:v1';
  const STATION_ID = 'station';

  /** @type {Record<string, ChatSession>} */
  let sessions = {};
  /** @type {Record<string, string>} */
  let lastOpenByProject = {};
  /** @type {string[]} */
  let openOrder = [];
  let activeId = STATION_ID;
  const subs = new Set();
  let writeTimer = null;
  let quotaWarned = false;

  function makeStation() {
    return {
      id: STATION_ID,
      kind: 'station',
      projectId: null,
      title: 'Station',
      history: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      pinned: false,
      order: 0,
      providerOverride: null,
      modelOverride: null,
      permissionMode: null,
    };
  }
  function makeProject(projectId, projectName) {
    return {
      id: 'p:' + projectId,
      kind: 'project',
      projectId,
      title: projectName || 'Project session',
      history: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      pinned: false,
      order: 0,
      providerOverride: null,
      modelOverride: null,
      permissionMode: null,
    };
  }

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return false;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        sessions = parsed.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {};
        lastOpenByProject = parsed.lastOpenByProject || {};
        openOrder = Array.isArray(parsed.openOrder) ? parsed.openOrder : [];
        return true;
      }
    } catch { /* corrupt or quota — fall through to fresh state */ }
    return false;
  }

  function persist() {
    if (writeTimer) clearTimeout(writeTimer);
    writeTimer = setTimeout(() => {
      writeTimer = null;
      try {
        localStorage.setItem(KEY, JSON.stringify({ sessions, lastOpenByProject, openOrder }));
      } catch (e) {
        // Quota: trim closed sessions' histories (keep last 4 turns), retry once.
        if (e && (e.name === 'QuotaExceededError' || /quota/i.test(e.message || ''))) {
          for (const id of Object.keys(sessions)) {
            if (openOrder.includes(id) || id === STATION_ID) continue;
            const s = sessions[id];
            if (s && Array.isArray(s.history) && s.history.length > 4) {
              s.history = s.history.slice(-4);
            }
          }
          try {
            localStorage.setItem(KEY, JSON.stringify({ sessions, lastOpenByProject, openOrder }));
            return;
          } catch { /* fall through to RAM-only */ }
        }
        if (!quotaWarned) {
          quotaWarned = true;
          try { toast('Chat sessions: storage full', 'New messages will not survive reload.', 'warn'); } catch {}
        }
      }
    }, 500);
  }

  function notify() {
    for (const fn of subs) {
      try { fn(); } catch { /* subscriber errors must not break the store */ }
    }
  }

  function init() {
    load();
    // Always ensure the station session exists. Acts as both default landing
    // and back-compat for fresh users with no localStorage entry.
    if (!sessions[STATION_ID]) sessions[STATION_ID] = makeStation();
    persist();
  }

  function get(id) { return sessions[id] || null; }
  function list() { return Object.values(sessions); }
  function listOpen() {
    return openOrder.map(id => sessions[id]).filter(Boolean);
  }
  function listForProject(projectId) {
    return Object.values(sessions).filter(s => s.kind === 'project' && s.projectId === projectId);
  }
  function getActive() { return sessions[activeId] || sessions[STATION_ID]; }
  function getActiveId() { return activeId; }

  function setActive(id) {
    if (!sessions[id]) return;
    activeId = id;
    notify();
  }

  function ensureProjectSession(projectId, projectName) {
    const existingId = lastOpenByProject[projectId];
    if (existingId && sessions[existingId]) {
      // Refresh title if it was a placeholder and we now have a real name.
      const s = sessions[existingId];
      if (projectName && s.title === 'Project session') s.title = projectName;
      if (!openOrder.includes(s.id)) openOrder.push(s.id);
      persist();
      return s;
    }
    const s = makeProject(projectId, projectName);
    sessions[s.id] = s;
    lastOpenByProject[projectId] = s.id;
    if (!openOrder.includes(s.id)) openOrder.push(s.id);
    persist();
    notify();
    return s;
  }

  function appendMessage(id, msg) {
    const s = sessions[id];
    if (!s) return;
    s.history.push(msg);
    s.updatedAt = Date.now();
    persist();
    // No notify on every message — chat panel renders incrementally;
    // nav doesn't need per-token updates. Title-derivation calls notify.
  }

  function setTitle(id, title) {
    const s = sessions[id];
    if (!s) return;
    s.title = title;
    s.updatedAt = Date.now();
    persist();
    notify();
  }

  function clearHistory(id) {
    const s = sessions[id];
    if (!s) return;
    s.history = [];
    s.updatedAt = Date.now();
    persist();
  }

  function close(id) {
    if (id === STATION_ID) return; // station never closes
    openOrder = openOrder.filter(x => x !== id);
    persist();
    notify();
  }

  // Drop project sessions whose project no longer exists in the resolved
  // list. Called once the projects cache is known so we don't render dead
  // entries in the nav.
  function gcAgainstProjects(projectIds) {
    const known = new Set(projectIds);
    let changed = false;
    for (const id of Object.keys(sessions)) {
      const s = sessions[id];
      if (s.kind !== 'project') continue;
      if (!known.has(s.projectId)) {
        delete sessions[id];
        openOrder = openOrder.filter(x => x !== id);
        for (const pid of Object.keys(lastOpenByProject)) {
          if (lastOpenByProject[pid] === id) delete lastOpenByProject[pid];
        }
        changed = true;
      }
    }
    if (changed) { persist(); notify(); }
  }

  function subscribe(fn) {
    subs.add(fn);
    return () => subs.delete(fn);
  }

  // Cross-tab sync: storage events fire in OTHER tabs only, so a second tab
  // re-hydrates when this one writes. Last-writer-wins is fine for chat state.
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY) return;
    load();
    if (!sessions[STATION_ID]) sessions[STATION_ID] = makeStation();
    if (!sessions[activeId]) activeId = STATION_ID;
    notify();
  });

  init();

  return {
    STATION_ID,
    get, list, listOpen, listForProject,
    getActive, getActiveId, setActive,
    ensureProjectSession,
    appendMessage, setTitle, clearHistory, close,
    gcAgainstProjects,
    subscribe,
  };
})();

// ── Panel: Chat (with provider/model switcher) ───────────────────────────

const ChatPanel = (() => {
  const feed  = $('chat-feed');
  const input = $('chat-input');
  const send  = $('chat-send');
  const provSel = $('chat-provider');
  const modelSel = $('chat-model');
  const warnEl = $('chat-key-warning');

  // activeProject mirrors the projectId of the currently-active session.
  // Kept as a separate var so existing call sites (renderBadge, sendMsg,
  // PreviewPane.sync) can read project metadata without re-resolving from
  // SessionStore on every access.
  let activeProject = null;         // { id, name, previewable?, stacksProject? } or null
  let busy = false;

  function currentHistory() {
    return SessionStore.getActive().history;
  }

  function addMsg(role, text) {
    const el = document.createElement('div');
    el.className = 'msg ' + role;
    el.innerHTML = `<div class="lbl">${role === 'asst' ? 'assistant' : role}</div><div class="body"></div>`;
    el.querySelector('.body').textContent = text;
    feed.appendChild(el);
    feed.scrollTop = feed.scrollHeight;
    return el.querySelector('.body');
  }

  function clearChat() {
    SessionStore.clearHistory(SessionStore.getActiveId());
    const note = activeProject
      ? `Cleared. Project context: ${activeProject.name}.`
      : `Cleared. Start a new conversation — NOSTR_STATION.md still loaded as context.`;
    feed.innerHTML = `
      <div class="msg asst">
        <div class="lbl">assistant</div>
        <div class="body">${escapeHtml(note)}</div>
      </div>`;
  }

  function renderHistory() {
    feed.innerHTML = '';
    const h = currentHistory();
    if (h.length === 0) {
      const note = activeProject
        ? `Context: ${activeProject.name}. Ask anything about this project.`
        : 'Ready. NOSTR_STATION.md loaded as system context. What are you building?';
      feed.innerHTML = `
        <div class="msg asst">
          <div class="lbl">assistant</div>
          <div class="body">${escapeHtml(note)}</div>
        </div>`;
      return;
    }
    for (const m of h) {
      addMsg(m.role === 'assistant' ? 'asst' : 'user', m.content);
    }
  }

  // Project badge in chat-controls — inserted dynamically.
  function ensureBadgeEl() {
    let b = document.getElementById('chat-project-badge');
    if (b) return b;
    b = document.createElement('span');
    b.id = 'chat-project-badge';
    b.className = 'chat-project-badge';
    b.style.display = 'none';
    // Place next to key warning
    warnEl.parentElement.appendChild(b);
    return b;
  }
  function renderBadge() {
    const b = ensureBadgeEl();
    if (!activeProject) { b.style.display = 'none'; return; }
    // Click the name → jump to Projects panel (per Step 4.5 spec's
    // "Project indicator" behavior). The × still clears the scope
    // without navigating.
    b.innerHTML = `
      <span class="k">context</span>
      <a href="#projects" class="v" title="Open in Projects">${escapeHtml(activeProject.name)}</a>
      <button class="clear-ctx" aria-label="Clear project context">×</button>
    `;
    b.style.display = '';
    b.querySelector('.clear-ctx').onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      // Navigate to bare #chat — the hash router will land us on the
      // station session via applyRoute(). Keeps URL + active-session
      // state in sync (vs. setActiveProject(null) leaving #chat/s/<id>).
      if (location.hash === '#chat') setActiveProject(null);
      else location.hash = '#chat';
    };
  }

  async function setActiveProject(p) {
    activeProject = p || null;
    if (p) {
      const s = SessionStore.ensureProjectSession(p.id, p.name);
      SessionStore.setActive(s.id);
    } else {
      SessionStore.setActive(SessionStore.STATION_ID);
    }
    try {
      await api('/api/chat/context', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId: p?.id || null }),
      });
    } catch {}
    renderBadge();
    renderHistory();
    syncPermissionsControl();
    PreviewPane.sync(activeProject);
  }

  // ── Live-preview pane ────────────────────────────────────────────────
  // Shakespeare.diy-style side-by-side: chat on the left, an iframe of the
  // project's running dev server on the right. v1 limitations:
  //   - Port 5173 is hardcoded (matches the existing `stacks-dev` PTY
  //     recipe in src/lib/terminal.ts). Two stacks projects can't preview
  //     simultaneously.
  //   - Dev server lives in the terminal panel; closing the terminal tab
  //     kills it. Reopen via the "Start dev server" button.
  //   - Visibility is gated on activeProject + stacksProject. Generalising
  //     to "any project with a `dev` npm script" is a future relax.
  const PreviewPane = (() => {
    const PREVIEW_URL  = 'http://localhost:5173';
    const COLLAPSE_KEY = 'ns:chat-preview:collapsed';
    let split, frame, empty, urlEl, startBtn, reloadBtn, collapseBtn, showBtn;
    let initialized = false;

    function init() {
      if (initialized) return;
      split       = document.getElementById('chat-split');
      frame       = document.getElementById('cp-iframe');
      empty       = document.getElementById('cp-empty');
      urlEl       = document.getElementById('cp-url');
      startBtn    = document.getElementById('cp-start');
      reloadBtn   = document.getElementById('cp-reload');
      collapseBtn = document.getElementById('cp-collapse');
      showBtn     = document.getElementById('cp-show');
      if (!split) return;
      initialized = true;

      urlEl.textContent = PREVIEW_URL;

      reloadBtn.addEventListener('click', () => {
        // Cache-bust by re-assigning src; iframe reloads from the dev server.
        // If the server isn't up, the load fails silently (browser shows its
        // own error page inside the iframe).
        frame.hidden = false;
        empty.style.display = 'none';
        frame.src = PREVIEW_URL + '?_t=' + Date.now();
      });

      collapseBtn.addEventListener('click', () => setCollapsed(true));
      showBtn.addEventListener('click',     () => setCollapsed(false));

      // Mobile bottom tab strip — flips between chat and preview by
      // delegating to the same setCollapsed() so localStorage + the
      // data-preview state stay consistent with the desktop pull-tab.
      const tabBar = document.getElementById('chat-split-tabs');
      if (tabBar) {
        tabBar.addEventListener('click', (e) => {
          const btn = e.target.closest('[data-cs-tab]');
          if (!btn) return;
          setCollapsed(btn.dataset.csTab === 'chat');
        });
      }

      startBtn.addEventListener('click', () => {
        const p = activeProject;
        if (!p) return;
        if (!window.NSTerminal?.isAvailable?.()) {
          alert('Terminal panel is not available — cannot spawn dev server.');
          return;
        }
        window.NSTerminal.open('stacks-dev', { projectId: p.id });
        // Kick the iframe ~2.5s later — Vite's first paint typically lands
        // within 1–3s after `npm run dev`. The reload button is the manual
        // fallback if it's still warming up.
        frame.hidden = false;
        empty.style.display = 'none';
        setTimeout(() => { frame.src = PREVIEW_URL + '?_t=' + Date.now(); }, 2500);
      });
    }

    function setCollapsed(collapsed) {
      init();
      if (!split) return;
      // Only toggle if the pane is actually applicable for this project.
      const state = split.dataset.preview;
      if (state === 'hidden') return;
      split.dataset.preview = collapsed ? 'collapsed' : 'open';
      showBtn.hidden = !collapsed;
      syncTabState(collapsed);
      try { localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0'); } catch {}
    }

    function syncTabState(collapsed) {
      // Mirror the data-preview state onto the mobile tab strip so the
      // active tab styling tracks PreviewPane.setCollapsed() — including
      // when sync() flips state on project change.
      const tabBar = document.getElementById('chat-split-tabs');
      if (!tabBar) return;
      for (const t of tabBar.querySelectorAll('[data-cs-tab]')) {
        const active = (t.dataset.csTab === 'chat') === !!collapsed;
        t.setAttribute('aria-selected', active ? 'true' : 'false');
      }
    }

    function isCollapsedPref() {
      try { return localStorage.getItem(COLLAPSE_KEY) === '1'; } catch { return false; }
    }

    function sync(project) {
      init();
      if (!split) return;
      // `previewable` is the package.json-has-dev-script gate (works for
      // any Vite/Next/etc. project). Older callers may still set only
      // `stacksProject`, so accept either as a back-compat fallback.
      const applicable = !!(project && (project.previewable || project.stacksProject));
      if (!applicable) {
        split.dataset.preview = 'hidden';
        showBtn.hidden = true;
        // Park the iframe so we don't keep loading the previous URL.
        if (frame && frame.src && frame.src !== 'about:blank') frame.src = 'about:blank';
        if (frame) frame.hidden = true;
        if (empty) empty.style.display = '';
        return;
      }
      const collapsed = isCollapsedPref();
      split.dataset.preview = collapsed ? 'collapsed' : 'open';
      showBtn.hidden = !collapsed;
      syncTabState(collapsed);
      // Don't auto-load the iframe — the dev server probably isn't running
      // yet, and a failed iframe load doesn't auto-recover. Empty state +
      // explicit "Start dev server" button is clearer than a blank frame.
    }

    return { sync, setCollapsed };
  })();

  // Permissions toggle (chat-header dropdown). Hidden when no
  // project is active (global chat has no project to scope perms
  // to). Persists per-project via PUT /api/projects/:id/ai-config
  // so the choice survives page reloads and the dispatcher's
  // fallback default (auto-edit) only applies when nothing is
  // stored. Useful for "explain this codebase" mode where you
  // want to flip to read-only without leaving the chat.
  const PERM_OPTIONS = [
    { value: 'read-only', label: 'read-only' },
    { value: 'auto-edit', label: 'auto-edit' },
    { value: 'yolo',      label: 'yolo' },
  ];
  async function syncPermissionsControl() {
    const group = $('chat-perm-group');
    const sel   = $('chat-perm');
    if (!group || !sel) return;
    if (!activeProject) {
      group.style.display = 'none';
      return;
    }
    // Render options once; keep them stable across project switches.
    if (sel.options.length === 0) {
      for (const o of PERM_OPTIONS) {
        const opt = document.createElement('option');
        opt.value = o.value;
        opt.textContent = o.label;
        sel.appendChild(opt);
      }
      sel.addEventListener('change', persistPermissionsChange);
    }
    group.style.display = '';
    // Resolve current value: project override → station default
    // 'auto-edit' (matches the backend dispatcher).
    let mode = 'auto-edit';
    try {
      const cfg = await api(`/api/projects/${activeProject.id}/ai-config`);
      if (cfg?.permissions?.mode) mode = cfg.permissions.mode;
    } catch {}
    sel.value = mode;
  }
  async function persistPermissionsChange() {
    if (!activeProject) return;
    const mode = $('chat-perm').value;
    try {
      await api(`/api/projects/${activeProject.id}/ai-config`, {
        method:  'PUT',
        headers: { 'content-type': 'application/json' },
        body:    JSON.stringify({ permissions: { mode } }),
      });
      toast(`Permissions: ${mode}`, '', 'ok');
    } catch (e) {
      toast('Permissions update failed', e?.message || '', 'err');
      // Roll back the visible value on failure so it matches what's
      // actually persisted.
      syncPermissionsControl();
    }
  }

  // Track whether any API provider is configured; gates the send button
  // and drives the "Add an AI provider in Config" callout.
  let hasConfiguredProvider = false;

  // Cache of the last /api/ai/providers response so model changes can
  // resolve the current provider's metadata without a re-fetch.
  let aiProvidersCache = null;

  async function populateProvider() {
    const list = await api('/api/ai/providers').catch(() => null);
    aiProvidersCache = list;
    const configured = (list?.providers || []).filter(p => p.configured && p.type === 'api');

    if (configured.length === 0) {
      provSel.innerHTML = '<option value="">—</option>';
      provSel.disabled = true;
      if (modelSel) { modelSel.innerHTML = ''; modelSel.disabled = true; }
      hasConfiguredProvider = false;
      showNoProviderCallout();
      updateSendDisabled();
      return;
    }

    hasConfiguredProvider = true;
    hideNoProviderCallout();
    provSel.disabled = false;
    provSel.innerHTML = configured.map(p =>
      `<option value="${escapeHtml(p.id)}">${escapeHtml(p.displayName)}</option>`
    ).join('');
    // Preselect the chat default; fall back to the first configured entry
    // if no default is set.
    const activeId = list?.defaults?.chat && configured.find(p => p.id === list.defaults.chat)
      ? list.defaults.chat
      : configured[0].id;
    provSel.value = activeId;
    await populateModels(activeId);
    updateSendDisabled();
  }

  async function populateModels(providerId) {
    if (!modelSel) return;
    const models = await modelsFor(providerId);
    if (!models.length) {
      // Unknown provider in PROVIDER_LIST — hide the model picker
      // gracefully rather than showing an empty dropdown.
      modelSel.innerHTML = '';
      modelSel.disabled = true;
      return;
    }
    modelSel.disabled = false;
    modelSel.innerHTML = models.map(m =>
      `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`
    ).join('');
    // Prefer the per-provider override stored in ai-config; fall back to
    // the registry default. The server's /api/ai/providers response
    // already resolved this into the `model` field.
    const entry = aiProvidersCache?.providers?.find(p => p.id === providerId);
    const preferred = entry?.model;
    if (preferred && models.includes(preferred)) modelSel.value = preferred;
  }

  // Fallback message when zero API providers are configured. Rendered as
  // a callout inside the chat-controls row — no separate modal, no page
  // churn. Clicking takes the user to the Config panel.
  function showNoProviderCallout() {
    let el = document.getElementById('chat-no-provider');
    if (!el) {
      el = document.createElement('div');
      el.id = 'chat-no-provider';
      el.className = 'chat-no-provider';
      el.innerHTML = `
        <span>No AI provider configured for Chat.</span>
        <a href="#config">Add one in Config →</a>
      `;
      warnEl.parentElement.appendChild(el);
    }
    el.style.display = '';
  }
  function hideNoProviderCallout() {
    const el = document.getElementById('chat-no-provider');
    if (el) el.style.display = 'none';
  }

  function updateSendDisabled() {
    send.disabled = busy || !hasConfiguredProvider;
  }

  async function persistProviderChange() {
    // Switching providers moves defaults.chat + repopulates the model
    // dropdown with the new provider's options. The new provider's stored
    // model (or registry default) becomes the selected model.
    const id = provSel.value;
    if (!id) return;
    await populateModels(id);
    try {
      await api('/api/ai/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ defaults: { chat: id } }),
      });
      // Header reads ai-config.json `defaults.chat` via /api/config —
      // notify so it repaints with the new provider name + model. Skipping
      // this leaves the header chip stuck on whatever was set at boot.
      document.dispatchEvent(new CustomEvent('api-config-changed'));
    } catch { /* api() already toasted */ }
  }

  async function persistModelChange() {
    // Saving a per-provider model override — e.g. switching Anthropic
    // from haiku to sonnet. Goes into ai-config.providers[id].model so
    // the next boot + the Config panel reflect it.
    const id  = provSel.value;
    const mdl = modelSel?.value;
    if (!id || !mdl) return;
    try {
      await api('/api/ai/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ providers: { [id]: { model: mdl } } }),
      });
      // Refresh our cache so subsequent provider switches + renderings
      // see the newly-saved override.
      if (aiProvidersCache?.providers) {
        const entry = aiProvidersCache.providers.find(p => p.id === id);
        if (entry) entry.model = mdl;
      }
      document.dispatchEvent(new CustomEvent('api-config-changed'));
    } catch { /* api() already toasted */ }
  }

  provSel.addEventListener('change', persistProviderChange);
  modelSel?.addEventListener('change', persistModelChange);
  $('chat-clear').addEventListener('click', clearChat);

  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 180) + 'px';
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg(); }
  });
  send.addEventListener('click', sendMsg);

  async function sendMsg() {
    if (busy) return;
    if (!hasConfiguredProvider) {
      toast('No provider', 'Add an AI provider in Config', 'warn');
      return;
    }
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    input.style.height = 'auto';
    busy = true; updateSendDisabled();

    // Bind to the session active when the send started so a mid-flight
    // switch can't append the assistant reply to the wrong bucket.
    const turnSessionId = SessionStore.getActiveId();
    const userMsg = { role: 'user', content: text };
    SessionStore.appendMessage(turnSessionId, userMsg);
    const history = SessionStore.get(turnSessionId).history.slice();
    addMsg('user', text);
    const bodyEl = addMsg('asst', '');
    // Body is now a fragment sequence: text spans and tool-call blocks
    // appended in stream order. The cursor lives in a tail text span
    // that becomes the destination for new text deltas.
    bodyEl.classList.add('asst-body');
    let textSpan = document.createElement('span');
    textSpan.className = 'asst-text';
    bodyEl.appendChild(textSpan);
    const cur = document.createElement('span');
    cur.className = 'cursor';
    bodyEl.appendChild(cur);
    let full = '';
    let sessionId = null;
    const toolCallEls = new Map(); // id → DOM element

    function appendText(t) {
      full += t;
      textSpan.textContent = (textSpan.textContent || '') + t;
      feed.scrollTop = feed.scrollHeight;
    }
    function startNewTextSpan() {
      // After a tool-call block, future text deltas should land in a
      // fresh span so the rendering reads top-to-bottom.
      textSpan = document.createElement('span');
      textSpan.className = 'asst-text';
      // Insert before the cursor so the cursor stays at the tail.
      bodyEl.insertBefore(textSpan, cur);
    }
    // Compress a tool call into a single human-readable line —
    // shakespeare.diy-style ("Wrote src/foo.ts", "Searched \"TARGET\"",
    // "git status"). The full args remain available in the
    // expandable <pre> below for power users; the header label is
    // optimised for scannability when the agent makes 5-15 calls
    // per turn. Truncates long paths/patterns to keep the chat
    // column from wrapping awkwardly on narrow screens.
    function actionLabel(name, args) {
      const a = args || {};
      const trunc = (s, n = 64) => {
        const str = String(s ?? '');
        return str.length > n ? str.slice(0, n - 1) + '…' : str;
      };
      switch (name) {
        case 'read_file':    return `Viewed ${trunc(a.path)}`;
        case 'list_dir':     return `Listed ${trunc(a.path ?? '.')}`;
        case 'write_file':   return `Wrote ${trunc(a.path)}`;
        case 'apply_patch':  return `Edited ${trunc(a.path)}`;
        case 'delete_file':  return `Deleted ${trunc(a.path)}`;
        case 'glob':         return `Globbed "${trunc(a.pattern, 48)}"`;
        case 'grep':         return a.glob
                                  ? `Searched "${trunc(a.pattern, 32)}" in ${trunc(a.glob, 24)}`
                                  : `Searched "${trunc(a.pattern, 48)}"`;
        case 'git_status':   return 'git status';
        case 'git_log':      return `git log${Number.isInteger(a.n) ? ` -n${a.n}` : ''}`;
        case 'git_diff':     return a.path ? `git diff ${trunc(a.path)}` : (a.staged ? 'git diff --cached' : 'git diff');
        case 'git_commit':   return `Committed: "${trunc(a.message, 56)}"`;
        case 'todo_read':    return 'Read todo list';
        case 'todo_write':   return Array.isArray(a.todos)
                                  ? `Updated todos (${a.todos.length})`
                                  : 'Updated todos';
        case 'build_project': return 'Built project';
        case 'run_command': {
          const argv = Array.isArray(a.argv) ? a.argv : [];
          if (argv.length === 0) return 'run_command';
          const joined = argv.map(x => /\s/.test(String(x)) ? `"${x}"` : x).join(' ');
          return trunc(joined, 80);
        }
        default:             return name;
      }
    }

    function renderToolCall(id, name, args) {
      const el = document.createElement('div');
      el.className = 'tool-call pending';
      el.dataset.id = id;
      const label = actionLabel(name, args);
      el.innerHTML = `
        <div class="tc-head">
          <span class="tc-status">▸</span>
          <span class="tc-label">${escapeHtml(label)}</span>
          <span class="tc-summary"></span>
        </div>
        <pre class="tc-args">${escapeHtml(JSON.stringify(args, null, 2))}</pre>
      `;
      // Toggle expand/collapse on header click — the full argv stays
      // a click away for users who want to inspect what actually ran.
      el.querySelector('.tc-head').addEventListener('click', () => el.classList.toggle('expanded'));
      bodyEl.insertBefore(el, cur);
      startNewTextSpan();
      toolCallEls.set(id, el);
      feed.scrollTop = feed.scrollHeight;
      return el;
    }
    function updateToolResult(id, ok, summary, error) {
      const el = toolCallEls.get(id);
      if (!el) return;
      el.classList.remove('pending');
      el.classList.add(ok ? 'ok' : 'err');
      const status = el.querySelector('.tc-status');
      if (status) status.textContent = ok ? '✓' : '✗';
      const sum = el.querySelector('.tc-summary');
      if (sum) sum.textContent = ok ? (summary || 'done') : (error || 'failed');
    }

    // Todo tracker — reuses one element appended to the chat feed so
    // every todo_state SSE update mutates in place rather than
    // stacking multiple trackers as the agent works through items.
    // Empty list (`todos.length === 0`) hides the tracker entirely;
    // a TodoWrite([]) effectively dismisses it once a multi-step
    // task is fully done. The tracker re-renders inline (not as a
    // separate sticky bar) so it scrolls with the conversation —
    // matches shakespeare.diy's "[1/4] Create NotePreview…" style.
    let todoTrackerEl = null;
    function renderTodoTracker(todos) {
      if (!Array.isArray(todos) || todos.length === 0) {
        if (todoTrackerEl) { todoTrackerEl.remove(); todoTrackerEl = null; }
        return;
      }
      if (!todoTrackerEl) {
        todoTrackerEl = document.createElement('div');
        todoTrackerEl.className = 'todo-tracker';
        bodyEl.insertBefore(todoTrackerEl, cur);
      }
      const done   = todos.filter(t => t.status === 'completed').length;
      const total  = todos.length;
      todoTrackerEl.innerHTML = `
        <div class="tt-head">
          <span class="tt-count">[${done}/${total}]</span>
          <span class="tt-label">${done === total ? 'tasks completed' : 'tasks'}</span>
        </div>
        <ul class="tt-list">
          ${todos.map(t => {
            const glyph = t.status === 'completed'  ? '✓'
                        : t.status === 'in_progress' ? '▸'
                        :                              '○';
            return `<li class="tt-item tt-${t.status}">
              <span class="tt-glyph">${glyph}</span>
              <span class="tt-content">${escapeHtml(t.content)}</span>
            </li>`;
          }).join('')}
        </ul>
      `;
      feed.scrollTop = feed.scrollHeight;
    }
    function renderApprovalRequest(id, approvalId, name, args, preview) {
      const el = renderToolCall(id, name, args);
      el.classList.add('awaiting-approval');
      const head = el.querySelector('.tc-head');
      if (head) head.querySelector('.tc-status').textContent = '⚠';
      const previewEl = document.createElement('pre');
      previewEl.className = 'tc-preview';
      previewEl.textContent = typeof preview === 'string' ? preview : JSON.stringify(preview, null, 2);
      el.appendChild(previewEl);
      const actions = document.createElement('div');
      actions.className = 'tc-actions';
      const approveBtn = document.createElement('button');
      approveBtn.className = 'primary';
      approveBtn.textContent = 'Approve';
      const rejectBtn = document.createElement('button');
      rejectBtn.className = 'danger';
      rejectBtn.textContent = 'Reject';
      actions.appendChild(approveBtn);
      actions.appendChild(rejectBtn);
      el.appendChild(actions);
      const respond = async (decision) => {
        approveBtn.disabled = true;
        rejectBtn.disabled  = true;
        actions.style.opacity = 0.6;
        try {
          await api('/api/ai/chat/approve', {
            method:  'POST',
            headers: { 'content-type': 'application/json' },
            body:    JSON.stringify({ sessionId, approvalId, decision }),
          });
        } catch (e) {
          toast('Approval failed', e.message, 'err');
        }
      };
      approveBtn.addEventListener('click', () => respond('approve'));
      rejectBtn.addEventListener('click',  () => respond('reject'));
      // Auto-expand approval prompts so the user can see the diff.
      el.classList.add('expanded');
    }

    try {
      // /api/ai/chat handles provider resolution + project context
      // injection server-side. We pass provider explicitly so the user's
      // dropdown choice wins over the stored chat default even before the
      // persistSelection() round-trip lands.
      const res = await fetch('/api/ai/chat', {
        method:  'POST',
        headers: { 'content-type': 'application/json', 'Authorization': `Bearer ${getSessionToken() || ''}` },
        body:    JSON.stringify({
          messages: history,
          provider: provSel.value || undefined,
          // Explicit model wins over ai-config — the dropdown is the
          // source of truth for the current send. persistModelChange
          // writes in parallel so the next tab-switch / restart sees
          // the same selection, but this avoids the race.
          model:    modelSel?.value || undefined,
          projectId: activeProject?.id || undefined,
        }),
      });
      if (!res.ok) throw new Error('server ' + res.status);

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      outer: while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n'); buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const d = line.slice(6).trim();
          if (d === '[DONE]') break outer;
          try {
            const p = JSON.parse(d);
            if (p.error) throw new Error(p.error);
            if (p.session) { sessionId = p.session; continue; }
            if (p.model) {
              const lbl = bodyEl.parentElement?.querySelector('.lbl');
              if (lbl) {
                let tag = lbl.querySelector('.model-tag');
                if (!tag) {
                  tag = document.createElement('span');
                  tag.className = 'model-tag';
                  lbl.appendChild(tag);
                }
                tag.textContent = p.model;
              }
              continue;
            }
            if (typeof p.content === 'string') { appendText(p.content); continue; }
            if (p.type === 'tool_call_start') { renderToolCall(p.id, p.name, p.args); continue; }
            if (p.type === 'approval_request') { renderApprovalRequest(p.id, p.approvalId, p.name, p.args, p.preview); continue; }
            if (p.type === 'tool_result') { updateToolResult(p.id, !!p.ok, p.summary, p.error); continue; }
            if (p.type === 'todo_state') { renderTodoTracker(p.todos); continue; }
          } catch (e) {
            if (e.message && !e.message.startsWith('{')) throw e;
          }
        }
      }
    } catch (e) {
      const errEl = document.createElement('div');
      errEl.className = 'asst-error';
      errEl.textContent = '✗ ' + e.message;
      bodyEl.appendChild(errEl);
      bodyEl.parentElement.className = 'msg error';
    }
    cur.remove();
    if (full) SessionStore.appendMessage(turnSessionId, { role: 'assistant', content: full });
    busy = false; updateSendDisabled();
    input.focus();
  }

  // Config panel emits this after a successful provider add / key update /
  // default change. Re-run populateProvider() so the Chat dropdown reflects
  // the new state without the user having to leave + re-enter the panel.
  document.addEventListener('api-config-changed', () => {
    populateProvider();
  });

  // Resolve the project metadata for a session — preferring the in-memory
  // ProjectsPanel cache so we don't round-trip the server when switching
  // between already-loaded projects. Falls back to GET /api/projects/:id
  // for deep-link landings (`#chat/s/p:<id>` opened in a fresh tab before
  // the Projects panel has run).
  async function resolveProjectForSession(session) {
    if (!session || session.kind !== 'project' || !session.projectId) return null;
    const cached = Array.isArray(window.__projectsCache)
      ? window.__projectsCache.find(x => x.id === session.projectId)
      : null;
    if (cached) return cached;
    try {
      const p = await api(`/api/projects/${session.projectId}`);
      return p && p.id ? p : null;
    } catch {
      return null;
    }
  }

  // Apply the hash sub-route to the active session. Always rebinds
  // activeProject + repaints the UI so any drift between the URL and the
  // panel state self-heals on next entry. setActiveProject is idempotent.
  async function applyRoute() {
    const { sessionId } = currentChatSubroute();
    const session = sessionId ? SessionStore.get(sessionId) : SessionStore.get(SessionStore.STATION_ID);
    if (!session || session.kind === 'station') {
      if (sessionId && !session && location.hash !== '#chat') location.hash = '#chat';
      await setActiveProject(null);
      return;
    }
    const p = await resolveProjectForSession(session);
    if (!p) {
      // Project vanished out from under us — close the dead session and
      // land on station rather than render an empty chat with no context.
      SessionStore.close(session.id);
      if (location.hash !== '#chat') location.hash = '#chat';
      await setActiveProject(null);
      return;
    }
    await setActiveProject({
      id: p.id,
      name: p.name,
      previewable:   !!p.previewable,
      stacksProject: !!p.stacksProject,
    });
  }

  let initialized = false;
  return {
    onEnter() {
      if (!initialized) {
        initialized = true;
        populateProvider();
        renderBadge();
        // Repaint the persisted history on first entry — covers reloads
        // where the station session has prior turns in localStorage but
        // no setActiveProject() has fired yet.
        renderHistory();
      }
      applyRoute();
      input.focus();
    },
    setActiveProject,
    getActiveProject() { return activeProject; },
  };
})();

// ── NavSessions: render open project sessions nested under Projects ─────
//
// Subscribes to SessionStore so create / close / setActive triggers a
// re-render. Each row is a regular <a> with href="#chat/s/<id>" so the
// existing hashchange router does the navigation; ChatPanel.applyRoute()
// then resolves the active session. The top-level Chat nav link is
// un-highlighted whenever a project session is active, so the active
// indicator only ever points at one row at a time.
const NavSessions = (() => {
  const container = document.getElementById('nav-project-sessions');
  const stationLink = document.querySelector('#nav a[href="#chat"]');
  if (!container) return { refresh() {} };

  // Derive the visually-active session straight from the hash so the
  // highlight tracks the URL without waiting for the (async) session
  // resolve inside ChatPanel.applyRoute(). Off the chat panel, no row
  // should be highlighted.
  function activeIdFromHash() {
    const h = location.hash || '';
    const m = h.match(/^#chat\/s\/([\w:-]+)$/);
    if (m) return m[1];
    if (h === '#chat' || h === '' || h === '#') return SessionStore.STATION_ID;
    return null;
  }

  function render() {
    const sessions = SessionStore.listOpen().filter(s => s.kind === 'project');
    const activeId = activeIdFromHash();
    container.innerHTML = '';
    for (const s of sessions) {
      const row = document.createElement('a');
      row.className = 'nav-session' + (s.id === activeId ? ' active' : '');
      row.href = `#chat/s/${s.id}`;
      row.title = s.title;
      const label = document.createElement('span');
      label.className = 'nav-session-label';
      label.textContent = s.title;
      const close = document.createElement('button');
      close.className = 'nav-session-close';
      close.type = 'button';
      close.setAttribute('aria-label', 'Close session');
      close.textContent = '×';
      close.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const wasActive = SessionStore.getActiveId() === s.id;
        SessionStore.close(s.id);
        if (wasActive) {
          // Prefer another open project session for the same project,
          // else fall back to station.
          const siblings = SessionStore.listOpen().filter(x => x.projectId === s.projectId);
          location.hash = siblings.length ? `#chat/s/${siblings[0].id}` : '#chat';
        }
      });
      row.appendChild(label);
      row.appendChild(close);
      container.appendChild(row);
    }
    // Top-level Chat link should only be "active" when the station
    // session is what's actually showing. Without this it'd light up
    // alongside any project session row (both live under the same panel).
    if (stationLink) {
      const stationActive = activeId === SessionStore.STATION_ID;
      stationLink.classList.toggle('active', stationActive);
    }
  }

  SessionStore.subscribe(render);
  window.addEventListener('hashchange', render);
  render();
  return { refresh: render };
})();

// ── Panel: Relay ─────────────────────────────────────────────────────────

const RelayPanel = (() => {
  const KIND_LABELS = {
    0: 'profile', 1: 'note', 3: 'contacts', 4: 'DM', 5: 'delete', 6: 'repost',
    7: 'reaction', 1059: 'gift-wrap', 9735: 'zap', 10002: 'relays',
    30023: 'article', 30078: 'app-data',
  };
  const kindLabel = (k) => KIND_LABELS[k] || `kind ${k}`;

  let ws = null;
  let events = [];
  const kindCounts = new Map();
  const pubkeys = new Set();
  let entered = false;
  // Resolved on first connect from /api/relay-config so the panel
  // tracks whatever port the in-process relay is actually on (default
  // 7777, overridable via STATION_INPROC_RELAY_PORT). Pre-cleanup this
  // was hardcoded to :8080 — the standalone nostr-rs-relay's port —
  // and silently failed once that daemon was replaced by the in-process
  // implementation.
  let relayUrl = null;

  async function ensureRelayUrl() {
    if (relayUrl) return relayUrl;
    try {
      const rc = await api('/api/relay-config');
      if (rc?.url) relayUrl = rc.url;
    } catch { /* fall through to default */ }
    if (!relayUrl) relayUrl = `ws://${location.hostname}:7777`;
    paintNakHelpCommands(relayUrl);
    return relayUrl;
  }

  // Help-card nak example commands carry the relay URL inline. Paint
  // them from the resolved URL so STATION_INPROC_RELAY_PORT overrides
  // produce copy-pasteable commands instead of always-:7777 stubs.
  // The pre elements use `data-template` with a {url} placeholder; the
  // <span class="code"> child holds the visible text, the data-cmd
  // attribute (copy-button source) gets refreshed in lockstep.
  function paintNakHelpCommands(url) {
    for (const pre of document.querySelectorAll('.help-card pre[data-template]')) {
      const cmd = pre.dataset.template.replace('{url}', url);
      pre.dataset.cmd = cmd;
      const code = pre.querySelector('.code');
      if (code) code.textContent = cmd;
    }
  }

  async function connect() {
    disconnect();
    const url = await ensureRelayUrl();
    try { ws = new WebSocket(url); }
    catch { setWsStatus('error'); return; }
    setWsStatus('connecting');
    ws.addEventListener('open', () => {
      setWsStatus('open');
      const subId = 'ns-dash-' + Math.random().toString(36).slice(2, 8);
      ws.send(JSON.stringify(['REQ', subId, { limit: 50 }]));
    });
    ws.addEventListener('message', (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (Array.isArray(msg) && msg[0] === 'EVENT' && msg[2]) onEvent(msg[2]);
      } catch {}
    });
    ws.addEventListener('close', () => setWsStatus('closed'));
    ws.addEventListener('error', () => setWsStatus('error'));
  }

  function disconnect() { if (ws) { try { ws.close(); } catch {} ws = null; } }
  function setWsStatus(s) { $('relay-ws').textContent = s; }
  function onEvent(ev) {
    events.unshift(ev);
    events = events.slice(0, 100);
    kindCounts.set(ev.kind, (kindCounts.get(ev.kind) || 0) + 1);
    if (ev.pubkey) pubkeys.add(ev.pubkey);
    $('relay-count').textContent   = Array.from(kindCounts.values()).reduce((a, b) => a + b, 0);
    $('relay-pubkeys').textContent = pubkeys.size;
    const inline = $('relay-events-inline-count');
    if (inline) inline.textContent = events.length;
    renderKinds(); renderEvents();
  }
  function renderKinds() {
    const el = $('relay-kinds');
    el.innerHTML = '';
    const sorted = Array.from(kindCounts.entries()).sort((a, b) => b[1] - a[1]);
    for (const [k, n] of sorted) {
      const b = document.createElement('span');
      b.className = 'kind-badge';
      b.innerHTML = `${escapeHtml(kindLabel(k))}<span class="n">${n}</span>`;
      el.appendChild(b);
    }
  }
  function renderEvents() {
    const el = $('relay-events');
    if (events.length === 0) {
      const u = relayUrl || `ws://${location.hostname}:7777`;
      el.innerHTML = `<div class="empty-state">Waiting for events…<div class="hint">Publish one: <code>nak event -k 1 --sec &lt;nsec&gt; "hello" ${escapeHtml(u)}</code></div></div>`;
      return;
    }
    el.innerHTML = '';
    for (const ev of events) {
      const row = document.createElement('div');
      row.className = 'event';
      const ts = new Date((ev.created_at || 0) * 1000);
      row.innerHTML = `
        <div class="k-tag">${escapeHtml(kindLabel(ev.kind))}</div>
        <div class="pk">${escapeHtml((ev.pubkey || '').slice(0, 12))}…</div>
        <div class="content">${escapeHtml(ev.content || '')}</div>
        <div class="ts">${escapeHtml(isNaN(ts.getTime()) ? '' : ts.toLocaleTimeString())}</div>
      `;
      el.appendChild(row);
    }
  }

  async function refreshRelayStatus() {
    try {
      const s = await api('/api/status');
      const r = s.find(x => x.id === 'relay');
      // gatherStatus emits "ws://host:port ✓" for the relay row's value,
      // so use that directly instead of falling back to a hardcoded
      // default. The ensureRelayUrl cache may not have populated yet on
      // the first refresh tick (it resolves on connect), and a fallback
      // to :7777 here would silently misrepresent a custom port.
      const upUrl = (r?.value || '').replace(/\s*✓\s*$/, '').trim();
      $('relay-status').textContent = r?.state === 'ok' ? `up · ${upUrl}`
                                    : r?.state === 'warn' ? 'installed (down)'
                                    : 'not installed';
      $('relay-status').style.color = r?.state === 'ok' ? 'var(--success)'
                                    : r?.state === 'warn' ? 'var(--warn)'
                                    : 'var(--error)';
    } catch {}
    try {
      const dbStats = await api('/api/relay/database/stats');
      $('relay-db-size').textContent = dbStats.exists ? formatBytes(dbStats.sizeBytes) : 'empty';
    } catch {}
  }

  function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(2)} MB`;
  }

  async function action(name) {
    const btn = $('relay-' + name);
    const orig = btn.textContent;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>';
    try {
      const data = await api('/api/relay/' + name, { method: 'POST' });
      if (!data.ok) throw new Error(data.error || 'failed');
      toast(`Relay ${name}`, data.up ? 'running' : 'stopped', 'ok');
    } catch (e) {
      toast(`Relay ${name} failed`, e.message, 'err');
    }
    btn.textContent = orig;
    btn.disabled = false;
    await refreshRelayStatus();
    if (name === 'restart' || name === 'start') setTimeout(() => connect(), 1200);
    else if (name === 'stop') { disconnect(); setWsStatus('disconnected'); }
  }

  // ── Whitelist manager ──────────────────────────────────────────────────

  async function refreshWhitelist() {
    try {
      const rc = await api('/api/relay-config');
      const items = $('relay-whitelist-items');
      items.innerHTML = '';
      if (!rc.whitelist || rc.whitelist.length === 0) {
        items.innerHTML = `<div style="color:var(--text-dim);font-size:11px;padding:6px 0">No entries — nobody can publish yet. Add an npub below.</div>`;
        return;
      }
      // Reverse lookup: npub → role label. knownRoles is populated by the
      // server from identity.json + keychain (watchdog-nsec, seed-nsec)
      // so the labels stay correct as those rotate.
      const roles = rc.knownRoles || {};
      const byNpub = new Map();
      if (roles.station)  byNpub.set(roles.station,  { cls: 'station',  text: 'You · station' });
      if (roles.watchdog) byNpub.set(roles.watchdog, { cls: 'watchdog', text: 'Watchdog' });
      if (roles.seed)     byNpub.set(roles.seed,     { cls: 'seed',     text: 'Seed' });

      for (const npub of rc.whitelist) {
        const row = document.createElement('div');
        row.className = 'item-row';
        const role = byNpub.get(npub);
        const badge = role
          ? `<span class="npub-badge npub-badge-${role.cls}">${escapeHtml(role.text)}</span>`
          : '';
        row.innerHTML = `<div class="npub">${escapeHtml(npub)}</div>${badge}`;
        const rm = document.createElement('button');
        rm.className = 'danger'; rm.textContent = '×'; rm.title = 'remove';
        rm.addEventListener('click', () => handleRemove(npub));
        row.appendChild(rm);
        items.appendChild(row);
      }
    } catch {}
  }

  async function handleAdd() {
    const input = $('relay-whitelist-input');
    const npub = input.value.trim();
    if (!npub) return;
    try {
      const r = await api('/api/relay/whitelist/add', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ npub }),
      });
      if (!r.ok) throw new Error(r.error || 'add failed');
      if (r.already) toast('Already whitelisted', npub, 'warn');
      else           relayApplyToast('Added to whitelist', r);
      input.value = '';
      refreshWhitelist();
    } catch (e) {
      toast('Whitelist add failed', e.message, 'err');
    }
  }

  async function handleRemove(npub) {
    const confirmed = await confirmDestructive({
      title: 'Remove from whitelist',
      description: `${npub}\n\nThis npub will no longer be able to publish to your relay.`,
      confirmLabel: 'Remove',
    });
    if (!confirmed) return;
    try {
      const r = await api('/api/relay/whitelist/remove', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ npub }),
      });
      if (!r.ok) throw new Error(r.error || 'remove failed');
      relayApplyToast('Removed', r);
      refreshWhitelist();
    } catch (e) {
      toast('Whitelist remove failed', e.message, 'err');
    }
  }

  $('relay-whitelist-add').addEventListener('click', handleAdd);
  $('relay-whitelist-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleAdd();
  });
  $('relay-whitelist-paste').addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      $('relay-whitelist-input').value = text.trim();
    } catch { toast('Clipboard read blocked', 'paste manually', 'warn'); }
  });

  // ── Database ops ───────────────────────────────────────────────────────

  $('relay-db-wipe').addEventListener('click', async () => {
    const confirmed = await confirmDestructive({
      title: 'Wipe relay database',
      description: 'All events will be deleted. Relay will stop, files removed, then restart.',
      typeToConfirm: 'RESET',
      confirmLabel: 'Wipe',
    });
    if (!confirmed) return;
    try {
      const r = await api('/api/relay/database/wipe', { method: 'POST' });
      if (!r.ok) throw new Error(r.error || 'wipe failed');
      toast('Database wiped', 'Relay restarted', 'ok');

      // The server stops the relay, deletes the SQLite files, then
      // restarts — but our in-memory view is still holding whatever
      // events we saw before the wipe, and the WS that fed them is now
      // a dead socket from the relay-stop. Clear client state and
      // reconnect so the user sees an honest empty feed that fills in
      // again as new events arrive. Mirrors what action('restart')
      // does at the end of its handler.
      events = [];
      kindCounts.clear();
      pubkeys.clear();
      $('relay-count').textContent   = '0';
      $('relay-pubkeys').textContent = '0';
      const inline = $('relay-events-inline-count');
      if (inline) inline.textContent = '0';
      renderKinds();
      renderEvents();
      disconnect();
      setTimeout(() => connect(), 1200);

      refreshRelayStatus();
    } catch (e) {
      toast('Wipe failed', e.message, 'err');
    }
  });

  $('relay-db-export').addEventListener('click', async () => {
    try {
      const r = await api('/api/relay/database/export', { method: 'POST' });
      if (!r.ok) throw new Error(r.error || 'export failed');
      toast('Exported', r.file, 'ok');
    } catch (e) { toast('Export failed', e.message, 'err'); }
  });

  $('relay-start').addEventListener('click', () => action('start'));
  $('relay-stop').addEventListener('click', () => action('stop'));
  $('relay-restart').addEventListener('click', () => action('restart'));

  // `seed` prompts for event count + confirms before sending, so it needs
  // a real TTY. Deferred availability check: RelayPanel's module-init runs
  // before NSTerminal.init() has finished probing /api/terminal/capability,
  // so an init-time isAvailable() gate would always see null and stay hidden.
  // Check at click-time instead — terminal panel or toast surfaces any
  // unavailability reason. Live event stream above will show seeded events
  // as they land.
  $('relay-seed')?.addEventListener('click', () => {
    if (window.NSTerminal?.isAvailable?.()) {
      window.NSTerminal.open('seed');
    } else {
      toast('Terminal unavailable',
        window.NSTerminal?.getUnavailableReason?.() || 'Run `nostr-station seed` from your shell.',
        'err');
    }
  });


  // Copy buttons on help card <pre data-cmd="..."> elements
  $$('.help-card pre[data-cmd]').forEach(pre => pre.appendChild(copyBtn(pre.dataset.cmd)));

  return {
    onEnter() {
      refreshRelayStatus();
      refreshWhitelist();
      if (!entered) { entered = true; connect(); }
    },
  };
})();

// ── Panel: Blossom ───────────────────────────────────────────────────────
//
// Media explorer + manager for the in-process Blossom server. Mirrors
// the Relay panel's role: a dedicated deep-dive surface for the service.
// Reads from /api/blossom-config (status + stats) and /api/blossom/blobs
// (paginated index). Writes through the admin-mediated delete endpoints
// added in routes/blossom-config.ts.
//
// v1 scope:
//   - Stats header (count, bytes, quota %, per-uploader breakdown)
//   - Filter chips (All / Owner / Whitelist / Test-identity + mime
//     buckets: image / video / audio / other)
//   - Paginated grid view with thumbnails for images, icons otherwise
//   - Per-blob detail overlay with preview + delete
//   - Multi-select via per-card checkbox + bulk delete
//   - Off-state CTA: Enable button that POSTs /api/blossom/start
//
// Deferred to v2: per-blob NIP-94 generation, upload from panel,
// cross-references against the local relay, export/import.
const BlossomPanel = (() => {
  const PAGE_SIZE = 24;
  const FILTERS = [
    { id: 'all',           label: 'All',           kind: 'pseudo' },
    { id: 'owner',         label: 'Owner',         kind: 'uploader' },
    { id: 'whitelist',     label: 'Whitelist',     kind: 'uploader' },
    { id: 'test-identity', label: 'Test users',    kind: 'uploader' },
    { id: 'image',         label: 'Images',        kind: 'mime', prefix: 'image/' },
    { id: 'video',         label: 'Videos',        kind: 'mime', prefix: 'video/' },
    { id: 'audio',         label: 'Audio',         kind: 'mime', prefix: 'audio/' },
    { id: 'other',         label: 'Other',         kind: 'mime', prefix: null /* anything not in image/video/audio */ },
  ];

  let state = {
    running:  false,
    url:      null,
    stats:    null,
    blobs:    [],
    total:    0,
    page:     0,
    filter:   'all',
    selected: new Set(),
    loading:  false,
  };

  function fmtBytes(n) {
    if (!n || n < 0) return '0 B';
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    let i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
  }

  function fmtAge(epochMs) {
    if (!epochMs) return '';
    const s = Math.max(0, (Date.now() - epochMs) / 1000);
    if (s < 60)     return `${Math.floor(s)}s ago`;
    if (s < 3600)   return `${Math.floor(s / 60)}m ago`;
    if (s < 86400)  return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  }

  function mimeIcon(mime) {
    if (!mime) return '📄';
    if (mime.startsWith('image/')) return '🖼️';
    if (mime.startsWith('video/')) return '🎬';
    if (mime.startsWith('audio/')) return '🎵';
    if (mime.startsWith('text/'))  return '📝';
    if (mime === 'application/pdf') return '📕';
    return '📄';
  }

  function blobDirectUrl(sha) {
    return state.url ? `${state.url}/${sha}` : `http://127.0.0.1:8081/${sha}`;
  }

  // ── Network ────────────────────────────────────────────────────────────

  async function load() {
    state.loading = true;
    renderEmpty('Loading…');
    try {
      const cfg = await api('/api/blossom-config');
      state.running = !!cfg?.running;
      state.url     = cfg?.url || null;
      state.stats   = cfg?.stats || null;
      if (!state.running) {
        state.blobs = []; state.total = 0;
        renderOffState();
        return;
      }
      // Server-side pagination: limit + offset on the blobs endpoint.
      // Filters are applied client-side after fetch — for v1's volumes
      // (single digits to maybe low hundreds) the simplicity is worth
      // the extra ~few KB pulled. Phase 2 can push filters server-side.
      const r = await api(`/api/blossom/blobs?limit=500&offset=0`);
      state.blobs = Array.isArray(r?.blobs) ? r.blobs : [];
      state.total = typeof r?.total === 'number' ? r.total : state.blobs.length;
    } catch (e) {
      renderEmpty(`Failed to load: ${escapeHtml(e?.message || String(e))}`);
      state.running = false;
    } finally {
      state.loading = false;
    }
    render();
  }

  async function deleteBlob(sha) {
    const r = await api(`/api/blossom/blobs/${encodeURIComponent(sha)}`, { method: 'DELETE' });
    if (r?.ok === false) throw new Error(r?.error || 'delete failed');
    return r;
  }

  async function bulkDelete(shas) {
    const r = await api('/api/blossom/blobs/bulk-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sha256s: shas }),
    });
    if (r?.ok === false) throw new Error(r?.error || 'bulk delete failed');
    return r;
  }

  // ── Filtering / pagination ─────────────────────────────────────────────

  function applyFilter(blobs) {
    const f = FILTERS.find(x => x.id === state.filter) || FILTERS[0];
    if (f.id === 'all') return blobs;
    if (f.kind === 'uploader') {
      return blobs.filter(b => b.uploaderKind === f.id);
    }
    if (f.kind === 'mime') {
      if (f.id === 'other') {
        return blobs.filter(b => {
          const m = b.mime || '';
          return !m.startsWith('image/') && !m.startsWith('video/') && !m.startsWith('audio/');
        });
      }
      return blobs.filter(b => (b.mime || '').startsWith(f.prefix));
    }
    return blobs;
  }

  function paged(filtered) {
    const start = state.page * PAGE_SIZE;
    return filtered.slice(start, start + PAGE_SIZE);
  }

  // ── Render ─────────────────────────────────────────────────────────────

  function renderOffState() {
    const grid = $('blossom-grid');
    const stats = $('blossom-stats');
    const filters = $('blossom-filters');
    const empty = $('blossom-empty');
    const pager = $('blossom-pager');
    const bulk = $('blossom-bulk-bar');
    if (filters) filters.hidden = true;
    if (pager)   pager.hidden = true;
    if (bulk)    bulk.hidden = true;
    if (stats) {
      stats.innerHTML = `
        <div class="blossom-off">
          <div class="blossom-off-title">Blossom is not running</div>
          <div class="muted" style="margin-bottom:8px">Bundled in-process — no install required.</div>
          <button class="primary" id="blossom-enable">Enable Blossom</button>
        </div>
      `;
      $('blossom-enable')?.addEventListener('click', async () => {
        const btn = $('blossom-enable');
        if (btn) { btn.disabled = true; btn.textContent = 'Enabling…'; }
        try {
          await api('/api/blossom/start', { method: 'POST' });
          apiInvalidate('/api/blossom-config');
          apiInvalidate('/api/status');
          await load();
          refreshHealth?.();
          try { await StatusPanel?._fillBlossomCard?.(); } catch {}
          try { await ConfigPanel?.refreshBlossomSection?.(); } catch {}
        } catch (e) {
          toast('Failed to enable Blossom', e?.message || '', 'err');
          if (btn) { btn.disabled = false; btn.textContent = 'Enable Blossom'; }
        }
      });
    }
    if (grid) grid.innerHTML = '';
    if (empty) empty.hidden = true;
  }

  function renderEmpty(message) {
    const grid = $('blossom-grid');
    const empty = $('blossom-empty');
    if (grid) grid.innerHTML = '';
    if (empty) {
      empty.hidden = false;
      empty.textContent = message;
    }
  }

  function renderStats() {
    const el = $('blossom-stats');
    if (!el) return;
    const s = state.stats || { blobCount: 0, totalBytes: 0, quotaBytes: 0, uploadsByKind: { owner: 0, whitelist: 0, 'test-identity': 0 } };
    const pct = s.quotaBytes ? Math.min(100, Math.round((s.totalBytes / s.quotaBytes) * 100)) : 0;
    el.innerHTML = `
      <div class="blossom-stat-row">
        <div class="blossom-stat-headline">
          <b>${s.blobCount}</b> blob${s.blobCount === 1 ? '' : 's'} ·
          <b>${escapeHtml(fmtBytes(s.totalBytes))}</b>${s.quotaBytes ? ` of <b>${escapeHtml(fmtBytes(s.quotaBytes))}</b>` : ''}
          ${s.quotaBytes ? `<span class="muted">(${pct}%)</span>` : ''}
        </div>
        <div class="blossom-stat-url"><code>${escapeHtml(state.url || '')}</code></div>
      </div>
      ${s.quotaBytes ? `
        <div class="blossom-quota-bar">
          <div class="blossom-quota-fill" style="width:${pct}%"></div>
        </div>
      ` : ''}
      <div class="blossom-stat-breakdown muted">
        Owner: <b>${s.uploadsByKind?.owner || 0}</b> ·
        Whitelist: <b>${s.uploadsByKind?.whitelist || 0}</b> ·
        Test users: <b>${s.uploadsByKind?.['test-identity'] || 0}</b>
      </div>
    `;
  }

  function renderFilters() {
    const el = $('blossom-filters');
    if (!el) return;
    el.hidden = false;
    el.innerHTML = FILTERS.map(f => `
      <button class="blossom-filter-chip ${state.filter === f.id ? 'active' : ''}" data-filter="${escapeHtml(f.id)}">
        ${escapeHtml(f.label)}
      </button>
    `).join('');
    el.querySelectorAll('.blossom-filter-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        state.filter = btn.dataset.filter;
        state.page = 0;
        state.selected.clear();
        render();
      });
    });
  }

  function renderBulkBar() {
    const el = $('blossom-bulk-bar');
    if (!el) return;
    if (state.selected.size === 0) { el.hidden = true; return; }
    el.hidden = false;
    $('blossom-bulk-count').textContent = `${state.selected.size} selected`;
  }

  function renderGrid() {
    const grid = $('blossom-grid');
    const empty = $('blossom-empty');
    const pager = $('blossom-pager');
    if (!grid) return;

    const filtered = applyFilter(state.blobs);
    const pageBlobs = paged(filtered);

    if (filtered.length === 0) {
      grid.innerHTML = '';
      empty.hidden = false;
      empty.textContent = state.blobs.length === 0
        ? 'No blobs stored yet. Apps uploading to http://127.0.0.1:8081 via NIP-98 will appear here.'
        : `No blobs match the "${FILTERS.find(f => f.id === state.filter)?.label}" filter.`;
      pager.hidden = true;
      return;
    }
    empty.hidden = true;

    grid.innerHTML = pageBlobs.map(b => {
      const isImg = (b.mime || '').startsWith('image/');
      const isSelected = state.selected.has(b.sha256);
      const thumb = isImg
        ? `<img class="blossom-thumb" src="${escapeHtml(blobDirectUrl(b.sha256))}" alt="" loading="lazy">`
        : `<div class="blossom-thumb blossom-thumb-icon">${mimeIcon(b.mime)}</div>`;
      const kindClass = `blossom-kind-${b.uploaderKind}`;
      return `
        <div class="blossom-card ${isSelected ? 'selected' : ''}" data-sha="${escapeHtml(b.sha256)}">
          <label class="blossom-card-check" title="Select for bulk action">
            <input type="checkbox" data-sha="${escapeHtml(b.sha256)}" ${isSelected ? 'checked' : ''}>
          </label>
          ${thumb}
          <div class="blossom-card-meta">
            <div class="blossom-card-line"><code>${escapeHtml(b.sha256.slice(0, 12))}…</code></div>
            <div class="blossom-card-line muted">
              <span class="blossom-kind-chip ${kindClass}" title="uploader: ${escapeHtml(b.uploaderKind)}">${escapeHtml(b.uploaderKind)}</span>
              <span>${escapeHtml(fmtBytes(b.size))}</span>
              <span>${escapeHtml(fmtAge(b.createdAt))}</span>
            </div>
          </div>
        </div>
      `;
    }).join('');

    // Wire interactions.
    grid.querySelectorAll('.blossom-card').forEach(card => {
      card.addEventListener('click', (e) => {
        // Clicks on the checkbox itself shouldn't open the detail.
        if (e.target.closest('.blossom-card-check')) return;
        const sha = card.dataset.sha;
        const blob = state.blobs.find(b => b.sha256 === sha);
        if (blob) openDetail(blob);
      });
    });
    grid.querySelectorAll('.blossom-card-check input').forEach(cb => {
      cb.addEventListener('click', (e) => e.stopPropagation());
      cb.addEventListener('change', () => {
        const sha = cb.dataset.sha;
        if (cb.checked) state.selected.add(sha);
        else            state.selected.delete(sha);
        cb.closest('.blossom-card')?.classList.toggle('selected', cb.checked);
        renderBulkBar();
      });
    });

    // Pager.
    const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    pager.hidden = totalPages <= 1;
    $('blossom-page-label').textContent = `Page ${state.page + 1} of ${totalPages} (${filtered.length} matching)`;
    $('blossom-prev').disabled = state.page <= 0;
    $('blossom-next').disabled = state.page >= totalPages - 1;
  }

  function render() {
    if (!state.running) { renderOffState(); return; }
    renderStats();
    renderFilters();
    renderBulkBar();
    renderGrid();
  }

  // ── Detail overlay ─────────────────────────────────────────────────────

  function openDetail(blob) {
    const isImg = (blob.mime || '').startsWith('image/');
    const isVid = (blob.mime || '').startsWith('video/');
    const isAud = (blob.mime || '').startsWith('audio/');
    const url   = blobDirectUrl(blob.sha256);
    const preview = isImg ? `<img src="${escapeHtml(url)}" class="blossom-detail-img" alt="">`
                  : isVid ? `<video src="${escapeHtml(url)}" controls class="blossom-detail-media"></video>`
                  : isAud ? `<audio src="${escapeHtml(url)}" controls class="blossom-detail-audio"></audio>`
                  :         `<div class="blossom-detail-icon">${mimeIcon(blob.mime)}</div>`;

    const overlay = document.createElement('div');
    overlay.className = 'blossom-detail-overlay';
    overlay.innerHTML = `
      <div class="blossom-detail-card">
        <div class="blossom-detail-head">
          <div class="blossom-detail-title">Blob detail</div>
          <button class="blossom-detail-close" aria-label="Close">×</button>
        </div>
        <div class="blossom-detail-preview">${preview}</div>
        <div class="blossom-detail-meta">
          <div class="config-row"><div class="k">sha256</div><div class="v"><code>${escapeHtml(blob.sha256)}</code></div></div>
          <div class="config-row"><div class="k">mime</div><div class="v">${escapeHtml(blob.mime || '(unset)')}</div></div>
          <div class="config-row"><div class="k">size</div><div class="v">${escapeHtml(fmtBytes(blob.size))}</div></div>
          <div class="config-row"><div class="k">uploader</div><div class="v">
            <span class="blossom-kind-chip blossom-kind-${blob.uploaderKind}">${escapeHtml(blob.uploaderKind)}</span>
            <code style="margin-left:6px">${escapeHtml(blob.uploaderPubkey?.slice(0, 12) || '')}…</code>
          </div></div>
          <div class="config-row"><div class="k">uploaded</div><div class="v">${escapeHtml(new Date(blob.createdAt).toLocaleString())}</div></div>
          <div class="config-row"><div class="k">URL</div><div class="v"><a href="${escapeHtml(url)}" target="_blank" rel="noreferrer"><code>${escapeHtml(url)}</code></a></div></div>
        </div>
        <div class="blossom-detail-actions">
          <button class="blossom-detail-copy">Copy URL</button>
          <button class="danger blossom-detail-delete">Delete blob</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const close = () => { try { document.body.removeChild(overlay); } catch {} };
    overlay.querySelector('.blossom-detail-close').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
    });

    overlay.querySelector('.blossom-detail-copy').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(url); toast('URL copied', '', 'ok'); }
      catch { toast('Clipboard blocked', 'copy manually', 'warn'); }
    });
    overlay.querySelector('.blossom-detail-delete').addEventListener('click', async () => {
      const ok = await confirmDestructive({
        title: 'Delete this blob?',
        description: `sha256: ${blob.sha256.slice(0, 16)}…\n\nDeletes the file from disk and removes the index row. Apps that linked to this blob URL will 404.`,
        confirmLabel: 'Delete',
      });
      if (!ok) return;
      try {
        await deleteBlob(blob.sha256);
        toast('Blob deleted', '', 'ok');
        close();
        state.selected.delete(blob.sha256);
        await load();
      } catch (e) {
        toast('Delete failed', e?.message || '', 'err');
      }
    });
  }

  // ── Static button wiring ───────────────────────────────────────────────

  $('blossom-refresh')?.addEventListener('click', () => { apiInvalidate('/api/blossom-config'); load(); });
  $('blossom-wipe-all')?.addEventListener('click', async () => {
    if (!state.running) return;
    const ok = await confirmDestructive({
      title: 'Wipe all local blobs?',
      description: `Deletes ${state.stats?.blobCount || 0} blob(s) (${fmtBytes(state.stats?.totalBytes || 0)}). Cannot be undone.`,
      confirmLabel: 'Wipe',
    });
    if (!ok) return;
    try {
      await api('/api/blossom/wipe', { method: 'POST' });
      toast('All blobs wiped', '', 'ok');
      state.selected.clear();
      await load();
    } catch (e) {
      toast('Wipe failed', e?.message || '', 'err');
    }
  });
  $('blossom-prev')?.addEventListener('click', () => { if (state.page > 0) { state.page--; render(); } });
  $('blossom-next')?.addEventListener('click', () => {
    const filtered = applyFilter(state.blobs);
    const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    if (state.page < totalPages - 1) { state.page++; render(); }
  });
  $('blossom-bulk-clear')?.addEventListener('click', () => {
    state.selected.clear();
    render();
  });
  $('blossom-bulk-delete')?.addEventListener('click', async () => {
    if (state.selected.size === 0) return;
    const shas = [...state.selected];
    const ok = await confirmDestructive({
      title: `Delete ${shas.length} blob${shas.length === 1 ? '' : 's'}?`,
      description: `Removes the selected blob${shas.length === 1 ? '' : 's'} from the local store. Cannot be undone.`,
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    try {
      const r = await bulkDelete(shas);
      toast('Bulk delete', `${r.deletedCount}/${shas.length} removed`, r.deletedCount === shas.length ? 'ok' : 'warn');
      state.selected.clear();
      await load();
    } catch (e) {
      toast('Bulk delete failed', e?.message || '', 'err');
    }
  });

  return {
    onEnter() { load(); },
  };
})();

// ── Panel: Git ───────────────────────────────────────────────────────────

// ── Projects: shared helpers ─────────────────────────────────────────────

function fmtAgoMs(ms) {
  if (!ms) return '—';
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 1)  return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24)  return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ms).toLocaleDateString();
}

function fmtAgoIso(iso) {
  if (!iso) return '—';
  return fmtAgoMs(new Date(iso).getTime());
}

function projectCapBadges(caps) {
  const badges = [];
  if (caps.git)   badges.push(`<span class="cap-chip cap-git">git</span>`);
  if (caps.ngit)  badges.push(`<span class="cap-chip cap-ngit">ngit</span>`);
  if (caps.nsite) badges.push(`<span class="cap-chip cap-nsite">nsite</span>`);
  return badges.join('');
}

// Per-project active-env chip — dev (purple, brand) or prod (blue).
// Hidden for projects that haven't opted into the environment block
// yet, so legacy / cloned cards stay visually identical to their
// pre-feature state until the user clicks "Isolate to local infra"
// in Settings. Tooltip explicitly names the scope so the chip alone
// answers "what does this affect?" on hover.
const ENV_CHIP_TOOLTIPS = {
  dev:    'dev — spawned dev servers, deploy, and exec see NOSTR_STATION_RELAY pointing at the local in-process relay. Safe to publish test events. Client panel is independent of this.',
  prod:   'prod — spawned dev servers see public relays via NOSTR_STATION_RELAY. Promote publishes to real Nostr. Client panel is independent of this.',
  public: 'Public Nostr — this panel always reads + posts via your App Relays ∪ Your Relays (Config → Client Relays). Never bound to any project\'s dev/prod active-env.',
};
function projectEnvBadge(project) {
  const active = project.environment?.active;
  if (active !== 'dev' && active !== 'prod') return '';
  return `<span class="env-chip env-chip-${active}" title="${escapeHtml(ENV_CHIP_TOOLTIPS[active])}">${active}</span>`;
}

function projectIdentityLabel(project) {
  if (project.identity.useDefault) return 'station identity';
  const n = project.identity.npub;
  if (!n) return 'project identity';
  return truncNpub(n);
}

// ── Projects: drawer (add + edit wizards) ────────────────────────────────

const ProjectDrawer = (() => {
  const root  = $('project-drawer');
  const scrim = $('project-drawer-scrim');
  const body  = $('project-drawer-body');
  const title = $('project-drawer-title');

  let mode = 'add';               // 'add' | 'edit'
  let editTarget = null;          // project id in edit mode
  let draft = null;               // working copy
  let expanded = 1;               // 1..4 stepper
  let detect = null;              // last detect result
  let ownerNpub = null;           // station identity for "use default"
  let prefillNotice = null;       // {name, url} shown at top of the drawer when seeded from Discover

  function resetDraft() {
    draft = {
      name: '',
      path: '',
      noPath: false,
      capabilities: { git: false, ngit: false, nsite: false },
      identity: { useDefault: true, npub: '', bunkerUrl: '' },
      remotes: { github: '', ngit: '' },
      nsite: { url: '', lastDeploy: null },
    };
    expanded = 1;
    detect = null;
  }

  async function openAdd() {
    mode = 'add'; editTarget = null;
    title.textContent = 'Add project';
    resetDraft();
    prefillNotice = null;
    try { const cfg = await api('/api/identity/config'); ownerNpub = cfg.npub || null; } catch {}
    show();
    render();
  }

  // Used by the Discover flow — opens the Add drawer pre-seeded with a
  // repo name, capabilities, and remote URLs. Path stays blank so the
  // user can choose where to clone (or leave it empty for an ngit-only
  // project with no local checkout — a supported configuration).
  async function openAddPrefilled(seed) {
    mode = 'add'; editTarget = null;
    title.textContent = 'Add project';
    resetDraft();
    draft.name = seed.name || '';
    // Leave draft.path empty — the server owns clone-target construction
    // and returns the fully-resolved absolute path via the "resolvedPath"
    // info frame. Pre-filling with a "~"-prefixed string risks saving a
    // non-expanded path into projects.json when the user skips the clone
    // step. The "Clone this repo" action on Step 1 populates draft.path
    // with an absolute path once the clone succeeds.
    const nsiteCap = !!seed.capabilities?.nsite;
    const gitCap   = !!seed.capabilities?.git;
    const ngitCap  = !!seed.capabilities?.ngit;
    // nsite-only seeds skip the local-path step — nsite deployments don't
    // need a checkout. Git/ngit seeds still ask the user where to clone.
    const nsiteOnly = nsiteCap && !gitCap && !ngitCap;
    draft.noPath = nsiteOnly;
    draft.path = '';
    draft.capabilities = { git: gitCap, ngit: ngitCap, nsite: nsiteCap };
    draft.remotes = {
      github: seed.remotes?.github || '',
      ngit:   seed.remotes?.ngit   || '',
    };
    draft.nsite = {
      url:        seed.nsite?.url || '',
      lastDeploy: seed.nsite?.lastDeploy || null,
    };
    // Start on Step 1 so the user walks forward through the flow. Steps
    // 2–4 are already seeded — they just confirm and continue.
    expanded = 1;
    prefillNotice = {
      name: draft.name,
      url:  draft.nsite.url || draft.remotes.ngit || draft.remotes.github || '',
    };
    try { const cfg = await api('/api/identity/config'); ownerNpub = cfg.npub || null; } catch {}
    show();
    render();
  }

  function openEditFromProject(project) {
    mode = 'edit'; editTarget = project.id;
    prefillNotice = null;
    title.textContent = 'Edit project';
    draft = {
      name: project.name,
      path: project.path || '',
      noPath: !project.path,
      capabilities: { ...project.capabilities },
      identity: {
        useDefault: project.identity.useDefault,
        npub: project.identity.npub || '',
        bunkerUrl: project.identity.bunkerUrl || '',
      },
      remotes: { github: project.remotes.github || '', ngit: project.remotes.ngit || '' },
      nsite: { url: project.nsite.url || '', lastDeploy: project.nsite.lastDeploy || null },
    };
    expanded = 1;
    show();
    render();
  }

  function show() {
    root.classList.add('open');
    scrim.classList.add('open');
    root.setAttribute('aria-hidden', 'false');
  }
  function close() {
    root.classList.remove('open');
    scrim.classList.remove('open');
    root.setAttribute('aria-hidden', 'true');
  }

  scrim.addEventListener('click', close);
  $('project-drawer-close').addEventListener('click', close);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && root.classList.contains('open')) close();
  });

  function render() {
    body.innerHTML = '';
    if (prefillNotice) {
      const banner = document.createElement('div');
      banner.className = 'prefill-banner';
      banner.innerHTML = `
        <div class="prefill-head">
          <span class="prefill-label">Pre-filled from scanned ngit repo</span>
          <button class="prefill-dismiss" type="button" title="Clear pre-fill">×</button>
        </div>
        <div class="prefill-body">
          <div class="prefill-name">${escapeHtml(prefillNotice.name || '(unnamed)')}</div>
          ${prefillNotice.url ? `<div class="prefill-url"><code>${escapeHtml(prefillNotice.url)}</code></div>` : ''}
          <div class="prefill-hint muted">
            Capabilities and remote URL are seeded — pick a local clone path on Step 1 (or check "No local path" to add without cloning).
          </div>
        </div>
      `;
      banner.querySelector('.prefill-dismiss').addEventListener('click', () => {
        prefillNotice = null;
        render();
      });
      body.appendChild(banner);
    }
    body.appendChild(stepEl(1, 'Path',         renderStep1()));
    body.appendChild(stepEl(2, 'Capabilities', renderStep2()));
    body.appendChild(stepEl(3, 'Identity',     renderStep3()));
    body.appendChild(stepEl(4, 'Name',         renderStep4()));
  }

  function stepEl(n, label, contentEl) {
    const wrap = document.createElement('div');
    wrap.className = 'stepper-step' + (n === expanded ? ' active' : (n < expanded ? ' done' : ''));
    wrap.innerHTML = `
      <div class="step-head">
        <span class="step-num">${n}</span>
        <span class="step-label">${escapeHtml(label)}</span>
        <span class="step-summary" data-step-summary></span>
        <button class="step-edit" style="display:none">edit</button>
      </div>
    `;
    const head = wrap.querySelector('.step-head');
    const content = document.createElement('div');
    content.className = 'step-content';
    content.appendChild(contentEl);
    wrap.appendChild(content);

    const editBtn = wrap.querySelector('.step-edit');
    const summaryEl = wrap.querySelector('[data-step-summary]');

    if (n < expanded) {
      editBtn.style.display = '';
      editBtn.addEventListener('click', () => { expanded = n; render(); });
      summaryEl.innerHTML = stepSummary(n);
    } else {
      summaryEl.textContent = '';
    }
    if (n !== expanded) content.style.display = 'none';
    return wrap;
  }

  function stepSummary(n) {
    if (n === 1) {
      if (draft.noPath) return '<em>No local path (nsite-only)</em>';
      return `<code>${escapeHtml(draft.path || '—')}</code>`;
    }
    if (n === 2) return projectCapBadges(draft.capabilities) || '<em class="muted">none</em>';
    if (n === 3) return draft.identity.useDefault
      ? 'Station identity'
      : `Project: <code>${escapeHtml(truncNpub(draft.identity.npub))}</code>`;
    if (n === 4) return escapeHtml(draft.name || '—');
    return '';
  }

  // Shared Clone action used by the top-level Clone block and the
  // in-detect-box fallback. Sends { url, repoName } — the server owns
  // path construction (path.join(HOME, 'projects', repoName)) and
  // returns the absolute clone target via the "resolvedPath" info
  // frame. After success we detect + re-render so Step 1 shows the
  // real absolute path and downstream steps pick up detected caps.
  async function runCloneThenDetect(ngitRemote, repoName) {
    if (!ngitRemote || !repoName) {
      toast('Missing clone metadata', 'No naddr or repo name on the draft', 'err');
      return;
    }
    const r = await openExecModal({
      title: `Clone · ${repoName}`,
      subtitle: `git clone ${ngitRemote} ~/projects/${repoName}`,
      endpoint: '/api/ngit/clone',
      body: { url: ngitRemote, repoName },
    });
    if (!r.ok) {
      toast('Clone failed', `exit ${r.code} — see modal`, 'err');
      return;
    }
    const resolved = r.info?.resolvedPath || '';
    if (!resolved) {
      toast('Clone finished', 'Server did not return a resolved path', 'warn');
      return;
    }
    toast('Clone complete', resolved, 'ok');
    try {
      const d = await api('/api/projects/detect', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: resolved }),
      });
      detect = d;
      draft.path = resolved;
      if (d.exists && d.isGitRepo) {
        draft.capabilities.git = true;
        if (d.githubRemote) draft.remotes.github = d.githubRemote;
        if (d.ngitRemote)   { draft.capabilities.ngit = true; draft.remotes.ngit = d.ngitRemote; }
        if (d.hasNsyte)     draft.capabilities.nsite = true;
      }
      if (d.suggestedName && !draft.name) draft.name = d.suggestedName;
    } catch {}
    render();
  }

  function renderStep1() {
    const el = document.createElement('div');
    // When the drawer was seeded from Scan ngit and the user hasn't
    // cloned yet (draft.path empty), surface a dedicated "Clone this
    // repo" action at the top of the step. The server constructs the
    // target path as ~/projects/<repoName> via path.join(HOME, …) and
    // returns the absolute target via the info frame — no "~" ever
    // flows through the client.
    const ngitRemote = draft.remotes.ngit || '';
    const canClone   = !!prefillNotice
      && draft.capabilities.ngit
      && !draft.path
      && (ngitRemote.startsWith('naddr1') || ngitRemote.startsWith('nostr://'));
    const cloneBlock = canClone ? `
      <div class="clone-ready">
        <div class="clone-ready-title">Clone <b>${escapeHtml(draft.name || 'this repo')}</b> to your machine</div>
        <div class="muted" style="font-size:11px;margin-top:4px">
          Will run <code>git clone ${escapeHtml(ngitRemote)} ~/projects/${escapeHtml(draft.name || 'repo')}</code>
          (expanded to an absolute path server-side).
        </div>
        <div class="step-actions" style="margin-top:10px">
          <button class="primary clone-repo-btn">Clone this repo</button>
        </div>
      </div>
    ` : '';
    el.innerHTML = `
      ${cloneBlock}
      <label class="field-label">Local path</label>
      <div class="field-row">
        <input type="text" class="path-input" placeholder="/Users/you/projects/my-project" value="${escapeHtml(draft.path)}" ${draft.noPath ? 'disabled' : ''}>
        <button type="button" class="paste-btn">paste</button>
      </div>
      <label class="checkbox-row">
        <input type="checkbox" class="no-path-cb" ${draft.noPath ? 'checked' : ''}>
        No local path (nsite-only)
      </label>
      <div class="detect-box"></div>
      <div class="step-actions">
        <button class="primary next-btn">Continue</button>
      </div>
    `;
    const input = el.querySelector('.path-input');
    const noPathCb = el.querySelector('.no-path-cb');
    const detectBox = el.querySelector('.detect-box');
    const nextBtn = el.querySelector('.next-btn');

    // Wire the top-level Clone block (visible only when seeded + empty path).
    const cloneRepoBtn = el.querySelector('.clone-repo-btn');
    if (cloneRepoBtn) {
      cloneRepoBtn.addEventListener('click', () => runCloneThenDetect(ngitRemote, draft.name));
    }

    const runDetect = async () => {
      const p = input.value.trim();
      // Capture the path immediately so Continue works regardless of what
      // detection reports — the user may be typing a clone target that
      // doesn't exist yet. The server-side save validates existence too
      // where it matters; the drawer's job is to record intent.
      draft.path = p;
      if (!p) { detectBox.innerHTML = ''; return; }
      detectBox.innerHTML = '<div class="detect-pending">detecting…</div>';
      try {
        const r = await api('/api/projects/detect', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: p }),
        });
        detect = r;
        if (!r.exists) {
          // Non-existent path is a valid state when the user is adding a
          // scanned ngit repo they haven't cloned yet. Show a neutral info
          // message instead of a hard error — Continue stays enabled and
          // the pre-seeded caps/remote are preserved. If we have an ngit
          // naddr/nostr:// remote on hand (typical after a Discover pre-
          // fill), offer an inline "Clone here" button that streams the
          // clone into this exact path and re-runs detect on success.
          const seeded = prefillNotice || draft.capabilities.ngit || draft.capabilities.git;
          const ngitRemote = draft.remotes.ngit || '';
          const canClone = draft.capabilities.ngit
            && (ngitRemote.startsWith('naddr1') || ngitRemote.startsWith('nostr://'));
          if (seeded) {
            detectBox.innerHTML = `
              <div class="detect neutral">
                <div>Path doesn't exist yet — it will be created when the repo is cloned.</div>
                ${canClone
                  ? `<div class="detect-actions" style="margin-top:8px">
                       <button class="primary clone-here-btn">Clone here</button>
                       <span class="muted" style="font-size:11px;margin-left:8px">Streams <code>git clone ${escapeHtml(ngitRemote)} ${escapeHtml(p)}</code></span>
                     </div>`
                  : `<div class="muted" style="font-size:11px;margin-top:4px">You can clone manually in a terminal, then re-enter the path.</div>`}
              </div>`;
            const cloneBtn = detectBox.querySelector('.clone-here-btn');
            if (cloneBtn) {
              cloneBtn.addEventListener('click', () => runCloneThenDetect(ngitRemote, draft.name));
            }
          } else {
            detectBox.innerHTML = '<div class="detect err">Path not found</div>';
          }
          return;
        }
        if (draft.name === '' && r.suggestedName) draft.name = r.suggestedName;
        if (r.isGitRepo) {
          draft.capabilities.git = true;
          if (r.githubRemote) draft.remotes.github = r.githubRemote;
          if (r.ngitRemote)   { draft.capabilities.ngit = true; draft.remotes.ngit = r.ngitRemote; }
          const bits = [];
          bits.push('<span class="ok">Git repo detected</span>');
          if (r.githubRemote) bits.push(`<span>GitHub: <code>${escapeHtml(r.githubRemote)}</code></span>`);
          if (r.ngitRemote)   bits.push(`<span>ngit: <code>${escapeHtml(r.ngitRemote)}</code></span>`);
          if (r.hasNsyte)     { draft.capabilities.nsite = true; bits.push('<span>nsyte config found</span>'); }
          detectBox.innerHTML = `<div class="detect ok">${bits.join(' · ')}</div>`;
        } else {
          if (r.hasNsyte) draft.capabilities.nsite = true;
          detectBox.innerHTML = `<div class="detect neutral">Not a git repo — configure as nsite-only or ngit-init later${r.hasNsyte ? ' · nsyte config found' : ''}</div>`;
        }
      } catch (e) {
        detectBox.innerHTML = `<div class="detect err">${escapeHtml(e.message)}</div>`;
      }
    };
    input.addEventListener('blur', runDetect);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); runDetect(); } });

    el.querySelector('.paste-btn').addEventListener('click', async () => {
      try {
        const t = (await navigator.clipboard.readText()).trim();
        input.value = t;
        runDetect();
      } catch { toast('Clipboard blocked', 'paste manually', 'warn'); }
    });

    noPathCb.addEventListener('change', () => {
      draft.noPath = noPathCb.checked;
      if (draft.noPath) {
        input.value = ''; input.disabled = true;
        draft.path = '';
        draft.capabilities.git = false; draft.capabilities.ngit = false;
        draft.capabilities.nsite = true;
        detectBox.innerHTML = '';
      } else {
        input.disabled = false;
      }
    });

    nextBtn.addEventListener('click', () => {
      if (!draft.noPath && !draft.path.trim()) { toast('Enter a path', 'or check "No local path"', 'warn'); return; }
      if (draft.noPath) { draft.capabilities.nsite = true; }
      expanded = 2; render();
    });
    return el;
  }

  function renderStep2() {
    const el = document.createElement('div');
    const gitDisabled = draft.noPath ? 'disabled' : '';
    const ngitDisabled = draft.noPath ? 'disabled' : '';
    el.innerHTML = `
      <div class="cap-row">
        <label class="cap-toggle">
          <input type="checkbox" class="cap-git" ${draft.capabilities.git ? 'checked' : ''} ${gitDisabled}>
          <div class="cap-body">
            <div class="cap-title"><span class="cap-chip cap-git">git</span> GitHub / origin</div>
            <div class="cap-sub">Standard git remote — pushes via <code>git push</code> or <code>nostr-station publish</code>.</div>
          </div>
        </label>
        <div class="cap-detail git-detail" style="${draft.capabilities.git ? '' : 'display:none'}">
          <label class="field-label">GitHub remote URL</label>
          <input type="text" class="github-remote" placeholder="https://github.com/you/repo" value="${escapeHtml(draft.remotes.github)}">
        </div>
      </div>
      <div class="cap-row">
        <label class="cap-toggle">
          <input type="checkbox" class="cap-ngit" ${draft.capabilities.ngit ? 'checked' : ''} ${ngitDisabled}>
          <div class="cap-body">
            <div class="cap-title"><span class="cap-chip cap-ngit">ngit</span> Nostr-native repo</div>
            <div class="cap-sub">Pushes git events through a nostr relay. Amber signs on your phone.</div>
          </div>
        </label>
        <div class="cap-detail ngit-detail" style="${draft.capabilities.ngit ? '' : 'display:none'}">
          <label class="field-label">ngit remote URL</label>
          <input type="text" class="ngit-remote" placeholder="nostr://…" value="${escapeHtml(draft.remotes.ngit)}">
          <div class="muted">Signing uses this project's identity (configured in step 3).</div>
        </div>
      </div>
      <div class="cap-row">
        <label class="cap-toggle">
          <input type="checkbox" class="cap-nsite" ${draft.capabilities.nsite ? 'checked' : ''}>
          <div class="cap-body">
            <div class="cap-title"><span class="cap-chip cap-nsite">nsite</span> Published site</div>
            <div class="cap-sub">Deploy a static site via nsyte. Optional, can be filled in later.</div>
          </div>
        </label>
        <div class="cap-detail nsite-detail" style="${draft.capabilities.nsite ? '' : 'display:none'}">
          <label class="field-label">nsite URL <span class="muted">(optional)</span></label>
          <input type="text" class="nsite-url" placeholder="https://mysite.nsite.pub" value="${escapeHtml(draft.nsite.url)}">
        </div>
      </div>
      <div class="cap-error"></div>
      <div class="step-actions">
        <button class="primary next-btn">Continue</button>
      </div>
    `;
    const wire = (cbCls, capKey, detailCls) => {
      const cb = el.querySelector(cbCls);
      const detail = el.querySelector(detailCls);
      cb.addEventListener('change', () => {
        draft.capabilities[capKey] = cb.checked;
        detail.style.display = cb.checked ? '' : 'none';
      });
    };
    wire('.cap-git',   'git',   '.git-detail');
    wire('.cap-ngit',  'ngit',  '.ngit-detail');
    wire('.cap-nsite', 'nsite', '.nsite-detail');

    el.querySelector('.github-remote').addEventListener('input', (e) => { draft.remotes.github = e.target.value.trim(); });
    el.querySelector('.ngit-remote').addEventListener('input',   (e) => { draft.remotes.ngit   = e.target.value.trim(); });
    el.querySelector('.nsite-url').addEventListener('input',     (e) => { draft.nsite.url      = e.target.value.trim(); });

    el.querySelector('.next-btn').addEventListener('click', () => {
      const errEl = el.querySelector('.cap-error');
      const caps = draft.capabilities;
      if (!caps.git && !caps.ngit && !caps.nsite) {
        errEl.textContent = 'Enable at least one capability';
        errEl.className = 'cap-error err';
        return;
      }
      errEl.textContent = '';
      expanded = 3; render();
    });
    return el;
  }

  function renderStep3() {
    const el = document.createElement('div');
    const ownerDisplay = ownerNpub ? truncNpub(ownerNpub) : '(not configured)';
    el.innerHTML = `
      <label class="radio-row">
        <input type="radio" name="ident-mode" value="default" ${draft.identity.useDefault ? 'checked' : ''}>
        <div>
          <div class="radio-title">Use station identity</div>
          <div class="radio-sub">${escapeHtml(ownerDisplay)} · uses your station owner identity for all signing.</div>
        </div>
      </label>
      <label class="radio-row">
        <input type="radio" name="ident-mode" value="project" ${draft.identity.useDefault ? '' : 'checked'}>
        <div>
          <div class="radio-title">Project-specific identity</div>
          <div class="radio-sub">Isolates this project's signing. Recommended for brands, shops, or client projects.</div>
        </div>
      </label>
      <div class="project-ident-fields" style="${draft.identity.useDefault ? 'display:none' : ''}">
        <label class="field-label">npub</label>
        <input type="text" class="ident-npub" placeholder="npub1… or 64-char hex" value="${escapeHtml(draft.identity.npub)}">
        <div class="ident-npub-err err"></div>
        <label class="field-label">Bunker URL <span class="muted">(optional)</span></label>
        <input type="text" class="ident-bunker" placeholder="bunker://…" value="${escapeHtml(draft.identity.bunkerUrl)}">
        <div class="muted">Amber will prompt on first signing operation if left empty.</div>
      </div>
      <div class="step-actions">
        <button class="primary next-btn">Continue</button>
      </div>
    `;
    const fieldsEl = el.querySelector('.project-ident-fields');
    el.querySelectorAll('input[name="ident-mode"]').forEach(r => {
      r.addEventListener('change', () => {
        draft.identity.useDefault = (r.value === 'default');
        fieldsEl.style.display = draft.identity.useDefault ? 'none' : '';
      });
    });
    const npubInput = el.querySelector('.ident-npub');
    const npubErr = el.querySelector('.ident-npub-err');
    npubInput.addEventListener('input', () => {
      const v = npubInput.value.trim();
      draft.identity.npub = v;
      npubErr.textContent = '';
      if (v && v.startsWith('nsec')) {
        npubErr.textContent = 'nsec detected — nostr-station never stores private keys';
      }
    });
    el.querySelector('.ident-bunker').addEventListener('input', (e) => { draft.identity.bunkerUrl = e.target.value.trim(); });

    el.querySelector('.next-btn').addEventListener('click', () => {
      if (!draft.identity.useDefault) {
        const v = draft.identity.npub;
        if (!v) { npubErr.textContent = 'npub required'; return; }
        if (v.startsWith('nsec')) { npubErr.textContent = 'nsec detected — nostr-station never stores private keys'; return; }
        const valid = /^npub1[a-z0-9]{58,}$/.test(v) || /^[0-9a-f]{64}$/.test(v);
        if (!valid) { npubErr.textContent = 'must be bech32 npub or 64-char hex'; return; }
        if (draft.identity.bunkerUrl && !/^bunker:\/\//i.test(draft.identity.bunkerUrl)) {
          npubErr.textContent = 'bunker URL must start with bunker://';
          return;
        }
      }
      expanded = 4; render();
    });
    return el;
  }

  function renderStep4() {
    const el = document.createElement('div');
    el.innerHTML = `
      <label class="field-label">Name</label>
      <input type="text" class="name-input" maxlength="64" value="${escapeHtml(draft.name)}" placeholder="my-project">

      <div class="summary-card">
        <div class="summary-row"><span class="k">Capabilities</span><span class="v summary-caps">${projectCapBadges(draft.capabilities) || '<em class="muted">none</em>'}</span></div>
        <div class="summary-row"><span class="k">Identity</span><span class="v">${draft.identity.useDefault ? 'Station identity' : `Project: ${escapeHtml(truncNpub(draft.identity.npub))}`}</span></div>
        <div class="summary-row"><span class="k">Path</span><span class="v">${draft.noPath ? '<em>nsite-only (no path)</em>' : `<code>${escapeHtml(draft.path || '—')}</code>`}</span></div>
      </div>

      <div class="step-actions">
        <button class="primary save-btn">${mode === 'edit' ? 'Save changes' : 'Add project'}</button>
      </div>
    `;
    const nameInput = el.querySelector('.name-input');
    nameInput.addEventListener('input', () => { draft.name = nameInput.value; });
    el.querySelector('.save-btn').addEventListener('click', save);
    return el;
  }

  async function save() {
    if (!draft.name.trim()) { toast('Name required', '', 'warn'); return; }
    const payload = {
      name: draft.name.trim(),
      path: draft.noPath ? null : (draft.path.trim() || null),
      capabilities: { ...draft.capabilities },
      identity: {
        useDefault: draft.identity.useDefault,
        npub: draft.identity.useDefault ? null : (draft.identity.npub || null),
        bunkerUrl: draft.identity.useDefault ? null : (draft.identity.bunkerUrl || null),
      },
      remotes: {
        github: draft.capabilities.git  ? (draft.remotes.github || null) : null,
        ngit:   draft.capabilities.ngit ? (draft.remotes.ngit   || null) : null,
      },
      nsite: {
        url: draft.capabilities.nsite ? (draft.nsite.url || null) : null,
        lastDeploy: draft.nsite.lastDeploy || null,
      },
    };
    try {
      if (mode === 'edit') {
        await api(`/api/projects/${editTarget}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        toast('Project updated', payload.name, 'ok');
      } else {
        await api('/api/projects', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        toast('Project added', payload.name, 'ok');
      }
      close();
      ProjectsPanel.reload();
    } catch (e) {
      // api() already toasted.
    }
  }

  return { openAdd, openAddPrefilled, openEditFromProject, close };
})();

// ── Projects panel ───────────────────────────────────────────────────────

const ProjectsPanel = (() => {
  const body       = $('projects-body');
  const headActions = $('projects-head-actions');
  const title      = $('projects-title');
  const subtitle   = $('projects-subtitle');

  // View state persists across onEnter so back/refresh keeps users in place.
  let state = { view: 'list', projectId: null, tab: 'overview' };
  let projects = [];
  let projectStatus = null;    // cached git/status for current detail
  let projectGitLog = null;

  // Resolved terminal-native AI (claude-code / opencode) from ai-config.
  // null when defaults.terminal isn't set OR the configured provider isn't
  // in our terminal.ts key map. Drives the "Open in …" button visibility
  // on cards + the detail view, and the "Set up a terminal AI" callout
  // at panel head when nothing's configured.
  let terminalAi = null;

  // Map from ai-providers.ts registry id → terminal.ts resolver key.
  // Update when a new terminal-native provider is added to the registry.
  const TERMINAL_AI_KEY = {
    'claude-code': 'claude',
    'opencode':    'opencode',
  };

  async function loadTerminalAi() {
    try {
      const list = await api('/api/ai/providers');
      const id = list?.defaults?.terminal;
      const entry = id ? list.providers.find(p => p.id === id) : null;
      if (entry && entry.configured && TERMINAL_AI_KEY[entry.id]) {
        terminalAi = {
          id:          entry.id,
          displayName: entry.displayName,
          key:         TERMINAL_AI_KEY[entry.id],
        };
      } else {
        terminalAi = null;
      }
    } catch {
      terminalAi = null;
    }
  }

  async function reload() {
    try {
      // Run in parallel — both are independent + we render once at the end.
      const [ps] = await Promise.all([
        api('/api/projects').catch(() => []),
        loadTerminalAi(),
      ]);
      projects = Array.isArray(ps) ? ps : [];
    } catch {
      projects = [];
    }
    // Publish the cache so other modules (ChatPanel, NavSessions, ngit
    // remote helpers) can read project metadata without a re-fetch, and
    // drop chat sessions whose project no longer exists.
    window.__projectsCache = projects;
    try { SessionStore.gcAgainstProjects(projects.map(p => p.id)); } catch {}
    render();
    // Kick off git-state polling now that cards are in the DOM. The
    // helper is idempotent — repeat reloads (Add Project, capability
    // toggle) replace the existing interval rather than stacking.
    startGitStatePolling();
  }

  function onEnter() { reload(); }

  // Re-resolve the terminal AI when Config panel changes providers /
  // defaults. Cards + detail view re-render so the "Open in …" button
  // label or callout flips immediately.
  document.addEventListener('api-config-changed', async () => {
    await loadTerminalAi();
    if (state.view === 'list' || state.view === 'detail') render();
  });

  // bootDashboard() activates the panel BEFORE NSTerminal.init() resolves,
  // so the first render gates Stacks Dork/dev + Open in <terminalAi>
  // buttons on isAvailable() === false. When init finishes, repaint so
  // those buttons appear without the user needing to switch tabs.
  document.addEventListener('terminal-available', () => {
    if (state.view === 'list' || state.view === 'detail') render();
  });

  // ── git-state badge polling (Item 3) ───────────────────────────────────
  //
  // Each card carries a `.pc-state` pill that renders the GitState label
  // returned by GET /api/projects/:id/git-state. Polling rules:
  //
  //   - On reload() success: fire one round immediately so cards show
  //     state on first paint instead of "(blank → 30 s later → label)".
  //   - Every 30 s thereafter while the panel is mounted.
  //   - On `visibilitychange` → 'visible' so a tab-switch refresh happens
  //     even between interval ticks. We never fetch while hidden.
  //   - In-flight dedup per project — if a fetch is still pending when
  //     the next tick arrives, that project is skipped this cycle.
  //   - Local-only projects skip the fetch entirely (no remote story
  //     to render — the brief explicitly says no badge for local-only).
  //   - Path-missing projects skip too (no repo to query). The existing
  //     red `pathMissing` border is the actionable signal there.
  //
  // No CSP / WS surface change — pure REST polling against the new
  // sync endpoint. 30 s × N projects is comfortably below any rate
  // anyone would care about; the dedup keeps a slow `git fetch` from
  // stacking calls.
  const inFlightGitState = new Set();
  let gitStateInterval = null;
  let visibilityHookInstalled = false;
  const stateClassFor = (gs) => {
    // Backend-aware: local-only projects always render no badge, so we
    // never get here for them. The label string drives the colour
    // class — match the brief's mapping verbatim:
    //   up to date → muted, dirty → amber, ahead/behind → blue,
    //   diverged → red. We key on the GitState boolean fields so the
    //   class doesn't drift with future label string tweaks.
    if (gs.dirty)              return 'pcs-dirty';
    if (gs.diverged)           return 'pcs-diverged';
    if (gs.ahead || gs.behind) return 'pcs-ahead-behind';
    return 'pcs-up-to-date';
  };
  async function pollGitStateOne(projectId) {
    if (inFlightGitState.has(projectId)) return;
    inFlightGitState.add(projectId);
    try {
      const gs = await api(`/api/projects/${projectId}/git-state`);
      if (!gs) return;
      const cardEl = body.querySelector(`.project-card[data-id="${projectId}"] .pc-state`);
      if (!cardEl) return;  // user navigated away mid-fetch
      if (gs.backend === 'local-only') {
        cardEl.hidden = true;
        cardEl.textContent = '';
        return;
      }
      cardEl.hidden = false;
      cardEl.textContent = gs.label;
      cardEl.title = `${gs.branch || 'no branch'} · ${gs.label}`;
      cardEl.className = `pc-state ${stateClassFor(gs)}`;
    } catch {
      // Endpoint failed — silent. The badge stays in whatever state
      // the previous successful poll left it in. A persistent failure
      // surfaces via the existing red pathMissing pill if relevant.
    } finally {
      inFlightGitState.delete(projectId);
    }
  }
  function pollGitStateAll() {
    if (state.view !== 'list') return;  // detail view doesn't show cards
    if (document.visibilityState !== 'visible') return;
    for (const p of projects) {
      if (!p.path || p.pathMissing) continue;
      pollGitStateOne(p.id);
    }
  }
  function startGitStatePolling() {
    // First fire happens after render; wait one tick so the card DOM
    // exists by the time the fetch resolves and we go to write into it.
    setTimeout(pollGitStateAll, 0);
    if (gitStateInterval !== null) clearInterval(gitStateInterval);
    gitStateInterval = setInterval(pollGitStateAll, 30_000);
    if (!visibilityHookInstalled) {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') pollGitStateAll();
      });
      visibilityHookInstalled = true;
    }
  }

  function render() {
    if (state.view === 'detail') renderDetail();
    else renderList();
  }

  function renderList() {
    title.textContent = 'Projects';
    subtitle.textContent = 'Your Nostr development projects';
    headActions.innerHTML = '';
    const addBtn = document.createElement('button');
    addBtn.className = 'primary';
    addBtn.textContent = '+ Add project';
    addBtn.title = 'New local, adopt existing, or import from a repository';
    addBtn.addEventListener('click', () => openAddProjectChooserModal());
    headActions.appendChild(addBtn);

    if (projects.length === 0) {
      body.innerHTML = `
        <div class="projects-empty">
          <img class="empty-art" src="/nori.svg" alt="">
          <div class="big">No projects yet</div>
          <div class="hint">Add your first project to manage git, ngit, and nsite from one place.</div>
          <button class="primary empty-add">Add project</button>
        </div>
      `;
      body.querySelector('.empty-add').addEventListener('click', () => openAddProjectChooserModal());
      return;
    }

    // Panel-level callout when no terminal-native AI is configured but at
    // least one project has a local path — otherwise the "Open in AI"
    // buttons would silently be absent and the user wouldn't know where
    // to set it up. Points to Config → AI Providers.
    const hasLocalPath = projects.some(p => p.path);
    const calloutHtml = (!terminalAi && hasLocalPath && window.NSTerminal?.isAvailable?.())
      ? `<div class="callout" style="margin-bottom:12px">
           No terminal AI configured — "Open in …" is hidden on project cards.
           <a href="#config">Set one up in Config</a> (Claude Code or OpenCode).
         </div>`
      : '';
    body.innerHTML = `${calloutHtml}<div class="project-grid"></div>`;
    const grid = body.querySelector('.project-grid');
    for (const p of projects) grid.appendChild(renderProjectCard(p));
  }

  function projectCardState(p) {
    // Red = path-missing (server sets `pathMissing` when the recorded
    // path doesn't exist on disk anymore — dir deleted externally,
    // failed scaffold mid-flight, etc.). User needs to either Remove
    // the orphan registration or restore the dir.
    //
    // Yellow = incomplete config worth a nudge. Local-only projects
    // (no capabilities, no remotes) are intentional and get default
    // styling; only "enabled ngit but missing naddr URL" triggers warn.
    if (p.pathMissing) return 'err';
    if (p.capabilities.ngit && !p.remotes.ngit) return 'warn';
    return '';
  }

  function renderProjectCard(p) {
    const card = document.createElement('div');
    const st = projectCardState(p);
    card.className = 'project-card' + (st ? ' ' + st : '');
    card.dataset.id = p.id;

    const lastAct = p.nsite?.lastDeploy
      ? `deployed ${fmtAgoIso(p.nsite.lastDeploy)}`
      : '—';

    card.innerHTML = `
      <div class="pc-head">
        <div class="pc-name">${escapeHtml(p.name || '(unnamed)')}</div>
        <div class="pc-actions"></div>
      </div>
      <div class="pc-path">${p.path ? `<code>${escapeHtml(p.path)}</code>` : '<em class="muted">no local path</em>'}</div>
      <div class="pc-badges">${projectCapBadges(p.capabilities)}${projectEnvBadge(p)}<span class="pc-state" hidden></span></div>
      <div class="pc-meta">
        <div class="pc-meta-row"><span class="k">identity</span><span class="v">${escapeHtml(projectIdentityLabel(p))}</span></div>
        <div class="pc-meta-row"><span class="k">last activity</span><span class="v pc-last-activity">${lastAct}</span></div>
      </div>
      <div class="pc-banner" hidden></div>
    `;

    // Quick action icons
    const actionsEl = card.querySelector('.pc-actions');
    const chatBtn = iconBtn('chat', 'Open in chat',
      `<svg viewBox="0 0 24 24"><path d="M21 12a8 8 0 0 1-8 8H5l-2 2V12a8 8 0 1 1 18 0Z" stroke-linejoin="round"/></svg>`);
    chatBtn.addEventListener('click', (e) => { e.stopPropagation(); openInChat(p); });
    actionsEl.appendChild(chatBtn);

    // "Open in <Terminal AI>" — spawns the configured terminal-native
    // provider (Claude Code, OpenCode, …) in a terminal tab with cwd
    // scoped to the project path. Hidden when:
    //   - no local path (nothing to cd into)
    //   - node-pty unavailable (terminal panel won't render)
    //   - no terminal-native provider configured (ai-config.defaults.terminal)
    // The panel-level callout (see renderList) covers the "how do I set
    // this up?" question when the button is hidden.
    if (p.path && window.NSTerminal?.isAvailable?.() && terminalAi) {
      const btn = iconBtn(terminalAi.id, `Open in ${terminalAi.displayName}`,
        `<svg viewBox="0 0 24 24"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>`);
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        window.NSTerminal.open(terminalAi.key, { projectId: p.id });
      });
      actionsEl.appendChild(btn);
    }

    // Sync (Item 4) — git fetch + ff-only merge for git, ngit fetch +
    // proposals query for ngit. Hidden on local-only cards (no remote
    // story). Inline result lands in `.pc-banner` so the user sees the
    // outcome without a modal hop.
    if (p.path && (p.capabilities.git || p.capabilities.ngit)) {
      const syncBtn = iconBtn('sync', 'Sync',
        `<svg viewBox="0 0 24 24"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>`);
      syncBtn.classList.add('pc-sync-btn');
      syncBtn.addEventListener('click', (e) => { e.stopPropagation(); runProjectSync(p, card, syncBtn); });
      actionsEl.appendChild(syncBtn);
    }

    // Save snapshot (Item 4) — local commit primitive. Available on all
    // backends with a local path (every project is a git repo locally,
    // including ngit and nsite-only repos that opted into a path).
    if (p.path) {
      const snapBtn = iconBtn('snapshot', 'Save snapshot',
        `<svg viewBox="0 0 24 24"><path d="M21 19V8l-3-4H6L3 8v11a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2z"/><circle cx="12" cy="14" r="3"/></svg>`);
      snapBtn.classList.add('pc-snap-btn');
      snapBtn.addEventListener('click', (e) => { e.stopPropagation(); openSnapshotDialog(p, card); });
      actionsEl.appendChild(snapBtn);
    }

    // Push lives on the project drawer's git/ngit tabs (Publish-to-ngit
    // / Push triad), where the verbs and dialog copy are explicit.
    // Pre-fix this card-grid icon duplicated the same action with a
    // generic up-arrow + "Publish" tooltip — for ngit-only projects
    // it actually ran ngit push, label-vs-action mismatch noted in
    // the PR #5 followup. Removing it eliminates the duplication;
    // sync/snapshot stay because one-click refresh + commit still
    // benefit from grid-level access.
    if (p.capabilities.nsite) {
      const deployBtn = iconBtn('deploy', 'Deploy',
        `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M2 12h20M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/></svg>`);
      deployBtn.addEventListener('click', (e) => { e.stopPropagation(); runProjectDeploy(p); });
      actionsEl.appendChild(deployBtn);
    }

    // Stacks/MKStack-specific actions — Dork agent, Vite dev server,
    // NostrDeploy publish. Only shown when the project has a stack.json
    // (server-derived `stacksProject` flag). Each spawns into the
    // terminal panel except deploy, which uses the streaming exec
    // modal so the success URL stays visible after the run completes.
    if (p.stacksProject && p.path && window.NSTerminal?.isAvailable?.()) {
      const dorkBtn = iconBtn('dork', 'Open in Dork (Stacks agent)',
        `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2"/></svg>`);
      dorkBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        window.NSTerminal.open('stacks-agent', { projectId: p.id });
      });
      actionsEl.appendChild(dorkBtn);

      const devBtn = iconBtn('stacks-dev', 'Run dev server (localhost:5173)',
        `<svg viewBox="0 0 24 24"><polygon points="6 4 20 12 6 20 6 4"/></svg>`);
      devBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        window.NSTerminal.open('stacks-dev', { projectId: p.id });
      });
      actionsEl.appendChild(devBtn);
    }
    if (p.stacksProject && p.path) {
      const stacksDeployBtn = iconBtn('stacks-deploy', 'Deploy to NostrDeploy',
        `<svg viewBox="0 0 24 24"><path d="M4 12l8-8 8 8M12 4v16"/></svg>`);
      stacksDeployBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        runStacksDeploy(p);
      });
      actionsEl.appendChild(stacksDeployBtn);
    }

    card.addEventListener('click', () => openDetail(p.id));

    // Fetch git activity async for git-capable projects to fill in "last commit"
    if (p.capabilities.git && p.path) {
      api(`/api/projects/${p.id}/git/status`).then(st => {
        if (st && st.timestamp) {
          card.querySelector('.pc-last-activity').textContent = `commit ${fmtAgoMs(st.timestamp)}`;
        } else if (st && st.error) {
          card.classList.add('err');
        }
      }).catch(() => {});
    }
    return card;
  }

  function iconBtn(kind, label, svg) {
    const btn = document.createElement('button');
    btn.className = 'pc-icon-btn';
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.innerHTML = svg;
    return btn;
  }

  // ── Sync + snapshot (Item 4) ──────────────────────────────────────────
  //
  // The card banner is the inline output surface for both flows. It
  // sits below `.pc-meta` and is hidden when empty. Click events
  // inside the banner stop at the banner — the card has a click
  // handler that opens the detail view, and we don't want every input
  // keystroke or button press to navigate away.

  function setCardBanner(card, html, opts = {}) {
    const banner = card.querySelector('.pc-banner');
    if (!banner) return null;
    if (!html) {
      banner.hidden = true;
      banner.className = 'pc-banner';
      banner.innerHTML = '';
      return banner;
    }
    banner.hidden = false;
    banner.className = `pc-banner${opts.kind ? ` pcb-${opts.kind}` : ''}`;
    banner.innerHTML = html;
    // One-shot listener: anything inside the banner shouldn't bubble
    // up to the card-level click handler (openDetail). Reset on every
    // call because innerHTML wipes child listeners.
    banner.onclick = (e) => e.stopPropagation();
    return banner;
  }

  function clearCardBannerLater(card, ms) {
    setTimeout(() => {
      const banner = card.querySelector('.pc-banner');
      if (!banner) return;
      // Only auto-clear if nothing else has overwritten the banner
      // since we scheduled this call (e.g. user opened the snapshot
      // dialog right after a sync ok message).
      if (banner.dataset.scheduledClear === String(ms)) {
        setCardBanner(card, '');
      }
    }, ms);
    const banner = card.querySelector('.pc-banner');
    if (banner) banner.dataset.scheduledClear = String(ms);
  }

  async function runProjectSync(p, card, syncBtn) {
    if (syncBtn.disabled) return;  // dedup double-clicks
    syncBtn.disabled = true;
    syncBtn.classList.add('pc-sync-active');
    const originalTitle = syncBtn.title;
    syncBtn.title = 'Syncing…';
    setCardBanner(card, `<span class="pcb-msg">Syncing…</span>`, { kind: 'pending' });
    try {
      const r = await api(`/api/projects/${p.id}/sync`, { method: 'POST' });
      if (!r) {
        setCardBanner(card, `<span class="pcb-msg">Sync failed</span>`, { kind: 'err' });
        return;
      }
      if (r.ok === false) {
        // Diverged or dirty — actionable inline message. Surface the
        // ahead/behind counts when the backend gave them so the user
        // knows the scale of the divergence at a glance.
        const counts = (typeof r.ahead === 'number' && typeof r.behind === 'number')
          ? ` (${r.ahead} ahead, ${r.behind} behind)`
          : '';
        setCardBanner(card,
          `<span class="pcb-msg">${escapeHtml(r.message || 'sync failed')}${counts}</span>`,
          { kind: 'err' },
        );
        return;
      }
      // ok branch.
      // ngit case: surface the proposals count badge first-class —
      // the brief is explicit that proposals must NOT be flattened
      // into a generic message. No proposals view exists yet, so we
      // render a non-linked count chip; clicking the card itself
      // opens the detail view where a future proposals tab will
      // surface the list.
      let proposalsHtml = '';
      if (Array.isArray(r.proposals) && r.proposals.length > 0) {
        const n = r.proposals.length;
        proposalsHtml = ` <span class="pcb-prop-count">${n} open proposal${n === 1 ? '' : 's'}</span>`;
      }
      setCardBanner(card,
        `<span class="pcb-msg">${escapeHtml(r.message || 'synced')}</span>${proposalsHtml}`,
        { kind: 'ok' },
      );
      // ok messages auto-clear so the card doesn't end up with a
      // stale "fast-forwarded" line three days later. Errors stick
      // until the next user action — they're actionable, not noise.
      clearCardBannerLater(card, 5000);
      // Refresh the badge so the user sees the new state — fast-
      // forward erases the "behind" pill, ff fetch may flip "up to
      // date" into "ahead" for ngit-only fetches that brought new
      // remote commits without a local merge.
      pollGitStateOne(p.id);
    } catch (e) {
      setCardBanner(card,
        `<span class="pcb-msg">Sync failed: ${escapeHtml(String(e?.message || e || 'unknown'))}</span>`,
        { kind: 'err' },
      );
    } finally {
      syncBtn.disabled = false;
      syncBtn.classList.remove('pc-sync-active');
      syncBtn.title = originalTitle;
    }
  }

  function openSnapshotDialog(p, card) {
    // Render the dialog form into the banner. Single text input + Save
    // + Cancel. Empty input is fine — the server falls back to an
    // ISO timestamp message.
    setCardBanner(card, `
      <form class="pcb-snap-form" novalidate>
        <input type="text" class="pcb-snap-input" placeholder="Describe this snapshot (optional)" maxlength="200" autocomplete="off">
        <button type="submit" class="primary pcb-snap-save">Save</button>
        <button type="button" class="pcb-snap-cancel">Cancel</button>
      </form>
    `, { kind: 'dialog' });

    const form    = card.querySelector('.pcb-snap-form');
    const input   = card.querySelector('.pcb-snap-input');
    const saveBtn = card.querySelector('.pcb-snap-save');
    const cancelBtn = card.querySelector('.pcb-snap-cancel');
    if (!form || !input || !saveBtn || !cancelBtn) return;

    // Auto-focus the input so the user can start typing immediately.
    setTimeout(() => input.focus(), 0);

    cancelBtn.addEventListener('click', (e) => {
      e.stopPropagation(); e.preventDefault();
      setCardBanner(card, '');
    });

    // Esc dismisses; Enter submits via the form's natural submit path.
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation(); e.preventDefault();
        setCardBanner(card, '');
      }
    });

    form.addEventListener('submit', async (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (saveBtn.disabled) return;
      saveBtn.disabled = true;
      cancelBtn.disabled = true;
      saveBtn.textContent = 'Saving…';
      const message = input.value;
      try {
        const r = await api(`/api/projects/${p.id}/snapshot`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message }),
        });
        if (!r || r.ok === false) {
          setCardBanner(card,
            `<span class="pcb-msg">${escapeHtml(r?.error || 'snapshot failed')}</span>`,
            { kind: 'err' },
          );
          return;
        }
        // Two ok shapes: real commit (sha set) and graceful no-op
        // ('nothing to commit' surfaces in r.error per snapshot.ts
        // contract). Render both as ok kinds so the dashboard never
        // paints a red banner for the legitimate empty-tree case.
        const tail = r.sha
          ? ` <code class="pcb-sha">${escapeHtml(r.sha)}</code>`
          : '';
        const headline = r.error === 'nothing to commit'
          ? 'Nothing to commit'
          : 'Saved';
        setCardBanner(card,
          `<span class="pcb-msg">${headline}${tail}</span>`,
          { kind: 'ok' },
        );
        clearCardBannerLater(card, 4000);
        pollGitStateOne(p.id);
      } catch (e2) {
        setCardBanner(card,
          `<span class="pcb-msg">Snapshot failed: ${escapeHtml(String(e2?.message || e2 || 'unknown'))}</span>`,
          { kind: 'err' },
        );
      }
    });
  }

  // ── Detail view ──────────────────────────────────────────────────────
  function openDetail(id) {
    state.view = 'detail';
    state.projectId = id;
    state.tab = 'overview';
    projectStatus = null; projectGitLog = null;
    render();
    // Phase 7: fire-and-forget counts fetch so tab badges populate
    // shortly after the tabs first paint. Doesn't block the initial
    // render — failure just means tabs without counts.
    const p = projects.find(x => x.id === id);
    if (p) refreshTabCounts(p);
  }

  function backToList() {
    state.view = 'list';
    state.projectId = null;
    render();
  }

  function renderDetail() {
    const p = projects.find(x => x.id === state.projectId);
    if (!p) { backToList(); return; }

    title.innerHTML = `<button class="detail-back" aria-label="Back">←</button><span class="detail-title">${escapeHtml(p.name)}</span>`;
    title.querySelector('.detail-back').addEventListener('click', backToList);
    subtitle.textContent = p.path ? p.path : 'nsite-only project';

    headActions.innerHTML = '';
    if (p.path && window.NSTerminal?.isAvailable?.() && terminalAi) {
      const btn = document.createElement('button');
      btn.textContent = `Open in ${terminalAi.displayName}`;
      btn.addEventListener('click', () => window.NSTerminal.open(terminalAi.key, { projectId: p.id }));
      headActions.appendChild(btn);
    }
    if (p.capabilities.git || p.capabilities.ngit) {
      const pushBtn = document.createElement('button');
      pushBtn.className = 'primary';
      pushBtn.textContent = 'Publish';
      pushBtn.addEventListener('click', () => runProjectPublish(p));
      headActions.appendChild(pushBtn);
    }
    if (p.capabilities.nsite) {
      const deployBtn = document.createElement('button');
      deployBtn.textContent = 'Deploy';
      deployBtn.addEventListener('click', () => runProjectDeploy(p));
      headActions.appendChild(deployBtn);
    }

    // Tabs — only for enabled capabilities; Settings always shown.
    // The Proposals tab piggybacks on ngit capability + a configured
    // remote: with no remote there's nothing to query for, and the
    // existing `ngit` tab already swaps to an Initialize form in that
    // state. Surfacing a separate Proposals tab keeps the list-y view
    // distinct from the operations tab (push / settings).
    // Tab structure follows the github / gitworkshop pattern: a small,
    // discoverable set focused on what the user reads (Code, PRs,
    // Issues), with operational chrome (git remotes, ngit signer +
    // sync controls) folded into Settings as sections. Reduces the
    // top-level tab strip from 8 → 6.
    //
    // The Code tab is gated on having a local git checkout — its
    // backing endpoints (refs/tree/blob/log/readme) all shell out to
    // `git` against project.path. Local-only projects without a repo
    // (e.g. nsite-only) skip Code but still see Settings.
    const hasGitCheckout = !!p.path && (p.capabilities.git || p.capabilities.ngit);
    const counts = (state.tabCounts && state.tabCounts[p.id]) || {};
    const issueCount = counts.issues;
    const prCount    = counts.prs;
    const fmtCount = (n) => (typeof n === 'number' && n > 0)
      ? ` <span class="tab-count">${n}</span>` : '';
    const tabs = [
      { key: 'overview', label: 'Overview' },
      // About — gitworkshop-style metadata page. Only meaningful for
      // ngit-published projects (no 30617 → nothing to show). Sits
      // before Code so it acts as the canonical "what is this repo?"
      // landing for visitors after Overview.
      (p.capabilities.ngit && p.remotes.ngit) && { key: 'about', label: 'About' },
      hasGitCheckout && { key: 'code', label: 'Code' },
      // Renamed from "Proposals" — every other Nostr-git client and
      // github itself call them "Pull requests" / "PRs". Matching
      // saves new users a beat of mental translation.
      (p.capabilities.ngit && p.remotes.ngit) && {
        key: 'proposals',
        label: `Pull requests${fmtCount(prCount)}`,
        labelHtml: true,
      },
      (p.capabilities.ngit && p.remotes.ngit) && {
        key: 'issues',
        label: `Issues${fmtCount(issueCount)}`,
        labelHtml: true,
      },
      p.capabilities.nsite && { key: 'nsite', label: 'nsite' },
      { key: 'settings', label: 'Settings' },
    ].filter(Boolean);
    if (!tabs.find(t => t.key === state.tab)) state.tab = 'overview';

    body.innerHTML = '';

    // Status chip bar
    const chipBar = document.createElement('div');
    chipBar.className = 'project-chip-bar';
    body.appendChild(chipBar);

    // Tabs row
    const tabsEl = document.createElement('div');
    tabsEl.className = 'tabs project-tabs';
    tabsEl.innerHTML = tabs.map(t =>
      `<button class="tab ${t.key === state.tab ? 'active' : ''}" data-tab="${t.key}">${t.labelHtml ? t.label : escapeHtml(t.label)}</button>`
    ).join('');
    body.appendChild(tabsEl);
    tabsEl.addEventListener('click', (e) => {
      const t = e.target.closest('.tab');
      if (!t) return;
      state.tab = t.dataset.tab;
      render();
    });

    const content = document.createElement('div');
    content.className = 'project-tab-content';
    body.appendChild(content);

    // Populate status chip bar + active tab.
    renderChipBar(chipBar, p);
    renderTab(content, p);
  }

  async function renderChipBar(el, p) {
    const chips = [];
    chips.push(`<span class="pchip identity"><span class="k">identity</span><span class="v">${escapeHtml(projectIdentityLabel(p))}</span></span>`);
    el.innerHTML = chips.join('');

    if ((p.capabilities.git || p.capabilities.ngit) && p.path) {
      // Lazy fetch git status for chip bar
      try {
        projectStatus = await api(`/api/projects/${p.id}/git/status`);
        const st = projectStatus;
        if (st && st.inRepo) {
          const extra = [];
          extra.push(`<span class="pchip"><span class="k">branch</span><span class="v">${escapeHtml(st.branch)}</span></span>`);
          extra.push(`<span class="pchip"><span class="k">HEAD</span><span class="v">${escapeHtml(st.hash)}</span></span>`);
          if (st.dirty) extra.push(`<span class="pchip warn"><span class="k">uncommitted</span><span class="v">${st.dirty} file${st.dirty !== 1 ? 's' : ''}</span></span>`);
          el.insertAdjacentHTML('afterbegin', extra.join(''));
        }
      } catch {}
    }
    if (p.capabilities.nsite && p.nsite?.lastDeploy) {
      el.insertAdjacentHTML('beforeend',
        `<span class="pchip"><span class="k">deployed</span><span class="v">${escapeHtml(fmtAgoIso(p.nsite.lastDeploy))}</span></span>`);
    }
  }

  function renderTab(container, p) {
    // Each tab renderer may register a cleanup via container.__cleanup
    // (intervals, visibility listeners). Run it before swapping content
    // so timers/listeners don't leak when the user switches tabs.
    try { container.__cleanup?.(); } catch {}
    container.__cleanup = null;
    container.innerHTML = '';
    if (state.tab === 'overview') renderOverview(container, p);
    else if (state.tab === 'about')     renderAboutTab(container, p);
    else if (state.tab === 'code')      renderCodeTab(container, p);
    else if (state.tab === 'proposals') renderProposalsTab(container, p);
    else if (state.tab === 'issues')    renderIssuesTab(container, p);
    else if (state.tab === 'nsite')     renderNsiteTab(container, p);
    else if (state.tab === 'settings')  renderSettingsTab(container, p);
  }

  // Phase 7: shared empty-state renderer for Issues / PRs lists.
  // Big icon + title + explanation + optional CTA — matches the
  // pattern github/gitworkshop both use to onboard first-time users.
  function renderListEmptyState(opts) {
    const cta = opts.cta
      ? `<button class="primary ${escapeHtml(opts.cta.className || '')}">${escapeHtml(opts.cta.label)}</button>`
      : '';
    return `
      <div class="list-empty-state">
        <div class="list-empty-icon">${escapeHtml(opts.icon || '·')}</div>
        <div class="list-empty-title">${escapeHtml(opts.title || '')}</div>
        <div class="list-empty-body muted">${opts.body || ''}</div>
        ${cta ? `<div class="list-empty-cta">${cta}</div>` : ''}
      </div>
    `;
  }

  // Phase 7: bulk-fetch the issue + PR counts so the tab strip can
  // show "Pull requests (N)" / "Issues (N)" at-a-glance. Both
  // endpoints already exist and are cached; one round trip each.
  // Failures degrade silently — tabs render without the count.
  async function refreshTabCounts(p) {
    if (!p.capabilities.ngit || !p.remotes.ngit) return;
    state.tabCounts = state.tabCounts || {};
    state.tabCounts[p.id] = state.tabCounts[p.id] || {};
    try {
      const [iss, prs] = await Promise.all([
        api(`/api/projects/${p.id}/issues`).catch(() => null),
        api(`/api/projects/${p.id}/patches`).catch(() => null),
      ]);
      const issues = Array.isArray(iss?.issues) ? iss.issues : [];
      const series = Array.isArray(prs?.series) ? prs.series : [];
      // Phase 4 already computes status; pre-annotate so the tab
      // count reflects ONLY open items (closed / merged / resolved
      // don't need user attention).
      await Promise.all([
        annotateIssuesWithStatus(p.id, issues),
        annotateSeriesWithStatus(p.id, series),
      ]);
      state.tabCounts[p.id].issues = issues.filter(i => (i.status || 'open') === 'open').length;
      state.tabCounts[p.id].prs    = series.filter(s => (s.effectiveStatus || 'open') === 'open').length;
      // Refresh ONLY the tab strip (don't re-render the active tab
      // body — would re-fire its data fetches needlessly).
      const tabsEl = document.querySelector('.project-tabs');
      if (tabsEl && state.view === 'detail' && state.projectId === p.id) {
        renderDetail();
      }
    } catch { /* silent */ }
  }

  async function renderOverview(container, p) {
    container.innerHTML = `<div class="overview-loading muted">loading…</div>`;
    let gitBlock = '', ngitBlock = '', nsiteBlock = '';

    if (p.capabilities.git && p.path) {
      try {
        const st = projectStatus || await api(`/api/projects/${p.id}/git/status`);
        projectStatus = st;
        if (st && st.inRepo) {
          const ghRemote = st.remotes?.find(r => r.type === 'github')?.url || p.remotes.github || '';
          gitBlock = `
            <div class="tab-section">
              <h3>Git</h3>
              <div class="overview-grid">
                <div class="overview-kv"><div class="k">last commit</div><div class="v">${escapeHtml(st.hash)} · ${escapeHtml(st.message || '')}</div></div>
                <div class="overview-kv"><div class="k">author</div><div class="v">${escapeHtml(st.author || '—')} · ${escapeHtml(fmtAgoMs(st.timestamp))}</div></div>
                ${ghRemote ? `<div class="overview-kv has-copy"><div class="k">GitHub</div><div class="v"><code>${escapeHtml(ghRemote)}</code></div><div class="copy-slot" data-copy="${escapeHtml(ghRemote)}"></div></div>` : ''}
                ${st.dirty ? `<div class="overview-kv"><div class="k">uncommitted</div><div class="v warn">${st.dirty} file${st.dirty !== 1 ? 's' : ''} · <a href="#" class="open-git-tab">view</a></div></div>` : ''}
              </div>
            </div>`;
        }
      } catch {}
    }

    if (p.capabilities.ngit) {
      const bunker = p.identity.useDefault ? 'using station identity' : (p.identity.bunkerUrl ? 'project bunker configured' : 'no bunker (Amber prompts on first push)');
      const url = p.remotes.ngit || '(not configured)';
      ngitBlock = `
        <div class="tab-section">
          <h3>ngit</h3>
          <div class="overview-grid">
            <div class="overview-kv has-copy"><div class="k">nostr remote</div><div class="v"><code>${escapeHtml(url)}</code></div>${p.remotes.ngit ? `<div class="copy-slot" data-copy="${escapeHtml(url)}"></div>` : ''}</div>
            <div class="overview-kv"><div class="k">bunker</div><div class="v">${escapeHtml(bunker)}</div></div>
          </div>
        </div>`;
    }

    if (p.capabilities.nsite) {
      const url = p.nsite.url;
      nsiteBlock = `
        <div class="tab-section">
          <h3>nsite</h3>
          ${url
            ? `<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer" class="nsite-url-big">${escapeHtml(url)}</a>`
            : `<div class="muted">No deployed URL yet</div>`}
          <div class="overview-kv"><div class="k">last deploy</div><div class="v">${escapeHtml(fmtAgoIso(p.nsite.lastDeploy))}</div></div>
          <div style="margin-top:12px"><button class="primary deploy-btn">Deploy now</button></div>
        </div>`;
    }

    container.innerHTML = `
      ${gitBlock}${ngitBlock}${nsiteBlock}
      <div class="tab-section">
        <div class="overview-actions">
          <button class="primary open-chat-btn">Open in chat</button>
          ${(p.capabilities.git || p.capabilities.ngit) ? '<button class="quick-push">Publish</button>' : ''}
          ${p.capabilities.nsite ? '<button class="quick-deploy">Deploy</button>' : ''}
        </div>
      </div>
    `;
    container.querySelector('.open-chat-btn')?.addEventListener('click', () => openInChat(p));
    container.querySelector('.quick-push')?.addEventListener('click', () => runProjectPublish(p));
    container.querySelector('.quick-deploy')?.addEventListener('click', () => runProjectDeploy(p));
    container.querySelector('.deploy-btn')?.addEventListener('click', () => runProjectDeploy(p));
    container.querySelectorAll('.copy-slot').forEach(slot => {
      slot.appendChild(copyBtn(slot.dataset.copy));
    });
    container.querySelector('.open-git-tab')?.addEventListener('click', (e) => {
      e.preventDefault();
      openExecModal({
        title: `git status · ${p.name}`,
        subtitle: p.path || '',
        endpoint: `/api/projects/${p.id}/exec`,
        body: { cmd: 'git-status' },
      });
    });
  }

  // ── About tab ────────────────────────────────────────────────────────
  //
  // Gitworkshop-style metadata page for ngit-published projects.
  // Consolidates everything the kind-30617 announcement(s) declare:
  //
  //   - Description + website
  //   - Maintainers (anchor + verified + candidate-only)
  //   - GRASP servers — hosts that serve BOTH a git endpoint AND a
  //     nostr relay at the same domain (per ngit.dev/grasp). Detected
  //     by intersecting an announcement's `clone` host set with its
  //     `relays` host set.
  //   - Other relays — relay URLs whose host doesn't appear in any
  //     clone URL. Each labelled "via X" so the user can see which
  //     co-maintainer's announcement contributed it.
  //   - Clone URLs grouped by maintainer (per GRASP convention,
  //     `https://<host>/<npub>/<identifier>.git` — the npub in the
  //     path identifies which maintainer hosts that copy).
  //   - "Raw announcement events (N)" — opens the inspector modal.
  //
  // All data comes from /api/projects/:id/repo (repo + maintainerSet).
  // No new server work; the analysis is pure client-side derivation.
  async function renderAboutTab(container, p) {
    container.innerHTML = `<div class="muted">loading…</div>`;
    let repoMeta;
    try {
      repoMeta = await api(`/api/projects/${p.id}/repo`);
    } catch (e) {
      container.innerHTML = `<div class="empty-state err">Failed to load repo metadata: ${escapeHtml(e?.message || String(e))}</div>`;
      return;
    }
    const repo = repoMeta?.repo;
    if (!repo) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="muted">This project hasn't been announced to nostr yet.</div>
          <div class="muted" style="font-size:11px;margin-top:8px">Run <code>ngit init</code> to publish the kind-30617 announcement.</div>
        </div>
      `;
      return;
    }
    const ms = repoMeta.maintainerSet;
    paintAboutTab(container, p, repo, ms);
    // Kick off profile resolution for every pubkey we display. The painter
    // pulls names from the profile cache, so a second paint after this
    // promise resolves upgrades the visible rows from npub-truncated
    // placeholders to real names + avatars.
    const allPubkeys = [
      repo.pubkey,
      ...(ms?.verified || []),
      ...(ms?.candidatesOnly || []),
    ];
    const analysisForKeys = analyseAnnouncements(repo, ms);
    for (const k of analysisForKeys.clonesByMaintainer.keys()) allPubkeys.push(k);
    // Repo's relays + maintainer-announcement relays make a decent
    // initial hint set for profile lookups — these maintainers are most
    // likely to have their kind-0 on relays the repo already touches.
    const relays = Array.isArray(repo.relays) ? repo.relays : [];
    resolveProfiles(allPubkeys, { relays }).then(() => {
      // Guard against tab switch during the fetch — only re-paint if the
      // user is still on this tab and the container is in the DOM.
      if (!container.isConnected) return;
      paintAboutTab(container, p, repo, ms);
      // Kick off NIP-05 verification asynchronously. This adds DNS +
      // HTTPS per claim — slower than the kind-0 fetch, hence a third
      // paint when it completes. Non-blocking; the tab is fully
      // usable after the second paint without verification.
      resolveProfilesVerified(allPubkeys, { relays }).then(() => {
        if (!container.isConnected) return;
        paintAboutTab(container, p, repo, ms);
      });
    });
  }

  // Pure painter — synchronous, idempotent. Called once with placeholder
  // names, then again after profile resolution upgrades the cache. Reads
  // names/avatars from profileCache via profileNameOf.
  function paintAboutTab(container, p, repo, ms) {
    const analysis = analyseAnnouncements(repo, ms);

    // Section order matches gitworkshop: Topics → Maintainers → GRASP →
    // Other relays → Clone (the nostr:// URL contributors actually use)
    // → Raw git URLs (the per-maintainer https:// breakdown). Putting
    // Topics first reads naturally because it's the "what is this?"
    // signal; Clone before Raw git URLs because the nostr:// URL is the
    // canonical entry point and the raw https:// URLs are a
    // power-user view of the same data.
    const ngitRemoteUrl = window.__projectsCache?.find?.(x => x.id === p.id)?.remotes?.ngit
      ?? p.remotes?.ngit
      ?? '';

    container.innerHTML = `
      <div class="about-tab">
        ${repo.description ? `<div class="about-desc">${escapeHtml(repo.description)}</div>` : ''}

        ${repo.web?.length ? `
          <div class="about-section">
            <div class="about-head muted">Website</div>
            <div class="about-web">
              ${repo.web.map(u => `<a href="${escapeHtml(u)}" target="_blank" rel="noreferrer noopener" class="about-web-link">${escapeHtml(u)}</a>`).join('')}
            </div>
          </div>
        ` : ''}

        ${repo.hashtags?.length ? `
          <div class="about-section">
            <div class="about-head muted">Topics</div>
            <div class="about-pills">
              ${repo.hashtags.map(t => `<code class="about-pill about-pill-tag">${escapeHtml(t)}</code>`).join('')}
            </div>
          </div>
        ` : ''}

        <div class="about-section">
          <div class="about-head muted">Maintainers</div>
          <div class="about-maintainers">${renderAboutMaintainers(repo, ms, analysis)}</div>
        </div>

        ${analysis.graspHosts.size > 0 ? `
          <div class="about-section">
            <div class="about-head muted">GRASP servers</div>
            <div class="about-pills">
              ${[...analysis.graspHosts].map(h => `<code class="about-pill about-pill-grasp">${escapeHtml(h)}</code>`).join('')}
            </div>
          </div>
        ` : ''}

        ${analysis.otherRelays.size > 0 ? `
          <div class="about-section">
            <div class="about-head muted">Other relays</div>
            <div class="about-pills">
              ${[...analysis.otherRelays.entries()].map(([url, contributors]) => {
                const host = (() => { try { return new URL(url).host; } catch { return url; } })();
                const viaLabel = contributors.length > 0 && contributors[0] !== repo.pubkey
                  ? ` <span class="about-pill-via">via ${escapeHtml(analysis.nameOf(contributors[0]))}</span>` : '';
                return `<code class="about-pill">${escapeHtml(host)}${viaLabel}</code>`;
              }).join('')}
            </div>
          </div>
        ` : ''}

        ${ngitRemoteUrl ? `
          <div class="about-section">
            <div class="about-head muted">Clone</div>
            <div class="about-clone-ngit">
              <div class="about-clone-ngit-label">ngit <span class="muted">(nostr git plugin)</span></div>
              <div class="about-clone-row about-clone-row-primary">
                <code class="about-clone-url">git clone ${escapeHtml(ngitRemoteUrl)}</code>
                <span class="copy-slot" data-copy="${escapeHtml('git clone ' + ngitRemoteUrl)}"></span>
              </div>
            </div>
          </div>
        ` : ''}

        ${analysis.clonesByMaintainer.size > 0 ? `
          <div class="about-section">
            <div class="about-head muted" title="Raw https:// URLs from each maintainer's announcement. Most users should clone via the nostr:// URL above instead — it discovers all of these automatically.">Raw git URLs</div>
            <div class="about-clones">
              ${[...analysis.clonesByMaintainer.entries()].map(([owner, urls]) => `
                <div class="about-clone-group">
                  <div class="about-clone-owner">
                    <span class="about-clone-owner-name">${escapeHtml(analysis.nameOf(owner))}</span>
                    ${owner === repo.pubkey ? `<span class="about-clone-owner-badge">owner</span>` : ''}
                  </div>
                  ${urls.map(u => `
                    <div class="about-clone-row">
                      <code class="about-clone-url">${escapeHtml(u)}</code>
                      <span class="copy-slot" data-copy="${escapeHtml(u)}"></span>
                    </div>
                  `).join('')}
                </div>
              `).join('')}
            </div>
          </div>
        ` : ''}

        <div class="about-footer-row">
          <button class="about-action about-action-edit" type="button" title="Edit this repository's announcement (re-publishes a signed kind-30617 with your changes)">
            <span class="about-action-icon">✎</span> Edit
          </button>
          <button class="about-action about-action-share" type="button" title="Copy share links (naddr / nostr:// URL)">
            <span class="about-action-icon">↗</span> Share links
          </button>
          ${ms?.events?.length ? `
            <button class="about-action about-action-raw" type="button" title="Inspect each maintainer's raw kind-30617 event">
              <span class="about-action-icon">{ }</span> Raw announcement event${ms.events.length === 1 ? '' : 's'}${ms.events.length > 1 ? ` (${ms.events.length})` : ''}
            </button>
          ` : ''}
          <button class="about-action about-action-delete" type="button" title="Unregister this project from your dashboard (the nostr events remain on relays — there is no on-chain delete)">
            <span class="about-action-icon">🗑</span> Delete
          </button>
        </div>
      </div>
    `;

    container.querySelectorAll('.copy-slot').forEach(s => s.appendChild(copyBtn(s.dataset.copy)));
    container.querySelector('.about-action-raw')?.addEventListener('click', () => {
      openAnnouncementsModal(repo, ms);
    });
    container.querySelector('.about-action-edit')?.addEventListener('click', () => {
      openEditRepositoryModal(p, repo, ms, () => {
        // After a successful save, re-fetch the repo metadata so the
        // About tab reflects the new announcement. The cache is busted
        // server-side. Guard against the user having switched tabs
        // during the round-trip — re-rendering into a detached
        // container would leak DOM and orphan our cleanup hooks.
        if (!container.isConnected) return;
        renderAboutTab(container, p);
      });
    });
    container.querySelector('.about-action-share')?.addEventListener('click', () => {
      openShareLinksModal(p, repo);
    });
    container.querySelector('.about-action-delete')?.addEventListener('click', () => {
      openDeleteProjectConfirm(p);
    });
  }

  // Render the maintainer rows on the About tab. Richer than the
  // Code-tab strip: full row per maintainer with role badge, npub,
  // and copy. Anchor first, then verified by the order MaintainerSet
  // already establishes (anchor + verified-by-freshest), then any
  // candidate-only pubkeys at the bottom under a "claimed but not
  // announced" caption.
  function renderAboutMaintainers(repo, ms, analysis) {
    const anchor = repo.pubkey;
    const verified = ms?.verified || [];
    const candidate = ms?.candidatesOnly || [];
    const selectedPubkey = ms?.display?.pubkey || anchor;
    const seen = new Set([anchor]);
    const verifiedRows = [{ pubkey: anchor, role: 'anchor' }];
    for (const pk of verified) {
      if (seen.has(pk)) continue;
      seen.add(pk);
      verifiedRows.push({ pubkey: pk, role: 'verified' });
    }
    const verifiedHtml = verifiedRows.map(({ pubkey, role }) => {
      const isSelected = pubkey === selectedPubkey;
      const pic = profilePictureOf(pubkey);
      // Avatar: real picture > first letter of resolved name > generic
      // person glyph. The generic glyph (instead of first-char-of-hex)
      // prevents the "2" placeholder reading as a count badge when
      // profile resolution hasn't returned a kind-0 for this pubkey.
      const avatar = pic
        ? `<img class="about-avatar" src="${escapeHtml(pic)}" alt="" referrerpolicy="no-referrer" loading="lazy">`
        : hasResolvedProfileName(pubkey)
          ? `<div class="about-avatar-placeholder" aria-hidden="true">${escapeHtml(profileNameOf(pubkey).slice(0, 1).toUpperCase())}</div>`
          : `<div class="about-avatar-placeholder about-avatar-placeholder-anon" aria-hidden="true" title="Profile not resolved (no kind-0 found on the relays we queried)">●</div>`;
      // NIP-05 row when the profile has a claim. Verified === true →
      // green ✓; verified === false → muted ✗ (claim doesn't resolve);
      // verified === undefined → no marker (verification still running
      // or never requested). Hover reveals the full claim.
      const { nip05, verified } = profileNip05Of(pubkey);
      let nip05Html = '';
      if (nip05) {
        const marker = verified === true
          ? '<span class="about-nip05-mark about-nip05-mark-ok" title="NIP-05 verified — well-known JSON resolves back to this pubkey">✓</span>'
          : verified === false
            ? '<span class="about-nip05-mark about-nip05-mark-bad" title="NIP-05 claim does not verify — the well-known JSON points elsewhere">✗</span>'
            : '';
        nip05Html = `<span class="about-nip05" title="${escapeHtml(nip05)}">${escapeHtml(nip05)}${marker}</span>`;
      }
      return `
        <div class="about-maintainer-row">
          ${avatar}
          <span class="maintainers-role maintainers-role-${role}" title="${escapeHtml(role === 'anchor' ? 'Trust anchor — published the repo announcement' : 'Verified — published their own kind-30617')}">${escapeHtml(role)}</span>
          <div class="about-maintainer-main">
            <div class="about-maintainer-name-row">
              <code class="about-maintainer-pk">${escapeHtml(analysis.nameOf(pubkey))}</code>
              ${isSelected ? `<span class="ann-selected">selected</span>` : ''}
            </div>
            ${nip05Html}
          </div>
          <span class="copy-slot" data-copy="${escapeHtml(window.NostrTools?.nip19 ? window.NostrTools.nip19.npubEncode(pubkey) : pubkey)}"></span>
        </div>
      `;
    }).join('');
    const candidateHtml = candidate.length === 0 ? '' : `
      <div class="about-maintainer-candidates">
        <div class="about-head muted" style="font-size:10px;margin-top:8px">Claimed but not announced (${candidate.length})</div>
        <div class="about-pills">
          ${candidate.map(pk => `<code class="ann-candidate-pk">${escapeHtml(analysis.nameOf(pk))}</code>`).join('')}
        </div>
      </div>
    `;
    return verifiedHtml + candidateHtml;
  }

  // Pure analysis of the per-maintainer 30617 events. Returns the
  // shape the About tab renderer consumes — GRASP hosts, attributed
  // relays, clones grouped by hosting maintainer.
  function analyseAnnouncements(repo, ms) {
    const events = Array.isArray(ms?.events) ? ms.events : [];
    // Defer to the shared profile resolver so the same name shows up
    // everywhere (About, maintainers panel, announcements modal) and
    // automatically upgrades from npub fallback → kind-0 display name
    // once profiles resolve and the painter re-runs.
    const nameOf = (pk) => profileNameOf(pk);
    const safeHost = (url) => {
      try { return new URL(url).host; } catch { return null; }
    };
    const ownerFromCloneUrl = (url) => {
      try {
        const m = new URL(url).pathname.match(/^\/(npub1[0-9a-z]+)\//);
        if (!m) return null;
        if (window.NostrTools?.nip19) {
          const d = window.NostrTools.nip19.decode(m[1]);
          if (d.type === 'npub' && typeof d.data === 'string') return d.data;
        }
      } catch {}
      return null;
    };
    const tagsOf = (ev, name) => ev.tags
      .filter(t => Array.isArray(t) && t[0] === name)
      .flatMap(t => t.slice(1).filter(v => typeof v === 'string' && v.length > 0));

    // Per-event extraction.
    const perEvent = events.map(ev => {
      const relays = tagsOf(ev, 'relays');
      const clones = tagsOf(ev, 'clone');
      const relayHosts = new Set(relays.map(safeHost).filter(Boolean));
      const cloneHosts = new Set(clones.map(safeHost).filter(Boolean));
      // GRASP: a host serving BOTH protocols at the same domain.
      const graspHosts = [...relayHosts].filter(h => cloneHosts.has(h));
      return { event: ev, pubkey: ev.pubkey, relays, clones, graspHosts };
    });

    // Aggregate GRASP hosts across all announcements.
    const graspHosts = new Set();
    for (const e of perEvent) for (const h of e.graspHosts) graspHosts.add(h);

    // Other relays: relay URLs whose host is not a known GRASP host.
    // Attribute to the contributing maintainer pubkeys (first-seen wins
    // for the "via" label so we don't blink between attributions).
    const otherRelays = new Map();
    for (const e of perEvent) {
      for (const url of e.relays) {
        const host = safeHost(url);
        if (host && graspHosts.has(host)) continue;
        if (!otherRelays.has(url)) otherRelays.set(url, []);
        otherRelays.get(url).push(e.pubkey);
      }
    }

    // Clone URLs grouped by the maintainer whose npub is in the path.
    // Falls back to the announcing maintainer when the path doesn't
    // match the GRASP convention. Order: anchor first, then others
    // by appearance in `events` (= anchor-first then freshest).
    const clonesByMaintainer = new Map();
    const seenClones = new Set();
    for (const e of perEvent) {
      for (const url of e.clones) {
        if (seenClones.has(url)) continue;
        seenClones.add(url);
        const owner = ownerFromCloneUrl(url) || e.pubkey;
        if (!clonesByMaintainer.has(owner)) clonesByMaintainer.set(owner, []);
        clonesByMaintainer.get(owner).push(url);
      }
    }
    // Re-sort the map so the anchor's clones appear first.
    if (clonesByMaintainer.has(repo.pubkey)) {
      const anchorClones = clonesByMaintainer.get(repo.pubkey);
      clonesByMaintainer.delete(repo.pubkey);
      const reordered = new Map();
      reordered.set(repo.pubkey, anchorClones);
      for (const [k, v] of clonesByMaintainer) reordered.set(k, v);
      clonesByMaintainer.clear();
      for (const [k, v] of reordered) clonesByMaintainer.set(k, v);
    }

    return { perEvent, graspHosts, otherRelays, clonesByMaintainer, nameOf };
  }

  async function renderGitTab(container, p) {
    container.innerHTML = `<div class="muted">loading…</div>`;
    try {
      const [st, log] = await Promise.all([
        api(`/api/projects/${p.id}/git/status`),
        api(`/api/projects/${p.id}/git/log`),
      ]);
      projectStatus = st; projectGitLog = log;
      if (!st.inRepo) {
        container.innerHTML = `<div class="empty-state">${escapeHtml(st.error || 'not a git repo at this path')}</div>`;
        return;
      }
      const remotesHtml = (st.remotes || []).map(r =>
        `<div class="remote-row"><span class="k">${escapeHtml(r.type)} (${escapeHtml(r.name)})</span><span class="v">${escapeHtml(r.url)}</span><span class="copy-slot" data-copy="${escapeHtml(r.url)}"></span></div>`
      ).join('');
      container.innerHTML = `
        <div class="tab-section">
          <div class="tab-section-head">
            <h3>Branch · ${escapeHtml(st.branch)}</h3>
            <div class="tab-section-actions">
              <button class="pull-btn">Pull</button>
              <button class="primary push-btn">Publish</button>
            </div>
          </div>
          ${remotesHtml ? `<div class="remote-section"><h4>Remotes</h4>${remotesHtml}</div>` : ''}
        </div>

        <div class="tab-section">
          <h3>Recent commits</h3>
          <div class="commits">
            ${(log || []).map(c => `
              <div class="commit">
                <span class="hash">${escapeHtml(c.hash)}</span>
                <span class="msg">${escapeHtml(c.message)}</span>
                <span class="author">${escapeHtml(c.author)}</span>
                <span class="when">${escapeHtml(fmtAgoMs(c.timestamp))}</span>
              </div>
            `).join('')}
          </div>
        </div>
      `;
      container.querySelectorAll('.copy-slot').forEach(s => s.appendChild(copyBtn(s.dataset.copy)));
      container.querySelector('.pull-btn').addEventListener('click', () => runProjectPull(p));
      container.querySelector('.push-btn').addEventListener('click', () => runProjectPublish(p));
    } catch (e) {
      container.innerHTML = `<div class="empty-state err">failed to load git status: ${escapeHtml(e.message)}</div>`;
    }
  }

  // ── Code tab ─────────────────────────────────────────────────────────
  //
  // gitworkshop.dev-style repo home for projects with a local git
  // checkout. Single-column layout (mobile-first):
  //   1. Header — repo name / description / maintainers / clone URL
  //      (when published to ngit), working-tree status badge.
  //   2. Ref selector — branch/tag dropdown.
  //   3. File browser — breadcrumb + flat listing of the current
  //      tree level; click a folder to descend, click a file to open
  //      the preview pane.
  //   4. Preview — README (rendered markdown) on tab open; a selected
  //      file's content otherwise.
  //   5. Recent commits — last 8.
  //
  // All git data comes from local git via routes/repo.ts (Phase 1a) —
  // no relay round-trip needed for files/commits. The 30617 metadata
  // (Phase 1a /repo) IS a relay query but is cached for an hour, so
  // tab opens are cheap after the first.
  //
  // Phase 1c handles published projects (state B). Local-only / un-
  // published (state A) renders a stub pointing the user at Settings;
  // Phase 1d will replace that with the publish wizard.
  async function renderCodeTab(container, p) {
    container.innerHTML = `<div class="code-loading muted">Loading repo…</div>`;

    // Per-tab navigation state — preserved across tab switches so the
    // user returns to the same ref/path/blob they were viewing. Reset
    // when the project changes.
    if (!state.codeView || state.codeView.projectId !== p.id) {
      state.codeView = { projectId: p.id, ref: 'HEAD', path: '', selectedBlob: null };
    }
    const view = state.codeView;

    // Fetch in parallel — the four endpoints are independent and the
    // round-trip dominates rendering latency. repoMeta now carries
    // the Phase 5 maintainerSet alongside the parsed 30617 so chips
    // can surface verified vs candidate-only status.
    const [pubState, refs, repoMeta, gitState] = await Promise.all([
      api(`/api/projects/${p.id}/publish-state`).catch(() => null),
      api(`/api/projects/${p.id}/repo/refs`).catch(() => null),
      api(`/api/projects/${p.id}/repo`).catch(() => null),
      api(`/api/projects/${p.id}/git-state`).catch(() => null),
    ]);

    // Resolve a concrete ref. Prefer HEAD's symbolic target so
    // checkout/log calls work against a real branch name; fall back
    // to literal 'HEAD' in detached state.
    if (view.ref === 'HEAD' && refs?.head && !refs.head.startsWith('(')) {
      view.ref = refs.head;
    }

    container.innerHTML = '';

    // Phase 6: scratch-checkout banner. Pinned by the path prefix —
    // when a project lives under ~/.nostr-station/scratch/ it's a
    // temporary clone from the Discover → Browse flow. The banner
    // tells the user it's not persisted into their normal project
    // list and points to Settings (where they can edit `path` to
    // promote it to a regular project).
    if (isScratchProject(p)) {
      container.appendChild(renderScratchBanner(p));
    }

    // Local-only fork: full-tab publish wizard. We deliberately skip
    // the file browser / commits in this state because (a) there's
    // no nostr context to anchor them in and (b) the publish form
    // becomes the obvious next step rather than a side-panel.
    // Phase 1c rendered a tiny stub here; 1d turns it into the real
    // first-publish experience.
    if (pubState && pubState.status === 'local-only') {
      container.appendChild(renderPublishPanel(p, pubState));
      return;
    }

    // 1 — Header (with one-time post-publish banner if the user just
    // came back from a successful publish on this project)
    if (state.justPublishedProjectId === p.id) {
      container.appendChild(renderJustPublishedBanner(p, repoMeta));
      // Clear the flag so the banner only appears once.
      state.justPublishedProjectId = null;
    }
    container.appendChild(renderCodeHeader(p, pubState, repoMeta, gitState));

    // 2 — Ref selector + breadcrumb
    container.appendChild(renderCodeNav(p, refs, view));

    // 3 — File browser
    const filesEl = document.createElement('div');
    filesEl.className = 'code-files';
    container.appendChild(filesEl);
    renderCodeFiles(filesEl, p, view);

    // 4 — Preview (README on first open, blob on selection)
    const previewEl = document.createElement('div');
    previewEl.className = 'code-preview';
    container.appendChild(previewEl);
    renderCodePreview(previewEl, p, view);

    // 5 — Recent commits
    const commitsEl = document.createElement('div');
    commitsEl.className = 'code-commits';
    container.appendChild(commitsEl);
    renderCodeCommits(commitsEl, p, view);
  }

  // ── First-publish wizard (Phase 1d) ────────────────────────────────
  //
  // Renders an inline panel (full-tab) when a project hasn't been
  // published to ngit yet. The Review step inserts a confirmation
  // sheet between the form and the actual `ngit init` SSE so the
  // user sees exactly what event will be signed and where the repo
  // will be reachable, plus an opt-in for auto-sync.
  //
  // The panel is intentionally a sibling implementation of the
  // long-standing ngit-tab init form rather than a refactor: the
  // ngit-tab form is reachable from a different mental model (Init
  // panel for power-users) and changing both at once would tangle
  // the diff. They converge on the same /api/projects/:id/ngit/init
  // endpoint, so they stay behaviourally consistent.

  function renderPublishPanel(p, pubState) {
    const wrap = document.createElement('div');
    wrap.className = 'code-publish-panel';

    const name = pubState.detectedName || p.name || '';
    const desc = pubState.detectedDescription || '';
    const tags = (pubState.suggestedHashtags || []).join(', ');
    const noPath  = !pubState.isGitRepo;
    const hasOriginNonNostr = pubState.hasOrigin
      && pubState.originUrl
      && !/^nostr:/i.test(pubState.originUrl);

    wrap.innerHTML = `
      <div class="code-publish-head">
        <h2>Publish this project to ngit</h2>
        <p class="muted">
          Publishes a kind-30617 announcement so collaborators can
          <code>git clone nostr://…</code> your repo and submit patches
          directly. You'll review the exact event before anything is
          signed.
        </p>
      </div>

      ${noPath ? `
        <div class="code-publish-warn cp-needs-init">
          This project doesn't have a local git repository yet. Click below
          to run <code>git init</code> + an initial commit before publishing.
          <div style="margin-top:10px">
            <button class="primary cp-init-git">Initialize git</button>
          </div>
        </div>
      ` : ''}

      ${hasOriginNonNostr ? `
        <div class="code-publish-warn">
          This project already has an <code>origin</code> remote
          (<code>${escapeHtml(pubState.originUrl || '')}</code>).
          Publishing will replace it with a <code>nostr://</code> URL.
          The original is preserved as a local backup branch by
          <code>ngit init</code>.
        </div>
      ` : ''}

      <div class="code-publish-form">
        <label class="field-label">Repository name</label>
        <div class="field-row">
          <input type="text" class="cp-name" value="${escapeHtml(name)}"
                 placeholder="my-repo" ${noPath ? 'disabled' : ''}>
        </div>
        <div class="muted" style="font-size:11px;margin-top:4px">
          Letters, digits, dot, dash, underscore. 1–64 chars. This becomes
          the repo's <code>d</code> tag and the path in the clone URL.
        </div>

        <label class="field-label" style="margin-top:12px">Description</label>
        <div class="field-row">
          <input type="text" class="cp-description" value="${escapeHtml(desc)}"
                 placeholder="What does this project do?" ${noPath ? 'disabled' : ''}>
        </div>

        <label class="field-label" style="margin-top:12px">Hashtags (optional, space-separated)</label>
        <div class="field-row">
          <input type="text" class="cp-hashtags" value="${escapeHtml(tags)}"
                 placeholder="nostr  app  rust" ${noPath ? 'disabled' : ''}>
        </div>

        <label class="field-label" style="margin-top:12px">GRASP server</label>
        <div class="field-row">
          <input type="text" class="cp-grasp" value="${escapeHtml(pubState.suggestedGraspServer || 'wss://relay.ngit.dev')}"
                 placeholder="wss://relay.ngit.dev" ${noPath ? 'disabled' : ''}>
        </div>
        <div class="muted" style="font-size:11px;margin-top:4px">
          Where your git data lives. Anyone can host one;
          <a href="https://gitgrasp.com" target="_blank" rel="noreferrer">learn more</a>.
        </div>

        <div class="step-actions" style="margin-top:16px">
          <button class="primary cp-review" ${noPath ? 'disabled' : ''}>Review announcement</button>
          <a href="#" class="cp-cli-escape muted">Use the ngit CLI instead →</a>
        </div>
      </div>
    `;

    if (noPath) {
      // Wire the Initialize-git button. After success, re-render the
      // Code tab so the warn panel collapses and the publish form
      // becomes interactive.
      wrap.querySelector('.cp-init-git').addEventListener('click', () => {
        openExecModal({
          title:    `Initialize git · ${p.name}`,
          subtitle: 'git init && git add -A && git commit -m "initial commit"',
          endpoint: `/api/projects/${p.id}/git-init`,
          body:     {},
        }).then((r) => {
          if (r.ok) {
            toast('Git initialized', `${p.name} is ready to publish`, 'ok');
            // Re-fetch + re-render Code tab so the form unlocks.
            renderTab(document.querySelector('.project-tab-content'), p);
          } else {
            toast('git init failed', `exit ${r.code}`, 'err');
          }
        });
      });
      return wrap;
    }

    wrap.querySelector('.cp-cli-escape').addEventListener('click', (e) => {
      e.preventDefault();
      state.tab = 'ngit';
      render();
    });

    wrap.querySelector('.cp-review').addEventListener('click', async () => {
      const formData = readPublishFormData(wrap);
      if (!formData) return;
      // Fetch identity + signer state up-front so the Review sheet can
      // accurately reflect "this will sign as <npub>" / "Amber not paired".
      const [owner, account] = await Promise.all([
        api('/api/identity/config').catch(() => ({ npub: '' })),
        api('/api/ngit/account').catch(() => ({ loggedIn: false })),
      ]);
      openPublishReview(p, formData, owner, account, pubState);
    });

    return wrap;
  }

  function readPublishFormData(wrap) {
    const name        = wrap.querySelector('.cp-name').value.trim();
    const description = wrap.querySelector('.cp-description').value.trim();
    const grasp       = wrap.querySelector('.cp-grasp').value.trim();
    const hashtags    = wrap.querySelector('.cp-hashtags').value.trim()
      .split(/[\s,]+/).filter(Boolean).slice(0, 8);
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) {
      toast('Invalid name', '1-64 chars: alphanumerics, dot, dash, underscore', 'err');
      return null;
    }
    if (grasp && !/^wss?:\/\//i.test(grasp)) {
      toast('Invalid GRASP server URL', 'must start with wss:// or ws://', 'err');
      return null;
    }
    return { name, description, hashtags, graspServers: grasp ? [grasp] : [] };
  }

  function openPublishReview(p, formData, owner, account, pubState) {
    const npub = owner?.npub || '(no npub configured)';
    const grasp = formData.graspServers[0] || 'wss://relay.ngit.dev';
    const graspHost = String(grasp).replace(/^wss?:\/\//, '');
    const cloneUrl  = `https://${graspHost}/${npub}/${formData.name}.git`;
    const shareUrl  = `nostr://${npub}/${formData.name}`;

    // Tag rows pinned to NIP-34 §1.2 — this is the contract the user
    // is reviewing. Keep field names verbatim so a curious reader can
    // cross-check against the spec.
    const tagRows = [
      ['d',           formData.name],
      ['name',        formData.name],
      formData.description ? ['description', formData.description] : null,
      ['clone',       cloneUrl],
      ['relays',      grasp],
      ...formData.hashtags.map(t => ['t', t]),
    ].filter(Boolean);

    const tagHtml = tagRows.map(([k, v]) =>
      `<div class="rev-tag-row">
         <code class="rev-tag-key">${escapeHtml(k)}</code>
         <code class="rev-tag-val">${escapeHtml(v)}</code>
       </div>`,
    ).join('');

    const branchLine = pubState.detectedBranch
      ? `Push branch <code>${escapeHtml(pubState.detectedBranch)}</code> to the GRASP server`
      : 'Push current branch to the GRASP server';

    const body = document.createElement('div');
    body.className = 'rev-body';
    body.innerHTML = `
      <div class="rev-section">
        <h4>Event to publish</h4>
        <div class="rev-meta">
          <span class="rev-pill"><span class="k">kind</span><span class="v">30617</span></span>
          <span class="rev-pill"><span class="k">signed by</span><span class="v">${escapeHtml(shortPubkey(npub))}</span></span>
        </div>
        <div class="rev-tags">${tagHtml}</div>
      </div>

      <div class="rev-section">
        <h4>After publishing</h4>
        <ul class="rev-list">
          <li>${branchLine}</li>
          <li>Configure git remote <code>origin</code> → <code>${escapeHtml(shareUrl)}</code></li>
          <li>Anyone can clone with <code>git clone ${escapeHtml(shareUrl)}</code></li>
        </ul>
      </div>

      <div class="rev-section">
        <h4>Continuous sync</h4>
        <label class="rev-autosync">
          <input type="checkbox" class="rev-autosync-toggle" checked>
          <span>
            <strong>Enable auto-sync after publishing</strong>
            <div class="muted" style="font-size:12px;margin-top:2px">
              Pulls remote changes and pushes local commits every few minutes.
              Toggle later in Settings.
            </div>
          </span>
        </label>
      </div>

      ${!account?.loggedIn ? `
        <div class="rev-warn">
          <strong>Amber not paired.</strong> ngit init publishes a signed
          event; without a signer, publishing will fail. Pair Amber in
          Config → ngit and try again.
        </div>
      ` : ''}
    `;

    const foot = document.createElement('div');
    foot.style.display = 'flex'; foot.style.gap = '8px'; foot.style.width = '100%';
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    const publish = document.createElement('button');
    publish.className = 'primary';
    publish.textContent = 'Publish';
    publish.disabled = !account?.loggedIn;
    if (!account?.loggedIn) publish.title = 'Pair Amber first';
    const spacer = document.createElement('div');
    spacer.style.flex = '1';
    foot.appendChild(cancel); foot.appendChild(spacer); foot.appendChild(publish);

    const modal = openModal({
      title:    'Review announcement',
      subtitle: `${p.name} → ${shareUrl}`,
      body,
      footer:   foot,
    });

    cancel.addEventListener('click', () => modal.close());
    publish.addEventListener('click', () => {
      const enableAutoSync = body.querySelector('.rev-autosync-toggle').checked;
      modal.close();
      runPublishFlow(p, formData, enableAutoSync);
    });
  }

  async function runPublishFlow(p, formData, enableAutoSync) {
    const r = await openExecModal({
      title:    `Publish ${p.name}`,
      subtitle: `ngit init --name ${formData.name}`,
      endpoint: `/api/projects/${p.id}/ngit/init`,
      body:     {
        name:         formData.name,
        description:  formData.description,
        graspServers: formData.graspServers,
      },
    });
    if (!r.ok) return;  // exec modal stays open with the error stream

    // Sync the project record so the new ngit remote + autoSync flag
    // land before the next render. We re-detect first (picks up the
    // ngit URL ngit init wrote into git config), then PATCH any
    // additional flags the user opted into.
    try {
      const det = await api('/api/projects/detect', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: p.path }),
      });
      const patch = {};
      if (det.ngitRemote) {
        patch.remotes = { github: p.remotes.github || null, ngit: det.ngitRemote };
      }
      if (enableAutoSync) patch.autoSync = true;
      if (Object.keys(patch).length > 0) {
        await api(`/api/projects/${p.id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch),
        });
      }
      // Mark for the one-time success banner; cleared on the next
      // renderCodeTab pass so it doesn't reappear on tab switches.
      state.justPublishedProjectId = p.id;
      toast('Published to ngit',
            enableAutoSync ? 'auto-sync enabled' : 'manual sync', 'ok');
    } catch (e) {
      toast('Post-publish sync failed', e?.message || '', 'warn');
    }
    reload();
  }

  // Phase 6: scratch checkout heuristic. The /api/ngit/explore
  // endpoint always lands in ~/.nostr-station/scratch/<...>, so a
  // simple substring match is unambiguous. (We don't need an
  // absolute path check because the server only ever writes under
  // HOME, and the path comparison happens client-side on a string
  // the server emitted.)
  function isScratchProject(p) {
    return typeof p?.path === 'string' && p.path.includes('/.nostr-station/scratch/');
  }

  function renderScratchBanner(p) {
    const wrap = document.createElement('div');
    wrap.className = 'code-scratch-banner';
    wrap.innerHTML = `
      <div class="csb-icon">🧪</div>
      <div class="csb-body">
        <div class="csb-title">Temporary clone</div>
        <div class="csb-sub muted">
          You're browsing this repo from a scratch checkout at
          <code class="csb-path">${escapeHtml(p.path)}</code>.
          Scratch checkouts older than 7 days are cleaned up
          automatically.
        </div>
      </div>
      <div class="csb-actions">
        <button class="primary csb-save">Save to project list</button>
      </div>
    `;
    wrap.querySelector('.csb-save').addEventListener('click', () => openSavePathModal(p));
    return wrap;
  }

  // Phase 6-tidy: prompt for a target path + POST /save. Pre-fills
  // ~/projects/<basename> so the common case is one click. The
  // server validates the path is under HOME and atomic-moves the
  // directory; on success the project record is updated and we
  // re-render to drop the scratch banner.
  function openSavePathModal(p) {
    const base = (p.path || '').split('/').pop() || p.name;
    // Strip the scratch-hash suffix from the directory name when
    // pre-filling so the saved location reads as `<name>` not
    // `<name>-<hash>`.
    const cleanName = base.replace(/-[a-f0-9]{8}$/, '');
    const homeHint  = window.__homeDir || '~';
    const defaultTarget = `${homeHint}/projects/${cleanName}`;

    const body = document.createElement('div');
    body.innerHTML = `
      <div class="muted" style="margin-bottom:10px">
        Moves <code>${escapeHtml(p.path)}</code> to a permanent
        location under your home directory. The project record is
        updated so the dashboard keeps tracking it.
      </div>
      <label class="field-label">Target path</label>
      <input type="text" class="csm-target" value="${escapeHtml(defaultTarget)}"
             style="width:100%" autofocus>
      <div class="muted" style="font-size:11px;margin-top:4px">
        Must be under your home directory. Parent dirs are created
        automatically. Cancel if you'd rather pick the path manually
        from Settings.
      </div>
    `;
    const foot = document.createElement('div');
    foot.style.display = 'flex'; foot.style.gap = '8px'; foot.style.width = '100%';
    const cancel = document.createElement('button'); cancel.textContent = 'Cancel';
    const submit = document.createElement('button');
    submit.className = 'primary'; submit.textContent = 'Save';
    const spacer = document.createElement('div'); spacer.style.flex = '1';
    foot.appendChild(cancel); foot.appendChild(spacer); foot.appendChild(submit);

    const modal = openModal({ title: 'Save to project list', subtitle: p.name, body, footer: foot });
    cancel.addEventListener('click', () => modal.close());
    submit.addEventListener('click', async () => {
      const target = body.querySelector('.csm-target').value.trim();
      if (!target) { toast('Target path required', '', 'err'); return; }
      submit.disabled = true; submit.textContent = 'Saving…';
      try {
        const r = await api(`/api/projects/${p.id}/save`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ targetPath: target }),
        });
        if (r?.ok) {
          toast('Saved', `Moved to ${r.project.path}`, 'ok');
          modal.close();
          await reload();
          // Re-render the now-non-scratch project — banner will be
          // gone, Code tab unchanged otherwise.
          renderTab(document.querySelector('.project-tab-content'), r.project);
        } else {
          toast('Save failed', r?.error || 'unknown error', 'err');
          submit.disabled = false; submit.textContent = 'Save';
        }
      } catch (e) {
        toast('Save failed', e?.message || String(e), 'err');
        submit.disabled = false; submit.textContent = 'Save';
      }
    });
  }

  function renderJustPublishedBanner(p, repoMeta) {
    const wrap = document.createElement('div');
    wrap.className = 'code-published-banner';
    const shareUrl = repoMeta?.repo
      ? `nostr://${shortPubkey(repoMeta.repo.pubkey)}/${repoMeta.repo.identifier}`
      : '';
    wrap.innerHTML = `
      <div class="cpb-icon">✓</div>
      <div class="cpb-body">
        <div class="cpb-title">Published to ngit</div>
        <div class="cpb-sub muted">
          Anyone can now clone with this URL:
          ${shareUrl ? `<code class="cpb-url">${escapeHtml(shareUrl)}</code>` : '<em>(detecting clone URL…)</em>'}
        </div>
      </div>
      ${shareUrl ? `<span class="cpb-copy"></span>` : ''}
      <button class="cpb-dismiss" aria-label="Dismiss">×</button>
    `;
    if (shareUrl) {
      wrap.querySelector('.cpb-copy').appendChild(copyBtn(shareUrl));
    }
    wrap.querySelector('.cpb-dismiss').addEventListener('click', () => wrap.remove());
    return wrap;
  }

  function renderCodeHeader(p, pubState, repoMeta, gitState) {
    const wrap = document.createElement('div');
    wrap.className = 'code-header';

    const repo = repoMeta?.repo;          // null when local-only
    const name = repo?.name || pubState?.detectedName || p.name;
    const desc = repo?.description || pubState?.detectedDescription || '';

    // Working-tree status badge. Phase 7: plain English replaces the
    // M·N ↑N ↓N glyphs — friendlier for non-developer users and
    // still scannable for power users. Hidden entirely when there's
    // nothing to report (clean + in-sync).
    let badge = '';
    if (gitState && gitState.backend !== 'local-only') {
      const parts = [];
      if (gitState.dirty)        parts.push(`<span class="code-badge-warn">unsaved changes</span>`);
      if (gitState.ahead  > 0)   parts.push(`<span class="code-badge-up">${gitState.ahead} ahead</span>`);
      if (gitState.behind > 0)   parts.push(`<span class="code-badge-down">${gitState.behind} behind</span>`);
      if (parts.length) {
        badge = `<span class="code-badge" title="working tree state relative to the remote">${parts.join(' · ')}</span>`;
      }
    }

    // Maintainer + clone chips only for published projects.
    // Phase 5: verified vs candidate maintainer split.
    // Phase 7: clone URLs become a real dropdown (grouped by
    // protocol) rather than a count chip — copy-to-clipboard from
    // the dropdown menu so the user can grab a URL without
    // leaving the Code tab.
    let chips = '';
    let cloneDropdown = null;
    if (repo) {
      const ms = repoMeta.maintainerSet;
      const verifiedCount = ms ? ms.verified.length     : (repo.maintainers?.length || 0);
      const candidateCount = ms ? ms.candidatesOnly.length : 0;
      const cloneUrls = (ms && ms.clone.length > 0) ? ms.clone : (repo.clone || []);
      const chipParts = [];
      if (verifiedCount > 0) {
        chipParts.push(`<span class="code-chip code-chip-verified" title="Verified — published own kind-30617 under this coordinate"><span class="k">✓ verified</span><span class="v">${verifiedCount}</span></span>`);
      }
      if (candidateCount > 0) {
        chipParts.push(`<span class="code-chip code-chip-candidate" title="Claimed as maintainer by the announcement but has not published their own kind-30617 — cannot grant authority on this repo"><span class="k">⚠ candidate</span><span class="v">${candidateCount}</span></span>`);
      }
      const hashtags = (ms && ms.hashtags.length > 0) ? ms.hashtags : (repo.hashtags || []);
      for (const t of hashtags.slice(0, 4)) {
        chipParts.push(`<span class="code-chip code-chip-tag">#${escapeHtml(t)}</span>`);
      }
      chips = `<div class="code-chips">${chipParts.join('')}</div>`;
      if (cloneUrls.length > 0) cloneDropdown = buildCloneDropdown(cloneUrls);
    }

    // Phase 8 — read-only maintainers panel + Announcement events
    // inspector. Mirrors gitworkshop / shakespeare.diy: both treat
    // their UIs as read+inspect surfaces and keep mutation in the
    // ngit CLI. Panel summarises who's authoritative; the "View
    // announcement events" link opens a modal showing each verified
    // maintainer's raw 30617 with timestamp, "selected" badge for the
    // event whose fields drive the active display, and a Raw event
    // JSON viewer.
    const maintainersPanel = repo ? buildMaintainersPanel(repo, repoMeta?.maintainerSet) : '';

    wrap.innerHTML = `
      <div class="code-title-row">
        <h2 class="code-title">${escapeHtml(name)}</h2>
        ${badge}
        <span class="code-clone-slot"></span>
      </div>
      ${desc ? `<div class="code-desc">${escapeHtml(desc)}</div>` : ''}
      ${chips}
      ${maintainersPanel}
    `;
    if (cloneDropdown) {
      wrap.querySelector('.code-clone-slot').appendChild(cloneDropdown);
    }
    wrap.querySelectorAll('.copy-slot').forEach(s => s.appendChild(copyBtn(s.dataset.copy)));
    // "View announcement events" trigger — wired only when the panel
    // rendered AND we have a serialised maintainerSet to inspect.
    const announceBtn = wrap.querySelector('.maintainers-view-events');
    if (announceBtn && repoMeta?.maintainerSet) {
      announceBtn.addEventListener('click', () => {
        openAnnouncementsModal(repo, repoMeta.maintainerSet);
      });
    }
    // Resolve profiles for the maintainers shown in the Code-tab panel
    // so the npub fallbacks upgrade to real names on the next tick. We
    // only need to repaint the panel's .maintainers-list (not the whole
    // wrap) — keeps any other listeners on the wrap intact.
    if (repo && repoMeta?.maintainerSet) {
      const ms = repoMeta.maintainerSet;
      const allPubkeys = [
        repo.pubkey,
        ...(ms.verified || []),
        ...(ms.candidatesOnly || []),
      ];
      const relays = Array.isArray(repo.relays) ? repo.relays : [];
      resolveProfiles(allPubkeys, { relays }).then(() => {
        if (!wrap.isConnected) return;
        const fresh = buildMaintainersPanel(repo, ms);
        const oldPanel = wrap.querySelector('.maintainers-panel');
        if (oldPanel) {
          const tmp = document.createElement('div');
          tmp.innerHTML = fresh;
          const newPanel = tmp.querySelector('.maintainers-panel');
          if (newPanel) {
            oldPanel.replaceWith(newPanel);
            newPanel.querySelectorAll('.copy-slot').forEach(s => s.appendChild(copyBtn(s.dataset.copy)));
            // Re-wire the View announcement events button on the fresh panel.
            const btn = newPanel.querySelector('.maintainers-view-events');
            if (btn) btn.addEventListener('click', () => openAnnouncementsModal(repo, ms));
          }
        }
      });
    }
    return wrap;
  }

  // Render the maintainers list as `anchor` + verified + candidate rows.
  // Repo `pubkey` is the trust anchor (always authoritative by definition);
  // verified are pubkeys that re-announced under the same identifier;
  // candidate-only are claimed by the anchor but haven't re-announced.
  // Returns an HTML string — caller wires copy-slots after innerHTML.
  function buildMaintainersPanel(repo, ms) {
    const anchor = repo.pubkey;
    const verified  = ms?.verified       || [];
    const candidate = ms?.candidatesOnly || [];
    // De-dupe: anchor is always shown explicitly first; verified set
    // already contains it by construction so filter that out. Candidate
    // pubkeys are disjoint from verified by computeMaintainerSet design.
    const seen = new Set([anchor]);
    const rows = [{ pubkey: anchor, role: 'anchor' }];
    for (const pk of verified) {
      if (seen.has(pk)) continue;
      seen.add(pk);
      rows.push({ pubkey: pk, role: 'verified' });
    }
    for (const pk of candidate) {
      if (seen.has(pk)) continue;
      seen.add(pk);
      rows.push({ pubkey: pk, role: 'candidate' });
    }
    if (rows.length === 0) return '';
    const roleLabel = {
      anchor:    { text: 'owner',     title: 'Trust anchor — published the repo announcement; always authoritative.' },
      verified:  { text: 'verified',  title: 'Published their own kind-30617 under this coordinate — fully authorised.' },
      candidate: { text: 'candidate', title: 'Listed as a maintainer but has not published their own kind-30617 — accepted permissively for gitworkshop parity.' },
    };
    const rowHtml = rows.map(({ pubkey, role }) => {
      let npub = pubkey;
      try {
        if (window.NostrTools?.nip19) npub = window.NostrTools.nip19.npubEncode(pubkey);
      } catch { /* fall back to hex on encode failure */ }
      // Prefer kind-0 display name when the profile cache has one;
      // falls back to truncated npub. The Code-tab page kicks off
      // resolveProfiles after first paint so this upgrades on re-render.
      const display = profileNameOf(pubkey);
      const r = roleLabel[role];
      return `
        <div class="maintainers-row">
          <span class="maintainers-role maintainers-role-${role}" title="${escapeHtml(r.title)}">${escapeHtml(r.text)}</span>
          <code class="maintainers-pk">${escapeHtml(display)}</code>
          <span class="copy-slot" data-copy="${escapeHtml(npub)}"></span>
        </div>
      `;
    }).join('');
    // Show the "View announcement events" link only when we have at
    // least one verified 30617 to inspect. With zero verified events
    // the modal would render empty.
    const hasEvents = (ms?.events?.length || 0) > 0;
    const inspector = hasEvents
      ? `<button class="maintainers-view-events" type="button" title="Inspect each maintainer's raw kind-30617 announcement event">View announcement events</button>`
      : '';
    return `
      <div class="maintainers-panel">
        <div class="maintainers-head-row">
          <div class="maintainers-head muted">Maintainers</div>
          ${inspector}
        </div>
        <div class="maintainers-list">${rowHtml}</div>
      </div>
    `;
  }

  // gitworkshop-parity "Announcement events" inspector. The kind-30617
  // event drives a repo's display fields, and a multi-maintainer repo
  // has one such event per maintainer who's published their own. Show
  // them all so the user can see exactly which event each field is
  // sourced from. The "selected" badge marks the event whose fields
  // the dashboard currently treats as authoritative for display
  // (newest verified by created_at — matches MaintainerSet.display.pubkey).
  // ── Edit Repository form modal (Phase 3b) ────────────────────────────
  //
  // Republishes the kind-30617 announcement via POST /announce. Server
  // constructs the event template, signs via the persisted Amber pairing
  // (signEventWithSavedBunker), publishes to the relay union, and busts
  // the repo-30617 cache. Form is pre-populated from the current
  // announcement; submit sends the FULL new value of every field (not a
  // delta) because the server replaces the announcement wholesale —
  // omitted fields would otherwise be lost on the next render.
  //
  // Field parity with gitworkshop's edit form (per the screenshots):
  //   - Name, Description
  //   - Website (multi-value)
  //   - Topics (chip-based)
  //   - Earliest unique commit
  //   - GRASP servers (multi-value; server treats as a relay subset)
  //   - Other relays (multi-value, wss://)
  //   - Other git servers (clone URLs, multi-value, https://)
  //   - Other maintainers — npub or hex, hex-decoded server-side
  //   - Custom tags (advanced) — preserves forward-compat tags
  function openEditRepositoryModal(p, repo, ms, onSaved) {
    // Pre-fill arrays mutated by add/remove buttons in-modal. The
    // confirmed value is the array state at submit time.
    const state = {
      name:        repo.name        || '',
      description: repo.description || '',
      web:         (repo.web || []).slice(),
      topics:      (repo.hashtags || []).slice(),
      euc:         repo.euc || '',
      // The 30617 doesn't distinguish GRASP from other relays — that's
      // a derived UI grouping. For the form we recompute the GRASP set
      // (hosts appearing in both relays + clone of any announcement) so
      // the user can edit each group independently. On submit we
      // collapse back to a single relays list + clone list.
      graspServers: deriveGraspHostsForEdit(ms),
      otherRelays:  deriveOtherRelaysForEdit(ms),
      cloneUrls:    (repo.clone || []).slice(),
      otherMaintainers: ((ms?.events || [])
        // Include the anchor's own maintainers tag — that's whose
        // endorsement list the user is editing.
        .find(e => e.pubkey === repo.pubkey)?.tags || [])
        .filter(t => Array.isArray(t) && t[0] === 'maintainers')
        .flatMap(t => t.slice(1))
        .filter(p => /^[0-9a-f]{64}$/.test(p) && p !== repo.pubkey),
      customTags: extractEditableCustomTags(ms, repo),
    };

    const body = document.createElement('div');
    body.className = 'edit-repo-modal';
    // Scoping note: a 30617 announcement is per-maintainer. Saving here
    // republishes YOUR announcement only — co-maintainers' announcements
    // are untouched. Important for multi-maintainer repos where the user
    // could otherwise read this form as repo-global.
    const isMultiMaintainer = (ms?.events?.length || 0) > 1;
    const renderBody = () => {
      body.innerHTML = `
        ${isMultiMaintainer ? `
          <div class="edit-repo-banner muted">
            You're editing <strong>your own</strong> announcement event. Co-maintainers' announcements
            are independent — fields like clone URLs and relays here are yours alone, and the
            "Other relays" section on About will continue to surface other maintainers' contributions
            via the union.
          </div>
        ` : ''}

        <div class="edit-repo-section">
          <label class="edit-repo-label" for="erm-name">Name</label>
          <input id="erm-name" class="edit-repo-input" type="text" value="${escapeHtml(state.name)}" />
        </div>

        <div class="edit-repo-section">
          <label class="edit-repo-label" for="erm-desc">Description</label>
          <textarea id="erm-desc" class="edit-repo-textarea" rows="3">${escapeHtml(state.description)}</textarea>
        </div>

        <div class="edit-repo-section">
          <label class="edit-repo-label">Website</label>
          ${multiValueRows(state.web, 'web', 'https://example.com')}
        </div>

        <div class="edit-repo-section">
          <label class="edit-repo-label">Topics</label>
          <div class="edit-repo-chips">
            ${state.topics.map((t, i) => `<span class="edit-repo-chip"><span>${escapeHtml(t)}</span><button type="button" class="edit-repo-chip-x" data-topic-idx="${i}" aria-label="remove">×</button></span>`).join('')}
            <input class="edit-repo-input edit-repo-chip-input" type="text" placeholder="Add topic and press Enter" data-input="topic" />
          </div>
        </div>

        <div class="edit-repo-section">
          <label class="edit-repo-label" for="erm-euc">Earliest unique commit
            <span class="muted">(40-char git SHA — set automatically by ngit init; rarely needs editing)</span>
          </label>
          <input id="erm-euc" class="edit-repo-input" type="text" maxlength="40" value="${escapeHtml(state.euc)}" />
        </div>

        <div class="edit-repo-section">
          <div class="edit-repo-section-head">Infrastructure</div>
          <div class="muted edit-repo-help">
            GRASP servers serve both git hosting and a nostr relay at the same domain
            (e.g. <code>git.shakespeare.diy</code>). Other relays are nostr-only.
          </div>

          <label class="edit-repo-label">GRASP servers <span class="muted">(wss://)</span></label>
          ${multiValueRows(state.graspServers, 'grasp', 'wss://git.example.com')}

          <label class="edit-repo-label" style="margin-top:8px">Other relays <span class="muted">(wss://)</span></label>
          ${multiValueRows(state.otherRelays, 'relay', 'wss://relay.example.com')}

          <label class="edit-repo-label" style="margin-top:8px">Clone URLs <span class="muted">(https:// or git://)</span></label>
          ${multiValueRows(state.cloneUrls, 'clone', 'https://git.example.com/npub.../repo.git')}
        </div>

        <div class="edit-repo-section">
          <label class="edit-repo-label">Other maintainers <span class="muted">(your acknowledged co-maintainers — they need to publish their own 30617 to count as authoritative)</span></label>
          ${multiValueRows(state.otherMaintainers, 'maintainer', 'npub1… or 64-char hex')}
        </div>

        <details class="edit-repo-section edit-repo-advanced">
          <summary>Custom tags <span class="muted">(advanced)</span></summary>
          <div class="muted edit-repo-help">
            Tags not recognised by this form are preserved here. Editing them lets you
            attach forward-compat data — nostr-station auto-includes <code>client = nostr-station</code>
            on save unless you set a different <code>client</code> value yourself.
          </div>
          ${state.customTags.map((tag, i) => `
            <div class="edit-repo-tag-row">
              <input class="edit-repo-input edit-repo-tag-name" data-tag-idx="${i}" data-field="name" value="${escapeHtml(tag[0] || '')}" placeholder="tag name" />
              <input class="edit-repo-input edit-repo-tag-value" data-tag-idx="${i}" data-field="value" value="${escapeHtml((tag.slice(1)).join(' '))}" placeholder="value (space-separated for multi-value)" />
              <button type="button" class="edit-repo-row-x" data-tag-idx="${i}" aria-label="remove">×</button>
            </div>
          `).join('')}
          <button type="button" class="edit-repo-add" data-add="tag">+ add custom tag</button>
        </details>
      `;
      wireBody();
    };

    function multiValueRows(values, kind, placeholder) {
      const rows = values.map((v, i) => `
        <div class="edit-repo-row">
          <input class="edit-repo-input" type="text" data-kind="${kind}" data-idx="${i}" value="${escapeHtml(v)}" placeholder="${escapeHtml(placeholder)}" />
          <button type="button" class="edit-repo-row-x" data-kind="${kind}" data-idx="${i}" aria-label="remove">×</button>
        </div>
      `).join('');
      return rows + `<button type="button" class="edit-repo-add" data-add="${kind}">+ add</button>`;
    }

    function wireBody() {
      // Plain inputs — debounced to avoid thrashing state on every keystroke.
      body.querySelector('#erm-name').addEventListener('input', e => { state.name = e.target.value; });
      body.querySelector('#erm-desc').addEventListener('input', e => { state.description = e.target.value; });
      body.querySelector('#erm-euc').addEventListener('input', e => { state.euc = e.target.value.trim().toLowerCase(); });

      // Multi-value rows: editing an entry updates the array; remove
      // button drops it; add button appends a blank.
      body.querySelectorAll('input[data-kind]').forEach(el => {
        el.addEventListener('input', () => {
          const kind = el.dataset.kind;
          const idx = Number(el.dataset.idx);
          const list = listForKind(kind);
          list[idx] = el.value;
        });
      });
      body.querySelectorAll('.edit-repo-row-x[data-kind]').forEach(btn => {
        btn.addEventListener('click', () => {
          const list = listForKind(btn.dataset.kind);
          list.splice(Number(btn.dataset.idx), 1);
          renderBody();
        });
      });
      body.querySelectorAll('.edit-repo-add[data-add]').forEach(btn => {
        btn.addEventListener('click', () => {
          const kind = btn.dataset.add;
          if (kind === 'tag') state.customTags.push(['', '']);
          else listForKind(kind).push('');
          renderBody();
        });
      });

      // Topics chip-input — Enter to commit, click × to remove.
      body.querySelectorAll('.edit-repo-chip-x[data-topic-idx]').forEach(btn => {
        btn.addEventListener('click', () => {
          state.topics.splice(Number(btn.dataset.topicIdx), 1);
          renderBody();
        });
      });
      const topicInput = body.querySelector('[data-input="topic"]');
      if (topicInput) {
        topicInput.addEventListener('keydown', e => {
          if (e.key === 'Enter' && topicInput.value.trim()) {
            e.preventDefault();
            const v = topicInput.value.trim().replace(/^#/, '');
            if (v && !state.topics.includes(v)) state.topics.push(v);
            renderBody();
            // Re-focus into the input after re-render for fast multi-add.
            setTimeout(() => body.querySelector('[data-input="topic"]')?.focus(), 0);
          }
        });
      }

      // Custom tag rows: name + value (space-separated) edits.
      body.querySelectorAll('.edit-repo-tag-row input[data-tag-idx]').forEach(el => {
        el.addEventListener('input', () => {
          const idx = Number(el.dataset.tagIdx);
          const field = el.dataset.field;
          const row = state.customTags[idx];
          if (!row) return;
          if (field === 'name') row[0] = el.value;
          else {
            const values = el.value.split(/\s+/).filter(Boolean);
            row.splice(1, row.length - 1, ...values);
          }
        });
      });
      body.querySelectorAll('.edit-repo-row-x[data-tag-idx]').forEach(btn => {
        btn.addEventListener('click', () => {
          state.customTags.splice(Number(btn.dataset.tagIdx), 1);
          renderBody();
        });
      });
    }

    function listForKind(kind) {
      switch (kind) {
        case 'web':        return state.web;
        case 'grasp':      return state.graspServers;
        case 'relay':      return state.otherRelays;
        case 'clone':      return state.cloneUrls;
        case 'maintainer': return state.otherMaintainers;
        default: return [];
      }
    }

    renderBody();

    const foot = document.createElement('div');
    foot.className = 'edit-repo-foot';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'primary';
    save.textContent = 'Save changes';
    foot.appendChild(save); foot.appendChild(cancel);

    const modal = openModal({
      title:    'Edit repository',
      subtitle: repo.name || repo.identifier,
      body,
      footer:   foot,
    });
    cancel.addEventListener('click', () => modal.close());
    save.addEventListener('click', async () => {
      // Commit any pending text in the topic chip-input that the user
      // didn't press Enter on. Otherwise typing a topic and clicking
      // Save loses the topic silently — confusing.
      const pendingTopic = body.querySelector('[data-input="topic"]')?.value?.trim().replace(/^#/, '');
      if (pendingTopic && !state.topics.includes(pendingTopic)) {
        state.topics.push(pendingTopic);
      }

      save.disabled = true;
      save.textContent = 'Signing via Amber…';
      // GRASP and Other relays are treated as one `relays` list on
      // submit — server stores them as a single relays tag. The split
      // is purely a UI affordance.
      const allRelays = [...state.graspServers, ...state.otherRelays]
        .map(s => s.trim()).filter(Boolean)
        .filter((v, i, a) => a.indexOf(v) === i);
      // Decode npub → hex for any maintainer entered as npub.
      const decodeMaintainer = (v) => {
        v = v.trim();
        if (!v) return null;
        if (/^[0-9a-f]{64}$/i.test(v)) return v.toLowerCase();
        if (/^npub1[0-9a-z]+$/.test(v) && window.NostrTools?.nip19) {
          try {
            const d = window.NostrTools.nip19.decode(v);
            if (d.type === 'npub' && typeof d.data === 'string') return d.data;
          } catch {}
        }
        return null;
      };
      const maintainers = state.otherMaintainers.map(decodeMaintainer).filter(Boolean);
      const customTags = state.customTags
        .filter(t => Array.isArray(t) && typeof t[0] === 'string' && t[0].trim())
        .map(t => [t[0].trim(), ...t.slice(1).filter(v => typeof v === 'string' && v.length > 0)]);

      const payload = {
        name:        state.name.trim(),
        description: state.description,
        web:         state.web.map(s => s.trim()).filter(Boolean),
        clone:       state.cloneUrls.map(s => s.trim()).filter(Boolean),
        relays:      allRelays,
        hashtags:    state.topics.map(s => s.trim().replace(/^#/, '')).filter(Boolean),
        maintainers,
        euc:         state.euc || null,
        customTags,
      };
      try {
        // silent: true so api() doesn't auto-toast on non-2xx — we
        // produce a higher-quality, action-specific toast in the
        // catch (with per-relay reasons or the bunker error).
        const r = await api(`/api/projects/${p.id}/announce`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify(payload),
        }, { silent: true });
        if (r?.ok && r?.accepted > 0) {
          toast('Repository updated', `${r.accepted}/${r.targets} relays accepted the new announcement`, 'ok');
          modal.close();
          if (typeof onSaved === 'function') onSaved();
        } else {
          // Partial failure: at least we signed. Surface relay reasons.
          const reasons = (r?.publish || []).filter(x => !x.ok).map(x => `${x.relay}: ${x.reason || 'no OK'}`).slice(0, 3).join('\n');
          toast('No relays accepted', reasons || r?.error || 'unknown error', 'err');
          save.disabled = false;
          save.textContent = 'Save changes';
        }
      } catch (e) {
        // Stack trace into the console for actual debugging — toast is
        // for the user, console.warn is for us when they paste a screenshot.
        console.warn('[edit-repo] announce failed:', e);
        toast('Save failed', String(e?.message || e), 'err');
        save.disabled = false;
        save.textContent = 'Save changes';
      }
    });
  }

  // Derive the GRASP-host subset for the edit form. Same heuristic as
  // analyseAnnouncements but operating per-announcement: a host is GRASP
  // if any verified maintainer's 30617 lists it as BOTH a relay and a
  // clone URL host. Returns the raw wss:// URLs from the relays tag so
  // editing preserves the exact value (port, path) the user originally
  // had.
  function deriveGraspHostsForEdit(ms) {
    const events = Array.isArray(ms?.events) ? ms.events : [];
    const safeHost = (url) => { try { return new URL(url).host; } catch { return null; } };
    const graspHosts = new Set();
    for (const ev of events) {
      const relays = (ev.tags || []).filter(t => t[0] === 'relays').flatMap(t => t.slice(1));
      const clones = (ev.tags || []).filter(t => t[0] === 'clone').flatMap(t => t.slice(1));
      const relayHosts = new Set(relays.map(safeHost).filter(Boolean));
      const cloneHosts = new Set(clones.map(safeHost).filter(Boolean));
      for (const h of relayHosts) if (cloneHosts.has(h)) graspHosts.add(h);
    }
    // From the anchor's own announcement (events[0]), surface the
    // wss:// URLs whose host is in the GRASP set.
    const anchorRelays = events[0]
      ? (events[0].tags || []).filter(t => t[0] === 'relays').flatMap(t => t.slice(1))
      : [];
    return anchorRelays.filter(u => {
      const h = safeHost(u); return h && graspHosts.has(h);
    });
  }

  function deriveOtherRelaysForEdit(ms) {
    const events = Array.isArray(ms?.events) ? ms.events : [];
    const safeHost = (url) => { try { return new URL(url).host; } catch { return null; } };
    const graspHosts = new Set();
    for (const ev of events) {
      const relays = (ev.tags || []).filter(t => t[0] === 'relays').flatMap(t => t.slice(1));
      const clones = (ev.tags || []).filter(t => t[0] === 'clone').flatMap(t => t.slice(1));
      const relayHosts = new Set(relays.map(safeHost).filter(Boolean));
      const cloneHosts = new Set(clones.map(safeHost).filter(Boolean));
      for (const h of relayHosts) if (cloneHosts.has(h)) graspHosts.add(h);
    }
    const anchorRelays = events[0]
      ? (events[0].tags || []).filter(t => t[0] === 'relays').flatMap(t => t.slice(1))
      : [];
    return anchorRelays.filter(u => {
      const h = safeHost(u); return h && !graspHosts.has(h);
    });
  }

  // The "advanced" custom-tags editor only surfaces tags the form
  // doesn't already cover. The server-side template builder is the
  // source of truth for which names are emitted natively — this is a
  // copy of that set so the user doesn't see duplicates in the form.
  function extractEditableCustomTags(ms, repo) {
    const KNOWN = new Set(['d', 'r', 'name', 'description', 'clone', 'web', 'relays', 't', 'maintainers', 'alt', 'blossoms']);
    const anchor = (ms?.events || []).find(e => e.pubkey === repo.pubkey);
    if (!anchor || !Array.isArray(anchor.tags)) return [];
    return anchor.tags
      .filter(t => Array.isArray(t) && typeof t[0] === 'string' && !KNOWN.has(t[0]))
      .map(t => t.map(v => typeof v === 'string' ? v : ''));
  }

  // Share links — gitworkshop-style helper. The kind-30617 announcement
  // is identified by an NIP-19 naddr that bundles the coordinate
  // (30617:pubkey:identifier) plus the relay hints from the announcement,
  // and by the nostr:// URL that ngit-aware git plugins consume. Both
  // are useful: naddr for embedding/linking in other nostr clients, the
  // nostr:// for "git clone …" from a terminal. Copy buttons on both.
  function openShareLinksModal(p, repo) {
    const naddr = (() => {
      try {
        if (!window.NostrTools?.nip19) return '';
        return window.NostrTools.nip19.naddrEncode({
          kind:       30617,
          pubkey:     repo.pubkey,
          identifier: repo.identifier,
          // Cap relay hints so the encoded naddr stays compact — first
          // few are usually the maintainer's own.
          relays:     (repo.relays || []).slice(0, 4),
        });
      } catch { return ''; }
    })();
    const ngitRemote = window.__projectsCache?.find?.(x => x.id === p.id)?.remotes?.ngit
      ?? p.remotes?.ngit
      ?? '';
    const gitworkshopUrl = naddr ? `https://gitworkshop.dev/${naddr}` : '';
    const body = document.createElement('div');
    body.className = 'share-modal';
    const row = (label, value, hint) => value ? `
      <div class="share-row">
        <div class="share-label">${escapeHtml(label)}${hint ? ` <span class="muted">${escapeHtml(hint)}</span>` : ''}</div>
        <div class="share-value">
          <code>${escapeHtml(value)}</code>
          <span class="copy-slot" data-copy="${escapeHtml(value)}"></span>
        </div>
      </div>
    ` : '';
    body.innerHTML = `
      ${row('naddr', naddr, '(nostr address — NIP-19)')}
      ${row('nostr:// URL', ngitRemote, '(ngit clone)')}
      ${row('gitworkshop.dev', gitworkshopUrl, '(browser link)')}
    `;
    body.querySelectorAll('.copy-slot').forEach(s => s.appendChild(copyBtn(s.dataset.copy)));
    openModal({
      title:    'Share links',
      subtitle: repo.name || repo.identifier,
      body,
    });
  }

  // Confirm + run the project-unregister flow. The nostr events stay
  // on relays — that's an inherent property of NIP-34 announcements
  // and out of scope for a dashboard. The tooltip on the Delete button
  // states this explicitly so users don't expect a true delete.
  async function openDeleteProjectConfirm(p) {
    const ok = await confirmDestructive({
      title: 'Remove from dashboard',
      description:
        `Unregisters "${p.name}" from nostr-station. The kind-30617 announcement and all related ` +
        `nostr events remain on the relays they were published to — there is no on-chain delete in NIP-34. ` +
        `Files on disk are not touched either; remove them manually if desired.`,
      confirmLabel: 'Remove',
    });
    if (!ok) return;
    try {
      await api(`/api/projects/${p.id}`, { method: 'DELETE' });
      toast('Project removed', p.name, 'ok');
      state.view = 'list'; state.projectId = null;
      reload();
    } catch (e) {
      toast('Remove failed', String(e?.message || e), 'err');
    }
  }

  function openAnnouncementsModal(repo, ms) {
    const events = Array.isArray(ms?.events) ? ms.events : [];
    const selectedPubkey = ms?.display?.pubkey || repo?.pubkey || '';
    const candidates = Array.isArray(ms?.candidatesOnly) ? ms.candidatesOnly : [];
    const fmtAt = (sec) => {
      if (!sec) return '—';
      const d = new Date(sec * 1000);
      return d.toLocaleString(undefined, {
        month: 'short', day: 'numeric', year: 'numeric',
        hour: 'numeric', minute: '2-digit',
      });
    };

    // Pure painter — reads names from the profile cache. Called once
    // synchronously, then again after resolveProfiles upgrades the cache.
    const paint = () => {
      const eventRows = events.map((ev, i) => {
        const display = profileNameOf(ev.pubkey);
        const pic = profilePictureOf(ev.pubkey);
        const avatar = pic
          ? `<img class="ann-avatar ann-avatar-img" src="${escapeHtml(pic)}" alt="" referrerpolicy="no-referrer" loading="lazy">`
          : hasResolvedProfileName(ev.pubkey)
            ? `<div class="ann-avatar" aria-hidden="true">${escapeHtml(display.slice(0, 2).toUpperCase())}</div>`
            : `<div class="ann-avatar ann-avatar-anon" aria-hidden="true" title="Profile not resolved">●</div>`;
        const isSelected = ev.pubkey === selectedPubkey;
        return `
          <div class="ann-row" data-event-idx="${i}">
            <div class="ann-row-head">
              ${avatar}
              <div class="ann-row-main">
                <div class="ann-row-name"><code>${escapeHtml(display)}</code>${isSelected ? `<span class="ann-selected">selected</span>` : ''}</div>
                <div class="ann-row-meta muted">${escapeHtml(fmtAt(ev.created_at))}</div>
              </div>
              <button class="ann-raw-toggle" type="button" data-event-idx="${i}">{ } Raw event</button>
            </div>
            <pre class="ann-raw-json" hidden></pre>
          </div>
        `;
      }).join('');

      const candidateBlock = candidates.length > 0 ? `
        <div class="ann-candidates">
          <div class="ann-section-head muted">Claimed but not announced (${candidates.length})</div>
          <div class="ann-candidates-list">
            ${candidates.map(pk => `<code class="ann-candidate-pk" title="Listed as a maintainer but has not published their own kind-30617">${escapeHtml(profileNameOf(pk))}</code>`).join('')}
          </div>
        </div>
      ` : '';

      body.innerHTML = `
        <div class="ann-explainer muted">
          In a multi-maintainer repository each maintainer publishes their own announcement event.
          Some fields (relays, clone URLs, maintainers) are <strong>unioned across all announcements</strong>,
          while others (name, description) are taken from the <strong>most recently updated</strong> announcement
          — that one is marked <span class="ann-selected">selected</span>.
        </div>
        <div class="ann-list">${eventRows || `<div class="muted">No verified announcement events found.</div>`}</div>
        ${candidateBlock}
      `;
      body.querySelectorAll('.ann-raw-toggle').forEach(btn => {
        btn.addEventListener('click', () => {
          const idx = Number(btn.dataset.eventIdx);
          const ev = events[idx];
          if (!ev) return;
          const pre = btn.closest('.ann-row').querySelector('.ann-raw-json');
          if (pre.hidden) {
            pre.textContent = JSON.stringify(ev, null, 2);
            pre.hidden = false;
            btn.classList.add('active');
          } else {
            pre.hidden = true;
            pre.textContent = '';
            btn.classList.remove('active');
          }
        });
      });
    };

    const body = document.createElement('div');
    body.className = 'ann-modal';
    paint();
    const modal = openModal({
      title:    'Announcement events',
      subtitle: repo?.name || repo?.identifier || '',
      body,
    });
    // Kick off resolution for every pubkey we display + the candidate
    // set, then re-paint once. Modal close before resolution = re-paint
    // is a noop because the body is detached but innerHTML write is still
    // safe; we cheap-guard with body.isConnected.
    const allPubkeys = [...events.map(e => e.pubkey), ...candidates];
    const relays = Array.isArray(repo?.relays) ? repo.relays : [];
    resolveProfiles(allPubkeys, { relays }).then(() => {
      if (!body.isConnected) return;
      paint();
    });
    return modal;
  }

  // Phase 7: clone URLs grouped by transport (Nostr / HTTPS / SSH /
  // Git / Other) — mirrors nostrhub's pattern. Click any row to copy
  // that URL; click the toggle to open/close. Closes on outside
  // click. Returns a DOM node; caller decides where to mount it.
  function buildCloneDropdown(urls) {
    const wrap = document.createElement('div');
    wrap.className = 'clone-dropdown';
    const groups = {
      Nostr:  urls.filter(u => /^nostr:/i.test(u)),
      HTTPS:  urls.filter(u => /^https:/i.test(u)),
      HTTP:   urls.filter(u => /^http:/i.test(u)),
      SSH:    urls.filter(u => /^(ssh|git\+ssh):/i.test(u) || /^[^/]+@[^:]+:/.test(u)),
      Git:    urls.filter(u => /^git:/i.test(u)),
    };
    // Catch-all for anything that didn't slot into the named groups.
    const classified = new Set([
      ...groups.Nostr, ...groups.HTTPS, ...groups.HTTP,
      ...groups.SSH, ...groups.Git,
    ]);
    const other = urls.filter(u => !classified.has(u));
    if (other.length) groups.Other = other;

    const groupRows = Object.entries(groups)
      .filter(([, list]) => list.length > 0)
      .map(([label, list]) => `
        <div class="clone-group">
          <div class="clone-group-head">${escapeHtml(label)}</div>
          ${list.map((u) => `
            <div class="clone-row">
              <code class="clone-url" title="Click to copy">${escapeHtml(u)}</code>
              <span class="copy-slot" data-copy="${escapeHtml(u)}"></span>
            </div>
          `).join('')}
        </div>
      `).join('');

    wrap.innerHTML = `
      <button class="clone-toggle" aria-haspopup="true" aria-expanded="false">
        ⌥ Clone ▾
      </button>
      <div class="clone-menu" hidden>${groupRows}</div>
    `;
    const toggle = wrap.querySelector('.clone-toggle');
    const menu   = wrap.querySelector('.clone-menu');
    const close = () => {
      menu.hidden = true;
      toggle.setAttribute('aria-expanded', 'false');
    };
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = menu.hidden;
      menu.hidden = !open;
      toggle.setAttribute('aria-expanded', String(open));
      if (open) {
        // Wire copy buttons + URL click-to-copy on first open.
        wrap.querySelectorAll('.copy-slot').forEach(s => {
          if (s.childElementCount === 0) s.appendChild(copyBtn(s.dataset.copy));
        });
        wrap.querySelectorAll('.clone-url').forEach(el => {
          el.onclick = () => {
            navigator.clipboard?.writeText(el.textContent || '').then(
              () => toast('Copied', el.textContent, 'ok'),
            ).catch(() => {});
          };
        });
      }
    });
    // Outside click closes the menu.
    document.addEventListener('click', (e) => {
      if (!wrap.contains(e.target)) close();
    });
    return wrap;
  }

  function renderCodeNav(p, refs, view) {
    const wrap = document.createElement('div');
    wrap.className = 'code-nav';

    // Branch/tag selector. <select> is intentional — fully keyboard-
    // accessible and matches the dashboard's existing form style.
    const branches = refs?.branches || [];
    const tags     = refs?.tags     || [];
    const refOptions = [
      ...branches.map(b => ({ value: b.name, label: b.name, group: 'branches' })),
      ...tags    .map(t => ({ value: t.name, label: t.name, group: 'tags'     })),
    ];

    let selectHtml = '';
    if (refOptions.length > 0) {
      const byGroup = (group) => refOptions
        .filter(o => o.group === group)
        .map(o => `<option value="${escapeHtml(o.value)}" ${o.value === view.ref ? 'selected' : ''}>${escapeHtml(o.label)}</option>`)
        .join('');
      selectHtml = `
        <select class="code-ref-select" aria-label="Branch or tag">
          <optgroup label="branches">${byGroup('branches')}</optgroup>
          ${tags.length > 0 ? `<optgroup label="tags">${byGroup('tags')}</optgroup>` : ''}
        </select>
      `;
    } else {
      // Fallback for the "no refs" edge case (empty repo). The user
      // sees the literal HEAD string with no surprise dropdown.
      selectHtml = `<span class="muted code-ref-static">${escapeHtml(view.ref)}</span>`;
    }

    // Breadcrumb trail. Each segment is clickable and pops the path
    // back to that level. Root segment ("/" or repo name) goes home.
    const segs = view.path ? view.path.split('/') : [];
    const crumbHtml = [
      `<button class="code-crumb code-crumb-root" data-path="">${escapeHtml(p.name)}</button>`,
      ...segs.map((seg, i) => {
        const subPath = segs.slice(0, i + 1).join('/');
        return `<span class="code-crumb-sep">/</span><button class="code-crumb" data-path="${escapeHtml(subPath)}">${escapeHtml(seg)}</button>`;
      }),
    ].join('');

    wrap.innerHTML = `
      <div class="code-nav-row">
        ${selectHtml}
        <div class="code-breadcrumb">${crumbHtml}</div>
      </div>
    `;

    const sel = wrap.querySelector('.code-ref-select');
    if (sel) sel.addEventListener('change', () => {
      view.ref = sel.value;
      view.path = '';
      view.selectedBlob = null;
      // Re-render the whole tab — branch switch invalidates files,
      // preview, and commits all at once.
      renderTab(document.querySelector('.project-tab-content'), p);
    });

    wrap.querySelectorAll('.code-crumb').forEach(btn => {
      btn.addEventListener('click', () => {
        view.path = btn.dataset.path;
        view.selectedBlob = null;
        renderTab(document.querySelector('.project-tab-content'), p);
      });
    });

    return wrap;
  }

  async function renderCodeFiles(el, p, view) {
    el.innerHTML = `<div class="muted">Loading files…</div>`;
    // Phase 7: withLog=1 asks the backend for per-entry last-commit
    // info. One bounded `git log` walk inside /repo/tree returns
    // file → most-recent-commit map; entries get a lastCommit field
    // for the file browser to display alongside name + size.
    const qs = new URLSearchParams({ ref: view.ref, path: view.path, withLog: '1' });
    let r;
    try {
      r = await api(`/api/projects/${p.id}/repo/tree?${qs}`);
    } catch (e) {
      el.innerHTML = `<div class="muted">Failed to load tree: ${escapeHtml(e?.message || String(e))}</div>`;
      return;
    }
    if (r?.error) {
      el.innerHTML = `<div class="muted">${escapeHtml(r.error)}</div>`;
      return;
    }
    const entries = Array.isArray(r?.entries) ? r.entries : [];
    if (entries.length === 0) {
      el.innerHTML = `<div class="muted">Empty.</div>`;
      return;
    }
    const rows = entries.map(e => {
      const icon = e.type === 'tree' ? '📁' : (e.type === 'commit' ? '🔗' : '📄');
      const sizeCell = e.type === 'blob' && Number.isFinite(e.size)
        ? `<span class="code-file-size muted">${fmtBytes(e.size)}</span>`
        : '<span class="code-file-size muted"></span>';
      // lastCommit cell — subject (truncated) + relative time. Blank
      // when the backend couldn't find a commit within the 200-commit
      // window. Click forwards to the relevant commit page (Phase 8
      // future hook — for now just shows the info).
      const lc = e.lastCommit;
      const commitCell = lc
        ? `<span class="code-file-commit muted" title="${escapeHtml(lc.subject)} (${escapeHtml(lc.abbrev)})">
             <span class="code-file-commit-subject">${escapeHtml(truncateSubject(lc.subject, 60))}</span>
             <span class="code-file-commit-time">${escapeHtml(fmtAgoIso(new Date((lc.timestamp || 0) * 1000).toISOString()))}</span>
           </span>`
        : '<span class="code-file-commit muted"></span>';
      return `
        <button class="code-file-row" data-name="${escapeHtml(e.name)}" data-type="${e.type}">
          <span class="code-file-icon">${icon}</span>
          <span class="code-file-name">${escapeHtml(e.name)}</span>
          ${commitCell}
          ${sizeCell}
        </button>
      `;
    }).join('');
    el.innerHTML = `<div class="code-file-list">${rows}</div>`;
    el.querySelectorAll('.code-file-row').forEach(row => {
      row.addEventListener('click', () => {
        const name = row.dataset.name;
        const type = row.dataset.type;
        if (type === 'tree') {
          view.path = view.path ? `${view.path}/${name}` : name;
          view.selectedBlob = null;
          renderTab(document.querySelector('.project-tab-content'), p);
        } else if (type === 'blob') {
          view.selectedBlob = view.path ? `${view.path}/${name}` : name;
          // Only re-render the preview pane — the file list and
          // commits don't change when you pick a file.
          const previewEl = document.querySelector('.code-preview');
          if (previewEl) renderCodePreview(previewEl, p, view);
        }
        // type === 'commit' = submodule. No-op for now (Phase 5+
        // can render submodule metadata).
      });
    });
  }

  function truncateSubject(s, max) {
    s = String(s || '');
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  }

  async function renderCodePreview(el, p, view) {
    el.innerHTML = `<div class="muted">Loading preview…</div>`;
    if (view.selectedBlob) {
      // Render a specific file picked in the browser.
      const qs = new URLSearchParams({ ref: view.ref, path: view.selectedBlob });
      let r;
      try {
        r = await api(`/api/projects/${p.id}/repo/blob?${qs}`);
      } catch (e) {
        el.innerHTML = `<div class="muted">Failed to load file: ${escapeHtml(e?.message || String(e))}</div>`;
        return;
      }
      if (r?.error) {
        el.innerHTML = `<div class="muted">${escapeHtml(r.error)}</div>`;
        return;
      }
      const head = `
        <div class="code-preview-head">
          <span class="code-preview-path">${escapeHtml(view.selectedBlob)}</span>
          <span class="code-preview-meta muted">${escapeHtml(fmtBytes(r.size || 0))}${r.binary ? ' · binary' : ''}</span>
          <button class="code-preview-close" aria-label="Close preview">×</button>
        </div>
      `;
      let body = '';
      if (r.truncated) {
        body = `<div class="code-preview-body muted">File too large to preview (${escapeHtml(fmtBytes(r.size))}). Open it locally.</div>`;
      } else if (r.binary) {
        body = `<div class="code-preview-body muted">Binary file (${escapeHtml(fmtBytes(r.size))}). Open it locally.</div>`;
      } else if (/\.md$/i.test(view.selectedBlob)) {
        body = `<div class="code-preview-body code-md">${renderMarkdown(r.content || '')}</div>`;
      } else {
        // Phase 1c: plain pre/code. Phase 1c+ will swap in highlight.js.
        body = `<div class="code-preview-body">${renderCodeBlock(r.content || '', extLang(view.selectedBlob))}</div>`;
      }
      el.innerHTML = head + body;
      const closeBtn = el.querySelector('.code-preview-close');
      if (closeBtn) closeBtn.addEventListener('click', () => {
        view.selectedBlob = null;
        renderCodePreview(el, p, view);
      });
      return;
    }

    // Default — render the README at the current ref.
    let r;
    try {
      r = await api(`/api/projects/${p.id}/repo/readme?ref=${encodeURIComponent(view.ref)}`);
    } catch (e) {
      el.innerHTML = `<div class="muted">Failed to load README: ${escapeHtml(e?.message || String(e))}</div>`;
      return;
    }
    if (!r?.found) {
      el.innerHTML = `<div class="code-preview-empty muted">No README found at this ref.</div>`;
      return;
    }
    el.innerHTML = `
      <div class="code-preview-head">
        <span class="code-preview-path">${escapeHtml(r.path || 'README')}</span>
        <span class="code-preview-meta muted">${escapeHtml(fmtBytes(r.size || 0))}</span>
      </div>
      <div class="code-preview-body code-md">${renderMarkdown(r.content || '')}</div>
    `;
  }

  async function renderCodeCommits(el, p, view) {
    el.innerHTML = `<div class="muted">Loading commits…</div>`;
    const qs = new URLSearchParams({ ref: view.ref, limit: '8' });
    let r;
    try {
      r = await api(`/api/projects/${p.id}/repo/log?${qs}`);
    } catch (e) {
      el.innerHTML = `<div class="muted">Failed to load commits: ${escapeHtml(e?.message || String(e))}</div>`;
      return;
    }
    if (r?.error) {
      el.innerHTML = `<div class="muted">${escapeHtml(r.error)}</div>`;
      return;
    }
    const commits = Array.isArray(r?.commits) ? r.commits : [];
    if (commits.length === 0) {
      el.innerHTML = `<div class="muted">No commits.</div>`;
      return;
    }
    const rows = commits.map(c => `
      <div class="code-commit-row">
        <div class="code-commit-main">
          <div class="code-commit-subject">${escapeHtml(c.subject || '(no message)')}</div>
          <div class="code-commit-meta muted">
            <code class="cmd-inline">${escapeHtml(c.abbrev)}</code>
            · ${escapeHtml(c.author || 'unknown')}
            · ${escapeHtml(fmtAgoIso(new Date((c.timestamp || 0) * 1000).toISOString()))}
          </div>
        </div>
        <span class="copy-slot" data-copy="${escapeHtml(c.sha)}"></span>
      </div>
    `).join('');
    el.innerHTML = `
      <div class="code-commits-head muted">Recent commits</div>
      <div class="code-commits-list">${rows}</div>
    `;
    el.querySelectorAll('.copy-slot').forEach(s => s.appendChild(copyBtn(s.dataset.copy)));
  }

  // Tiny extension-to-language hint for the preview. Phase 1c renders
  // plain `<pre><code>` regardless; this gets stored on the wrapper
  // class so a future highlight.js swap can pick it up via the
  // language- class convention without re-traversing the path.
  function extLang(path) {
    const m = String(path || '').match(/\.([a-z0-9]+)$/i);
    if (!m) return '';
    const ext = m[1].toLowerCase();
    const map = {
      js: 'js', jsx: 'jsx', ts: 'ts', tsx: 'tsx', mjs: 'js', cjs: 'js',
      json: 'json', md: 'markdown', html: 'html', css: 'css', scss: 'scss',
      py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', c: 'c',
      cpp: 'cpp', h: 'c', sh: 'bash', bash: 'bash', yml: 'yaml', yaml: 'yaml',
      toml: 'toml', sql: 'sql', xml: 'xml',
    };
    return map[ext] || '';
  }

  // Bytes → human-friendly size. Used by the file browser + preview
  // header. Two decimal places for sub-MB so a 12 KB README doesn't
  // round to "0 MB"; integer for MB+ since the precision adds noise.
  function fmtBytes(n) {
    if (!Number.isFinite(n) || n < 0) return '';
    if (n < 1024)              return `${n} B`;
    if (n < 1024 * 1024)       return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }

  function renderNgitTab(container, p) {
    // When ngit capability is enabled but we haven't detected a nostr remote
    // yet, the tab swaps to an Initialize form (GRASP server picker + d-tag).
    if (p.capabilities.ngit && !p.remotes.ngit) {
      renderNgitInitForm(container, p);
      return;
    }
    const remote = p.remotes.ngit || '(not configured)';
    const signing = p.identity.useDefault
      ? 'station identity'
      : `${truncNpub(p.identity.npub || '')}${p.identity.bunkerUrl ? ' · bunker configured' : ''}`;
    const alsoGit = p.capabilities.git
      ? `<div class="muted" style="margin-top:8px"><code>nostr-station publish</code> handles both the GitHub and ngit remotes simultaneously. The buttons here only act on the ngit remote.</div>`
      : '';
    // Layout follows shakespeare.diy's clean ngit popover: repo URL
    // header, then the Sync/Pull/Push triad as the primary verbs, then
    // signing details + value-add (Send as proposal) below. "Sync" is
    // bidir (pull + push) — the "just do the thing" verb users reach
    // for first; Pull and Push remain available as discrete primitives
    // for the rare case where a user wants only one half.
    container.innerHTML = `
      <div class="tab-section">
        <h3>Nostr remote</h3>
        <div class="remote-row">
          <span class="k">ngit</span><span class="v"><code>${escapeHtml(remote)}</code></span>
          ${p.remotes.ngit ? `<span class="copy-slot" data-copy="${escapeHtml(remote)}"></span>` : ''}
        </div>
      </div>
      <div class="tab-section">
        <h3>Sync</h3>
        <div class="ngit-verb-row">
          <button class="primary ngit-sync-btn">Sync</button>
          <button class="ngit-pull-btn">Pull</button>
          <button class="ngit-push-btn">Push</button>
        </div>
        <div class="muted" style="margin-top:6px;font-size:11px">
          <strong>Sync</strong> pulls then pushes in one click.
          <strong>Pull</strong> = <code>ngit fetch</code> + fast-forward merge.
          <strong>Push</strong> = <code>ngit push</code> (Amber signs on your phone).
        </div>
        <label class="ngit-autosync" style="display:flex;align-items:center;gap:8px;margin-top:10px;font-size:12px;cursor:pointer">
          <input type="checkbox" class="ngit-autosync-input" ${p.autoSync ? 'checked' : ''}>
          <span>Automatic sync</span>
          <span class="muted" style="font-size:11px">— pull every 5 minutes</span>
        </label>
        <div class="ngit-send-section" style="margin-top:14px">
          <button class="ngit-send-btn" style="display:none"></button>
          <span class="muted ngit-send-hint" style="display:none;font-size:11px">
            no commits ahead — switch to a feature branch and commit first
          </span>
        </div>
      </div>
      <div class="tab-section">
        <h3>Signing</h3>
        <div class="overview-kv"><div class="k">identity</div><div class="v">${escapeHtml(signing)}</div></div>
        <div class="muted">Pushes to the ngit remote trigger Amber signing on your phone.</div>
        ${alsoGit}
      </div>
    `;
    container.querySelectorAll('.copy-slot').forEach(s => s.appendChild(copyBtn(s.dataset.copy)));

    // Send-as-proposal gate: only meaningful when the local branch has
    // commits the upstream doesn't. /git-state hands back an `ahead`
    // count parsed from `git status --porcelain=v2 --branch`. We
    // render the button hidden by default, reveal it after the async
    // probe returns. Hint replaces the button when ahead is 0 so the
    // user knows why nothing's happening, rather than seeing a missing
    // affordance with no explanation.
    (async () => {
      const sendBtn  = container.querySelector('.ngit-send-btn');
      const sendHint = container.querySelector('.ngit-send-hint');
      if (!sendBtn || !sendHint) return;
      let st = null;
      try { st = await api(`/api/projects/${p.id}/git-state`); } catch {}
      const ahead = Number(st?.ahead || 0);
      if (ahead > 0) {
        sendBtn.style.display  = '';
        sendBtn.textContent    = `Send as proposal (${ahead} commit${ahead === 1 ? '' : 's'})`;
        sendBtn.addEventListener('click', () => {
          openExecModal({
            title:    `Send proposal · ${p.name}`,
            subtitle: 'ngit send  (Amber will sign on your phone)',
            endpoint: `/api/projects/${p.id}/ngit/send`,
          }).then(r => {
            if (r.ok) toast('Proposal sent', '', 'ok');
            else      toast('ngit send failed', `exit ${r.code}`, 'err');
          });
        });
      } else {
        sendHint.style.display = '';
      }
    })();

    // Auto-sync checkbox — toggles persisted Project.autoSync via PATCH.
    // The server-side AutoSyncManager.reconcile(id) hook arms/disarms
    // the interval inside the same response, so a flip takes effect
    // without the user having to wait for the next tick.
    const autoSyncInput = container.querySelector('.ngit-autosync-input');
    if (autoSyncInput) {
      autoSyncInput.addEventListener('change', async () => {
        const next = !!autoSyncInput.checked;
        autoSyncInput.disabled = true;
        try {
          await api(`/api/projects/${p.id}`, {
            method:  'PATCH',
            headers: { 'content-type': 'application/json' },
            body:    JSON.stringify({ autoSync: next }),
          });
          p.autoSync = next;
          toast(next ? 'Auto-sync on' : 'Auto-sync off', '', 'ok');
        } catch (e) {
          autoSyncInput.checked = !next;
          toast('Auto-sync update failed', e?.message || '', 'err');
        } finally {
          autoSyncInput.disabled = false;
        }
      });
    }

    container.querySelector('.ngit-sync-btn').addEventListener('click', () => {
      // Bidir — the primary verb. Streams both phases (fetch then push)
      // in one modal. Server skips push if pull fails.
      openExecModal({
        title:    `ngit sync · ${p.name}`,
        subtitle: 'pull (ngit fetch + ff-merge) then push',
        endpoint: `/api/projects/${p.id}/ngit/sync`,
      }).then(r => {
        if (r.ok) toast('ngit sync complete', '', 'ok');
        else      toast('ngit sync failed', `exit ${r.code}`, 'err');
        if (state.view === 'detail' && state.projectId === p.id) render();
      });
    });

    container.querySelector('.ngit-pull-btn').addEventListener('click', () => {
      // Pull-only — hits /git/pull, the SSE endpoint that runs
      // `git pull --no-rebase --ff-only`. Pre-fix this targeted /sync
      // (the card-grid endpoint), which returns plain JSON and only
      // does `git fetch` — so the streaming modal got one JSON blob
      // it couldn't parse and finished with code:null ("exit null"),
      // while the user's local HEAD never advanced.
      openExecModal({
        title:    `ngit pull · ${p.name}`,
        subtitle: 'git pull --ff-only',
        endpoint: `/api/projects/${p.id}/git/pull`,
      }).then(r => {
        if (r.ok) toast('ngit pull complete', '', 'ok');
        else      toast('ngit pull failed', `exit ${r.code}`, 'err');
        if (state.view === 'detail' && state.projectId === p.id) render();
      });
    });

    container.querySelector('.ngit-push-btn').addEventListener('click', () => {
      // ngit push is interactive once Amber gets involved (sign prompts).
      // Prefer the terminal panel; keep the SSE modal as fallback for
      // installs without node-pty.
      if (window.NSTerminal?.isAvailable?.()) {
        window.NSTerminal.open('ngit-push', { projectId: p.id });
        return;
      }
      openExecModal({
        title: `ngit push · ${p.name}`,
        subtitle: 'Streaming ngit push',
        endpoint: `/api/projects/${p.id}/ngit/push`,
      }).then(r => {
        if (r.ok) toast('ngit push complete', '', 'ok');
        else      toast('ngit push failed', `exit ${r.code}`, 'err');
      });
    });
  }

  // Truncate a 64-hex pubkey for display. Used by the proposals list —
  // the npub is rebuilt by the server but we only show it short.
  function shortPubkey(hex) {
    if (!hex || typeof hex !== 'string') return '';
    if (hex.length <= 16) return hex;
    return `${hex.slice(0, 8)}…${hex.slice(-4)}`;
  }

  // ── Profile resolution (kind-0 lookup with client-side cache) ─────────
  //
  // Backed by GET /api/profiles?pubkeys=…&relays=… (server fetches kind-0
  // from the user's relays + project hints, parses content JSON, caches).
  // This helper layers a session-lived client cache on top so re-renders
  // and tab switches don't refetch. Two concurrent calls for overlapping
  // sets are deduped by collapsing into a single in-flight request keyed
  // by the sorted set of "missing" pubkeys.
  //
  // Returns Map<hex, ProfileLite>. Always includes an entry for every
  // requested hex (npub fallback when relays returned nothing), so call
  // sites can render without an "is this profile resolved yet?" branch.
  const profileCache = new Map();           // hex → ProfileLite
  const profileInFlight = new Map();        // key → Promise<Map>

  async function resolveProfiles(pubkeys, opts = {}) {
    const hexes = Array.from(new Set(
      (pubkeys || [])
        .filter(p => typeof p === 'string' && /^[0-9a-f]{64}$/.test(p))
    ));
    const out = new Map();
    const need = [];
    for (const h of hexes) {
      const cached = profileCache.get(h);
      if (cached) out.set(h, cached);
      else need.push(h);
    }
    if (need.length === 0) return out;

    // Dedupe concurrent requests for the same missing set.
    const key = need.slice().sort().join(',') + (opts.verify ? '|v' : '');
    let promise = profileInFlight.get(key);
    if (!promise) {
      const qs = new URLSearchParams();
      qs.set('pubkeys', need.join(','));
      if (Array.isArray(opts.relays) && opts.relays.length > 0) {
        qs.set('relays', opts.relays.join(','));
      }
      if (opts.verify) qs.set('verify', '1');
      promise = api(`/api/profiles?${qs.toString()}`)
        .then(r => {
          const profiles = (r && r.profiles) || {};
          for (const h of need) {
            const p = profiles[h] || { hex: h };
            profileCache.set(h, p);
          }
        })
        .catch(() => {
          // Network / server error — still cache minimal entries so we
          // don't hammer the endpoint on every render attempt.
          for (const h of need) {
            if (!profileCache.has(h)) profileCache.set(h, { hex: h });
          }
        })
        .finally(() => profileInFlight.delete(key));
      profileInFlight.set(key, promise);
    }
    await promise;
    for (const h of need) out.set(h, profileCache.get(h) || { hex: h });
    return out;
  }

  // Same as resolveProfiles but FORCES a re-fetch so the caller can
  // request verification on profiles that were already cached without
  // it. Used by the About tab to do its async upgrade pass without
  // waiting for the 5min server cache TTL to expire.
  async function resolveProfilesVerified(pubkeys, opts = {}) {
    const hexes = Array.from(new Set(
      (pubkeys || []).filter(p => typeof p === 'string' && /^[0-9a-f]{64}$/.test(p))
    ));
    const candidates = hexes.filter(h => {
      const p = profileCache.get(h);
      // Skip pubkeys we already have a verification result for, AND
      // pubkeys that don't have a nip05 claim to verify.
      return !p || (p.nip05 && p.nip05Verified === undefined);
    });
    if (candidates.length === 0) return;
    const key = candidates.slice().sort().join(',') + '|v';
    let promise = profileInFlight.get(key);
    if (!promise) {
      const qs = new URLSearchParams();
      qs.set('pubkeys', candidates.join(','));
      if (Array.isArray(opts.relays) && opts.relays.length > 0) {
        qs.set('relays', opts.relays.join(','));
      }
      qs.set('verify', '1');
      promise = api(`/api/profiles?${qs.toString()}`)
        .then(r => {
          const profiles = (r && r.profiles) || {};
          for (const h of candidates) {
            const p = profiles[h];
            if (p) profileCache.set(h, p);
          }
        })
        .catch(() => { /* best-effort */ })
        .finally(() => profileInFlight.delete(key));
      profileInFlight.set(key, promise);
    }
    await promise;
  }

  // Render-time name resolver. Pure synchronous lookup against the client
  // cache; falls back to the npub-truncated form when no profile is loaded
  // yet. Call sites kick off resolveProfiles(...) and re-render to upgrade.
  function profileNameOf(hex) {
    if (!hex || typeof hex !== 'string') return '';
    const p = profileCache.get(hex);
    if (p && (p.displayName || p.name)) return p.displayName || p.name;
    // npub fallback — try nip19 if available, otherwise hex.
    try {
      if (window.NostrTools?.nip19) {
        const n = window.NostrTools.nip19.npubEncode(hex);
        return `${n.slice(0, 10)}…${n.slice(-4)}`;
      }
    } catch {}
    return shortPubkey(hex);
  }

  function profilePictureOf(hex) {
    const p = profileCache.get(hex);
    return p?.picture || '';
  }

  // Has the profile cache resolved a real human-readable name for this
  // pubkey? Used by avatar-placeholder rendering to decide between
  // "first-letter-of-name" vs "generic person icon" — without this
  // check the placeholder falls back to the first char of an npub or
  // hex string, which can render as a digit (e.g. hex starting "2…")
  // and look like a count badge to users.
  function hasResolvedProfileName(hex) {
    const p = profileCache.get(hex);
    return !!(p && (p.displayName || p.name));
  }

  // Returns { nip05, verified } where verified is true / false / undefined.
  // Undefined = verification hasn't run yet (the UI shows the raw claim
  // without a marker until a verify=1 round-trip completes and re-paints).
  function profileNip05Of(hex) {
    const p = profileCache.get(hex);
    if (!p?.nip05) return { nip05: '', verified: undefined };
    return { nip05: p.nip05, verified: p.nip05Verified };
  }

  // Cache the latest proposals payload per project so re-rendering the
  // tab (e.g. after a Download finishes) doesn't refetch unless the
  // user explicitly asks via the Refresh button.
  const proposalsCache = new Map();
  // One-shot "force refresh on next paint" set, populated by user
  // actions (merge / status-change) that just published a 163x event
  // and need the dashboard's next render to bypass the server's 60s
  // status cache. Consumed-and-cleared inside fetchAndRender.
  const proposalsForceRefresh = new Set();

  async function renderProposalsTab(container, p) {
    // Phase 2b: PR-shaped series cards driven by /api/projects/:id/patches
    // (Phase 2a backend). Phase 7 adds a status filter row at the top
    // so closed / merged PRs don't pollute the work-to-do view.
    //
    // The legacy /api/projects/:id/ngit/proposals endpoint still exists
    // for back-compat but isn't called from the UI anymore.
    if (!state.prsFilter) state.prsFilter = 'open';
    if (typeof state.prsSearch !== 'string') state.prsSearch = '';
    container.innerHTML = `
      <div class="tab-section">
        <div class="proposals-head">
          <h3 style="margin:0">Pull requests</h3>
          <div class="proposals-head-actions">
            <button class="proposals-view-patch">View latest patch</button>
            <button class="proposals-refresh">Refresh</button>
          </div>
        </div>
        <div class="list-toolbar">
          <div class="list-filter" role="tablist" aria-label="PR status filter">
            <button class="filter-pill ${state.prsFilter === 'open'   ? 'active' : ''}" data-filter="open"   role="tab">Open</button>
            <button class="filter-pill ${state.prsFilter === 'all'    ? 'active' : ''}" data-filter="all"    role="tab">All</button>
            <button class="filter-pill ${state.prsFilter === 'closed' ? 'active' : ''}" data-filter="closed" role="tab">Closed</button>
          </div>
          <input type="search" class="list-search" placeholder="Search subjects + authors"
                 value="${escapeHtml(state.prsSearch)}" aria-label="Search PRs">
        </div>
        <div class="muted" style="margin-bottom:12px;font-size:11px">
          NIP-34 patch series threaded by root + revision.
          Click a card to inspect commits + the unified diff.
        </div>
        <div class="proposals-series-list" id="proposals-series-list">
          <div class="muted">loading…</div>
        </div>
      </div>
    `;
    container.querySelectorAll('.filter-pill').forEach(btn => {
      btn.addEventListener('click', () => {
        state.prsFilter = btn.dataset.filter;
        renderTab(document.querySelector('.project-tab-content'), p);
      });
    });
    const prSearchEl = container.querySelector('.list-search');
    prSearchEl.addEventListener('input', () => {
      state.prsSearch = prSearchEl.value;
      // Debounce-free: list filter is cheap and runs client-side, so
      // re-rendering on each keystroke feels snappier than waiting.
      const cached = proposalsCache.get(p.id);
      if (Array.isArray(cached)) renderSeries(cached);
    });

    const listEl = container.querySelector('#proposals-series-list');

    // ── Submit-a-PR CTA card ─────────────────────────────────────────
    //
    // Conditional: only renders when (1) project has ngit cap + remote,
    // (2) user is on the default branch, (3) local is N commits ahead.
    // Bypasses the existing Settings → ngit signer + sync → Send-as-
    // proposal button by automating the branch creation step.
    //
    // Server-side route handles the multi-step git dance and validates
    // pre-conditions independently — this gate is purely a UI affordance.
    (async () => {
      if (!(p.capabilities?.ngit && p.remotes?.ngit)) return;
      let gs = null;
      try { gs = await api(`/api/projects/${p.id}/git-state`); } catch {}
      if (!gs || typeof gs !== 'object') return;
      // Heuristic for default branch — server resolves the real one
      // before doing anything, so 'main' or 'master' here is just a
      // gate for *showing* the CTA. Users with a non-standard default
      // can still use Settings → Send.
      const onDefault = gs.branch === 'main' || gs.branch === 'master';
      if (!onDefault) return;
      const ahead = Number(gs.ahead || 0);
      if (ahead < 1) return;
      if (gs.dirty) return;  // server refuses anyway; spare the user the round-trip

      const branchPlaceholder = `feature-${new Date().toISOString().slice(0, 10)}`;
      const cta = document.createElement('div');
      cta.className = 'tab-section proposal-new-cta';
      cta.innerHTML = `
        <div class="proposal-new-head">
          <h4 style="margin:0">Submit your local commits as a PR</h4>
          <span class="muted" style="font-size:11px">${ahead} commit${ahead === 1 ? '' : 's'} ahead of <code>origin/${escapeHtml(gs.branch)}</code></span>
        </div>
        <div class="proposal-new-form">
          <label class="proposal-new-row">
            <span>Branch name</span>
            <input type="text" class="proposal-new-branch"
                   placeholder="${escapeHtml(branchPlaceholder)}"
                   pattern="[A-Za-z][A-Za-z0-9._\\-]{0,63}"
                   maxlength="64" autocomplete="off" spellcheck="false">
          </label>
          <label class="proposal-new-row proposal-new-reset" title="If checked, your local '${escapeHtml(gs.branch)}' branch gets moved back to upstream after the feature branch is created. Off keeps the commits on both '${escapeHtml(gs.branch)}' and the new feature branch.">
            <input type="checkbox" class="proposal-new-reset-cb">
            <span>Reset <code>${escapeHtml(gs.branch)}</code> back to <code>origin/${escapeHtml(gs.branch)}</code> after branching</span>
          </label>
          <div class="proposal-new-actions">
            <button class="primary proposal-new-submit" disabled>Submit PR</button>
          </div>
        </div>
      `;
      // Insert ABOVE the existing list so it's the first thing users see.
      listEl.parentElement.insertBefore(cta, listEl);

      const branchInput = cta.querySelector('.proposal-new-branch');
      const resetCb     = cta.querySelector('.proposal-new-reset-cb');
      const submitBtn   = cta.querySelector('.proposal-new-submit');

      const validateBranchName = (s) => /^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(s);
      branchInput.addEventListener('input', () => {
        submitBtn.disabled = !validateBranchName(branchInput.value.trim());
      });

      submitBtn.addEventListener('click', async () => {
        const branchName = branchInput.value.trim();
        if (!validateBranchName(branchName)) return;
        submitBtn.disabled = true;
        const r = await openExecModal({
          title:    `Submit PR · ${p.name}`,
          subtitle: `branch + ${resetCb.checked ? 'reset + ' : ''}ngit send`,
          endpoint: `/api/projects/${p.id}/ngit/proposal/new`,
          body:     { branchName, resetMain: resetCb.checked },
        });
        if (r.ok) {
          toast('PR submitted', `Branch ${branchName} → proposal published`, 'ok');
          // Refresh the proposals list + project state so the new PR
          // appears in the list and the card's ahead count updates.
          apiInvalidate(`/api/projects/${p.id}/git-state`);
          proposalsCache.delete(p.id);
          if (state.view === 'detail' && state.projectId === p.id) render();
          refreshHealth();
        } else {
          toast('PR submit failed', `exit ${r.code}`, 'err');
          submitBtn.disabled = false;
        }
      });
    })();

    const runDownload = async (rootId, subject) => {
      const r = await openExecModal({
        title:    `Download proposal · ${p.name}`,
        subtitle: `ngit pr checkout ${rootId.slice(0, 12)}…`,
        endpoint: `/api/projects/${p.id}/ngit/download`,
        body:     { proposalId: rootId },
      });
      if (r.ok) {
        toast(`Checked out: ${subject || rootId.slice(0, 8)}`,
              'View latest patch to see commits', 'ok');
      } else {
        toast('Download failed', `exit ${r.code}`, 'err');
      }
    };

    const renderSeries = (series) => {
      if (!Array.isArray(series)) series = [];
      // Phase 7 status filter — applied client-side so the toggle is
      // instant. Open = open or draft (anything still actionable);
      // Closed = closed, merged, or resolved.
      const q = (state.prsSearch || '').trim().toLowerCase();
      const visible = series.filter(s => {
        const st = s.effectiveStatus || 'open';
        const statusOk =
          state.prsFilter === 'open'   ? (st === 'open' || st === 'draft') :
          state.prsFilter === 'closed' ? (st === 'closed' || st === 'merged' || st === 'resolved') :
          true;
        if (!statusOk) return false;
        if (!q) return true;
        const hay = `${s.subject || ''} ${s.author?.name || ''} ${s.author?.pubkey || ''}`.toLowerCase();
        return hay.includes(q);
      });
      if (visible.length === 0) {
        listEl.innerHTML = renderListEmptyState({
          icon: state.prsFilter === 'open' ? '🌱' : '✓',
          title: state.prsFilter === 'open'
            ? 'No open pull requests'
            : state.prsFilter === 'closed'
              ? 'No closed pull requests yet'
              : 'No pull requests yet',
          body: state.prsFilter === 'open' && series.length > 0
            ? `${series.length} pull request${series.length === 1 ? '' : 's'} found — all are closed, merged, or resolved.`
            : 'Pull requests are NIP-34 patch series proposing changes to this repo. Contributors create them with <code>ngit send</code> from their local checkout.',
          cta: state.prsFilter !== 'open' ? null : null,
        });
        return;
      }
      listEl.innerHTML = visible.map(s => {
        // Latest revision drives the "patches in this series" badge —
        // older revisions are shown as v1 / v2 pills but the action
        // button defaults to the freshest version.
        const latest = s.revisions[s.revisions.length - 1];
        const versionPills = s.revisions.map(r =>
          `<span class="series-version-pill" data-revision="${r.rootId}">v${r.version}</span>`
        ).join('');
        const authorLabel = s.author?.name || shortPubkey(s.author?.pubkey || '');
        const statusBadge = renderStatusBadge(s.effectiveStatus || 'open');
        return `
          <div class="series-card" data-root="${escapeHtml(s.rootId)}" tabindex="0" role="button">
            <div class="series-card-main">
              <div class="series-card-title">${statusBadge} ${escapeHtml(s.subject || s.rootId.slice(0, 8))}</div>
              <div class="series-card-meta muted">
                <span class="k">${escapeHtml(authorLabel)}</span>
                · <span class="k">${escapeHtml(fmtAgoIso(new Date((s.latestRevisionAt || 0) * 1000).toISOString()))}</span>
                · <span class="k">${s.patchCount} patch${s.patchCount === 1 ? '' : 'es'}</span>
                ${s.revisionCount > 1 ? `· <span class="k">${s.revisionCount} revisions</span>` : ''}
              </div>
              <div class="series-card-pills">${versionPills}</div>
            </div>
            <div class="series-card-actions">
              <button class="primary series-download"
                      data-root="${escapeHtml(latest.rootId)}"
                      data-subject="${escapeHtml(s.subject || '')}">Download</button>
              <span class="copy-slot" data-copy="${escapeHtml(latest.rootId)}"></span>
            </div>
          </div>
        `;
      }).join('');

      listEl.querySelectorAll('.copy-slot').forEach(s => s.appendChild(copyBtn(s.dataset.copy)));
      listEl.querySelectorAll('.series-download').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          runDownload(btn.dataset.root, btn.dataset.subject);
        });
      });
      listEl.querySelectorAll('.series-card').forEach(card => {
        card.addEventListener('click', () => openPatchSeriesDetail(p, card.dataset.root));
        card.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openPatchSeriesDetail(p, card.dataset.root);
          }
        });
      });
    };

    const fetchAndRender = async (refresh = false) => {
      // Consume any pending one-shot force-refresh from a prior user
      // action (merge / status-change) so its 163x event makes it
      // past the server's 60s cache on this very next paint.
      const forced = proposalsForceRefresh.delete(p.id);
      const refreshStatus = refresh || forced;
      try {
        const qs = refresh ? '?refresh=1' : '';
        const r = await api(`/api/projects/${p.id}/patches${qs}`);
        const series = Array.isArray(r?.series) ? r.series : [];
        // Phase 4: enrich each series row with its effective status
        // (merged / open / draft / closed). One bulk call covers
        // every visible series; the result is keyed by rootId so
        // renderSeries can decorate without changing its loop shape.
        await annotateSeriesWithStatus(p.id, series, refreshStatus);
        proposalsCache.set(p.id, series);
        renderSeries(series);
      } catch (e) {
        listEl.innerHTML = `<div class="muted">Failed to load proposals: ${escapeHtml(e?.message || String(e))}</div>`;
      }
    };

    container.querySelector('.proposals-refresh').addEventListener('click', () => {
      listEl.innerHTML = `<div class="muted">refreshing…</div>`;
      fetchAndRender(true);
    });

    container.querySelector('.proposals-view-patch').addEventListener('click', () => {
      openExecModal({
        title:    `Latest patch · ${p.name}`,
        subtitle: 'git log -p -5  (current branch)',
        endpoint: `/api/projects/${p.id}/exec`,
        body:     { cmd: 'git-log-patch' },
      });
    });

    // Cache hot path: re-render previous series so the tab feels
    // instant on switch; background fetch refreshes when the user
    // clicks Refresh. The cache shape changed in 2b (was flat list,
    // now series array) — coerce / discard if shape is wrong.
    const cached = proposalsCache.get(p.id);
    if (Array.isArray(cached) && cached[0] && cached[0].revisions) {
      renderSeries(cached);
    } else {
      fetchAndRender();
    }

    // Smart polling — keep status in tune with the actual relay state
    // without the cost of a persistent subscription.
    //
    //   - re-poll status every 30s while the tab is visible (the server's
    //     60s cache rate-limits the relay round-trips naturally)
    //   - re-poll immediately when the tab regains focus (covers the
    //     "I came back from gitworkshop, what changed?" case)
    //   - skip polling when the tab is hidden so a backgrounded dashboard
    //     doesn't burn relay round-trips on data nobody is looking at
    //
    // Patches list itself isn't repolled here — new PRs are slow-changing
    // and Refresh / tab re-entry already covers them; status flips are
    // what users care about catching live.
    const refreshStatusOnly = async () => {
      const series = proposalsCache.get(p.id);
      if (!Array.isArray(series) || series.length === 0) return;
      try {
        await annotateSeriesWithStatus(p.id, series);
        renderSeries(series);
      } catch { /* polling is best-effort */ }
    };
    let pollTimer = null;
    const startPoll = () => {
      if (pollTimer || document.hidden) return;
      pollTimer = setInterval(refreshStatusOnly, 30_000);
    };
    const stopPoll = () => {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    };
    const onVisibility = () => {
      if (document.hidden) { stopPoll(); return; }
      refreshStatusOnly();
      startPoll();
    };
    document.addEventListener('visibilitychange', onVisibility);
    startPoll();
    container.__cleanup = () => {
      stopPoll();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }

  // ── Phase 2c: per-series detail modal ────────────────────────────
  //
  // Opens on series-card click. Shows:
  //   - Header: subject, author, revision pills (clickable to switch)
  //   - Cover letter (markdown via renderMarkdown) when present
  //   - Per-patch list with subject + commit sha + author + lazy diff
  //   - Per-patch unified diff rendered file-by-file with hljs spans
  //
  // Lazy-loads diffs: each patch row has a "view diff" expander that
  // fetches /patches/:rootId/diff?patchId=… on first open. Avoids
  // parsing every diff up-front for series with many patches.
  async function openPatchSeriesDetail(p, rootId) {
    const body = document.createElement('div');
    body.className = 'pdetail-body';
    body.innerHTML = `<div class="muted" style="padding:24px">Loading series…</div>`;
    const modal = openModal({
      title:    'Patch series',
      subtitle: rootId.slice(0, 16) + '…',
      body,
    });

    let detail;
    try {
      detail = await api(`/api/projects/${p.id}/patches/${rootId}`);
    } catch (e) {
      body.innerHTML = `<div class="pdetail-err">Failed to load series: ${escapeHtml(e?.message || String(e))}</div>`;
      return;
    }
    if (!detail || detail.error) {
      body.innerHTML = `<div class="pdetail-err">${escapeHtml(detail?.error || 'series not found')}</div>`;
      return;
    }

    // Default to the latest revision; user can flip via the version pills.
    let activeRev = detail.revisions[detail.revisions.length - 1];

    const renderDetail = async () => {
      const author = detail.author?.name || shortPubkey(detail.author?.pubkey || '');
      const versionPills = detail.revisions.map(r =>
        `<button class="pdetail-version-pill ${r === activeRev ? 'active' : ''}"
                 data-rev="${r.rootId}">v${r.version}</button>`
      ).join('');
      const cover = activeRev.coverLetter
        ? `<div class="pdetail-cover code-md">${renderMarkdown(activeRev.coverLetter)}</div>`
        : '';
      const patchRows = activeRev.patches.map((pa, i) => `
        <div class="pdetail-patch" data-patch="${escapeHtml(pa.id)}" data-idx="${i}">
          <div class="pdetail-patch-head">
            <div class="pdetail-patch-main">
              <div class="pdetail-patch-subject">${escapeHtml(pa.subject)}</div>
              <div class="pdetail-patch-meta muted">
                ${pa.commit ? `<code class="cmd-inline">${escapeHtml(pa.commit.slice(0, 8))}</code> · ` : ''}
                ${escapeHtml(shortPubkey(pa.pubkey))}
                · ${escapeHtml(fmtAgoIso(new Date((pa.createdAt || 0) * 1000).toISOString()))}
                ${pa.isCoverLetter ? ' · cover letter' : ''}
              </div>
            </div>
            <button class="pdetail-toggle-diff" ${pa.isCoverLetter ? 'disabled' : ''}>view diff</button>
          </div>
          <div class="pdetail-diff" data-loaded="0"></div>
        </div>
      `).join('');
      body.innerHTML = `
        <div class="pdetail-head">
          <h3>${escapeHtml(detail.subject)}</h3>
          <div class="pdetail-head-meta muted">
            opened by ${escapeHtml(author)}
            · ${escapeHtml(fmtAgoIso(new Date((detail.createdAt || 0) * 1000).toISOString()))}
            · ${detail.patchCount} patch${detail.patchCount === 1 ? '' : 'es'}
          </div>
          ${detail.revisions.length > 1
            ? `<div class="pdetail-versions">${versionPills}</div>`
            : ''}
        </div>
        ${cover}
        <div class="pdetail-patches">${patchRows}</div>
        <div class="pdetail-foot">
          <button class="primary pdetail-download">Download</button>
          <button class="pdetail-merge" title="Merge this proposal locally via ngit pr_merge">Merge</button>
          <span class="pdetail-status-slot"></span>
          <span class="pdetail-copy"></span>
        </div>
        <div class="comment-thread" id="patch-comment-thread"></div>
        <div class="comment-composer" id="patch-comment-composer"></div>
      `;
      // Wire interactions.
      body.querySelectorAll('.pdetail-version-pill').forEach(btn => {
        btn.addEventListener('click', () => {
          const target = detail.revisions.find(r => r.rootId === btn.dataset.rev);
          if (target) { activeRev = target; renderDetail(); }
        });
      });
      body.querySelectorAll('.pdetail-toggle-diff').forEach(btn => {
        btn.addEventListener('click', async () => {
          const card = btn.closest('.pdetail-patch');
          const diffEl = card.querySelector('.pdetail-diff');
          const expanded = diffEl.dataset.loaded === '1';
          if (expanded) {
            diffEl.innerHTML = '';
            diffEl.dataset.loaded = '0';
            btn.textContent = 'view diff';
            return;
          }
          btn.textContent = 'loading…';
          btn.disabled = true;
          const patchId = card.dataset.patch;
          try {
            const r = await api(`/api/projects/${p.id}/patches/${detail.rootId}/diff?patchId=${encodeURIComponent(patchId)}`);
            diffEl.innerHTML = renderParsedDiff(r);
            diffEl.dataset.loaded = '1';
            btn.textContent = 'hide diff';
          } catch (e) {
            diffEl.innerHTML = `<div class="muted">Failed to load diff: ${escapeHtml(e?.message || String(e))}</div>`;
            btn.textContent = 'view diff';
          } finally {
            btn.disabled = false;
          }
        });
      });
      body.querySelector('.pdetail-download').addEventListener('click', () => {
        modal.close();
        openExecModal({
          title:    `Download proposal · ${p.name}`,
          subtitle: `ngit pr checkout ${activeRev.rootId.slice(0, 12)}…`,
          endpoint: `/api/projects/${p.id}/ngit/download`,
          body:     { proposalId: activeRev.rootId },
        }).then((r) => {
          if (r.ok) toast('Downloaded', detail.subject, 'ok');
          else      toast('Download failed', `exit ${r.code}`, 'err');
        });
      });
      body.querySelector('.pdetail-copy').appendChild(copyBtn(activeRev.rootId));

      // Phase 4 — Merge button + status dropdown. Merge runs a
      // five-phase server-side flow: fetch → checkout default →
      // ff-only merge → push → publish kind-1631. ngit's own
      // `pr merge` only handles the last phase (announcement); the
      // rest is done explicitly with plain git because ngit 2.x's
      // pr-merge doesn't actually integrate the patch.
      //
      // The status dropdown lets the user / a maintainer mark a PR
      // open / draft / closed via ngit pr status.
      body.querySelector('.pdetail-merge').addEventListener('click', () => {
        // branchName comes from the patch event's branch-name tag
        // (surfaced by routes/patches.ts's detail enrichment). If
        // the event somehow lacks it, surface a clear error rather
        // than letting the server's validation reject — gives the
        // user a faster path to the actual problem.
        if (!activeRev.branchName) {
          toast(
            'Cannot merge',
            'This PR\'s patch event has no branch-name tag — merge unavailable. ' +
            'You can still merge from a terminal via git checkout + git merge.',
            'err',
          );
          return;
        }
        confirmDestructive({
          title: 'Merge this proposal?',
          description:
            `Fast-forwards your default branch with the commits from ${activeRev.branchName}, ` +
            `pushes to origin, then publishes a kind-1631 status event. ` +
            `Working tree must be clean. Refuses if the default branch has diverged.`,
          confirmLabel: 'Merge',
        }).then((ok) => {
          if (!ok) return;
          openExecModal({
            title:    `Merge · ${p.name}`,
            subtitle: `fast-forward ${activeRev.branchName} → default branch, then ngit announce`,
            endpoint: `/api/projects/${p.id}/merge`,
            body:     { rootId: activeRev.rootId, branchName: activeRev.branchName },
          }).then((r) => {
            if (r.ok) {
              toast('Merged', detail.subject, 'ok');
              modal.close();
              // Force the proposals list's next paint to bypass the
              // 60s status cache so the freshly published 1631 shows
              // up immediately instead of after the TTL expires.
              proposalsForceRefresh.add(p.id);
              if (state.tab === 'proposals') {
                renderTab(document.querySelector('.project-tab-content'), p);
              }
            } else {
              toast('Merge failed', `exit ${r.code}`, 'err');
            }
          });
        });
      });

      // Phase 7: client-side authority check — show the status
      // dropdown only when the user can legitimately publish a
      // status change. Server still enforces; this hides options
      // the user can't act on.
      //
      // Also fetch the actual effective status for this root so the
      // dropdown reflects reality. Without this the control always
      // reads "open" even for merged/closed PRs (bug:
      // dashboard-merge-shows-open).
      const [userPubkey, repoMeta, statusResp] = await Promise.all([
        getOwnerPubkey(),
        api(`/api/projects/${p.id}/repo`).catch(() => null),
        api(`/api/projects/${p.id}/status?rootIds=${encodeURIComponent(detail.rootId)}`).catch(() => null),
      ]);
      const canEdit = canEditStatus(userPubkey, detail.author?.pubkey, repoMeta?.maintainerSet);
      const effectiveStatus = statusResp?.results?.[0]?.status || 'open';
      const statusSlot = body.querySelector('.pdetail-status-slot');
      statusSlot.appendChild(renderStatusControl('patch', effectiveStatus, canEdit, (newStatus) => {
        openExecModal({
          title:    `${newStatus} · ${p.name}`,
          subtitle: `ngit pr status --${newStatus} ${detail.rootId.slice(0, 12)}…`,
          endpoint: `/api/projects/${p.id}/status`,
          body:     { kind: 'patch', rootId: detail.rootId, status: newStatus },
        }).then((r) => {
          if (r.ok) {
            toast(`Marked ${newStatus}`, detail.subject, 'ok');
            // Force the proposals list to bypass the status cache so
            // the new status pill appears on the next paint instead
            // of waiting for the 60s TTL.
            proposalsForceRefresh.add(p.id);
          } else {
            toast('Status change failed', `exit ${r.code}`, 'err');
          }
        });
      }));

      // Phase 3c: NIP-22 comment thread on the patch series. Threaded
      // against the SERIES' v1 root id so a multi-revision PR keeps a
      // single conversation across re-rolls (matches gitworkshop UX).
      const threadEl = body.querySelector('#patch-comment-thread');
      const composerEl = body.querySelector('#patch-comment-composer');
      loadAndRenderPatchComments(threadEl, composerEl, p, detail.rootId);
    };

    renderDetail();
  }

  async function loadAndRenderPatchComments(threadEl, composerEl, p, rootId) {
    threadEl.innerHTML = `<div class="comment-empty muted">Loading comments…</div>`;
    let tree = [];
    try {
      const r = await api(`/api/projects/${p.id}/comments?rootId=${encodeURIComponent(rootId)}`);
      tree = Array.isArray(r?.comments) ? r.comments : [];
    } catch {
      // Fall through to empty tree — the composer still works.
    }
    threadEl.innerHTML = renderCommentTree(tree);
    wireCommentReplies(threadEl, p, rootId, () => {
      loadAndRenderPatchComments(threadEl, composerEl, p, rootId);
    });
    mountCommentComposer(composerEl, p, rootId, () => {
      loadAndRenderPatchComments(threadEl, composerEl, p, rootId);
    });
  }

  // Render a ParsedDiff (Phase 2a wire shape) into a file-by-file
  // <pre>-formatted diff with +/-/context line classes for CSS
  // colouring. Each chunk header gets a synthesized hunk line so the
  // user can see the line ranges. No syntax highlighting on diff
  // lines themselves — diffs are usually too short for hljs auto-
  // detect to be useful, and per-language detection per file would
  // double the render cost. The rest of the dashboard uses hljs
  // (Code tab file preview), so we have a consistent escape hatch
  // (the user can open the file in Code tab).
  function renderParsedDiff(r) {
    if (!r || !Array.isArray(r.files) || r.files.length === 0) {
      return `<div class="muted">Empty diff (cover letter or non-diff content).</div>`;
    }
    const filesHtml = r.files.map(f => {
      const path = f.to && f.to !== '/dev/null' ? f.to : (f.from || '(unknown)');
      const stats = `<span class="pdf-add">+${f.additions}</span> <span class="pdf-del">-${f.deletions}</span>`;
      const chunksHtml = (f.chunks || []).map(ch => {
        const headerLine = `<span class="pdf-line pdf-hunk">${escapeHtml(ch.content || `@@ ${ch.oldStart},${ch.oldLines} ${ch.newStart},${ch.newLines} @@`)}</span>`;
        const lines = (ch.changes || []).map(c => {
          const cls = c.type === 'add' ? 'pdf-add-line'
                    : c.type === 'del' ? 'pdf-del-line'
                    : 'pdf-ctx-line';
          return `<span class="pdf-line ${cls}">${escapeHtml(c.content || '')}</span>`;
        }).join('');
        return headerLine + lines;
      }).join('');
      return `
        <div class="pdf-file">
          <div class="pdf-file-head">
            <code class="pdf-path">${escapeHtml(path)}</code>
            <span class="pdf-stats muted">${stats}</span>
          </div>
          <pre class="pdf-body">${chunksHtml}</pre>
        </div>
      `;
    }).join('');
    const summary = `
      <div class="pdf-summary muted">
        ${r.fileCount} file${r.fileCount === 1 ? '' : 's'} ·
        <span class="pdf-add">+${r.totalAdditions}</span>
        <span class="pdf-del">-${r.totalDeletions}</span>
      </div>
    `;
    return summary + filesHtml;
  }

  // ── Phase 4: status helpers (shared by patches + issues) ─────────────
  //
  // renderStatusBadge: pill rendered next to a series subject or
  // issue subject. The data-status attribute drives colors via
  // the existing .issue-status-icon[data-status="…"] CSS, which we
  // reuse here so the visual language is consistent across surfaces.
  function renderStatusBadge(status) {
    const label = {
      open:     'open',
      draft:    'draft',
      closed:   'closed',
      merged:   'merged',
      resolved: 'resolved',
    }[status] || 'open';
    return `<span class="status-badge" data-status="${escapeHtml(status)}">${escapeHtml(label)}</span>`;
  }

  // Bulk-annotate a list of series / issues with their effective
  // status. Single GET /status?rootIds=… call covers all rows;
  // failures degrade silently to "open" so the surface still renders.
  async function annotateSeriesWithStatus(projectId, series, refresh = false) {
    if (!Array.isArray(series) || series.length === 0) return;
    const ids = series.map(s => s.rootId).join(',');
    const refreshParam = refresh ? '&refresh=1' : '';
    try {
      const r = await api(`/api/projects/${projectId}/status?rootIds=${encodeURIComponent(ids)}${refreshParam}`);
      const byId = new Map((r?.results || []).map(x => [x.rootId, x]));
      for (const s of series) {
        const c = byId.get(s.rootId);
        s.effectiveStatus = c?.status || 'open';
        s.statusEventId   = c?.statusEventId || null;
        s.mergeCommit     = c?.mergeCommit || null;
      }
    } catch {
      for (const s of series) s.effectiveStatus = s.effectiveStatus || 'open';
    }
  }

  async function annotateIssuesWithStatus(projectId, issues) {
    if (!Array.isArray(issues) || issues.length === 0) return;
    const ids = issues.map(i => i.id).join(',');
    try {
      const r = await api(`/api/projects/${projectId}/status?rootIds=${encodeURIComponent(ids)}`);
      const byId = new Map((r?.results || []).map(x => [x.rootId, x]));
      for (const i of issues) {
        const c = byId.get(i.id);
        // Server returns 'open' when no 163x exists yet — preserves
        // the default for fresh issues.
        i.status = c?.status || i.status || 'open';
        i.statusEventId = c?.statusEventId || null;
      }
    } catch {
      // Already defaults to 'open' from the server — leave as-is.
    }
  }

  // Phase 7: the status BADGE is the dropdown trigger (gitworkshop
  // pattern). Click the green "open" pill → menu opens with allowed
  // transitions. When the user isn't authorised to change status
  // (not the root author, not a verified maintainer), the badge is
  // rendered static — the menu never opens, no buttons to mislead
  // the user. The server still enforces authority either way; this
  // is UX hygiene, not security.
  //
  // kind:        'patch' | 'issue'
  // currentStatus: 'open' | 'draft' | 'closed' | 'merged' | 'resolved'
  // canEdit:     boolean — caller pre-computes the authority check
  // onChange:    (newStatus) => void
  function renderStatusControl(kind, currentStatus, canEdit, onChange) {
    const allowed = kind === 'patch'
      ? ['open', 'draft', 'closed']
      : ['open', 'resolved', 'closed'];
    // Static badge when the user can't edit — no menu, no chevron,
    // just the status pill the rest of the UI already shows.
    if (!canEdit) {
      const span = document.createElement('span');
      span.innerHTML = renderStatusBadge(currentStatus);
      return span;
    }
    const wrap = document.createElement('div');
    wrap.className = 'status-control';
    wrap.innerHTML = `
      <button class="status-control-toggle" aria-haspopup="true" aria-expanded="false"
              title="Click to change status">
        ${renderStatusBadge(currentStatus)}
        <span class="status-control-chevron">▾</span>
      </button>
      <div class="status-control-menu" hidden>
        ${allowed.map(s => `
          <button class="status-control-option ${s === currentStatus ? 'current' : ''}"
                  data-status="${escapeHtml(s)}">
            ${renderStatusBadge(s)}
          </button>
        `).join('')}
      </div>
    `;
    const toggle = wrap.querySelector('.status-control-toggle');
    const menu   = wrap.querySelector('.status-control-menu');
    const close = () => { menu.hidden = true; toggle.setAttribute('aria-expanded', 'false'); };
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = menu.hidden;
      menu.hidden = !open;
      toggle.setAttribute('aria-expanded', String(open));
    });
    menu.querySelectorAll('.status-control-option').forEach(opt => {
      opt.addEventListener('click', (e) => {
        e.stopPropagation();
        close();
        const next = opt.dataset.status;
        if (next && next !== currentStatus) onChange(next);
      });
    });
    document.addEventListener('click', (e) => {
      if (!wrap.contains(e.target)) close();
    });
    return wrap;
  }

  // Phase 7: client-side authority check. Cached owner identity +
  // resolved maintainer set let us decide whether to render the
  // status badge as an editable dropdown or a static pill. The
  // server check is the source of truth; this exists purely to
  // stop us showing the user options they can't actually use.
  let cachedOwnerPubkey = null;
  async function getOwnerPubkey() {
    if (cachedOwnerPubkey !== null) return cachedOwnerPubkey;
    try {
      const c = await api('/api/identity/config');
      let pk = c?.npub || '';
      if (/^npub1[0-9a-z]+$/.test(pk) && window.NostrTools?.nip19) {
        // Decode npub → hex if nostr-tools is available; fall back
        // to a quick regex check otherwise (most callers receive
        // hex already, but defence-in-depth keeps the API tolerant).
        try { pk = window.NostrTools.nip19.decode(pk).data; } catch {}
      }
      cachedOwnerPubkey = (typeof pk === 'string' && /^[0-9a-f]{64}$/.test(pk)) ? pk : '';
    } catch { cachedOwnerPubkey = ''; }
    return cachedOwnerPubkey;
  }

  function canEditStatus(userPubkey, rootAuthorPubkey, maintainerSet) {
    if (!userPubkey) return false;
    if (userPubkey === rootAuthorPubkey) return true;
    if (Array.isArray(maintainerSet?.verified) && maintainerSet.verified.includes(userPubkey)) return true;
    return false;
  }

  // ── Phase 3b: Issues tab ─────────────────────────────────────────────
  //
  // Kind 1621 issues for the repo, with NIP-22 comment counts and a
  // "New issue" composer that shells through ngit issue_create.
  // Click a row → openIssueDetail (Phase 3c) shows the full threaded
  // conversation + a reply composer. Phase 7 adds an Open/All/Closed
  // filter row at the top.
  async function renderIssuesTab(container, p) {
    if (!state.issuesFilter) state.issuesFilter = 'open';
    if (typeof state.issuesSearch !== 'string') state.issuesSearch = '';
    let issuesCache = [];
    container.innerHTML = `
      <div class="tab-section">
        <div class="proposals-head">
          <h3 style="margin:0">Issues</h3>
          <div class="proposals-head-actions">
            <button class="primary issues-new">New issue</button>
            <button class="issues-refresh">Refresh</button>
          </div>
        </div>
        <div class="list-toolbar">
          <div class="list-filter" role="tablist" aria-label="Issue status filter">
            <button class="filter-pill ${state.issuesFilter === 'open'   ? 'active' : ''}" data-filter="open"   role="tab">Open</button>
            <button class="filter-pill ${state.issuesFilter === 'all'    ? 'active' : ''}" data-filter="all"    role="tab">All</button>
            <button class="filter-pill ${state.issuesFilter === 'closed' ? 'active' : ''}" data-filter="closed" role="tab">Closed</button>
          </div>
          <input type="search" class="list-search" placeholder="Search subjects + labels + authors"
                 value="${escapeHtml(state.issuesSearch)}" aria-label="Search issues">
        </div>
        <div class="issues-list" id="issues-list">
          <div class="muted">loading…</div>
        </div>
      </div>
    `;
    container.querySelectorAll('.filter-pill').forEach(btn => {
      btn.addEventListener('click', () => {
        state.issuesFilter = btn.dataset.filter;
        renderTab(document.querySelector('.project-tab-content'), p);
      });
    });
    const issueSearchEl = container.querySelector('.list-search');
    issueSearchEl.addEventListener('input', () => {
      state.issuesSearch = issueSearchEl.value;
      if (issuesCache.length > 0) renderList(issuesCache);
    });

    const listEl = container.querySelector('#issues-list');

    const renderList = (issues) => {
      if (!Array.isArray(issues)) issues = [];
      // Phase 7 status filter — Open = anything not yet closed/resolved.
      issuesCache = issues;
      const q = (state.issuesSearch || '').trim().toLowerCase();
      const visible = issues.filter(i => {
        const st = i.status || 'open';
        const statusOk =
          state.issuesFilter === 'open'   ? (st === 'open' || st === 'draft') :
          state.issuesFilter === 'closed' ? (st === 'closed' || st === 'resolved') :
          true;
        if (!statusOk) return false;
        if (!q) return true;
        const labelsStr = Array.isArray(i.labels) ? i.labels.join(' ') : '';
        const hay = `${i.subject || ''} ${labelsStr} ${i.author?.pubkey || ''}`.toLowerCase();
        return hay.includes(q);
      });
      if (visible.length === 0) {
        listEl.innerHTML = renderListEmptyState({
          icon: state.issuesFilter === 'open' ? '📋' : '✓',
          title: state.issuesFilter === 'open'
            ? 'No open issues'
            : state.issuesFilter === 'closed'
              ? 'No closed issues yet'
              : 'No issues yet',
          body: state.issuesFilter === 'open' && issues.length > 0
            ? `${issues.length} issue${issues.length === 1 ? '' : 's'} found — all are closed or resolved.`
            : 'Issues are NIP-34 kind-1621 events for tracking bugs, ideas, and discussions. Anyone reading this repo over Nostr can open one.',
          cta: state.issuesFilter !== 'open' ? null : { label: 'Open the first issue', className: 'issues-new-cta' },
        });
        const ctaBtn = listEl.querySelector('.issues-new-cta');
        if (ctaBtn) ctaBtn.addEventListener('click', () => openNewIssueComposer(p, () => fetchAndRender(true)));
        return;
      }
      listEl.innerHTML = visible.map(iss => {
        const author = shortPubkey(iss.author?.pubkey || iss.pubkey || '');
        const labelHtml = (iss.labels || []).slice(0, 6)
          .map(l => `<span class="issue-label">${escapeHtml(l)}</span>`)
          .join('');
        return `
          <div class="issue-row" data-id="${escapeHtml(iss.id)}" tabindex="0" role="button">
            <div class="issue-status-icon" data-status="${escapeHtml(iss.status)}">●</div>
            <div class="issue-main">
              <div class="issue-title">${escapeHtml(iss.subject)}</div>
              <div class="issue-meta muted">
                <span class="k">opened by ${escapeHtml(author)}</span>
                · <span class="k">${escapeHtml(fmtAgoIso(new Date((iss.createdAt || 0) * 1000).toISOString()))}</span>
                ${iss.commentCount > 0
                  ? `· <span class="k">${iss.commentCount} comment${iss.commentCount === 1 ? '' : 's'}</span>`
                  : ''}
              </div>
              ${labelHtml ? `<div class="issue-labels">${labelHtml}</div>` : ''}
            </div>
          </div>
        `;
      }).join('');
      listEl.querySelectorAll('.issue-row').forEach(row => {
        const open = () => openIssueDetail(p, row.dataset.id);
        row.addEventListener('click', open);
        row.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
        });
      });
    };

    const fetchAndRender = async (refresh = false) => {
      try {
        const r = await api(`/api/projects/${p.id}/issues${refresh ? '?refresh=1' : ''}`);
        const issues = Array.isArray(r?.issues) ? r.issues : [];
        await annotateIssuesWithStatus(p.id, issues);
        renderList(issues);
      } catch (e) {
        listEl.innerHTML = `<div class="muted">Failed to load issues: ${escapeHtml(e?.message || String(e))}</div>`;
      }
    };

    container.querySelector('.issues-refresh').addEventListener('click', () => {
      listEl.innerHTML = `<div class="muted">refreshing…</div>`;
      fetchAndRender(true);
    });

    container.querySelector('.issues-new').addEventListener('click', () => {
      openNewIssueComposer(p, () => fetchAndRender(true));
    });

    fetchAndRender();
  }

  // ── New-issue composer (Phase 3b) ────────────────────────────────────
  function openNewIssueComposer(p, onPublished) {
    const body = document.createElement('div');
    body.className = 'issue-composer';
    body.innerHTML = `
      <label class="field-label">Title</label>
      <div class="field-row">
        <input type="text" class="ni-title" maxlength="240" placeholder="Short subject">
      </div>

      <label class="field-label" style="margin-top:12px">Body (markdown)</label>
      <textarea class="ni-body" rows="8" placeholder="Describe the issue…"></textarea>

      <label class="field-label" style="margin-top:12px">Labels (optional)</label>
      <div class="field-row">
        <input type="text" class="ni-labels" placeholder="bug urgent enhancement">
      </div>
      <div class="muted" style="font-size:11px;margin-top:4px">
        Space-separated. Alphanumeric, dash, underscore. Max 32 chars each.
      </div>
    `;
    const foot = document.createElement('div');
    foot.style.display = 'flex'; foot.style.gap = '8px'; foot.style.width = '100%';
    const cancel = document.createElement('button'); cancel.textContent = 'Cancel';
    const submit = document.createElement('button'); submit.className = 'primary'; submit.textContent = 'Open issue';
    const spacer = document.createElement('div'); spacer.style.flex = '1';
    foot.appendChild(cancel); foot.appendChild(spacer); foot.appendChild(submit);

    const modal = openModal({ title: 'New issue', subtitle: p.name, body, footer: foot });
    cancel.addEventListener('click', () => modal.close());
    submit.addEventListener('click', () => {
      const title = body.querySelector('.ni-title').value.trim();
      if (!title) { toast('Title required', '', 'err'); return; }
      const bodyText = body.querySelector('.ni-body').value;
      const labels = body.querySelector('.ni-labels').value.trim()
        .split(/\s+/).filter(Boolean).slice(0, 8);
      modal.close();
      openExecModal({
        title:    `Open issue · ${p.name}`,
        subtitle: `ngit issue_create --title ${title.slice(0, 32)}${title.length > 32 ? '…' : ''}`,
        endpoint: `/api/projects/${p.id}/issues`,
        body:     { title, body: bodyText, labels },
      }).then((r) => {
        if (r.ok) { toast('Issue opened', title, 'ok'); onPublished?.(); }
        else      { toast('Failed to open issue', `exit ${r.code}`, 'err'); }
      });
    });
  }

  // ── Phase 3c: per-issue detail with threaded comments ────────────────
  async function openIssueDetail(p, issueId) {
    const body = document.createElement('div');
    body.className = 'idetail-body';
    body.innerHTML = `<div class="muted" style="padding:24px">Loading issue…</div>`;
    const modal = openModal({
      title:    'Issue',
      subtitle: issueId.slice(0, 16) + '…',
      body,
    });

    const load = async () => {
      let detail;
      try {
        detail = await api(`/api/projects/${p.id}/issues/${issueId}`);
      } catch (e) {
        body.innerHTML = `<div class="pdetail-err">Failed to load issue: ${escapeHtml(e?.message || String(e))}</div>`;
        return;
      }
      if (!detail || detail.error) {
        body.innerHTML = `<div class="pdetail-err">${escapeHtml(detail?.error || 'issue not found')}</div>`;
        return;
      }
      const author = shortPubkey(detail.author?.pubkey || detail.pubkey || '');
      const labels = (detail.labels || []).map(l => `<span class="issue-label">${escapeHtml(l)}</span>`).join('');
      // Phase 4: pull current effective status before render so the
      // badge + dropdown both reflect the latest 163x.
      let effective = 'open';
      try {
        const sr = await api(`/api/projects/${p.id}/status?rootIds=${encodeURIComponent(detail.id)}`);
        effective = sr?.results?.[0]?.status || 'open';
      } catch { /* stays 'open' */ }

      body.innerHTML = `
        <div class="idetail-head">
          <h3>${renderStatusBadge(effective)} ${escapeHtml(detail.subject)}</h3>
          <div class="idetail-meta muted">
            opened by ${escapeHtml(author)}
            · ${escapeHtml(fmtAgoIso(new Date((detail.createdAt || 0) * 1000).toISOString()))}
          </div>
          ${labels ? `<div class="issue-labels" style="margin-top:6px">${labels}</div>` : ''}
          <div class="idetail-status-slot" style="margin-top:8px"></div>
        </div>

        ${detail.body
          ? `<div class="idetail-body-md code-md">${renderMarkdown(detail.body)}</div>`
          : ''}

        <div class="comment-thread" id="comment-thread"></div>
        <div class="comment-composer" id="comment-composer"></div>
      `;
      const [issueOwnerPk, issueRepoMeta] = await Promise.all([
        getOwnerPubkey(),
        api(`/api/projects/${p.id}/repo`).catch(() => null),
      ]);
      const issueCanEdit = canEditStatus(
        issueOwnerPk, detail.author?.pubkey || detail.pubkey, issueRepoMeta?.maintainerSet,
      );
      body.querySelector('.idetail-status-slot').appendChild(
        renderStatusControl('issue', effective, issueCanEdit, (newStatus) => {
          openExecModal({
            title:    `${newStatus} · ${p.name}`,
            subtitle: `ngit issue status --${newStatus} ${detail.id.slice(0, 12)}…`,
            endpoint: `/api/projects/${p.id}/status`,
            body:     { kind: 'issue', rootId: detail.id, status: newStatus },
          }).then((r) => {
            if (r.ok) { toast(`Marked ${newStatus}`, detail.subject, 'ok'); load(); }
            else      { toast('Status change failed', `exit ${r.code}`, 'err'); }
          });
        }),
      );
      const threadEl = body.querySelector('#comment-thread');
      threadEl.innerHTML = renderCommentTree(detail.comments || []);
      wireCommentReplies(threadEl, p, issueId, load);
      mountCommentComposer(
        body.querySelector('#comment-composer'),
        p, issueId, load,
      );
    };
    load();
  }

  // ── Comment thread rendering + composer (Phase 3c, reused) ───────────
  //
  // The same renderer + composer pair is used for issue threads and
  // (in 3c-tidy) patch detail threads — wherever a kind-1621 or 1617
  // event needs a NIP-22 conversation surface.
  function renderCommentTree(nodes, depth = 0) {
    if (!Array.isArray(nodes) || nodes.length === 0) {
      return depth === 0
        ? `<div class="comment-empty muted">No comments yet.</div>`
        : '';
    }
    return nodes.map(n => {
      const author = shortPubkey(n.pubkey);
      const legacy = n.kind === 1622 ? ' <span class="comment-legacy">legacy</span>' : '';
      return `
        <div class="comment" data-id="${escapeHtml(n.id)}" style="--depth:${depth}">
          <div class="comment-head">
            <span class="comment-author">${escapeHtml(author)}</span>${legacy}
            <span class="comment-time muted">${escapeHtml(fmtAgoIso(new Date((n.createdAt || 0) * 1000).toISOString()))}</span>
          </div>
          <div class="comment-body code-md">${renderMarkdown(n.content || '')}</div>
          <div class="comment-actions">
            <button class="comment-reply" data-id="${escapeHtml(n.id)}">reply</button>
            <span class="copy-slot" data-copy="${escapeHtml(n.id)}"></span>
          </div>
          <div class="comment-children">
            ${renderCommentTree(n.children || [], depth + 1)}
          </div>
        </div>
      `;
    }).join('');
  }

  function wireCommentReplies(threadEl, p, rootId, onPublished) {
    threadEl.querySelectorAll('.copy-slot').forEach(s => {
      if (s.childElementCount === 0) s.appendChild(copyBtn(s.dataset.copy));
    });
    threadEl.querySelectorAll('.comment-reply').forEach(btn => {
      btn.addEventListener('click', () => {
        const targetId = btn.dataset.id;
        const wrap = btn.closest('.comment');
        // Toggle: if an inline composer already exists, remove it.
        const existing = wrap.querySelector(':scope > .comment-inline-composer');
        if (existing) { existing.remove(); return; }
        const composer = document.createElement('div');
        composer.className = 'comment-inline-composer';
        mountCommentComposer(composer, p, targetId, () => {
          composer.remove();
          onPublished?.();
        });
        wrap.appendChild(composer);
      });
    });
  }

  function mountCommentComposer(container, p, targetEventId, onPublished) {
    container.innerHTML = `
      <textarea class="comment-input" rows="3" placeholder="Write a comment…"></textarea>
      <div class="comment-composer-foot">
        <span class="muted" style="font-size:11px">
          Replies to <code>${escapeHtml(targetEventId.slice(0, 12))}…</code>
        </span>
        <button class="primary comment-submit">Reply</button>
      </div>
    `;
    container.querySelector('.comment-submit').addEventListener('click', () => {
      const text = container.querySelector('.comment-input').value.trim();
      if (!text) { toast('Empty comment', 'write something first', 'err'); return; }
      openExecModal({
        title:    `Comment · ${p.name}`,
        subtitle: `ngit comment --on ${targetEventId.slice(0, 12)}…`,
        endpoint: `/api/projects/${p.id}/comments`,
        body:     { eventId: targetEventId, body: text },
      }).then((r) => {
        if (r.ok) { toast('Comment posted', '', 'ok'); onPublished?.(); }
        else      { toast('Failed to post comment', `exit ${r.code}`, 'err'); }
      });
    });
  }

  // Strip the wss:// prefix for display so the picker stays scannable
  // when the URL list grows (matches shakespeare.diy's grasp list UX,
  // where the rows show `relay.ngit.dev` not `wss://relay.ngit.dev`).
  function stripWsPrefix(url) {
    return String(url || '').replace(/^wss?:\/\//, '');
  }

  async function renderNgitInitForm(container, p) {
    // Pull the user's global grasp list from /api/identity/config —
    // when the user hasn't touched it, the backend serves
    // DEFAULT_GRASP_SERVERS automatically. Any custom additions made
    // via Config → ngit show up here pre-checked, so the per-project
    // init form reflects "your standard grasp picks" without having
    // to re-type them on every project.
    const owner = await api('/api/identity/config').catch(() => ({ npub: '', graspServers: [] }));
    const globalGrasp = Array.isArray(owner.graspServers) ? owner.graspServers : [];
    // Probe signer state up-front so the form can show whether init
    // will actually succeed before the user fills in fields and clicks
    // through. /api/ngit/account is the same source of truth the
    // backend pre-flight uses, so the pill won't ever lie about which
    // path init will take.
    const account = await api('/api/ngit/account').catch(() => ({ loggedIn: false }));
    const amberPaired = !!account?.loggedIn;
    const noPath  = !p.path;
    container.innerHTML = `
      <div class="tab-section">
        <h3>Initialize ngit for this project</h3>
        <div class="muted" style="margin-bottom:10px">
          ngit is enabled for this project but no nostr remote is configured yet.
          Publishes a kind-30617 repo announcement so collaborators can clone via
          <code>git clone nostr://…</code>.
        </div>

        <label class="field-label">Repository name</label>
        <div class="field-row">
          <input type="text" class="ngit-init-name" placeholder="my-repo"
                 value="${escapeHtml(p.name || '')}" ${noPath ? 'disabled' : ''}>
        </div>
        <div class="muted" style="font-size:11px;margin-top:4px">
          Letters, digits, dot, dash, underscore. 1-64 chars.
        </div>

        <label class="field-label" style="margin-top:12px">Description (optional)</label>
        <div class="field-row">
          <input type="text" class="ngit-init-description" placeholder="One-line summary"
                 ${noPath ? 'disabled' : ''}>
        </div>

        <label class="field-label" style="margin-top:12px">GRASP servers</label>
        <div class="muted" style="font-size:11px;margin-bottom:6px">
          Where your git+nostr data is hosted. Pre-checked from your global list
          (manage in <a href="#config">Config → ngit</a>). Per-project: uncheck
          any that don't host this repo, or add a one-off below.
        </div>
        <div class="ngit-init-grasp">
          ${globalGrasp.length > 0
            ? globalGrasp.map(url => `
                <label class="ngit-grasp-row">
                  <input type="checkbox" class="ngit-grasp-toggle" data-url="${escapeHtml(url)}" checked ${noPath ? 'disabled' : ''}>
                  <code>${escapeHtml(stripWsPrefix(url))}</code>
                </label>
              `).join('')
            : `<div class="muted" style="font-size:11px;padding:6px 0">
                 No global GRASP servers configured. Add some in
                 <a href="#config">Config → ngit</a>, or use the custom input below
                 for a one-off init. Empty submit falls back to
                 <code>ngit init --defaults</code>.
               </div>`}
          <div class="ngit-grasp-custom" style="margin-top:6px">
            <input type="text" class="ngit-grasp-custom-input"
                   placeholder="wss://one-off-grasp.example  (optional)"
                   ${noPath ? 'disabled' : ''}>
            <div class="muted" style="font-size:11px;margin-top:4px">
              One-off addition for this project only. To add it to every future
              init, save it in Config → ngit instead.
            </div>
          </div>
        </div>

        <label class="field-label" style="margin-top:12px">npub</label>
        <div class="field-row">
          <input type="text" value="${escapeHtml(p.identity.useDefault ? (owner.npub || '') : (p.identity.npub || ''))}" disabled>
        </div>

        <label class="field-label" style="margin-top:12px">Signing</label>
        <div style="display:flex;align-items:center;gap:8px;margin-top:4px">
          ${amberPaired
            ? `<span class="bin-indicator bin-indicator-ok">✓</span>
               <span style="font-size:12px">Amber paired — ready to sign</span>`
            : `<span class="bin-indicator bin-indicator-err">✗</span>
               <span style="font-size:12px">Amber not paired — pair via <a href="#config">Config → ngit</a> first, then return here</span>`
          }
        </div>
        <div class="muted" style="font-size:11px;margin-top:4px">
          ngit init publishes a signed kind-30617 event; without Amber it can't sign.
        </div>

        <div class="step-actions" style="margin-top:14px">
          <button class="primary ngit-init-btn" ${(noPath || !amberPaired) ? `disabled title="${noPath ? 'ngit requires a local repository path.' : 'Pair Amber in Config → ngit first.'}"` : ''}>Initialize ngit</button>
        </div>
      </div>
    `;

    if (noPath) return;

    container.querySelector('.ngit-init-btn').addEventListener('click', () => {
      const name = container.querySelector('.ngit-init-name').value.trim();
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) {
        toast('Invalid name', '1-64 chars: alphanumerics, dot, dash, underscore', 'err');
        return;
      }
      const description = container.querySelector('.ngit-init-description').value.trim();

      // Collect every checked default + the custom input (if filled +
      // shaped like ws/wss). Server re-validates each URL anyway, but
      // failing fast here keeps the modal from opening just to error.
      const graspServers = Array.from(
        container.querySelectorAll('.ngit-grasp-toggle:checked'),
      ).map(el => el.dataset.url);
      const custom = container.querySelector('.ngit-grasp-custom-input').value.trim();
      if (custom) {
        if (!/^wss?:\/\//i.test(custom)) {
          toast('Invalid grasp-server URL', 'must start with wss:// or ws://', 'err');
          return;
        }
        graspServers.push(custom);
      }

      const subtitle = graspServers.length > 0
        ? `ngit init --name ${name} --grasp-server ${graspServers.length === 1 ? graspServers[0] : `(${graspServers.length} servers)`}`
        : `ngit init --name ${name} --defaults`;

      openExecModal({
        title:    `Initialize ngit · ${p.name}`,
        subtitle,
        endpoint: `/api/projects/${p.id}/ngit/init`,
        body:     { name, description, graspServers },
      }).then(async (r) => {
        if (!r.ok) return; // modal stays open on non-zero; user dismisses
        try {
          const det = await api('/api/projects/detect', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: p.path }),
          });
          if (det.ngitRemote) {
            const remotes = { github: p.remotes.github || null, ngit: det.ngitRemote };
            await api(`/api/projects/${p.id}`, {
              method: 'PATCH',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ remotes }),
            });
            toast('ngit initialized', 'nostr remote added', 'ok');
          } else {
            toast('ngit initialized', 'no remote detected — reload to retry', 'warn');
          }
        } catch (e) {
          toast('Post-init sync failed', e.message || '', 'warn');
        }
        // Re-fetches the project list, which triggers renderDetail() for the
        // currently open project and swaps the tab from init form → normal view.
        reload();
      });
    });
  }

  function renderNsiteTab(container, p) {
    const url = p.nsite.url;
    container.innerHTML = `
      <div class="tab-section">
        <h3>Deployed site</h3>
        ${url
          ? `<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer" class="nsite-url-big">${escapeHtml(url)}</a>`
          : `<div class="empty-state">No deployed URL set. Configure in Settings.</div>`}
        <div class="overview-kv" style="margin-top:12px"><div class="k">last deploy</div><div class="v">${escapeHtml(fmtAgoIso(p.nsite.lastDeploy))}</div></div>
      </div>
      <div class="tab-section">
        <button class="primary deploy-btn">Deploy now</button>
      </div>
      <div class="tab-section">
        <h3>Deploy log</h3>
        <div class="deploy-log empty-state">No deploy history yet</div>
      </div>
    `;
    container.querySelector('.deploy-btn').addEventListener('click', () => runProjectDeploy(p));
  }

  // Phase 7: Git and ngit operational controls are now Settings
  // sections rather than top-level tabs. The publish wizard (Phase 1d)
  // covers fresh-project onboarding so the standalone ngit-init form
  // is no longer the user's first encounter — it sits here for
  // re-initialise / advanced cases.
  function renderSettingsTab(container, p) {
    // Wrap renderGitTab / renderNgitTab outputs in <details> sections
    // so the Settings tab stays scannable. Each section's body uses
    // the existing render function — no refactor needed.
    const sections = [];
    if (p.capabilities.git) {
      sections.push({
        label:  'Git remote',
        render: (el) => renderGitTab(el, p),
        open:   false,
      });
    }
    if (p.capabilities.ngit) {
      sections.push({
        label:  p.remotes.ngit
                  ? 'ngit signer + sync'
                  : 'Initialize ngit for this project',
        render: (el) => renderNgitTab(el, p),
        // Auto-open the ngit section when the project hasn't been
        // initialised yet — that's the case where the user needs it.
        open:   !p.remotes.ngit,
      });
    }
    // Render the existing Settings content first (project name, path,
    // capabilities, etc. — the canonical "metadata" section).
    renderSettingsTabBody(container, p);
    // Append operational sections as collapsible details so the
    // user can find them but they don't dominate the tab.
    for (const s of sections) {
      const det = document.createElement('details');
      det.className = 'settings-section';
      if (s.open) det.setAttribute('open', '');
      const sum = document.createElement('summary');
      sum.textContent = s.label;
      det.appendChild(sum);
      const body = document.createElement('div');
      body.className = 'settings-section-body';
      det.appendChild(body);
      container.appendChild(det);
      s.render(body);
    }
  }

  function renderSettingsTabBody(container, p) {
    // Phase 3 follow-up — once the About tab landed with full Edit
    // Repository support, Settings is exclusively for *local* dashboard
    // config (path, capabilities, AI overrides, etc). The banner orients
    // users who reach Settings looking to edit the public-facing repo
    // metadata (name/description/website/topics/relays/maintainers).
    const aboutAvailable = p.capabilities.ngit && p.remotes.ngit;
    const aboutBanner = aboutAvailable ? `
      <div class="settings-banner">
        <span class="muted">This tab manages how nostr-station handles this project locally
        — path, capabilities, signing identity, AI config.
        Edit the repository's public announcement (name, description, website, topics,
        relays, maintainers) on the
        <a href="#" class="settings-banner-link" data-go="about">About</a> tab.</span>
      </div>
    ` : '';
    container.innerHTML = `
      ${aboutBanner}
      <div class="tab-section">
        <h3>Details</h3>
        <label class="field-label">Name</label>
        <div class="field-row">
          <input type="text" class="s-name" maxlength="64" value="${escapeHtml(p.name)}">
          <button class="primary save-name">save</button>
        </div>

        <label class="field-label">Local path</label>
        <div class="field-row">
          <input type="text" class="s-path" placeholder="/Users/you/projects/my-project" value="${escapeHtml(p.path || '')}">
          <button class="primary save-path">save</button>
        </div>
        <div class="muted">Saving the path re-runs capability detection.</div>
      </div>

      <div class="tab-section">
        <h3>Capabilities</h3>
        <label class="checkbox-row"><input type="checkbox" class="s-cap-git" ${p.capabilities.git ? 'checked' : ''}> git</label>
        <label class="checkbox-row"><input type="checkbox" class="s-cap-ngit" ${p.capabilities.ngit ? 'checked' : ''}> ngit</label>
        <label class="checkbox-row"><input type="checkbox" class="s-cap-nsite" ${p.capabilities.nsite ? 'checked' : ''}> nsite</label>
        <div class="step-actions"><button class="primary save-caps">save capabilities</button></div>
      </div>

      <div class="tab-section" id="git-identity-section">
        <h3>Git Identity</h3>
        <div class="muted" style="margin-bottom:8px">
          Author name + email baked into every <code>git commit</code> in this
          repo. Resolves repo-local first, then global. Set per-project to
          override (e.g. real email for a client project, npub-shorthand for
          a Nostr-native one).
        </div>
        <div class="git-identity-body">loading…</div>
      </div>

      <div class="tab-section">
        <h3>Identity</h3>
        <label class="radio-row">
          <input type="radio" name="s-ident-mode" value="default" ${p.identity.useDefault ? 'checked' : ''}>
          <div>
            <div class="radio-title">Use station identity</div>
            <div class="radio-sub">Station owner npub signs all operations.</div>
          </div>
        </label>
        <label class="radio-row">
          <input type="radio" name="s-ident-mode" value="project" ${p.identity.useDefault ? '' : 'checked'}>
          <div>
            <div class="radio-title">Project-specific identity</div>
            <div class="radio-sub">Isolates this project's signing.</div>
          </div>
        </label>
        <div class="project-ident-fields" style="${p.identity.useDefault ? 'display:none' : ''}">
          <label class="field-label">npub</label>
          <input type="text" class="s-ident-npub" placeholder="npub1… or 64-char hex" value="${escapeHtml(p.identity.npub || '')}">
          <label class="field-label">Bunker URL <span class="muted">(optional)</span></label>
          <input type="text" class="s-ident-bunker" placeholder="bunker://…" value="${escapeHtml(p.identity.bunkerUrl || '')}">
        </div>
        <div class="step-actions"><button class="primary save-ident">save identity</button></div>
      </div>

      <div class="tab-section" id="environment-section">
        <h3>Environment</h3>
        <div class="env-body"></div>
      </div>

      <div class="tab-section" id="test-users-section">
        <h3>Test users</h3>
        <div class="muted" style="margin-bottom:8px">
          Per-project throwaway keys for local development. Each test
          user is auto-whitelisted on the local relay; events they sign
          carry a <code>["client","nostr-station-test"]</code> tag so
          they never leak to public infrastructure.
        </div>
        <div class="test-users-body">loading…</div>
      </div>

      <div class="tab-section" id="pcfg-section">
        <h3>AI configuration</h3>
        <div class="muted">
          Per-project overrides for the Chat pane. Empty fields inherit
          the station defaults from <a href="#config">Config</a>.
          Stored at <code>${escapeHtml(p.path || '<no path>')}/.nostr-station/</code>.
        </div>
        <div class="pcfg-body">loading…</div>
      </div>

      <div class="danger-zone">
        <h4>Danger zone</h4>
        <div class="row">
          <div>
            <div>Remove project</div>
            <div class="desc">
              Removes the project from nostr-station. Does not delete any files.
              ${aboutAvailable ? `Same action is also available on the About tab footer.` : ''}
            </div>
          </div>
          <button class="danger remove-btn">remove</button>
        </div>
        ${p.path ? `
          <div class="row">
            <div>
              <div>Delete on disk</div>
              <div class="desc">
                ${p.pathMissing
                  ? `Files at <code>${escapeHtml(p.path)}</code> are already gone. Use Remove to unregister the orphan entry.`
                  : `Removes the project from nostr-station <em>and</em> deletes <code>${escapeHtml(p.path)}</code> and all its contents. This is irreversible.`}
              </div>
            </div>
            <button class="danger delete-btn" ${p.pathMissing ? 'disabled' : ''}>delete on disk</button>
          </div>
        ` : ''}
      </div>
    `;

    // Lazy-load the AI config bundle. We don't block the rest of the
    // Settings tab on it — the panel renders immediately and the AI
    // section fills in as soon as /api/projects/:id/ai-config returns.
    if (p.path) {
      paintProjectAiConfig(container.querySelector('#pcfg-section .pcfg-body'), p);
      paintProjectGitIdentity(container.querySelector('#git-identity-section .git-identity-body'), p);
    } else {
      const sec = container.querySelector('#pcfg-section .pcfg-body');
      if (sec) sec.innerHTML = '<div class="muted">Project has no local path — AI config requires a path.</div>';
      const gid = container.querySelector('#git-identity-section .git-identity-body');
      if (gid) gid.innerHTML = '<div class="muted">Project has no local path — git identity requires a path.</div>';
    }

    // Banner link: switch to About without a full page navigation.
    container.querySelector('.settings-banner-link')?.addEventListener('click', (e) => {
      e.preventDefault();
      state.tab = 'about';
      renderTab(document.querySelector('.project-tab-content'), p);
      // Highlight the About tab in the strip — render() rebuilds the
      // strip but renderTab alone doesn't, so set the visual state too.
      document.querySelectorAll('.project-tabs .tab').forEach(t => {
        t.classList.toggle('active', t.dataset.tab === 'about');
      });
    });

    container.querySelector('.save-name').addEventListener('click', async () => {
      const v = container.querySelector('.s-name').value.trim();
      if (!v) return toast('Name required', '', 'warn');
      await patchAndReload(p.id, { name: v });
    });
    container.querySelector('.save-path').addEventListener('click', async () => {
      const v = container.querySelector('.s-path').value.trim();
      const newPath = v || null;
      let patch = { path: newPath };
      if (newPath) {
        try {
          const det = await api('/api/projects/detect', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: newPath }),
          });
          if (det.exists) {
            const caps = { ...p.capabilities };
            if (det.isGitRepo) caps.git = true;
            if (det.ngitRemote) caps.ngit = true;
            if (det.hasNsyte) caps.nsite = true;
            patch.capabilities = caps;
            patch.remotes = {
              github: det.githubRemote || p.remotes.github || null,
              ngit:   det.ngitRemote   || p.remotes.ngit   || null,
            };
          }
        } catch {}
      }
      await patchAndReload(p.id, patch);
    });

    container.querySelector('.save-caps').addEventListener('click', async () => {
      const caps = {
        git:   container.querySelector('.s-cap-git').checked,
        ngit:  container.querySelector('.s-cap-ngit').checked,
        nsite: container.querySelector('.s-cap-nsite').checked,
      };
      await patchAndReload(p.id, { capabilities: caps });
    });

    const identFields = container.querySelector('.project-ident-fields');
    container.querySelectorAll('input[name="s-ident-mode"]').forEach(r => {
      r.addEventListener('change', () => {
        identFields.style.display = (r.value === 'default') ? 'none' : '';
      });
    });
    container.querySelector('.save-ident').addEventListener('click', async () => {
      const useDefault = container.querySelector('input[name="s-ident-mode"][value="default"]').checked;
      const npub   = container.querySelector('.s-ident-npub').value.trim();
      const bunker = container.querySelector('.s-ident-bunker').value.trim();
      if (!useDefault && npub.startsWith('nsec')) return toast('nsec rejected', 'never paste your private key', 'err');
      await patchAndReload(p.id, {
        identity: {
          useDefault,
          npub: useDefault ? null : (npub || null),
          bunkerUrl: useDefault ? null : (bunker || null),
        },
      });
    });

    // Environment editor — replaces the old per-project read-relays
    // section. Routes through paintEnvironment so the same renderer can
    // be re-used after every patch (active-env toggle, list edits) and
    // by future Phase E flows that need to show the same widget.
    paintEnvironment(container.querySelector('#environment-section .env-body'), p);
    paintTestUsers(container.querySelector('#test-users-section .test-users-body'), p);

    container.querySelector('.remove-btn').addEventListener('click', async () => {
      const ok = await confirmDestructive({
        title: 'Remove project',
        description: 'This removes the project from nostr-station. It does not delete any files.',
        confirmLabel: 'Remove',
      });
      if (!ok) return;
      try {
        await api(`/api/projects/${p.id}`, { method: 'DELETE' });
        toast('Project removed', p.name, 'ok');
        state.view = 'list'; state.projectId = null;
        reload();
      } catch {}
    });

    // Delete on disk — destructive. Type-to-confirm dialog (reuses the
    // existing confirmDestructive helper) matches the gravity of rm -rf.
    // Button is hidden entirely for nsite-only projects (no path) and
    // disabled when the path is already missing (orphaned registration —
    // Remove is the right action, not Delete).
    const deleteBtn = container.querySelector('.delete-btn');
    if (deleteBtn && !deleteBtn.disabled) {
      deleteBtn.addEventListener('click', async () => {
        const ok = await confirmDestructive({
          title: 'Delete project on disk',
          description: `This removes the project from nostr-station AND deletes ${p.path} and all its contents. This cannot be undone.`,
          typeToConfirm: p.name,
          confirmLabel: 'Delete on disk',
        });
        if (!ok) return;
        try {
          const r = await api(`/api/projects/${p.id}/purge`, { method: 'POST' });
          if (r.rmError) {
            toast('Deleted registration — filesystem cleanup failed', r.rmError, 'warn');
          } else {
            toast('Project deleted', `${p.name} · ${r.removedPath}`, 'ok');
          }
          state.view = 'list'; state.projectId = null;
          reload();
        } catch (e) {
          toast('Delete failed', e.message, 'err');
        }
      });
    }
  }

  // Renders the per-project Environment editor. Two modes:
  //   - environment present: dev/prod tabs with relay+blossom list
  //     editors, active-env toggle, and a Stacks divergence banner
  //     when applicable.
  //   - environment absent: a single "Isolate to local infra" CTA
  //     that flips the project into dev mode against the running
  //     local relay (and Blossom in Phase C). New-local-project
  //     scaffolds already get the seed, so this CTA is the opt-in
  //     path for legacy + imported + cloned projects.
  function paintEnvironment(root, p) {
    if (!root) return;
    const env = p.environment;
    if (!env) {
      root.innerHTML = `
        <div class="muted" style="margin-bottom:10px">
          This project hasn't been isolated to local dev infrastructure yet.
          Click below to flip it into dev mode against the running local
          relay &mdash; spawned dev servers (<code>npm run dev</code>,
          deploy, exec) will then see
          <code>NOSTR_STATION_RELAY=ws://localhost:&lt;port&gt;</code> via
          environment variables. This setting affects only this project's
          spawned subprocesses; the Client panel (public Nostr) stays on
          your public relays regardless.
        </div>
        <div class="step-actions">
          <button class="primary isolate-btn">Isolate to local infra</button>
        </div>
      `;
      root.querySelector('.isolate-btn').addEventListener('click', async () => {
        // Server-side defaults are computed when we send an environment
        // block with empty arrays and active='dev'; the user can then
        // edit relays/blossoms via the editor that this paint will
        // re-render. We seed prod.relays from p.readRelays (the
        // legacy field, which still surfaces public defaults via the
        // identity-derived read-through) so the user doesn't have to
        // re-enter them. Local relay port is hardcoded to 7777 here
        // since the client doesn't know which port the server bound;
        // the server's scaffold seed pulls the live port for new
        // projects, but for retrofits the user can edit it inline.
        const seed = {
          active: 'dev',
          dev:  { relays: ['ws://localhost:7777'], blossoms: [] },
          prod: {
            relays: Array.isArray(p.readRelays) ? p.readRelays.slice() : [],
            blossoms: [],
          },
        };
        await patchAndReload(p.id, { environment: seed });
      });
      return;
    }

    const activeBlockKey = env.active === 'dev' ? 'dev' : 'prod';
    const stacksHint = renderStacksDivergenceHint(p, env);
    root.innerHTML = `
      <div class="env-header">
        <div class="env-active-row">
          <span class="env-chip env-chip-${env.active}" title="${escapeHtml(ENV_CHIP_TOOLTIPS[env.active])}">${env.active}</span>
          <span class="muted">active environment for this project &mdash; spawned dev servers (<code>npm run dev</code>, deploy, exec) read this block via <code>NOSTR_STATION_RELAY</code> / <code>_BLOSSOM</code>. The Client panel is unaffected; it always queries public relays.</span>
        </div>
        <div class="step-actions" style="margin-top:6px">
          <button class="${env.active === 'dev'  ? 'primary' : ''} env-flip-dev">use dev</button>
          <button class="${env.active === 'prod' ? 'primary' : ''} env-flip-prod">use prod</button>
        </div>
      </div>
      ${stacksHint}
      <div class="step-actions" style="margin-top:8px">
        <button class="env-promote-dryrun" title="Show what would be published to prod">Promote to prod (dry-run)…</button>
      </div>
      <div class="env-tabs" role="tablist" style="margin-top:14px">
        <button class="env-tab ${activeBlockKey === 'dev'  ? 'active' : ''}" data-which="dev"  role="tab">dev</button>
        <button class="env-tab ${activeBlockKey === 'prod' ? 'active' : ''}" data-which="prod" role="tab">prod</button>
      </div>
      <div class="env-tab-body" data-which="dev"  ${activeBlockKey === 'dev'  ? '' : 'hidden'}></div>
      <div class="env-tab-body" data-which="prod" ${activeBlockKey === 'prod' ? '' : 'hidden'}></div>
      <div class="muted" style="margin-top:10px;font-size:11px">
        Relays: <code>ws://</code> or <code>wss://</code>. Blossoms: <code>http://</code> (local) or
        <code>https://</code> (public). The "Isolate" button + scaffold seed local URLs;
        edit inline as needed.
      </div>
    `;
    paintEnvBlock(root.querySelector('.env-tab-body[data-which="dev"]'),  p, 'dev',  env.dev);
    paintEnvBlock(root.querySelector('.env-tab-body[data-which="prod"]'), p, 'prod', env.prod);

    // Active-env flip buttons. We don't gate on a running dev server
    // server-side (Phase A.6 deferred) — instead surface a soft warning
    // when the user has any open project-bound terminal tab so they
    // know the live PTY env is stale until they restart.
    const flipDev  = root.querySelector('.env-flip-dev');
    const flipProd = root.querySelector('.env-flip-prod');
    flipDev?.addEventListener('click', () => flipActiveEnv(p, 'dev'));
    flipProd?.addEventListener('click', () => flipActiveEnv(p, 'prod'));

    root.querySelector('.env-promote-dryrun')?.addEventListener('click', () => openPromoteDialog(p));

    // Tab switching. The two bodies stay in the DOM; we just toggle
    // hidden so list edits in one don't lose draft input when the user
    // peeks at the other.
    root.querySelectorAll('.env-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        const which = tab.dataset.which;
        root.querySelectorAll('.env-tab').forEach(t =>
          t.classList.toggle('active', t === tab));
        root.querySelectorAll('.env-tab-body').forEach(b =>
          b.hidden = (b.dataset.which !== which));
      });
    });
  }

  // Detect a divergence between the project's dev.relays and the local
  // Stacks config's relay list (when the project is a Stacks project on
  // macOS, where Stacks's config lives at
  // ~/Library/Preferences/stacks/config.json). The dashboard already
  // reads that config via GET /api/stacks/config for the AI provider
  // section, but it doesn't surface relay info today; for v1 we only
  // diff on the public flag (config exists vs. doesn't) and let the
  // banner copy point users at `stacks configure` for the fix. Phase B+
  // can extend this to a deep relay-list diff once we wire the config
  // reader to return the relays field too.
  function renderStacksDivergenceHint(p, env) {
    if (!p.stacksProject) return '';
    // Heuristic: a Stacks project whose dev block has only the local
    // relay almost certainly has Dork pointing at a different relay
    // list, since `stacks configure` defaults to public relays. We
    // can't confirm without reading the Stacks config server-side, so
    // the banner is a soft nudge rather than a hard claim.
    const devOnlyLocal = env.dev.relays.length === 1 &&
      /^ws:\/\/(localhost|127\.0\.0\.1)/.test(env.dev.relays[0]);
    if (!devOnlyLocal) return '';
    return `
      <div class="pc-banner warn" style="margin-top:10px" hidden-not>
        Stacks config may diverge — the Dork agent reads its own relay list from
        <code>~/Library/Preferences/stacks/config.json</code>. If you want Dork
        to see the same local relay, run <code>stacks configure</code> and point
        it at <code>${escapeHtml(env.dev.relays[0])}</code>.
      </div>
    `;
  }

  // Paints one dev/prod block — the relay + blossom list editor pair.
  // We render each as a list-with-remove + add-input shape that matches
  // the legacy "Read relays" UX so muscle memory carries over.
  function paintEnvBlock(root, p, which, block) {
    if (!root) return;
    root.innerHTML = `
      <div class="env-list-section">
        <h4 style="margin:8px 0 4px">relays</h4>
        <div class="env-relay-list"></div>
        <div class="field-row">
          <input type="text" class="env-relay-add" placeholder="${which === 'dev' ? 'ws://localhost:7777' : 'wss://relay.example.com'}">
          <button class="env-relay-add-btn">add</button>
        </div>
      </div>
      <div class="env-list-section" style="margin-top:10px">
        <h4 style="margin:8px 0 4px">blossoms</h4>
        <div class="env-blossom-list"></div>
        <div class="field-row">
          <input type="text" class="env-blossom-add" placeholder="${which === 'dev' ? 'http://localhost:8081' : 'https://blossom.example.com'}">
          <button class="env-blossom-add-btn">add</button>
        </div>
      </div>
    `;
    paintUrlList(root.querySelector('.env-relay-list'),   block.relays,   url => removeEnvUrl(p, which, 'relays', url));
    paintUrlList(root.querySelector('.env-blossom-list'), block.blossoms, url => removeEnvUrl(p, which, 'blossoms', url));
    root.querySelector('.env-relay-add-btn').addEventListener('click', () => {
      const input = root.querySelector('.env-relay-add');
      const v = (input.value || '').trim();
      if (!v) return;
      if (!/^wss?:\/\//.test(v)) return toast('Relay URL must start with ws:// or wss://', '', 'warn');
      addEnvUrl(p, which, 'relays', v);
    });
    root.querySelector('.env-blossom-add-btn').addEventListener('click', () => {
      const input = root.querySelector('.env-blossom-add');
      const v = (input.value || '').trim();
      if (!v) return;
      if (!/^https?:\/\//.test(v)) return toast('Blossom URL must start with http:// or https://', '', 'warn');
      addEnvUrl(p, which, 'blossoms', v);
    });
  }

  function paintUrlList(root, urls, onRemove) {
    if (!root) return;
    if (!urls || urls.length === 0) {
      root.innerHTML = `<div class="muted" style="font-size:11px">(none)</div>`;
      return;
    }
    root.innerHTML = urls.map(u =>
      `<div class="relay-row"><code>${escapeHtml(u)}</code><button class="relay-remove" data-url="${escapeHtml(u)}">remove</button></div>`,
    ).join('');
    root.querySelectorAll('.relay-remove').forEach(btn => {
      btn.addEventListener('click', () => onRemove(btn.dataset.url));
    });
  }

  // Mutators — each builds a fresh environment object and PATCHes the
  // whole block in one go. This matches the server's validation
  // contract (validate the full environment, no partial updates) and
  // keeps the client logic shallow — every list edit is one round-trip.
  async function addEnvUrl(p, which, key, url) {
    const env = clonedEnv(p.environment);
    if (!env) return;
    const list = env[which][key];
    if (!list.includes(url)) list.push(url);
    await patchAndReload(p.id, { environment: env });
  }
  async function removeEnvUrl(p, which, key, url) {
    const env = clonedEnv(p.environment);
    if (!env) return;
    env[which][key] = env[which][key].filter(u => u !== url);
    await patchAndReload(p.id, { environment: env });
  }
  async function flipActiveEnv(p, next) {
    if (!p.environment || p.environment.active === next) return;
    // Soft warning when there's any open project-bound PTY for this
    // project. Phase A.6 will add the server-side hard refusal; for
    // now we trust the user to acknowledge that the live PTY env is
    // stale until they restart.
    const hasLivePty = !!window.NSTerminal?.hasProjectSession?.(p.id);
    if (hasLivePty) {
      const ok = await confirmDestructive({
        title: 'Restart dev server to pick up new env',
        description:
          'A terminal tab is open for this project. The currently-running ' +
          'process keeps its old env vars until you restart it — flip the ' +
          'env, then stop and reopen the terminal.',
        confirmLabel: 'Flip anyway',
      });
      if (!ok) return;
    }
    const env = clonedEnv(p.environment);
    env.active = next;
    await patchAndReload(p.id, { environment: env });
  }
  function clonedEnv(src) {
    if (!src) return null;
    return {
      active: src.active,
      dev:  { relays: (src.dev?.relays  || []).slice(), blossoms: (src.dev?.blossoms  || []).slice() },
      prod: { relays: (src.prod?.relays || []).slice(), blossoms: (src.prod?.blossoms || []).slice() },
    };
  }

  // Open the promote dialog: run a dry-run, show the plan + refused
  // events + blob rewrites, then offer an Apply button. Apply re-runs
  // promote with apply=true (which re-prompts Amber for each re-sign +
  // each NIP-98 upload auth).
  async function openPromoteDialog(p) {
    const wait = toast('Running dry-run…', 'querying local relay', 'info');
    let plan;
    try {
      plan = await api(`/api/projects/${p.id}/promote`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ apply: false }),
      });
    } catch (e) {
      toast('Dry-run failed', e?.message || '', 'err');
      return;
    } finally {
      try { wait?.dismiss?.(); } catch {}
    }

    const summary = [
      `${plan.promote.length} event${plan.promote.length === 1 ? '' : 's'} to publish`,
      `${plan.refused.length} refused`,
      `${plan.blobs.length} blob${plan.blobs.length === 1 ? '' : 's'} to re-upload`,
    ].join(' · ');

    const detailLines = [];
    if (plan.errors.length) {
      detailLines.push('Errors:');
      for (const e of plan.errors) detailLines.push(`  • ${e}`);
      detailLines.push('');
    }
    if (plan.refused.length) {
      detailLines.push('Refused events:');
      for (const r of plan.refused) {
        detailLines.push(`  • kind ${r.kind} id ${r.id.slice(0, 8)}… (${r.reason})`);
      }
      detailLines.push('');
    }
    if (plan.promote.length) {
      detailLines.push('Will publish:');
      for (const c of plan.promote) {
        const marker = c.rewrote ? ' [rewrites local blob URLs]' : '';
        // kindClass surfaces NIP-01 semantics: "replaceable" /
        // "addressable" promote idempotently; "regular" creates a new
        // public note with a fresh timestamp. "deletion" is the kind-5
        // edge case with a clear advisory.
        const cls = c.kindClass ? ` (${c.kindClass})` : '';
        detailLines.push(`  • kind ${c.kind}${cls} id ${c.id.slice(0, 8)}…${marker}`);
        if (c.kindNote) detailLines.push(`      ↪ ${c.kindNote}`);
      }
      detailLines.push('');
    }
    if (plan.blobs.length) {
      detailLines.push('Blobs to re-upload to prod Blossom:');
      for (const b of plan.blobs) detailLines.push(`  • ${b.sha256.slice(0, 12)}… ← ${b.localUrl}`);
    }

    const canApply = plan.errors.length === 0 && plan.promote.length > 0;
    const ok = await confirmDestructive({
      title: `Promote ${p.name} to prod`,
      description: `${summary}\n\n${detailLines.join('\n')}`,
      confirmLabel: canApply ? 'Apply' : 'Close',
    });
    if (!ok || !canApply) return;

    const wait2 = toast('Promoting…', 'this prompts Amber to sign each event', 'info');
    try {
      const r = await api(`/api/projects/${p.id}/promote`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ apply: true }),
      });
      const msg = `Published ${r.eventsPublished} event(s), uploaded ${r.blobsUploaded} blob(s)` +
        (r.errors?.length ? ` (with ${r.errors.length} error${r.errors.length === 1 ? '' : 's'})` : '');
      toast('Promote complete', msg, r.errors?.length ? 'warn' : 'ok');
    } catch (e) {
      toast('Promote failed', e?.message || '', 'err');
    } finally {
      try { wait2?.dismiss?.(); } catch {}
    }
  }

  // Renders the per-project Test users section. Two states:
  //   - file mode 0600 + parseable → list + add + reset controls
  //   - file mode wrong / parse failure → big red banner with a
  //     "Fix permissions" button that chmods the file back to 0600
  async function paintTestUsers(root, p) {
    if (!root) return;
    if (!p.path) {
      root.innerHTML = `<div class="muted">Project has no local path — test users require a path.</div>`;
      return;
    }
    let resp = null;
    try { resp = await api(`/api/projects/${p.id}/test-identities`); }
    catch (e) {
      // Server returned 4xx (e.g. bad-mode) — body is JSON with { error, mode? }.
      const message = e?.body?.error || e?.message || 'unknown error';
      const isBadMode = message === 'bad-mode';
      root.innerHTML = `
        <div class="pc-banner err">
          <div><b>Cannot load test identities</b></div>
          <div class="muted" style="margin-top:4px">${escapeHtml(message)}</div>
          ${isBadMode ? `
            <div class="step-actions" style="margin-top:8px">
              <button class="primary tu-fix-perms">Fix permissions (chmod 600)</button>
            </div>
          ` : ''}
        </div>
      `;
      // No server-side "fix permissions" endpoint yet — point user at the path.
      root.querySelector('.tu-fix-perms')?.addEventListener('click', () => {
        const fp = `${p.path}/.nostr-station/test-identities.json`;
        toast('Run in your terminal',
          `chmod 600 "${fp}"`, 'warn');
      });
      return;
    }

    const identities = resp?.identities || [];
    const rows = identities.length === 0
      ? `<div class="muted">No test users yet.</div>`
      : identities.map(id => `
        <div class="test-user-row" data-tid="${escapeHtml(id.id)}">
          <div class="test-user-meta">
            <div><b>${escapeHtml(id.label)}</b> <span class="muted" style="font-size:11px">· ${escapeHtml(id.role || 'no role')}</span></div>
            <div class="muted" style="font-size:11px"><code>${escapeHtml(id.npub.slice(0, 14))}…${escapeHtml(id.npub.slice(-6))}</code></div>
          </div>
          <button class="tu-delete" data-tid="${escapeHtml(id.id)}">remove</button>
        </div>
      `).join('');

    root.innerHTML = `
      <div class="test-user-list">${rows}</div>
      <div class="field-row" style="margin-top:10px">
        <input type="text" class="tu-label" placeholder="label (e.g. teacher-alice)" style="flex:2">
        <input type="text" class="tu-role"  placeholder="role (optional)" style="flex:1">
        <button class="tu-add">add test user</button>
      </div>
      ${identities.length ? `
        <div class="step-actions" style="margin-top:10px">
          <button class="tu-seed">Seed fixture events (3 per user)</button>
          <button class="danger tu-reset">Reset all (regenerate)</button>
        </div>
      ` : ''}
    `;

    root.querySelectorAll('.tu-delete').forEach(btn => {
      btn.addEventListener('click', async () => {
        const tid = btn.dataset.tid;
        const ok = await confirmDestructive({
          title: 'Remove test user?',
          description: 'Deletes the keypair and removes the pubkey from the local relay\'s whitelist. Any events they\'ve published stay in the relay store.',
          confirmLabel: 'Remove',
        });
        if (!ok) return;
        try {
          await api(`/api/projects/${p.id}/test-identities/${tid}`, { method: 'DELETE' });
          paintTestUsers(root, p);
        } catch (e) { toast('Remove failed', e?.message || '', 'err'); }
      });
    });

    root.querySelector('.tu-add')?.addEventListener('click', async () => {
      const label = root.querySelector('.tu-label').value.trim();
      const role  = root.querySelector('.tu-role').value.trim();
      if (!label) return toast('Label required', 'pick something like teacher-alice', 'warn');
      try {
        await api(`/api/projects/${p.id}/test-identities`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body:    JSON.stringify({ label, role }),
        });
        paintTestUsers(root, p);
      } catch (e) {
        toast('Add failed', e?.message || '', 'err');
      }
    });

    root.querySelector('.tu-seed')?.addEventListener('click', async () => {
      const btn = root.querySelector('.tu-seed');
      btn.disabled = true;
      btn.textContent = 'Seeding…';
      try {
        const r = await api(`/api/projects/${p.id}/test-identities/seed`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ countPerIdentity: 3 }),
        });
        const msg = r.errors?.length
          ? `Published ${r.eventsPublished} events (with ${r.errors.length} errors)`
          : `Published ${r.eventsPublished} events from ${r.identitiesUsed} test user${r.identitiesUsed === 1 ? '' : 's'}`;
        toast('Seed complete', msg, r.errors?.length ? 'warn' : 'ok');
      } catch (e) {
        toast('Seed failed', e?.message || '', 'err');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Seed fixture events (3 per user)';
      }
    });

    root.querySelector('.tu-reset')?.addEventListener('click', async () => {
      const ok = await confirmDestructive({
        title: 'Reset all test users?',
        description: `Removes all ${identities.length} test user(s) from this project and the relay whitelist. Cannot be undone.`,
        confirmLabel: 'Reset',
      });
      if (!ok) return;
      try {
        await api(`/api/projects/${p.id}/test-identities/reset`, { method: 'POST' });
        paintTestUsers(root, p);
      } catch (e) { toast('Reset failed', e?.message || '', 'err'); }
    });
  }

  // Renders the per-project git-identity row in Settings: shows the
  // resolved value + source ('local' / 'global' / 'unset'), with an
  // inline form to set/clear repo-local override. Source attribution
  // is the load-bearing UX bit — users can tell at a glance whether
  // a repo inherits the global identity or has its own override,
  // without dropping to `git config --show-origin user.email`.
  async function paintProjectGitIdentity(root, p) {
    if (!root) return;
    let resolved;
    try {
      resolved = await api(`/api/projects/${p.id}/git-identity`);
    } catch (e) {
      root.innerHTML = `<div class="muted">failed to load: ${escapeHtml(e?.message || 'unknown')}</div>`;
      return;
    }
    const sourceLabel = resolved.source === 'local'  ? 'set per-project'
                      : resolved.source === 'global' ? 'inherited from global config'
                      :                                'unset (auto-seed will fire on first commit)';
    const sourceClass = resolved.source === 'local'  ? 'ok'
                      : resolved.source === 'global' ? ''
                      :                                'warn';
    root.innerHTML = `
      <div class="config-row">
        <div class="k">Resolved</div>
        <div class="v">
          <div>${resolved.name && resolved.email
            ? `<code>${escapeHtml(resolved.name)} &lt;${escapeHtml(resolved.email)}&gt;</code>`
            : '<span class="muted">(none)</span>'}</div>
          <div class="key-status-line ${sourceClass}" style="margin-top:4px">${escapeHtml(sourceLabel)}</div>
        </div>
      </div>
      <div class="config-row" style="margin-top:14px">
        <div class="k">Repo-local override</div>
        <div class="v">
          <div class="keyrow">
            <div class="keyfield">
              <input class="gid-name" type="text" autocomplete="off"
                     placeholder="Your Name (this repo only)"
                     value="${escapeHtml(resolved.source === 'local' ? resolved.name : '')}">
            </div>
          </div>
          <div class="keyrow" style="margin-top:6px">
            <div class="keyfield">
              <input class="gid-email" type="text" autocomplete="off" spellcheck="false"
                     placeholder="you@example.com (this repo only)"
                     value="${escapeHtml(resolved.source === 'local' ? resolved.email : '')}">
            </div>
            <button class="primary gid-save">save</button>
            ${resolved.source === 'local' ? `<button class="gid-clear">inherit global</button>` : ''}
          </div>
          <div class="muted" style="font-size:11px;margin-top:6px">
            Setting a repo-local override changes <code>.git/config</code> in this project
            only. Clearing it falls back to whatever's in <code>~/.gitconfig</code> (manage in <a href="#config">Config → Git Identity</a>).
          </div>
        </div>
      </div>
    `;

    root.querySelector('.gid-save').addEventListener('click', async () => {
      const name  = root.querySelector('.gid-name').value.trim();
      const email = root.querySelector('.gid-email').value.trim();
      if (!name || !email) {
        toast('Name and email are required', '', 'err');
        return;
      }
      try {
        const r = await api(`/api/projects/${p.id}/git-identity`, {
          method:  'PUT',
          headers: { 'content-type': 'application/json' },
          body:    JSON.stringify({ name, email }),
        });
        if (!r.ok) throw new Error(r.error || 'save failed');
        toast('Repo-local git identity saved', email, 'ok');
        paintProjectGitIdentity(root, p);
      } catch (e) {
        toast('Save failed', e?.message || '', 'err');
      }
    });

    const clearBtn = root.querySelector('.gid-clear');
    if (clearBtn) {
      clearBtn.addEventListener('click', async () => {
        try {
          await api(`/api/projects/${p.id}/git-identity`, { method: 'DELETE' });
          toast('Repo-local override cleared', 'now inherits global', 'ok');
          paintProjectGitIdentity(root, p);
        } catch (e) {
          toast('Clear failed', e?.message || '', 'err');
        }
      });
    }
  }

  async function paintProjectAiConfig(root, p) {
    if (!root) return;
    let bundle, providers;
    try {
      [bundle, providers] = await Promise.all([
        api(`/api/projects/${p.id}/ai-config`),
        api('/api/ai/providers').catch(() => null),
      ]);
    } catch (e) {
      root.innerHTML = `<div style="color:var(--warn)">Failed to load AI config: ${escapeHtml(e.message)}</div>`;
      return;
    }
    const apiProviders = (providers?.providers || []).filter(x => x.type === 'api');
    const provOpts = apiProviders.map(p =>
      `<option value="${escapeHtml(p.id)}" ${bundle.chat?.provider === p.id ? 'selected' : ''}>${escapeHtml(p.displayName)}</option>`
    ).join('');

    const tmplChip = bundle.template
      ? `<span class="chip" style="background:var(--accent-soft);color:var(--accent)">${escapeHtml(bundle.template.templateName)}</span>
         <span style="color:var(--text-dim);font-size:11px;margin-left:6px">scaffolded ${escapeHtml(fmtAgoIso(bundle.template.scaffoldedAt))}${bundle.template.sourceUrl ? ` from <code>${escapeHtml(bundle.template.sourceUrl)}</code>` : ''}</span>`
      : '<span style="color:var(--text-dim)">No template recorded — project predates the registry or was created from a raw URL.</span>';

    const legacyBanner = bundle.legacyContext
      ? `<div class="callout" style="margin-bottom:10px">
           <strong>Legacy file detected.</strong> A <code>project-context.md</code> exists at the project root.
           Save below to migrate it under <code>.nostr-station/</code> (the legacy file stays — delete it manually when ready).
         </div>` : '';

    root.innerHTML = `
      ${legacyBanner}
      <div class="pcfg-row">
        <div class="pcfg-label">Template</div>
        <div class="pcfg-value">${tmplChip}</div>
      </div>

      <div class="pcfg-row">
        <div class="pcfg-label">Provider override</div>
        <div class="pcfg-value">
          <select class="pcfg-provider">
            <option value="">— Inherit station default —</option>
            ${provOpts}
          </select>
          <input class="pcfg-model" type="text" placeholder="model id (optional)" value="${escapeHtml(bundle.chat?.model || '')}" style="margin-left:8px;min-width:220px">
        </div>
      </div>

      <div class="pcfg-row">
        <div class="pcfg-label">Permissions</div>
        <div class="pcfg-value">
          <select class="pcfg-permissions">
            <option value="">— Inherit station default —</option>
            <option value="read-only" ${bundle.permissions?.mode === 'read-only' ? 'selected' : ''}>Read-only (writes need approval)</option>
            <option value="auto-edit" ${bundle.permissions?.mode === 'auto-edit' ? 'selected' : ''}>Auto-edit (file writes auto-approved)</option>
            <option value="yolo"      ${bundle.permissions?.mode === 'yolo'      ? 'selected' : ''}>YOLO (everything auto-approved)</option>
          </select>
        </div>
      </div>

      <label class="field-label" style="margin-top:14px">System prompt override</label>
      <textarea class="pcfg-system-prompt" rows="6" placeholder="Empty = inherit station default. Supports {{ variable }} interpolation.">${escapeHtml(bundle.systemPrompt || '')}</textarea>

      <label class="field-label" style="margin-top:14px">Project context overlay</label>
      <textarea class="pcfg-project-context" rows="6" placeholder="Markdown — spliced verbatim into the system prompt at chat time.">${escapeHtml(bundle.projectContext || '')}</textarea>

      <div class="step-actions" style="margin-top:14px">
        <button class="primary pcfg-save">Save AI config</button>
      </div>
    `;

    root.querySelector('.pcfg-save').addEventListener('click', async () => {
      const provider = root.querySelector('.pcfg-provider').value;
      const model    = root.querySelector('.pcfg-model').value.trim();
      const perm     = root.querySelector('.pcfg-permissions').value;
      const sys      = root.querySelector('.pcfg-system-prompt').value;
      const ctx      = root.querySelector('.pcfg-project-context').value;

      const body = {
        // null clears the override file; empty string is treated as
        // "still empty content," which read-helpers treat as null
        // anyway. Keep them distinct so the user can clear cleanly.
        systemPrompt:   sys.trim() === '' ? null : sys,
        projectContext: ctx.trim() === '' ? null : ctx,
        permissions:    perm ? { mode: perm } : null,
        chat:           (provider || model) ? { provider: provider || undefined, model: model || undefined } : null,
      };
      try {
        await api(`/api/projects/${p.id}/ai-config`, {
          method:  'PUT',
          headers: { 'content-type': 'application/json' },
          body:    JSON.stringify(body),
        });
        toast('AI config saved', '', 'ok');
        paintProjectAiConfig(root, p);
      } catch (e) {
        toast('Save failed', e.message, 'err');
      }
    });
  }

  async function patchAndReload(id, patch) {
    try {
      await api(`/api/projects/${id}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      });
      toast('Saved', '', 'ok');
      await reload();
    } catch {}
  }

  // ── Quick action runners ────────────────────────────────────────────
  async function runProjectPublish(p) {
    const ok = await confirmDestructive({
      title: `Publish · ${p.name}`,
      description: p.capabilities.git && p.capabilities.ngit
        ? 'Publishes to both GitHub and ngit remotes. Amber will sign ngit operations.'
        : p.capabilities.ngit
        ? 'Publishes to the ngit remote. Amber will sign.'
        : 'Pushes current branch to origin.',
      confirmLabel: 'Publish',
    });
    if (!ok) return;

    // Prefer the terminal panel — publish is an Ink flow with colour +
    // Amber prompts that the SSE modal can only render as NO_COLOR plain
    // text. Pick the key that matches the project's capabilities (mirrors
    // the server-side branch in /api/projects/:id/git/push). When node-pty
    // isn't available we fall back to the exec modal so the feature still
    // works end-to-end.
    if (window.NSTerminal?.isAvailable?.()) {
      const key = (p.capabilities.git && p.capabilities.ngit) ? 'publish'
                : p.capabilities.ngit ? 'ngit-push'
                : p.capabilities.git  ? 'git-push'
                : null;
      if (!key) { toast('Publish unavailable', 'No git/ngit capability', 'warn'); return; }
      window.NSTerminal.open(key, { projectId: p.id });
      // Refresh the detail view a couple of times so chips (HEAD, uncommitted
      // count) pick up the push result without the user clicking refresh.
      if (state.view === 'detail' && state.projectId === p.id) {
        [5_000, 30_000].forEach(ms => setTimeout(() => render(), ms));
      }
      return;
    }

    openExecModal({
      title: `publish · ${p.name}`,
      subtitle: p.path || '',
      endpoint: `/api/projects/${p.id}/git/push`,
    }).then(r => {
      if (r.ok) toast('Publish complete', p.name, 'ok');
      else      toast('Publish finished with errors', `exit ${r.code}`, 'err');
      if (state.view === 'detail' && state.projectId === p.id) render();
    });
  }
  function runProjectPull(p) {
    openExecModal({
      title: `git pull · ${p.name}`,
      subtitle: 'fast-forward only',
      endpoint: `/api/projects/${p.id}/git/pull`,
    }).then(r => {
      if (r.ok) toast('Pulled', p.name, 'ok');
      else      toast('Pull failed', `exit ${r.code}`, 'err');
      if (state.view === 'detail' && state.projectId === p.id) render();
    });
  }
  async function runStacksDeploy(p) {
    const ok = await confirmDestructive({
      title: `Deploy ${p.name} to NostrDeploy`,
      description: 'Runs `npm run deploy` in this project — bundles, uploads to Blossom servers, publishes Nostr metadata. Returns a live URL.',
      confirmLabel: 'Deploy',
    });
    if (!ok) return;
    openExecModal({
      title: `Stacks deploy · ${p.name}`,
      subtitle: p.path || '',
      endpoint: `/api/projects/${p.id}/stacks/deploy`,
    }).then(r => {
      if (r.ok) toast('Deploy complete', 'Look for the live URL in the log above', 'ok');
      else      toast('Deploy failed', `exit ${r.code}`, 'err');
    });
  }

  async function runProjectDeploy(p) {
    const ok = await confirmDestructive({
      title: `Deploy · ${p.name}`,
      description: 'Runs `nostr-station nsite deploy --yes` in this project.',
      confirmLabel: 'Deploy',
    });
    if (!ok) return;
    // Terminal gets the coloured progress + any blossom server prompts
    // that the SSE modal flattens. Fallback to SSE when node-pty is
    // unavailable keeps the feature working end-to-end.
    if (window.NSTerminal?.isAvailable?.()) {
      window.NSTerminal.open('nsite-deploy', { projectId: p.id });
      return;
    }
    openExecModal({
      title: `deploy · ${p.name}`,
      subtitle: p.path || '',
      endpoint: `/api/projects/${p.id}/nsite/deploy`,
    }).then(r => {
      if (r.ok) toast('Deploy complete', p.name, 'ok');
      else      toast('Deploy failed', `exit ${r.code}`, 'err');
    });
  }

  function openInChat(p) {
    // Find or create the project's chat session, then route to it. The hash
    // router (ChatPanel.applyRoute) resolves the session → setActiveProject,
    // which handles preview-pane + permissions + the server context POST.
    const s = SessionStore.ensureProjectSession(p.id, p.name);
    const target = `#chat/s/${s.id}`;
    if (location.hash === target) {
      // Same project, same session — just activate the panel (covers
      // re-clicking the chat icon on a card from the chat panel itself).
      activatePanel('chat');
    } else {
      location.hash = target;
    }
  }

  // ── Discover ngit repos published under the station owner's npub ─────
  //
  // Opens a modal that hits GET /api/ngit/discover (server queries
  // kind-30617 events from the read-relays) and lets the user seed an
  // Add Project draft from any returned repo.
  function openDiscoverModal() {
    const body = document.createElement('div');
    body.className = 'discover-modal';
    body.innerHTML = `
      <div class="discover-status">
        <div class="spinner" style="margin:auto"></div>
        <div class="discover-msg" style="text-align:center;margin-top:12px">Querying relays for your ngit repositories…</div>
        <div class="discover-queried muted" style="text-align:center;margin-top:6px;font-size:11px"></div>
      </div>
      <div class="discover-results" style="display:none"></div>
    `;
    const modal = openModal({
      title: 'Discover ngit repositories',
      subtitle: 'kind 30617 · published under your npub',
      body,
    });
    modal.root.classList.add('discover-modal-root');

    const queriedEl = body.querySelector('.discover-queried');
    const statusEl  = body.querySelector('.discover-status');
    const resultsEl = body.querySelector('.discover-results');

    api('/api/ngit/discover').then((res) => {
      const queried = (res.queried || []).join(', ');
      if (res.empty || !res.repos || res.repos.length === 0) {
        statusEl.style.display = 'none';
        resultsEl.style.display = '';
        // Diagnostics block — empty result used to give zero hint as to
        // which relay rejected the query, whether nak ran at all, or
        // whether events came back but got filtered. Show the captured
        // nak stderr and event counts so the next scan is debuggable.
        const diag = res.diagnostics || {};
        const diagBits = [];
        if (diag.spawnError) {
          diagBits.push(`<div class="diag-row err">nak failed to start: <code>${escapeHtml(diag.spawnError)}</code></div>`);
        }
        if (typeof diag.eventsSeen === 'number') {
          diagBits.push(`<div class="diag-row">Events seen: ${diag.eventsSeen} · Unique repos: ${diag.uniqueRepos ?? 0}${diag.parseFailures ? ` · Parse failures: ${diag.parseFailures}` : ''}</div>`);
        }
        if (diag.exitCode !== undefined && diag.exitCode !== null) {
          diagBits.push(`<div class="diag-row">nak exit: ${diag.exitCode}</div>`);
        }
        if (diag.stderrTail) {
          diagBits.push(`<details class="diag-stderr"><summary>nak stderr (tail)</summary><pre>${escapeHtml(diag.stderrTail)}</pre></details>`);
        }
        const diagHtml = diagBits.length
          ? `<details class="discover-diag" open><summary>Diagnostics</summary>${diagBits.join('')}</details>`
          : '';
        resultsEl.innerHTML = `
          <div class="discover-empty">
            <div class="big">No ngit repositories found under your npub.</div>
            <div class="muted" style="margin-top:8px;font-size:11px">Queried: ${escapeHtml(queried || '(no relays)')}</div>
            <a href="#config" class="config-link" style="display:inline-block;margin-top:10px">Check your GRASP servers in Config →</a>
            ${diagHtml}
          </div>
        `;
        resultsEl.querySelector('.config-link').addEventListener('click', () => modal.close());
        return;
      }
      statusEl.style.display = 'none';
      resultsEl.style.display = '';
      resultsEl.innerHTML = res.repos.map((r, i) => discoverRepoCardHtml(r, i)).join('');
      resultsEl.querySelectorAll('.discover-card').forEach((card) => {
        const idx = Number(card.dataset.idx);
        const repo = res.repos[idx];
        card.querySelectorAll('[data-copy]').forEach(slot => slot.appendChild(copyBtn(slot.dataset.copy)));
        card.querySelector('.add-to-projects').addEventListener('click', () => {
          modal.close();
          // Prefer the server-computed `cloneUrl` (nostr://<npub>/<d-tag>)
          // — that is the form `git-remote-nostr` actually accepts per
          // `ngit --help`. A bare naddr is NOT a valid `git clone`
          // argument; naddr is kept on the repo for reference only.
          const nostrUrl = repo.cloneUrl
            || repo.clone.find(u => u.startsWith('nostr://'))
            || '';
          const gitUrl   = repo.clone.find(u => /^(git|https?|ssh):\/\//i.test(u)) || '';
          ProjectDrawer.openAddPrefilled({
            name: repo.name,
            capabilities: { git: !!gitUrl, ngit: true },
            remotes: { github: gitUrl, ngit: nostrUrl },
          });
        });
        // Phase 6: Browse button — clones into ~/.nostr-station/scratch/
        // for one-tap exploration without committing the repo to the
        // main project list. After clone succeeds the client calls
        // /api/projects/detect to register the scratch path; the Code
        // tab detects the path prefix and renders a "temporary clone"
        // banner with a path to make it permanent.
        const browseBtn = card.querySelector('.browse-scratch');
        if (browseBtn) browseBtn.addEventListener('click', async () => {
          modal.close();
          const nostrUrl = repo.cloneUrl
            || (repo.naddr ? repo.naddr : (repo.clone || []).find(u => u.startsWith('nostr://')))
            || '';
          if (!nostrUrl) {
            toast('Cannot browse', 'no nostr:// URL or naddr available for this repo', 'err');
            return;
          }
          const r = await openExecModal({
            title:    `Browse · ${repo.name}`,
            subtitle: `git clone ${nostrUrl.slice(0, 32)}…  →  ~/.nostr-station/scratch/`,
            endpoint: `/api/ngit/explore`,
            body:     { url: nostrUrl },
          });
          const resolvedPath = r.info?.resolvedPath;
          if (!r.ok || !resolvedPath) {
            if (!r.ok) toast('Browse failed', `exit ${r.code}`, 'err');
            return;
          }
          // Register the scratch path as a Project so the Code tab
          // can open against it. If a project already lives at this
          // path (re-explore), just navigate to it.
          try {
            const existing = projects.find(x => x.path === resolvedPath);
            if (!existing) {
              const identity = { useDefault: true, npub: '', bunkerUrl: '' };
              await registerAfterNgitClone(resolvedPath, repo.name, nostrUrl, identity);
            }
            await reload();
            const fresh = projects.find(x => x.path === resolvedPath);
            if (fresh) {
              state.view = 'detail';
              state.projectId = fresh.id;
              state.tab = 'code';
              render();
            }
          } catch (e) {
            toast('Could not register scratch checkout', e?.message || '', 'err');
          }
        });
      });
      queriedEl.textContent = `Queried: ${queried}`;
    }).catch((e) => {
      statusEl.style.display = 'none';
      resultsEl.style.display = '';
      resultsEl.innerHTML = `
        <div class="discover-empty err">
          <div class="big">Could not reach relays.</div>
          <div class="muted" style="margin-top:8px;font-size:11px">${escapeHtml(e.message || '')}</div>
          <a href="#config" class="config-link" style="display:inline-block;margin-top:10px">Check your read relay configuration in Config →</a>
        </div>
      `;
      resultsEl.querySelector('.config-link').addEventListener('click', () => modal.close());
    });
  }

  function discoverRepoCardHtml(r, idx) {
    const desc = (r.description || '').length > 120
      ? (r.description.slice(0, 117) + '…')
      : (r.description || '');
    const cloneRows = (r.clone || []).map(url => `
      <div class="clone-row">
        <code>${escapeHtml(url)}</code>
        <span class="copy-slot" data-copy="${escapeHtml(url)}"></span>
      </div>
    `).join('');
    return `
      <div class="discover-card" data-idx="${idx}">
        <div class="discover-card-head">
          <div class="discover-name">${escapeHtml(r.name)}</div>
          <div class="discover-card-actions">
            <button class="browse-scratch" title="Clone into a scratch directory and browse without committing to your project list">Browse</button>
            <button class="primary add-to-projects" title="Open the Add Project drawer pre-filled with this repo's metadata">Add to Projects</button>
          </div>
        </div>
        ${desc ? `<div class="discover-desc muted">${escapeHtml(desc)}</div>` : ''}
        ${cloneRows ? `<div class="discover-clones">${cloneRows}</div>` : ''}
        <div class="discover-meta muted">
          Published ${escapeHtml(fmtAgoMs((r.published_at || 0) * 1000))}
          ${r.web ? ` · <a href="${escapeHtml(r.web)}" target="_blank" rel="noreferrer">web ↗</a>` : ''}
        </div>
      </div>
    `;
  }

  // ── Add Project flow ───────────────────────────────────────────────────
  //
  // Three source paths, picked via the chooser:
  //   - New local project   — fresh ~/projects/<slug>, git init, minimal
  //                           README + .gitignore, initial commit. No
  //                           template, no AI; bring your own stack.
  //   - Existing local      — adopt a directory that's already on disk
  //                           (ProjectDrawer.openAdd, unchanged).
  //   - Import repository   — clone any git URL (github/gitlab/ngit).
  //                           nostr URLs route to /api/ngit/clone; other
  //                           git URLs route to /api/projects/new with a
  //                           git-url source.

  function slugifyClient(raw) {
    return String(raw || '')
      .trim()
      .toLowerCase()
      .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);
  }

  // Shared "Advanced → signer identity" block for the New Project and
  // Import Repository modals. Collapsed by default — most users stick
  // with station identity; expanding surfaces the project-specific
  // npub + bunker fields, matching what the full ProjectDrawer already
  // offers. Mutates `ident` in place as the user edits; the modal reads
  // the final state on submit.
  //
  // `uid` scopes the radio group so two modals can coexist (no
  // cross-contamination of selected state if both were ever open).
  function renderIdentitySection(ident, ownerNpub, uid) {
    const ownerDisplay = ownerNpub ? truncNpub(ownerNpub) : '(station identity not configured)';
    const groupName = `np-ident-${uid}`;
    return `
      <details class="np-advanced">
        <summary>Advanced — signer identity</summary>
        <div class="np-advanced-body">
          <label class="radio-row">
            <input type="radio" name="${groupName}" value="default" ${ident.useDefault ? 'checked' : ''}>
            <div>
              <div class="radio-title">Use station identity</div>
              <div class="radio-sub">${escapeHtml(ownerDisplay)} · signs publish / push operations for this project.</div>
            </div>
          </label>
          <label class="radio-row">
            <input type="radio" name="${groupName}" value="project" ${ident.useDefault ? '' : 'checked'}>
            <div>
              <div class="radio-title">Project-specific identity</div>
              <div class="radio-sub">Publish this project as a different npub. Useful for brands, shops, or client work.</div>
            </div>
          </label>
          <div class="np-ident-fields" style="${ident.useDefault ? 'display:none' : ''}">
            <label class="field-label">npub</label>
            <input type="text" class="np-ident-npub" placeholder="npub1… or 64-char hex" value="${escapeHtml(ident.npub || '')}">
            <div class="np-ident-err err"></div>
            <label class="field-label">Bunker URL <span class="muted">(optional)</span></label>
            <input type="text" class="np-ident-bunker" placeholder="bunker://…" value="${escapeHtml(ident.bunkerUrl || '')}">
            <div class="muted">Amber prompts on first signing if left empty.</div>
          </div>
        </div>
      </details>
    `;
  }

  // Wire up the identity section's radios + inputs. Mutates `ident`.
  function wireIdentitySection(container, ident) {
    const fieldsEl = container.querySelector('.np-ident-fields');
    if (!fieldsEl) return;
    container.querySelectorAll('input[type="radio"]').forEach(r => {
      if (!r.name.startsWith('np-ident-')) return;
      r.addEventListener('change', () => {
        ident.useDefault = (r.value === 'default');
        fieldsEl.style.display = ident.useDefault ? 'none' : '';
      });
    });
    const npubInput = container.querySelector('.np-ident-npub');
    const npubErr = container.querySelector('.np-ident-err');
    if (npubInput) {
      npubInput.addEventListener('input', () => {
        const v = npubInput.value.trim();
        ident.npub = v;
        npubErr.textContent = v.startsWith('nsec')
          ? 'nsec detected — nostr-station never stores private keys'
          : '';
      });
    }
    const bunkerInput = container.querySelector('.np-ident-bunker');
    if (bunkerInput) {
      bunkerInput.addEventListener('input', (e) => { ident.bunkerUrl = e.target.value.trim(); });
    }
  }

  // Pre-submit validation for the identity draft. Matches what the
  // server's validateInput enforces, so we can surface errors without
  // round-tripping. nsec rejection is the safety-critical one.
  function validateIdentityDraft(ident) {
    if (ident.useDefault) return { ok: true };
    if (!ident.npub) return { ok: false, error: 'project-specific identity requires an npub' };
    if (ident.npub.startsWith('nsec')) return { ok: false, error: 'nsec detected — nostr-station never stores private keys' };
    return { ok: true };
  }

  // Shape the identity draft for POST payloads. Empty strings collapse
  // to nulls so validateInput on the server sees "unset" cleanly.
  function identityPayload(ident) {
    if (ident.useDefault) return { useDefault: true, npub: null, bunkerUrl: null };
    return {
      useDefault: false,
      npub:      ident.npub || null,
      bunkerUrl: ident.bunkerUrl || null,
    };
  }

  // Small helper: render a full-width choice card for the chooser. Each
  // card is a self-contained button with a title + description; avoids
  // building a dropdown component for a three-option picker.
  function chooserCard(title, desc) {
    return `
      <button class="add-source-card" type="button">
        <div class="add-source-title">${escapeHtml(title)}</div>
        <div class="add-source-desc">${escapeHtml(desc)}</div>
      </button>
    `;
  }

  // Chooser modal — first click of "+ Add project" lands here. Picks one
  // of three paths, then dismisses itself and opens the specific modal.
  // Matches shakespeare.diy's "+ New Project ▾" dropdown in spirit but
  // uses a light modal so each option gets real title + description
  // space (dropdowns truncate; we want users to understand the choice).
  function openAddProjectChooserModal() {
    const body = document.createElement('div');
    body.className = 'add-source-chooser';
    body.innerHTML = `
      ${chooserCard(
        'New local project',
        'Fresh directory with git init, initial commit. BYO stack and AI agent.'
      )}
      ${chooserCard(
        'Existing local project',
        'Adopt a directory that already exists on disk. Nothing on disk is modified.'
      )}
      ${chooserCard(
        'Import repository',
        'Clone from any git URL — GitHub, GitLab, ngit (nostr://… or naddr1…).'
      )}
    `;

    const modal = openModal({
      title: 'Add a project',
      subtitle: 'Pick how you want to get started',
      body,
    });

    const cards = body.querySelectorAll('.add-source-card');
    cards[0].addEventListener('click', () => { modal.close(); openNewProjectModal(); });
    cards[1].addEventListener('click', () => { modal.close(); ProjectDrawer.openAdd(); });
    cards[2].addEventListener('click', () => { modal.close(); openImportRepositoryModal(); });
  }

  // New local project — name-only scaffold. POSTs source:{type:'local-only'}.
  // Keeps the collision handoff: if ~/projects/<slug> exists, offer to
  // adopt via ProjectDrawer.openAddPrefilled instead of failing.
  async function openNewProjectModal() {
    const identity = { useDefault: true, npub: '', bunkerUrl: '' };
    let ownerNpub = null;
    try { const cfg = await api('/api/identity/config'); ownerNpub = cfg.npub || null; } catch {}

    const body = document.createElement('div');
    body.className = 'new-project-form';
    body.innerHTML = `
      <label class="np-field">
        <span class="np-label">Project name</span>
        <input id="np-name" type="text" autocomplete="off" placeholder="My cool app" />
        <div class="np-preview">
          Path: <code id="np-path-preview">${escapeHtml(`${(window.__homeDir || '~')}/projects/…`)}</code>
        </div>
      </label>
      <div class="np-hint">
        Creates a folder with a minimal README. No git init — opt into version
        control when you're ready. Use any AI agent (Claude Code, Dork, aider)
        or editor from there. Sync to ngit or another git host via the project
        card's Publish action when you want to push.
      </div>
      ${renderIdentitySection(identity, ownerNpub, 'new')}
    `;

    const foot = document.createElement('div');
    foot.style.display = 'flex';
    foot.style.gap = '8px';
    foot.style.justifyContent = 'flex-end';
    foot.style.width = '100%';
    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    const createBtn = document.createElement('button');
    createBtn.className = 'primary';
    createBtn.textContent = 'Create';
    createBtn.disabled = true;
    foot.appendChild(cancelBtn);
    foot.appendChild(createBtn);

    const modal = openModal({
      title: 'New local project',
      subtitle: 'Create a fresh project in ~/projects',
      body,
      footer: foot,
    });

    const nameInput = body.querySelector('#np-name');
    const preview   = body.querySelector('#np-path-preview');
    const updatePreview = () => {
      const slug = slugifyClient(nameInput.value);
      preview.textContent = slug
        ? `~/projects/${slug}`
        : '~/projects/…';
      createBtn.disabled = !slug;
    };
    nameInput.addEventListener('input', updatePreview);
    nameInput.focus();
    cancelBtn.addEventListener('click', () => modal.close());

    wireIdentitySection(body, identity);

    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !createBtn.disabled) { e.preventDefault(); createBtn.click(); }
    });

    createBtn.addEventListener('click', async () => {
      const name = nameInput.value.trim();
      if (!name) return;
      const identityCheck = validateIdentityDraft(identity);
      if (!identityCheck.ok) {
        toast('Identity invalid', identityCheck.error, 'err');
        return;
      }
      createBtn.disabled = true;

      let coll;
      try {
        coll = await api('/api/projects/new/check', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name }),
        });
      } catch (e) {
        toast('Check failed', e.message, 'err');
        createBtn.disabled = false;
        return;
      }

      if (coll.exists) {
        body.innerHTML = `
          <p style="margin:0 0 12px 0; color: var(--text);">
            A directory already exists at <code>${escapeHtml(coll.path)}</code>.
          </p>
          <p style="margin:0; color: var(--text-dim); font-size: 12px;">
            Would you like to adopt the existing directory as a project instead?
            Adopting won't modify any files inside it.
          </p>
        `;
        foot.innerHTML = '';
        const back = document.createElement('button');
        back.textContent = 'Change name';
        back.addEventListener('click', () => { modal.close(); openNewProjectModal(); });
        const adopt = document.createElement('button');
        adopt.className = 'primary';
        adopt.textContent = 'Adopt existing';
        adopt.addEventListener('click', () => {
          modal.close();
          ProjectDrawer.openAddPrefilled({
            name,
            capabilities: { git: true, ngit: false, nsite: false },
            remotes: {},
            path: coll.path,
          });
        });
        foot.appendChild(back);
        foot.appendChild(adopt);
        return;
      }

      modal.close();
      const result = await openExecModal({
        title: `Creating ${coll.slug}`,
        subtitle: `Local project at ${coll.path}`,
        endpoint: '/api/projects/new',
        body: {
          name,
          source: { type: 'local-only' },
          identity: identityPayload(identity),
        },
      });

      if (result.ok && result.info?.project) {
        toast('Project created', result.info.project.name, 'ok');
        await reload();
        try { openDetail(result.info.project.id); } catch {}
      } else if (!result.ok) {
        toast('Create failed', `exit ${result.code}`, 'err');
      }
    });
  }

  // Import repository — one modal for both ngit and standard git URLs.
  // URL sniffing decides the downstream endpoint:
  //   nostr://… | naddr1…   → /api/ngit/clone + detect + register
  //   https/git/ssh git URL → /api/projects/new with source:'git-url'
  //
  // The "Template" dropdown reads /api/templates and quick-fills the URL
  // for whatever entry the user picks. MKStack is the seeded default.
  // Users can add their own templates in Config → Project Templates;
  // they show up here automatically.
  //
  // "Scan my ngit repos" closes this modal and opens the Discover flow
  // — slightly faster than pasting an naddr for users who just want to
  // pick from their own published repos.

  function isNostrCloneUrl(s) {
    const v = String(s || '').trim();
    return v.startsWith('nostr://') || v.startsWith('naddr1');
  }

  function isStandardGitUrl(s) {
    const v = String(s || '').trim();
    if (!v) return false;
    return /^https?:\/\//i.test(v)
      || /^git@[\w.-]+:[\w./-]+$/i.test(v)
      || /^ssh:\/\//i.test(v)
      || /^git:\/\//i.test(v);
  }

  // After an ngit clone succeeds we still need to detect caps and
  // register the project in projects.json — /api/ngit/clone only clones.
  // One-shot orchestration keeps the UX tight: user pastes naddr, clicks
  // Import, and lands on the ready project card.
  //
  // Capability note: "git" means "has a traditional git remote
  // (github/gitlab/self-hosted)", not "is a git repo on disk." An ngit
  // clone always creates .git locally (git-remote-nostr's doing), but we
  // only set capabilities.git when the repo's ngit announcement event
  // also lists a github-style mirror URL. Otherwise it's ngit-only →
  // only the "ngit" chip shows on the card.
  async function registerAfterNgitClone(resolvedPath, name, ngitUrl, identity) {
    let caps = { git: false, ngit: true, nsite: false };
    let githubRemote = null;
    let ngitRemote = ngitUrl;
    try {
      const d = await api('/api/projects/detect', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: resolvedPath }),
      });
      if (d && d.exists && d.isGitRepo) {
        caps = {
          git:   !!d.githubRemote,
          ngit:  true,
          nsite: !!d.hasNsyte,
        };
        if (d.githubRemote) githubRemote = d.githubRemote;
        if (d.ngitRemote)   ngitRemote   = d.ngitRemote;
      }
    } catch { /* detect failed — fall back to defaults computed above */ }

    const body = {
      name,
      path: resolvedPath,
      capabilities: caps,
      identity: identityPayload(identity),
      remotes:  { github: githubRemote, ngit: ngitRemote },
      nsite:    { url: null, lastDeploy: null },
    };
    return await api('/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async function openImportRepositoryModal() {
    const identity = { useDefault: true, npub: '', bunkerUrl: '' };
    let ownerNpub = null;
    try { const cfg = await api('/api/identity/config'); ownerNpub = cfg.npub || null; } catch {}

    // Load the templates registry up front so the picker is rendered
    // with the live list. Failures here are non-fatal — the modal still
    // works for raw-URL imports; the user just doesn't see the picker.
    let templates = [];
    try {
      const r = await api('/api/templates');
      if (r && Array.isArray(r.templates)) templates = r.templates;
    } catch { /* leave empty — picker is omitted */ }
    const gitTemplates = templates.filter(t => t.source?.type === 'git-url');
    const templateOpts = gitTemplates.map(t =>
      `<option value="${escapeHtml(t.id)}" data-url="${escapeHtml(t.source.url)}">${escapeHtml(t.name)}</option>`
    ).join('');

    const body = document.createElement('div');
    body.className = 'import-repo-form';
    body.innerHTML = `
      <label class="np-field">
        <span class="np-label">Project name</span>
        <input id="ir-name" type="text" autocomplete="off" placeholder="my-app" />
        <div class="np-preview">
          Path: <code id="ir-path-preview">${escapeHtml(`${(window.__homeDir || '~')}/projects/…`)}</code>
        </div>
      </label>
      ${gitTemplates.length ? `
      <label class="np-field">
        <span class="np-label">Template <span style="color:var(--text-dim);font-weight:400">(optional)</span></span>
        <select id="ir-template">
          <option value="">— Pick a template to quick-fill the URL —</option>
          ${templateOpts}
        </select>
        <div class="np-hint" id="ir-template-hint" style="margin-top:6px"></div>
      </label>
      ` : ''}
      <label class="np-field">
        <span class="np-label">Repository URL</span>
        <input id="ir-url" type="text" autocomplete="off"
               placeholder="https://github.com/you/repo.git  ·  nostr://…  ·  naddr1…" />
        <div class="ir-url-actions">
          <button type="button" class="ir-quick-scan">Scan my ngit repos…</button>
        </div>
      </label>
      <div class="np-hint">
        Any git URL works — GitHub, GitLab, self-hosted, or a Nostr-native ngit address.
        After import, history is reset so the initial commit is yours (stops you
        accidentally pushing back to the source).
      </div>
      ${renderIdentitySection(identity, ownerNpub, 'import')}
    `;

    const foot = document.createElement('div');
    foot.style.display = 'flex';
    foot.style.gap = '8px';
    foot.style.justifyContent = 'flex-end';
    foot.style.width = '100%';
    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    const createBtn = document.createElement('button');
    createBtn.className = 'primary';
    createBtn.textContent = 'Import';
    createBtn.disabled = true;
    foot.appendChild(cancelBtn);
    foot.appendChild(createBtn);

    const modal = openModal({
      title: 'Import repository',
      subtitle: 'Clone from a git URL or ngit address',
      body,
      footer: foot,
    });

    const nameInput = body.querySelector('#ir-name');
    const urlInput  = body.querySelector('#ir-url');
    const preview   = body.querySelector('#ir-path-preview');
    const tmplSel   = body.querySelector('#ir-template');
    const tmplHint  = body.querySelector('#ir-template-hint');
    const scanBtn   = body.querySelector('.ir-quick-scan');

    // Tracks which templateId the user picked (if any). When a template
    // is selected we forward `templateId` to /api/projects/new so the
    // server resolves the source server-side AND records the template
    // on the project. If the user types a URL by hand instead, this
    // stays null and we send `source: { type: 'git-url', url }`.
    let pickedTemplateId = null;

    const updateState = () => {
      const slug = slugifyClient(nameInput.value);
      preview.textContent = slug ? `~/projects/${slug}` : '~/projects/…';
      const url = urlInput.value.trim();
      const urlOk = isNostrCloneUrl(url) || isStandardGitUrl(url);
      createBtn.disabled = !slug || !urlOk;
    };
    nameInput.addEventListener('input', updateState);
    urlInput.addEventListener('input', () => {
      // Clearing the picker when the user edits the URL by hand keeps
      // the form honest — we don't want to send a stale templateId for
      // a URL the user replaced.
      if (tmplSel && tmplSel.value && urlInput.value !== templates.find(t => t.id === tmplSel.value)?.source?.url) {
        tmplSel.value = '';
        pickedTemplateId = null;
        if (tmplHint) tmplHint.textContent = '';
      }
      updateState();
    });
    nameInput.focus();

    cancelBtn.addEventListener('click', () => modal.close());

    if (tmplSel) {
      tmplSel.addEventListener('change', () => {
        const id = tmplSel.value;
        if (!id) {
          pickedTemplateId = null;
          if (tmplHint) tmplHint.textContent = '';
          return;
        }
        const t = templates.find(x => x.id === id);
        if (!t) return;
        pickedTemplateId = id;
        urlInput.value = t.source?.url || '';
        if (!nameInput.value.trim()) nameInput.value = `${t.id}-app`;
        if (tmplHint) tmplHint.textContent = t.description;
        updateState();
        nameInput.focus();
      });
    }

    scanBtn.addEventListener('click', () => {
      modal.close();
      openDiscoverModal();
    });

    [nameInput, urlInput].forEach(el => el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !createBtn.disabled) { e.preventDefault(); createBtn.click(); }
    }));

    wireIdentitySection(body, identity);

    createBtn.addEventListener('click', async () => {
      const name = nameInput.value.trim();
      const url  = urlInput.value.trim();
      if (!name || !url) return;
      const identityCheck = validateIdentityDraft(identity);
      if (!identityCheck.ok) {
        toast('Identity invalid', identityCheck.error, 'err');
        return;
      }
      createBtn.disabled = true;

      // Collision pre-flight against the final slug. ngit clone uses
      // repoName=slug, scaffold endpoint uses name→slug on the server —
      // same target path in both cases.
      let coll;
      try {
        coll = await api('/api/projects/new/check', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name }),
        });
      } catch (e) {
        toast('Check failed', e.message, 'err');
        createBtn.disabled = false;
        return;
      }
      if (coll.exists) {
        toast('Path exists', `${coll.path} already exists — pick a different name`, 'err');
        createBtn.disabled = false;
        return;
      }

      modal.close();

      if (isNostrCloneUrl(url)) {
        // ngit path — use existing /api/ngit/clone endpoint + post-clone
        // detect + register. repoName is the slug; server owns the
        // absolute path construction.
        const result = await openExecModal({
          title: `Importing ${coll.slug}`,
          subtitle: `git clone ${url} → ${coll.path}`,
          endpoint: '/api/ngit/clone',
          body: { url, repoName: coll.slug },
        });
        if (!result.ok) {
          toast('Import failed', `exit ${result.code}`, 'err');
          return;
        }
        const resolved = result.info?.resolvedPath || coll.path;
        try {
          const project = await registerAfterNgitClone(resolved, name, url, identity);
          toast('Project imported', project.name, 'ok');
          await reload();
          try { openDetail(project.id); } catch {}
        } catch (e) {
          toast('Registration failed', e.message, 'err');
        }
      } else {
        // Standard git URL — goes through the scaffold endpoint which
        // clones, wipes inherited history, and registers in one shot.
        // When the user picked a template, send templateId so the
        // server resolves the source from the registry AND records the
        // template on the project; otherwise send source.url verbatim.
        const reqBody = pickedTemplateId
          ? { name, templateId: pickedTemplateId, identity: identityPayload(identity) }
          : { name, source: { type: 'git-url', url }, identity: identityPayload(identity) };
        const result = await openExecModal({
          title: `Importing ${coll.slug}`,
          subtitle: `git clone ${url} → ${coll.path}`,
          endpoint: '/api/projects/new',
          body: reqBody,
        });
        if (result.ok && result.info?.project) {
          toast('Project imported', result.info.project.name, 'ok');
          await reload();
          try { openDetail(result.info.project.id); } catch {}
        } else if (!result.ok) {
          toast('Import failed', `exit ${result.code}`, 'err');
        }
      }
    });
  }

  return { onEnter, reload, openDetail };
})();

// ── Panel: Logs (with VPN tab + error badge + scroll toggle) ─────────────

let logsBadgeCount = 0;
function bumpLogsBadge() {
  if (currentPanel() === 'logs') return;
  logsBadgeCount++;
  const badge = $('logs-badge');
  badge.textContent = logsBadgeCount > 99 ? '99+' : String(logsBadgeCount);
  badge.style.display = '';
}
function clearLogsBadge() {
  logsBadgeCount = 0;
  $('logs-badge').style.display = 'none';
}

const LogsPanel = (() => {
  const view   = $('log-view');
  const banner = $('logs-status');
  const meta   = $('logs-meta');
  let currentSvc = 'relay';
  let es = null;
  let paused = false;

  // Relay-error detection (vpn channel only). When nvpn's
  // nostr_relay_pool spams "Impossible to connect" 504s, the log tail
  // drowns in identical errors and the user has no obvious next step.
  // Once we've seen ≥3 within a 5-minute rolling window we surface a
  // one-line hint above the log with a "Use recommended relays"
  // shortcut — same action as Config's button but reachable without
  // leaving the Logs tab.
  const RELAY_ERR_RE         = /Impossible to connect to 'wss:/;
  const RELAY_ERR_THRESHOLD  = 3;
  const RELAY_ERR_WINDOW_MS  = 5 * 60_000;
  let relayErrTimestamps = [];
  let relayHintEl = null;

  const ANSI_RE = /\x1b\[[0-9;]*m/g;
  function classify(line) {
    if (/error|ERR|fail|panic/i.test(line)) return 'err';
    if (/WARN|warn/.test(line)) return 'warn';
    if (/OK|started|listening|ready/i.test(line)) return 'ok';
    return '';
  }
  // Strip a leading ISO timestamp so successive emissions of an
  // otherwise-identical message collapse together — nvpn re-emits the
  // same "tunnel: failed to flush ..." trio every ~1s on a VM lacking
  // the route-flush capability, and three new rows per second drowns
  // out everything else in the panel.
  const TS_PREFIX_RE = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s+/;
  function makeDedupeKey(line) {
    return line.replace(TS_PREFIX_RE, '');
  }
  // Look back this far when matching duplicates. Captures nvpn's typical
  // 3-line repeating cycle (tunnel: ... / stdout: / stderr: ...) without
  // pulling in unrelated context. Lines that aren't part of the recent
  // window get a fresh row, keeping the dedupe local and predictable.
  const DEDUPE_LOOKBACK = 8;

  function noteRelayError() {
    const now = Date.now();
    relayErrTimestamps.push(now);
    while (relayErrTimestamps.length > 0
           && now - relayErrTimestamps[0] > RELAY_ERR_WINDOW_MS) {
      relayErrTimestamps.shift();
    }
    if (relayErrTimestamps.length >= RELAY_ERR_THRESHOLD) showRelayHint();
  }

  function hideRelayHint() {
    if (relayHintEl) relayHintEl.hidden = true;
  }

  function showRelayHint() {
    if (!relayHintEl) {
      relayHintEl = document.createElement('div');
      relayHintEl.className = 'logs-relay-hint';
      relayHintEl.id = 'logs-relay-hint';
      relayHintEl.innerHTML = `
        <span class="logs-relay-hint-icon">⚠</span>
        <span class="logs-relay-hint-text">
          Repeated relay <code>504</code> errors — your nostr-vpn discovery
          relays may be down.
        </span>
        <button class="primary" id="logs-relay-hint-fix">Use recommended</button>
        <button id="logs-relay-hint-dismiss">Dismiss</button>`;
      // Insert above the log scroll view so it floats with the meta strip
      // rather than scrolling away with old entries.
      view.parentNode.insertBefore(relayHintEl, view);
      relayHintEl.querySelector('#logs-relay-hint-fix').addEventListener('click', async () => {
        const btn = relayHintEl.querySelector('#logs-relay-hint-fix');
        btn.disabled = true;
        try {
          const r = await api('/api/nvpn/relays/recommended');
          const list = Array.isArray(r?.relays) ? r.relays : [];
          if (list.length === 0) throw new Error('no recommended set defined');
          const setRes = await api('/api/nvpn/relays/set', {
            method:  'POST',
            headers: { 'content-type': 'application/json' },
            body:    JSON.stringify({ relays: list }),
          });
          if (!setRes.ok) throw new Error(setRes.detail || 'set failed');
          toast('Relays updated', `${list.length} recommended relay${list.length === 1 ? '' : 's'}`, 'ok');
          relayErrTimestamps = [];
          hideRelayHint();
        } catch (e) {
          toast('Update failed', e.message, 'err');
          btn.disabled = false;
        }
      });
      relayHintEl.querySelector('#logs-relay-hint-dismiss').addEventListener('click', () => {
        hideRelayHint();
      });
    }
    relayHintEl.hidden = false;
  }
  function append(lines) {
    if (paused) return;
    const autoScroll = $('logs-autoscroll').checked;
    for (const rawLine of lines) {
      const line = (rawLine || '').replace(ANSI_RE, '');
      if (!line) continue;
      const cls = classify(line);
      // Bump the badge for every error occurrence even if the line
      // collapses visually — the count semantics ("how many errors
      // since I last looked") shouldn't lie just because we deduped.
      if (cls === 'err') bumpLogsBadge();
      // vpn-only relay-error tracker. Threshold + window keep the hint
      // off for a single transient blip but trigger it for the kind of
      // sustained 504 storm that motivated this UX.
      if (currentSvc === 'vpn' && RELAY_ERR_RE.test(line)) noteRelayError();
      const key = makeDedupeKey(line);
      let dup = null;
      const children = view.children;
      const start = Math.max(0, children.length - DEDUPE_LOOKBACK);
      for (let i = children.length - 1; i >= start; i--) {
        if (children[i].dataset.dedupeKey === key) { dup = children[i]; break; }
      }
      if (dup) {
        const n = (parseInt(dup.dataset.dedupeCount, 10) || 1) + 1;
        dup.dataset.dedupeCount = String(n);
        dup.textContent = `${dup.dataset.dedupeFirstLine} (×${n})`;
        continue;
      }
      const el = document.createElement('div');
      el.className = 'log-line ' + cls;
      el.textContent = line;
      el.dataset.dedupeKey = key;
      el.dataset.dedupeFirstLine = line;
      el.dataset.dedupeCount = '1';
      view.appendChild(el);
    }
    while (view.childElementCount > 1000) view.removeChild(view.firstChild);
    if (autoScroll) view.scrollTop = view.scrollHeight;
  }

  function humanAge(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    if (s < 90)       return `${s}s`;
    if (s < 3600)     return `${Math.floor(s / 60)}m`;
    if (s < 86_400)   return `${Math.floor(s / 3600)}h`;
    return `${Math.floor(s / 86_400)}d`;
  }

  // Map a ServiceHealth snapshot to a banner. `null` hides the banner
  // entirely (healthy + fresh logs). The `hint` slot is for actionable
  // guidance; it's the thing the old "connecting to relay…" stub was
  // supposed to give you and didn't.
  function statusToBanner(s) {
    const svcLabel = s.service === 'vpn' ? 'nostr-vpn' : s.service;
    if (!s.installed) {
      const hint = s.service === 'vpn'
        ? 'Open the <a href="#vpn">nostr-vpn</a> panel and click <strong>Install nvpn</strong> to download + register the daemon. The whole flow runs in the dashboard — no terminal needed.'
        : s.service === 'watchdog'
        ? 'The watchdog runs in-process with the dashboard. POST /api/watchdog/start to bring it back if it was stopped.'
        : 'The relay starts with the dashboard. Use the Relay panel\'s start button if it stopped.';
      return {
        level: 'err',
        title: `${svcLabel} is not installed on this machine.`,
        hint,
      };
    }
    if (!s.running) {
      // Each row's "running:false" hint should point the user at the
      // closest one-click fix. vpn lifecycle controls now live in the
      // dedicated nostr-vpn panel.
      const fix = s.service === 'relay'    ? 'use the Relay panel\'s start/restart buttons'
                : s.service === 'watchdog' ? 'POST /api/watchdog/start'
                : s.service === 'vpn'      ? 'click <strong>Start</strong> on the <a href="#vpn">nostr-vpn</a> panel'
                :                            'nvpn start --daemon';
      return {
        level: 'warn',
        title: `${svcLabel} is installed but not running.`,
        hint:  `Start it: ${fix}.`,
      };
    }
    if (!s.logExists) {
      return {
        level: 'warn',
        title: `${svcLabel} is running but hasn't logged anything yet.`,
        hint:  `Buffer source: <code>${s.logPath}</code>. New lines appear here as soon as the service logs something.`,
      };
    }
    if (s.stale) {
      const age = humanAge(Date.now() - s.logMtimeMs);
      return {
        level: 'warn',
        title: `${svcLabel} log is stale — last write ${age} ago.`,
        hint:  `The service may be wedged. Restart via the Relay panel (relay) or POST /api/watchdog/{stop,start} (watchdog).`,
      };
    }
    // The vpn tab renders its rich meta block separately (renderMeta
    // below). Suppress the banner when healthy + streaming — the meta
    // strip already shows tunnel IP, controls, and the daemon log path.
    return null;
  }

  function renderMeta(status) {
    if (!meta) return;
    if (status.service === 'watchdog' && status.watchdogNpub) {
      // Watchdog tab: surface the watchdog npub so the user can follow it
      // on their phone / preferred Nostr client and actually receive the
      // relay-down DMs the watchdog is there to send.
      meta.hidden = false;
      meta.innerHTML = `
        <span class="logs-meta-label">watchdog identity</span>
        <span class="logs-meta-value"></span>
        <button class="logs-meta-copy" title="copy npub">copy</button>`;
      meta.querySelector('.logs-meta-value').textContent = status.watchdogNpub;
      const btn = meta.querySelector('.logs-meta-copy');
      btn.addEventListener('click', () => {
        navigator.clipboard.writeText(status.watchdogNpub).then(() => {
          const prev = btn.textContent;
          btn.textContent = 'copied';
          setTimeout(() => { btn.textContent = prev; }, 1200);
        }).catch(() => {});
      });
      return;
    }

    // The vpn tab used to render a rich meta block here (controls, peers,
    // settings, service, danger zone). Those moved into the dedicated
    // nostr-vpn panel; the Logs tab is now just the log tail.
    meta.hidden = true;
    meta.innerHTML = '';
  }

  function renderBanner(status) {
    if (!banner) return;
    const b = statusToBanner(status);
    if (!b) {
      banner.hidden = true;
      banner.innerHTML = '';
      banner.className = 'logs-status';
      return;
    }
    banner.hidden = false;
    banner.className = `logs-status ${b.level}`;
    banner.innerHTML = `
      <span class="logs-status-icon">${b.level === 'err' ? '✕' : '⚠'}</span>
      <div class="logs-status-body">
        <div class="logs-status-title"></div>
        <div class="logs-status-hint"></div>
      </div>`;
    banner.querySelector('.logs-status-title').textContent = b.title;
    // hint is trusted (server-side template — no user input), so innerHTML
    // is fine for the <code> chips. If this ever starts incorporating
    // user-controlled strings, switch to textContent + manual spans.
    banner.querySelector('.logs-status-hint').innerHTML = b.hint;
  }

  function disconnect() { if (es) { es.close(); es = null; } }
  function connect(svc) {
    disconnect();
    view.innerHTML = '';
    if (banner) { banner.hidden = true; banner.innerHTML = ''; }
    if (meta)   { meta.hidden = true;   meta.innerHTML = ''; }
    // EventSource can't set Authorization headers, so we pass the session
    // token as a query param. Server-side extractBearer() accepts both
    // Authorization and ?token= for exactly this reason.
    const tok = encodeURIComponent(getSessionToken() || '');
    es = new EventSource(`/api/logs/${svc}${tok ? `?token=${tok}` : ''}`);
    es.addEventListener('message', (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.status) { renderBanner(data.status); renderMeta(data.status); }
        if (data.lines)  append(data.lines);
        if (data.error)  append(['[error] ' + data.error]);
      } catch {}
    });
    // Don't render "[stream closed]" as a log line — the server holds the
    // connection open with heartbeats when the log file is missing, so an
    // onerror here almost always means a real network drop, not a missing
    // service. The banner already explains service state.
    es.addEventListener('error', () => {});
  }

  $$('#logs-tabs .tab').forEach(tab => {
    tab.addEventListener('click', () => {
      $$('#logs-tabs .tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentSvc = tab.dataset.log;
      // Relay-error hint is vpn-specific. Hide on non-vpn tabs but keep
      // the timestamp window so flipping back to vpn doesn't lose
      // recently-observed errors.
      if (currentSvc !== 'vpn') hideRelayHint();
      else if (relayErrTimestamps.length >= RELAY_ERR_THRESHOLD) showRelayHint();
      connect(currentSvc);
    });
  });
  $('logs-clear').addEventListener('click', () => { view.innerHTML = ''; });
  $('logs-pause').addEventListener('click', (e) => {
    paused = !paused;
    e.target.textContent = paused ? 'resume' : 'pause';
  });

  return {
    onEnter() { if (!es) connect(currentSvc); clearLogsBadge(); },
  };
})();

// ── Panel: nostr-vpn ─────────────────────────────────────────────────────
//
// Dedicated control surface for the nostr-vpn daemon. Until this landed,
// every nvpn affordance lived in one of two places:
//   - Logs > nostr-vpn tab: status/peers/settings/service/danger zone +
//     log tail, all stacked into a "tab inside a logs viewer" that had
//     outgrown its container.
//   - Config: discovery relays + reachability dots + recommended set.
// Two surfaces, partial overlap, mental-model split. This panel is the
// canonical home; the Logs panel goes back to being just a log viewer
// (vpn tab kept for the live tail) and the Config relay block moves
// here verbatim.

const VpnPanel = (() => {
  const subtitleEl = $('vpn-panel-subtitle');
  const stripEl    = $('vpn-status-strip');
  const headEl     = $('vpn-head-actions');
  const tabsEl     = $('vpn-tabs');
  const bodyEl     = $('vpn-panel-body');

  let currentTab = 'status';
  // Cached payloads — shared across sub-tab renders so flipping tabs
  // doesn't refetch what we already have. Each onEnter() refreshes.
  let lastStatus       = null;  // GET /api/nvpn/status
  let lastService      = null;  // GET /api/nvpn/service/status
  let lastRoster       = null;  // GET /api/nvpn/roster
  let lastRelays       = null;  // GET /api/nvpn/relays
  let lastNetworks     = null;  // GET /api/nvpn/networks  (full [[networks]] list)
  let lastDeployment   = null;  // GET /api/nvpn/deployment-context
  let lastSplitBrain   = null;  // GET /api/nvpn/split-brain
  let lastJoinRequests = null;  // GET /api/nvpn/join-requests
  // 60s TTL for the auto-fired netcheck — same idea as ConfigPanel's
  // cache. Manual "Check reachability" passes { force:true } to bypass.
  let relayHealthCache = null; // { fetchedAt: ms, raw: object|null }

  // Sub-tab switching is purely visual + lazy. Each sub-tab has a
  // render function that draws into bodyEl from the cached payloads.
  function selectTab(name) {
    currentTab = name;
    $$('#vpn-tabs .tab').forEach(t => t.classList.toggle('active', t.dataset.vpnTab === name));
    renderActiveTab();
  }
  tabsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (!btn || !btn.dataset.vpnTab) return;
    selectTab(btn.dataset.vpnTab);
  });

  function renderActiveTab() {
    const renderer = TAB_RENDERERS[currentTab];
    if (!renderer) { bodyEl.innerHTML = ''; return; }
    bodyEl.innerHTML = renderer();
    // Each renderer attaches its event handlers in a wire() callback we
    // expose on the function itself. Keeps the render-then-bind split
    // close together and lets us re-render without re-wiring globals.
    if (typeof renderer.wire === 'function') renderer.wire();
  }

  // Deployment-context banner — shown above the status strip when the
  // host is detected as being inside a container/VM or the daemon's
  // published endpoint is RFC1918. Tells the user "you may need to set
  // up port-forwarding" with a link to the deployment doc, instead of
  // letting them discover that through several hours of debugging.
  function renderDeploymentBanner() {
    const slot = $('vpn-deployment-banner') || (() => {
      // Lazy-create the slot above the status strip if the static HTML
      // doesn't already define it.
      const el = document.createElement('div');
      el.id = 'vpn-deployment-banner';
      el.className = 'vpn-deployment-banner';
      stripEl.parentNode.insertBefore(el, stripEl);
      return el;
    })();
    const w = lastDeployment && lastDeployment.warning ? lastDeployment.warning : null;
    if (!w) { slot.innerHTML = ''; slot.style.display = 'none'; return; }
    slot.style.display = 'block';
    slot.className = `vpn-deployment-banner ${w.level}`;
    slot.innerHTML = `
      <div class="vpn-deployment-banner-row">
        <strong>${escapeHtml(w.summary)}</strong>
        <a href="docs/nvpn-deployment.md" target="_blank" rel="noopener noreferrer">deployment guide →</a>
      </div>
      <div class="muted vpn-deployment-banner-detail">${escapeHtml(w.detail)}</div>
    `;
  }

  // Split-brain banner (#58). Renders above the status strip when the
  // server reports two daemons (user-mode + systemd-managed) are both
  // alive. Includes a "Consolidate" action that stops the user-mode
  // daemon and lets the systemd one own the network. Self-creating
  // slot so we don't need a static HTML hook.
  function renderSplitBrainBanner() {
    const slot = $('vpn-split-brain-banner') || (() => {
      const el = document.createElement('div');
      el.id = 'vpn-split-brain-banner';
      el.className = 'vpn-split-brain-banner';
      stripEl.parentNode.insertBefore(el, stripEl);
      return el;
    })();
    const sb = lastSplitBrain;
    if (!sb || !sb.splitBrain) { slot.innerHTML = ''; slot.style.display = 'none'; return; }
    slot.style.display = 'block';
    slot.innerHTML = `
      <div class="vpn-split-brain-row">
        <div>
          <strong>Two nvpn daemons running</strong>
          <div class="muted vpn-split-brain-detail">${escapeHtml(sb.summary)}</div>
          <div class="muted vpn-split-brain-detail">
            User-mode pid ${sb.user?.pid ?? '?'} &middot; systemd pid ${sb.systemd?.pid ?? '?'}
          </div>
        </div>
        <button id="vpn-split-brain-consolidate" class="primary">Consolidate</button>
      </div>
    `;
    const btn = $('vpn-split-brain-consolidate');
    if (btn) btn.addEventListener('click', async (e) => {
      e.preventDefault(); btn.disabled = true;
      try {
        const r = await api('/api/nvpn/split-brain/consolidate', { method: 'POST' });
        toast('Daemons consolidated', r?.detail || '', r?.ok === false ? 'err' : 'ok');
        await refresh();
      } catch { /* api() already toasted */ }
      btn.disabled = false;
    });
  }

  // Top-of-panel status strip — pill + control buttons. Always rendered
  // (independent of which sub-tab is active) so the user can Stop /
  // Restart / etc. without leaving Diagnostics, Settings, etc.
  function renderStatusStrip() {
    const status = lastStatus;
    if (!status) {
      stripEl.innerHTML = '<div class="muted vpn-strip-loading">loading…</div>';
      return;
    }
    const stateText = !status.installed ? 'not installed'
                    : !status.running   ? 'stopped'
                    :                     'running';
    const stateClass = !status.installed ? 'err'
                     : !status.running   ? 'warn'
                     :                     'ok';
    const tunnel = status.tunnelIp
      ? `<code class="cmd-inline vpn-strip-tunnel">${escapeHtml(status.tunnelIp)}</code>`
      : '';
    const pid = (status.raw && status.raw.daemon && status.raw.daemon.pid != null)
      ? `<span class="muted">pid ${escapeHtml(String(status.raw.daemon.pid))}</span>` : '';
    // Reality check (issue #56). status.health is the rolled-up surface
    // from nvpnHealthSummary — when it disagrees with the daemon-claimed
    // "running" pill (e.g., publish channel broken, STUN never landed),
    // we want the user to see that *first*, not buried in raw JSON.
    const health = status.health || null;
    const endpointBadge = health && health.publicEndpoint
      ? `<code class="cmd-inline vpn-strip-endpoint" title="STUN-discovered public endpoint — peers dial here">${escapeHtml(health.publicEndpoint)}</code>`
      : '';
    const degraded = (status.running && health && health.state === 'degraded')
      ? `<span class="dot warn"></span><span class="vpn-strip-degraded" title="${escapeHtml(health.issues.join(' • '))}">degraded</span>`
      : '';
    stripEl.innerHTML = `
      <div class="vpn-strip-state">
        <span class="dot ${stateClass}"></span>
        <span class="vpn-strip-label">nostr-vpn</span>
        <span class="vpn-strip-value">${escapeHtml(stateText)}</span>
        ${degraded}
        ${tunnel}
        ${endpointBadge}
        ${pid}
      </div>
      ${health && Array.isArray(health.issues) && health.issues.length > 0 && status.running
        ? `<div class="vpn-strip-issues muted">${health.issues.map(i => `<div>• ${escapeHtml(i)}</div>`).join('')}</div>`
        : ''}
      <div class="vpn-strip-actions" id="vpn-strip-actions"></div>
    `;
    const actions = $('vpn-strip-actions');
    if (!status.installed) {
      // Only meaningful when the binary is missing — directs the user
      // to the install wizard / dedicated install button.
      const b = document.createElement('button');
      b.className = 'primary';
      b.textContent = 'Install nvpn';
      b.addEventListener('click', () => runNvpnInstall());
      actions.appendChild(b);
    } else if (!status.running) {
      const b = document.createElement('button');
      b.className = 'primary';
      b.textContent = 'Start';
      b.addEventListener('click', async (e) => {
        e.preventDefault(); b.disabled = true;
        await callNvpnAction('start', 'started');
        await refresh();
        b.disabled = false;
      });
      actions.appendChild(b);
    } else {
      for (const [action, label, cls] of [
        ['restart', 'Restart', ''],
        ['pause',   'Pause',   ''],
        ['resume',  'Resume',  ''],
        ['stop',    'Stop',    'danger'],
      ]) {
        const b = document.createElement('button');
        if (cls) b.className = cls;
        b.textContent = label;
        b.addEventListener('click', async (e) => {
          e.preventDefault(); b.disabled = true;
          await callNvpnAction(action, label.toLowerCase());
          await refresh();
          b.disabled = false;
        });
        actions.appendChild(b);
      }
    }
    // Refresh button — explicit re-poll for users who want fresh data
    // immediately after toggling something out-of-band (e.g. a
    // terminal-side `nvpn set`).
    const refreshBtn = document.createElement('button');
    refreshBtn.textContent = 'Refresh';
    refreshBtn.addEventListener('click', async (e) => {
      e.preventDefault(); refreshBtn.disabled = true;
      try { await refresh(); } finally { refreshBtn.disabled = false; }
    });
    actions.appendChild(refreshBtn);
  }

  // Pull every payload the panel needs in parallel, then re-render.
  // Errors are swallowed per-call so a flaky daemon doesn't blank the
  // whole panel — each sub-tab handles missing data with its own
  // empty-state.
  async function refresh() {
    const [s, svc, roster, relays, networks, deployment, splitBrain, joinReqs] = await Promise.all([
      api('/api/nvpn/status').catch(() => null),
      api('/api/nvpn/service/status').catch(() => null),
      api('/api/nvpn/roster').catch(() => null),
      api('/api/nvpn/relays').catch(() => null),
      api('/api/nvpn/networks').catch(() => null),
      api('/api/nvpn/deployment-context', undefined, { silent: true }).catch(() => null),
      api('/api/nvpn/split-brain', undefined, { silent: true }).catch(() => null),
      api('/api/nvpn/join-requests', undefined, { silent: true }).catch(() => null),
    ]);
    lastStatus       = s;
    lastService      = svc;
    lastRoster       = roster;
    lastRelays       = relays;
    lastNetworks     = networks;
    lastDeployment   = deployment;
    lastSplitBrain   = splitBrain;
    lastJoinRequests = joinReqs;
    renderDeploymentBanner();
    renderSplitBrainBanner();
    renderStatusStrip();
    renderActiveTab();
  }

  // Sub-tab renderers. Each returns the inner HTML; their .wire()
  // method (set after the function definition) attaches event
  // handlers. Keeping render + wire local to each renderer keeps the
  // file structure sectioned by feature rather than by lifecycle hook.
  const TAB_RENDERERS = {
    status:      renderStatusBody,
    network:     renderNetworkBody,
    relays:      renderRelaysBody,
    settings:    renderSettingsBody,
    service:     renderServiceBody,
    diagnostics: renderDiagnosticsBody,
  };

  function renderStatusBody() {
    if (!lastStatus) return '<div class="vpn-empty muted">loading…</div>';
    if (!lastStatus.installed) {
      return `<div class="vpn-empty">
        <div class="vpn-empty-title">nostr-vpn isn't installed</div>
        <div class="vpn-empty-detail muted">
          Use the <strong>Install nvpn</strong> button above to download +
          register the daemon. The whole flow runs in the dashboard — no
          terminal needed.
        </div>
      </div>`;
    }
    const r = lastStatus.raw || {};
    // Two-column KV. Copyable rows (npub/pubkey/log path) get a slot for
    // a copy button which we append after innerHTML in .wire().
    const rows = [];
    if (r.daemon && r.daemon.pid != null) rows.push({ k: 'daemon pid', v: String(r.daemon.pid) });
    if (r.daemon && r.daemon.started_at) rows.push({ k: 'started',    v: String(r.daemon.started_at) });
    if (lastStatus.tunnelIp)              rows.push({ k: 'tunnel ip',  v: lastStatus.tunnelIp });
    if (typeof r.npub === 'string')       rows.push({ k: 'npub',      v: r.npub,    copy: true });
    if (typeof r.pubkey === 'string' && !r.npub) rows.push({ k: 'pubkey', v: r.pubkey, copy: true });
    if (typeof r.endpoint === 'string')   rows.push({ k: 'endpoint',   v: r.endpoint });
    if (typeof r.session_status === 'string') rows.push({ k: 'session', v: r.session_status });
    // Log path — surfaces where the daemon is writing. Lets a power user
    // `tail -f` from a terminal even though the live tail is right next
    // to the Logs panel.
    if (r.daemon && typeof r.daemon.log_file === 'string' && r.daemon.log_file) {
      rows.push({ k: 'log', v: r.daemon.log_file, copy: true });
    }
    if (lastStatus.error) rows.push({ k: 'last probe', v: lastStatus.error });
    const rowsHtml = rows.map(({ k, v, copy }) => `
      <div class="vpn-kv-row" data-row-key="${escapeHtml(k)}">
        <span class="vpn-kv-key">${escapeHtml(k)}</span>
        <code class="vpn-kv-val">${escapeHtml(v)}</code>
        ${copy ? '<span class="vpn-kv-copy-slot"></span>' : ''}
      </div>`).join('');
    return `<div class="vpn-section vpn-kv">${rowsHtml}</div>`;
  }
  renderStatusBody.wire = () => {
    // Attach copy buttons after innerHTML — the rendered value text is
    // already escaped, but copyBtn takes the raw string for clipboard.
    const r = lastStatus && lastStatus.raw ? lastStatus.raw : null;
    if (!r) return;
    const wireCopy = (key, value) => {
      if (!value) return;
      const row = bodyEl.querySelector(`.vpn-kv-row[data-row-key="${CSS.escape(key)}"]`);
      const slot = row && row.querySelector('.vpn-kv-copy-slot');
      if (slot) slot.appendChild(copyBtn(value));
    };
    if (typeof r.npub === 'string')   wireCopy('npub', r.npub);
    else if (typeof r.pubkey === 'string') wireCopy('pubkey', r.pubkey);
    if (r.daemon && typeof r.daemon.log_file === 'string') wireCopy('log', r.daemon.log_file);
  };

  // Network sub-tab — mesh state + lifecycle. Roster is the configured
  // set (config.toml); live peers come from `nvpn status --json`. Merged
  // so the user sees roster vs actually-online. Share invite / Import
  // invite / Publish roster live here, along with the add-peer form
  // and per-peer actions (ping / whois / alias / promote / demote /
  // remove).
  // Join-requests section (#62). Renders inside the Network tab when
  // any pending requests exist; hidden entirely on nvpn versions that
  // don't expose the join-request CLI surface (supported === false)
  // or when there are no pending requests.
  function renderJoinRequestsSection() {
    const jr = lastJoinRequests;
    if (!jr || !jr.supported) return '';
    const reqs = Array.isArray(jr.requests) ? jr.requests : [];
    if (reqs.length === 0) return '';
    const rows = reqs.map(r => {
      const id = r.npub || r.pubkey || '';
      const label = r.alias || r.device_name || (id ? (id.length > 24 ? `${id.slice(0, 12)}…${id.slice(-6)}` : id) : 'unknown');
      const ts = r.ts ? String(r.ts) : '';
      return `
        <div class="vpn-join-req-row" data-id="${escapeHtml(id)}">
          <div class="vpn-join-req-meta">
            <strong>${escapeHtml(label)}</strong>
            <code class="cmd-inline muted">${escapeHtml(id)}</code>
            ${ts ? `<span class="muted vpn-join-req-ts">${escapeHtml(ts)}</span>` : ''}
          </div>
          <div class="vpn-join-req-actions">
            <button data-action="approve" class="primary">Approve</button>
            <button data-action="deny" class="danger">Deny</button>
          </div>
        </div>`;
    }).join('');
    return `
      <div class="vpn-join-requests" style="margin-top:14px">
        <div class="vpn-meta-peers-head">
          <span class="vpn-meta-label">pending join requests (${reqs.length})</span>
        </div>
        <div class="vpn-join-req-list">${rows}</div>
      </div>`;
  }

  function renderNetworkBody() {
    const r = lastStatus && lastStatus.raw ? lastStatus.raw : null;
    const roster = lastRoster;
    if (!r && !roster) return '<div class="vpn-empty muted">loading…</div>';
    const networkId = (roster && roster.networkId)
      || (r && typeof r.network_id === 'string' ? r.network_id : null);
    const rosterParts  = (roster && Array.isArray(roster.participants)) ? roster.participants : [];
    const rosterAdmins = (roster && Array.isArray(roster.admins))       ? roster.admins       : [];
    const aliases = (roster && roster.aliases && typeof roster.aliases === 'object')
      ? roster.aliases : {};
    const livePeers = normalizeNvpnPeers(r?.peers);
    const merged = mergePeers(rosterParts, rosterAdmins, livePeers, aliases);
    const onlineCount = merged.filter(p => p.connected).length;

    // Multi-network awareness — config.toml supports a [[networks]]
    // array but only the first entry is active at a time. Pull the
    // active entry's name (if set) and surface inactive ones as a
    // muted "also configured" line so the user knows roster mutations
    // only affect the active network.
    const allNetworks = (lastNetworks && Array.isArray(lastNetworks.networks))
      ? lastNetworks.networks : [];
    const activeNet = allNetworks.find(n => n.active) || null;
    const inactiveNets = allNetworks.filter(n => !n.active);
    const activeName = activeNet?.name || null;
    const networkIdHtml = networkId
      ? `<code class="vpn-kv-val vpn-net-id">${escapeHtml(networkId)}</code>
         <span class="vpn-net-id-copy"></span>`
      : '<span class="vpn-kv-val muted">unconfigured</span>';
    const activeRowHtml = activeName
      ? `<div class="vpn-kv-row">
          <span class="vpn-kv-key">active network</span>
          <span class="vpn-kv-val">${escapeHtml(activeName)}</span>
        </div>`
      : '';
    const inactiveLine = inactiveNets.length > 0
      ? `<div class="vpn-section-footer muted" style="margin-top:6px">
          Also configured: ${inactiveNets.map(n => {
            const label = n.name || (n.networkId ? n.networkId.slice(0, 12) + '…' : '(unnamed)');
            return `<code class="cmd-inline">${escapeHtml(label)}</code>`;
          }).join(', ')}
          · roster mutations apply to the active network only.
        </div>`
      : '';

    return `
      <div class="vpn-section">
        <div class="vpn-kv">
          ${activeRowHtml}
          <div class="vpn-kv-row">
            <span class="vpn-kv-key">network id</span>
            ${networkIdHtml}
          </div>
          <div class="vpn-kv-row">
            <span class="vpn-kv-key">roster</span>
            <span class="vpn-kv-val">
              ${rosterParts.length} participant${rosterParts.length === 1 ? '' : 's'}
              · ${rosterAdmins.length} admin${rosterAdmins.length === 1 ? '' : 's'}
              · ${onlineCount} online
            </span>
          </div>
        </div>
        ${inactiveLine}
        <div class="vpn-net-actions" style="margin-top:14px">
          <button id="vpn-share-invite" class="primary">Share invite</button>
          <button id="vpn-import-invite">Import invite</button>
          <button id="vpn-publish-roster">Publish roster</button>
        </div>
        ${renderJoinRequestsSection()}
        <div class="vpn-meta-peers" style="margin-top:18px">
          <div class="vpn-meta-peers-head">
            <span class="vpn-meta-label">peers (${merged.length})</span>
            <span class="vpn-meta-peers-counts muted">
              ${onlineCount} online · ${rosterAdmins.length} admin${rosterAdmins.length === 1 ? '' : 's'}
            </span>
          </div>
          <div class="vpn-meta-peers-list">
            ${merged.length === 0
              ? '<div class="muted vpn-meta-peer-empty">no peers configured — add one below or import an invite</div>'
              : merged.map(renderPeerRow).join('')}
          </div>
          <form class="vpn-add-peer" autocomplete="off">
            <input type="text" id="vpn-add-peer-input"
                   placeholder="npub1… or 64-char hex" spellcheck="false">
            <label class="vpn-add-peer-publish">
              <input type="checkbox" id="vpn-add-peer-publish" checked>
              publish now
            </label>
            <button type="submit" class="primary">Add peer</button>
          </form>
        </div>
      </div>`;
  }
  renderNetworkBody.wire = () => {
    const r = lastStatus && lastStatus.raw ? lastStatus.raw : null;
    const roster = lastRoster;
    const networkId = (roster && roster.networkId)
      || (r && typeof r.network_id === 'string' ? r.network_id : null);
    const netCopy = bodyEl.querySelector('.vpn-net-id-copy');
    if (netCopy && networkId) netCopy.appendChild(copyBtn(networkId));

    const shareBtn = bodyEl.querySelector('#vpn-share-invite');
    if (shareBtn) shareBtn.addEventListener('click', (e) => { e.preventDefault(); openShareInviteModal(); });
    const importBtn = bodyEl.querySelector('#vpn-import-invite');
    if (importBtn) importBtn.addEventListener('click', (e) => { e.preventDefault(); openImportInviteModal(); });
    const pubBtn = bodyEl.querySelector('#vpn-publish-roster');
    if (pubBtn) {
      pubBtn.addEventListener('click', async (e) => {
        e.preventDefault(); pubBtn.disabled = true;
        try {
          const resp = await api('/api/nvpn/roster/publish', { method: 'POST' });
          toast('roster published', resp?.detail || '', 'ok');
        } catch { /* api() already toasted */ }
        pubBtn.disabled = false;
      });
    }

    // Join-request Approve / Deny buttons (#62). Dispatch on data-action
    // so the rendering code can drop / reorder rows without rewiring.
    bodyEl.querySelectorAll('.vpn-join-req-row button[data-action]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        const row = btn.closest('.vpn-join-req-row');
        const id = row?.dataset.id || '';
        if (!id) return;
        const action = btn.dataset.action;
        const endpoint = action === 'approve'
          ? '/api/nvpn/join-requests/approve'
          : '/api/nvpn/join-requests/deny';
        btn.disabled = true;
        try {
          const r = await api(endpoint, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ participant: id }),
          });
          toast(`request ${action}d`, r?.detail || '', r?.ok === false ? 'err' : 'ok');
          await refresh();
        } catch { /* api() already toasted */ }
        btn.disabled = false;
      });
    });

    const addForm = bodyEl.querySelector('.vpn-add-peer');
    if (addForm) {
      addForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const input  = bodyEl.querySelector('#vpn-add-peer-input');
        const pubInp = bodyEl.querySelector('#vpn-add-peer-publish');
        const value  = String(input?.value || '').trim();
        if (!value) return;
        if (!isValidParticipant(value)) {
          toast('Invalid pubkey', 'paste an npub1… or 64-char hex', 'warn');
          input.focus();
          return;
        }
        const submitBtn = addForm.querySelector('button[type="submit"]');
        if (submitBtn) submitBtn.disabled = true;
        try {
          const resp = await api('/api/nvpn/peers/add', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ participants: [value], publish: !!(pubInp?.checked) }),
          });
          toast('peer added', resp?.detail || '', 'ok');
          input.value = '';
          await refresh();
        } catch { /* api() already toasted */ }
        if (submitBtn) submitBtn.disabled = false;
      });
    }

    // Per-row buttons. Wired by data-action so renderPeerRow can drop
    // them in without a bespoke listener per row. Ping + whois are
    // read-only and render inline; alias opens a prompt;
    // remove/promote/demote mutate the roster.
    bodyEl.querySelectorAll('.vpn-meta-peer button[data-action]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        const peerEl = btn.closest('.vpn-meta-peer');
        const id = peerEl?.dataset?.id;
        if (!id) return;
        btn.disabled = true;
        try {
          if (btn.dataset.action === 'ping') {
            const target = btn.dataset.target || id;
            const out = peerEl.querySelector('.vpn-meta-peer-pingout');
            if (out) {
              out.hidden = false;
              out.textContent = `pinging ${target}…`;
              try {
                const resp = await api('/api/nvpn/ping', {
                  method: 'POST', headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ target, count: 3, timeoutSecs: 2 }),
                });
                out.textContent = (resp?.output || resp?.detail || 'no output').slice(0, 800);
                out.classList.toggle('vpn-meta-peer-pingout-err', resp?.ok === false);
              } catch { out.textContent = 'ping error'; }
            }
          } else if (btn.dataset.action === 'whois') {
            const target = btn.dataset.target || id;
            const out = peerEl.querySelector('.vpn-meta-peer-pingout');
            if (out) {
              out.hidden = false;
              out.textContent = `whois ${target}…`;
              try {
                const resp = await api('/api/nvpn/whois', {
                  method: 'POST', headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ query: target }),
                });
                // Prefer the structured `raw` payload; fall back to
                // the detail line when the daemon returned no JSON
                // (older nvpn build, or a connection-level failure).
                const body = resp?.raw
                  ? JSON.stringify(resp.raw, null, 2)
                  : (resp?.detail || 'no output');
                out.textContent = String(body).slice(0, 1200);
                out.classList.toggle('vpn-meta-peer-pingout-err', resp?.ok === false);
              } catch { out.textContent = 'whois error'; }
            }
          } else if (btn.dataset.action === 'alias') {
            const current = peerEl.dataset.alias || '';
            await openAliasPrompt(id, current);
            await refresh();
          } else {
            await peerAction(btn.dataset.action, id);
            await refresh();
          }
        } catch { /* api() already toasted */ }
        btn.disabled = false;
      });
    });
  };

  // Relays sub-tab — discovery relays (where nvpn publishes presence
  // and discovers peers). Read goes straight from config.toml so the
  // list renders even when the daemon is down; mutations go through
  // `nvpn set --relay` followed by an automatic `nvpn reload`.
  // Auto-fired netcheck decorates each row with latency + a coloured
  // dot (60s panel-scope cache; "Check reachability" forces refetch).
  function renderRelaysBody() {
    const r = lastRelays;
    if (!r) return '<div class="vpn-empty muted">loading…</div>';
    const items = (Array.isArray(r.relays) ? r.relays : []).map(url => `
      <div class="item" data-url="${escapeHtml(url)}">
        <span class="url">${escapeHtml(url)}</span>
        <span class="relay-health" data-slot="health"></span>
        <button class="danger rm-vpn-relay">×</button>
      </div>`).join('');
    const errorLine = r.found === false
      ? `<div class="key-status-line">${r.configPath
          ? '✗ config.toml unreadable'
          : 'no nvpn config — run <code>nvpn init</code> first'}</div>`
      : '';
    return `
      <div class="vpn-section">
        <p class="vpn-section-help">
          Nostr relays nostr-vpn uses to publish presence and discover
          peers. Distinct from your identity / ngit relay sets — these
          are mesh-only. If the log shows <code>504 Gateway Timeout</code>
          loops, the configured relay is likely flaky; add a healthier
          one and the daemon will pick it up on the next reload.
        </p>
        ${errorLine}
        <div class="relay-list" id="vpn-relays">
          ${items}
          <div class="add">
            <input id="vpn-relay-input" placeholder="wss://your-relay.example" autocomplete="off" spellcheck="false">
            <button id="vpn-relay-paste">paste</button>
            <button class="primary" id="vpn-relay-add">add</button>
          </div>
        </div>
        <div class="keyrow" style="margin-top:6px;justify-content:flex-end;gap:6px">
          <button id="vpn-relay-recommended">Use recommended</button>
          <button id="vpn-relay-recheck">Check reachability</button>
        </div>
        <div class="key-status-line ${r.relays && r.relays.length ? 'ok' : ''}">
          ${r.relays && r.relays.length
            ? `✓ ${r.relays.length} relay${r.relays.length === 1 ? '' : 's'} configured`
            : 'no relays configured'}
        </div>
      </div>`;
  }
  renderRelaysBody.wire = () => {
    $$('#vpn-relays .rm-vpn-relay').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const url = e.target.closest('.item').dataset.url;
        void removeRelay(url);
      });
    });
    const addBtn = $('vpn-relay-add');
    if (!addBtn) return;
    addBtn.addEventListener('click', addRelayFromInput);
    $('vpn-relay-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') addRelayFromInput();
    });
    $('vpn-relay-paste').addEventListener('click', async () => {
      try { $('vpn-relay-input').value = (await navigator.clipboard.readText()).trim(); }
      catch { toast('Clipboard blocked', 'paste manually', 'warn'); }
    });
    const recheckBtn = $('vpn-relay-recheck');
    if (recheckBtn) recheckBtn.addEventListener('click', async (e) => {
      e.preventDefault(); recheckBtn.disabled = true;
      try { await loadRelayHealth({ force: true }); }
      finally { recheckBtn.disabled = false; }
    });
    const recommendedBtn = $('vpn-relay-recommended');
    if (recommendedBtn) recommendedBtn.addEventListener('click', async (e) => {
      e.preventDefault(); recommendedBtn.disabled = true;
      try { await useRecommendedRelays(); }
      finally { recommendedBtn.disabled = false; }
    });
    // Auto-fire reachability after this sub-tab paints, only if relays
    // are configured. 60s cache avoids re-spawning an 8s netcheck on
    // every tab switch; manual recheck bypasses with { force:true }.
    if (lastRelays && Array.isArray(lastRelays.relays) && lastRelays.relays.length > 0) {
      void loadRelayHealth();
    }
  };

  // Trailing-slash normalization — config.toml may store "wss://x/"
  // while netcheck reports "wss://x" (and vice versa). Match on the
  // canonical form so reachability decorates the right row.
  function normalizeRelayUrl(s) {
    return String(s || '').replace(/\/+$/, '').toLowerCase();
  }

  async function addRelayFromInput() {
    const input = $('vpn-relay-input');
    const url = input.value.trim();
    if (!url) return;
    if (!/^wss?:\/\//i.test(url)) {
      toast('Invalid relay URL', 'must start with wss:// or ws://', 'err');
      return;
    }
    try {
      const r = await api('/api/nvpn/relays/add', {
        method:  'POST',
        headers: { 'content-type': 'application/json' },
        body:    JSON.stringify({ url }),
      });
      if (!r.ok) throw new Error(r.detail || 'add failed');
      toast('Relay added', url, 'ok');
      input.value = '';
      // Invalidate health cache — the new relay isn't in the cached
      // netcheck pass and the user is mid-troubleshoot.
      relayHealthCache = null;
      await refresh();
    } catch (e) { toast('Add failed', e.message, 'err'); }
  }

  async function removeRelay(url) {
    try {
      const r = await api('/api/nvpn/relays/remove', {
        method:  'POST',
        headers: { 'content-type': 'application/json' },
        body:    JSON.stringify({ url }),
      });
      if (!r.ok) throw new Error(r.detail || 'remove failed');
      toast('Relay removed', url, 'ok');
      relayHealthCache = null;
      await refresh();
    } catch (e) { toast('Remove failed', e.message, 'err'); }
  }

  // One-click recovery: replace with the dashboard-curated set
  // (RECOMMENDED_NVPN_RELAYS in nvpn.ts; server is the single source).
  // Confirms first because this is destructive.
  async function useRecommendedRelays() {
    let recommended = [];
    try {
      const r = await api('/api/nvpn/relays/recommended');
      recommended = Array.isArray(r?.relays) ? r.relays : [];
    } catch (e) { toast('Failed to load recommended', e.message, 'err'); return; }
    if (recommended.length === 0) {
      toast('No recommended set defined', '', 'err'); return;
    }
    const ok = confirm(
      `Replace your nostr-vpn relay list with the recommended set?\n\n` +
      recommended.map(u => `  • ${u}`).join('\n') +
      `\n\nAny existing relays will be removed.`
    );
    if (!ok) return;
    try {
      const r = await api('/api/nvpn/relays/set', {
        method:  'POST',
        headers: { 'content-type': 'application/json' },
        body:    JSON.stringify({ relays: recommended }),
      });
      if (!r.ok) throw new Error(r.detail || 'set failed');
      toast('Relays updated', `${recommended.length} recommended relay${recommended.length === 1 ? '' : 's'}`, 'ok');
      relayHealthCache = null;
      await refresh();
    } catch (e) { toast('Update failed', e.message, 'err'); }
  }

  // Pull `nvpn netcheck --json` and decorate each row in #vpn-relays
  // with a coloured dot + latency. Auto-fire path (no opts) shares a
  // 60s cache; manual "Check reachability" passes { force:true } to
  // bypass. Quiet on failure — if netcheck times out (relays really
  // are unreachable, daemon down, etc.) we leave rows un-annotated
  // rather than red-flagging everything.
  async function loadRelayHealth(opts) {
    const list = document.getElementById('vpn-relays');
    if (!list) return;
    const slots = list.querySelectorAll('.relay-health[data-slot="health"]');
    if (slots.length === 0) return;
    const force = !!(opts && opts.force);
    const cached = relayHealthCache;
    const fresh = cached && (Date.now() - cached.fetchedAt < 60_000);
    let raw = null;
    if (!force && fresh) {
      raw = cached.raw;
    } else {
      for (const slot of slots) {
        slot.className = 'relay-health checking';
        slot.textContent = 'checking…';
      }
      try {
        // silent:true so a flaky relay set (the very thing this UI
        // exists to fix) doesn't pop a red toast for every render.
        const r = await api('/api/nvpn/netcheck', undefined, { silent: true });
        if (r && r.ok) raw = r.raw || null;
      } catch { /* daemon down or relays unreachable — silent */ }
      relayHealthCache = { fetchedAt: Date.now(), raw };
    }
    if (!raw) {
      for (const slot of slots) { slot.className = 'relay-health'; slot.textContent = ''; }
      return;
    }
    const checks = Array.isArray(raw.relayChecks) ? raw.relayChecks : [];
    const preferred = typeof raw.preferredRelay === 'string'
      ? normalizeRelayUrl(raw.preferredRelay) : null;
    const byUrl = new Map();
    for (const c of checks) {
      if (c && typeof c.relay === 'string') byUrl.set(normalizeRelayUrl(c.relay), c);
    }

    // Publish-health from the in-process aggregator. Independent of
    // netcheck — netcheck measures connect latency; the aggregator
    // measures whether the daemon's recent publishes were accepted.
    // Both surfaces useful, and the aggregator's `lastError.text`
    // makes the "why is this relay broken" cause one hover away.
    const publishHealthByUrl = new Map();
    try {
      const ph = await api('/api/nvpn/relays/health', undefined, { silent: true });
      if (ph && Array.isArray(ph.health)) {
        for (const e of ph.health) {
          if (e && typeof e.url === 'string') publishHealthByUrl.set(normalizeRelayUrl(e.url), e);
        }
      }
    } catch { /* silent */ }

    for (const item of list.querySelectorAll('.item')) {
      const slot = item.querySelector('.relay-health[data-slot="health"]');
      if (!slot) continue;
      const url = normalizeRelayUrl(item.dataset.url);
      const check = byUrl.get(url);
      slot.className = 'relay-health';
      const pub = publishHealthByUrl.get(url);
      let parts;
      if (!check) {
        parts = ['<span class="dot warn"></span><span>untested</span>'];
      } else {
        const latency = typeof check.latencyMs === 'number' ? check.latencyMs : null;
        const cls = latency === null ? 'warn'
                  : latency < 200    ? 'ok'
                  :                    'warn';
        const star = (preferred && url === preferred)
          ? '<span class="preferred-star" title="nvpn-preferred relay">★</span>' : '';
        const text = latency === null ? 'no latency' : `${latency}ms`;
        parts = [`<span class="dot ${cls}"></span><span>${escapeHtml(text)}</span>${star}`];
      }
      // Append publish-health badge when the aggregator has data. We
      // only show errors — a healthy relay just stays quiet here, since
      // the latency dot already conveys the positive signal.
      if (pub && pub.errCount > 0) {
        const kind = pub.lastError ? pub.lastError.kind : 'other';
        const tip = pub.lastError ? pub.lastError.text : 'recent publish errors';
        parts.push(`<span class="dot err" title="${escapeHtml(tip)}"></span><span title="${escapeHtml(tip)}">${pub.errCount} publish ${pub.errCount === 1 ? 'err' : 'errs'} (${escapeHtml(kind)})</span>`);
      }
      slot.innerHTML = parts.join(' ');
    }
  }

  // Settings sub-tab — editable form mapping onto `nvpn set --<key>
  // <value>`. Pre-fills from `nvpn status --json` so the user sees the
  // current state. Blanks skip rather than clobbering, so a partial save
  // doesn't wipe out everything else.
  function renderSettingsBody() {
    const r = lastStatus && lastStatus.raw ? lastStatus.raw : null;
    if (!r) return '<div class="vpn-empty muted">loading…</div>';
    // Current exit-node selection — nvpn has shipped this under a few
    // names across releases; check the common shapes and fall back to
    // null when none match.
    const currentExitNode = (typeof r.exit_node === 'string' && r.exit_node)
      || (typeof r.exitNode === 'string' && r.exitNode)
      || (typeof r.selected_exit_node === 'string' && r.selected_exit_node)
      || null;
    const cur = {
      'node-name':           '',
      'listen-port':         r.listen_port          ?? r.configured_listen_port ?? '',
      'magic-dns-suffix':    r.magic_dns_suffix     ?? '',
      'magic-dns-port':      r.magic_dns_port       ?? r.configured_magic_dns_port ?? '',
      'autoconnect':         r.autoconnect          ? 'true' : 'false',
      'advertise-exit-node': r.advertise_exit_node  ? 'true' : 'false',
      'advertise-routes':    Array.isArray(r.advertised_routes)
                               ? r.advertised_routes.join(',')
                               : (r.advertise_routes ?? ''),
      'relay-for-others':    r.relay_for_others     ? 'true' : 'false',
    };
    const fld = (key, label, type = 'text') => {
      const val = String(cur[key] ?? '');
      if (type === 'bool') {
        return `<label class="vpn-meta-set-field">
          <span class="vpn-meta-set-label">${escapeHtml(label)}</span>
          <select data-key="${escapeHtml(key)}">
            <option value="">(no change)</option>
            <option value="true"${val === 'true' ? ' selected' : ''}>true</option>
            <option value="false"${val === 'false' ? ' selected' : ''}>false</option>
          </select>
        </label>`;
      }
      return `<label class="vpn-meta-set-field">
        <span class="vpn-meta-set-label">${escapeHtml(label)}</span>
        <input type="${type}" data-key="${escapeHtml(key)}" value="${escapeHtml(val)}" placeholder="${escapeHtml(val)}" spellcheck="false">
      </label>`;
    };

    // exit-node select. Options:
    //   "(no change)" — blank, skipped by the blank-skip save logic
    //   "off"         — explicitly clear the selection
    //   each roster peer (alias if available, else truncated npub)
    // Pre-selects the current value when known, including the case
    // where it's set to a peer no longer in the roster (we still show
    // it so the user can see what's set).
    const rosterParts = (lastRoster && Array.isArray(lastRoster.participants))
      ? lastRoster.participants : [];
    const aliases = (lastRoster && lastRoster.aliases && typeof lastRoster.aliases === 'object')
      ? lastRoster.aliases : {};
    // Treat both "no selection" (null/missing field) and the literal
    // string "off" as "off" for pre-selection purposes — different nvpn
    // versions report the un-set state either way.
    const exitNodeIsOff = currentExitNode === null || currentExitNode === 'off';
    const exitNodeOptions = [
      `<option value="">(no change)</option>`,
      `<option value="off"${exitNodeIsOff ? ' selected' : ''}>off (no exit node)</option>`,
    ];
    const rosterKeys = new Set(rosterParts.map(p => String(p).toLowerCase()));
    for (const p of rosterParts) {
      const alias = aliases[p] || '';
      const truncId = p.length > 20 ? `${p.slice(0, 12)}…${p.slice(-6)}` : p;
      const label = alias ? `${alias} (${truncId})` : truncId;
      const selected = !exitNodeIsOff && currentExitNode && currentExitNode.toLowerCase() === p.toLowerCase() ? ' selected' : '';
      exitNodeOptions.push(`<option value="${escapeHtml(p)}"${selected}>${escapeHtml(label)}</option>`);
    }
    // Edge case: the configured exit-node is set to a value that isn't
    // in the current roster (peer removed, or pre-import). Surface it
    // explicitly so the user can see the stale selection and choose
    // "off" to clear it.
    if (!exitNodeIsOff && currentExitNode && !rosterKeys.has(currentExitNode.toLowerCase())) {
      const truncId = currentExitNode.length > 20
        ? `${currentExitNode.slice(0, 12)}…${currentExitNode.slice(-6)}`
        : currentExitNode;
      exitNodeOptions.push(`<option value="${escapeHtml(currentExitNode)}" selected>${escapeHtml(truncId)} (not in roster)</option>`);
    }
    const exitNodeField = `<label class="vpn-meta-set-field">
      <span class="vpn-meta-set-label">exit node</span>
      <select data-key="exit-node">${exitNodeOptions.join('')}</select>
    </label>`;

    return `
      <div class="vpn-section vpn-meta-set">
        <div class="vpn-meta-set-body">
          <div class="vpn-meta-set-grid">
            ${fld('node-name', 'node name')}
            ${fld('listen-port', 'listen port', 'number')}
            ${fld('magic-dns-suffix', 'magic DNS suffix')}
            ${fld('magic-dns-port', 'magic DNS port', 'number')}
            ${fld('advertise-routes', 'advertise routes (a,b,c)')}
            ${fld('autoconnect', 'autoconnect', 'bool')}
            ${fld('advertise-exit-node', 'advertise exit node', 'bool')}
            ${fld('relay-for-others', 'relay for others', 'bool')}
            ${exitNodeField}
          </div>
          <div class="vpn-meta-set-actions">
            <button id="vpn-set-save" class="primary">Save &amp; reload</button>
            <span class="muted vpn-meta-set-hint">
              Saves changes via <code>nvpn set</code> and asks the daemon to reload its config.
            </span>
          </div>
        </div>
      </div>`;
  }
  renderSettingsBody.wire = () => {
    const saveBtn = bodyEl.querySelector('#vpn-set-save');
    if (!saveBtn) return;
    saveBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      const inputs = bodyEl.querySelectorAll('.vpn-meta-set-grid [data-key]');
      const payload = {};
      for (const inp of inputs) {
        const key = inp.dataset.key;
        const val = String(inp.value || '').trim();
        // Skip blanks so we don't clobber existing settings with empty
        // strings. Saves the user from having to remember every
        // current value.
        if (!val) continue;
        payload[key] = val;
      }
      if (Object.keys(payload).length === 0) {
        toast('No changes', 'fill at least one field to save', 'warn');
        return;
      }
      saveBtn.disabled = true;
      try {
        const setRes = await api('/api/nvpn/set', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (setRes?.ok === false) {
          toast('save failed', setRes?.detail || '', 'err');
        } else {
          toast('settings saved', setRes?.detail || '', 'ok');
          // Reload only when the save actually mutated state. If the
          // daemon isn't running, /api/nvpn/reload returns an error —
          // surface it as a hint rather than masking the successful save.
          try {
            const reloadRes = await api('/api/nvpn/reload', { method: 'POST' });
            if (reloadRes?.ok === false) {
              toast('reload skipped', 'changes saved; restart the daemon to pick them up', 'warn');
            }
          } catch { /* api() already toasted; settings save still succeeded */ }
        }
        await refresh();
      } catch { /* api() already toasted */ }
      saveBtn.disabled = false;
    });
  };

  // Service sub-tab — four-pill layout (installed / enabled at boot /
  // loaded / running) + state-aware action buttons (Install / Reinstall
  // / Enable / Disable / Remove). Sourced from `nvpn service status
  // --json`. Pills don't go red — that's reserved for the binary-
  // missing case, which the parent panel's Status tab handles.
  //
  // Danger zone lives here too (full uninstall of nvpn binary + unit).
  function renderServiceBody() {
    const svc = lastService;
    if (!svc) return '<div class="vpn-empty muted">loading…</div>';
    if (!svc.supported) {
      return `<div class="vpn-section vpn-empty muted">
        System service not supported on this platform${
          svc.binaryVersion ? ` · binary v${escapeHtml(svc.binaryVersion)}` : ''
        }.
        ${renderDangerZone()}
      </div>`;
    }
    const meta = [];
    if (svc.binaryPath)    meta.push(`bin: <code>${escapeHtml(svc.binaryPath)}</code>`);
    if (svc.binaryVersion) meta.push(`v${escapeHtml(svc.binaryVersion)}`);
    if (svc.label)         meta.push(`unit: <code>${escapeHtml(svc.label)}</code>`);
    if (svc.error)         meta.push(`<span class="muted">${escapeHtml(svc.error)}</span>`);
    if (!svc.installed) {
      return `
        <div class="vpn-section">
          <div class="vpn-meta-row vpn-meta-subrow vpn-meta-svc-head">
            <div>
              <div class="vpn-empty-title">Not registered with systemd</div>
              <div class="vpn-empty-detail muted">
                Daemon is running in standalone mode — fine for use, but
                won't auto-start at boot. Install the system unit to wire
                it up.
              </div>
            </div>
            <span class="vpn-meta-svc-actions">
              <button id="vpn-svc-install" class="primary">Install service</button>
            </span>
          </div>
          ${meta.length > 0
            ? `<div class="vpn-kv-row" style="margin-top:14px">
                <span class="vpn-kv-key">binary</span>
                <span class="vpn-kv-val">${meta.join(' · ')}</span>
              </div>`
            : ''}
        </div>
        ${renderDangerZone()}`;
    }
    const pill = (label, on, dim = false) => {
      const cls = on ? 'ok' : (dim ? 'muted' : 'warn');
      return `<span class="vpn-svc-pill vpn-svc-pill-${cls}">${on ? '✓' : '✗'} ${escapeHtml(label)}</span>`;
    };
    const enabledAtBoot = svc.installed && !svc.disabled;
    const pills = [
      pill('installed',       svc.installed),
      pill('enabled at boot', enabledAtBoot, !svc.installed),
      pill('loaded',          svc.loaded,    !svc.installed),
      pill('running',         svc.running,   !svc.installed),
    ].join('');
    const actions = [];
    if (svc.disabled) {
      actions.push('<button id="vpn-svc-enable" class="primary">Enable boot</button>');
    } else {
      actions.push('<button id="vpn-svc-disable">Disable boot</button>');
    }
    actions.push('<button id="vpn-svc-reinstall">Reinstall</button>');
    actions.push('<button id="vpn-svc-uninstall" class="danger">Remove service</button>');
    return `
      <div class="vpn-section">
        <div class="vpn-svc-pills" style="margin-bottom:12px">${pills}</div>
        ${meta.length > 0
          ? `<div class="vpn-kv-row">
              <span class="vpn-kv-key">unit</span>
              <span class="vpn-kv-val">${meta.join(' · ')}</span>
            </div>`
          : ''}
        <div class="vpn-meta-svc-actions" style="margin-top:14px">${actions.join('')}</div>
      </div>
      ${renderDangerZone()}`;
  }
  renderServiceBody.wire = () => {
    // Lifecycle buttons — each calls the corresponding /api/nvpn/
    // service/* endpoint and re-renders the panel on success.
    const wireSvcBtn = (id, endpoint, label, method = 'POST') => {
      const btn = bodyEl.querySelector(`#${id}`);
      if (!btn) return;
      btn.addEventListener('click', async (e) => {
        e.preventDefault(); btn.disabled = true;
        try {
          const r = await api(endpoint, { method });
          toast(`${label}`, r?.detail || '', r?.ok === false ? 'err' : 'ok');
          await refresh();
          refreshHealth();
        } catch { /* api() already toasted */ }
        btn.disabled = false;
      });
    };
    wireSvcBtn('vpn-svc-install',   '/api/nvpn/service/install',   'service installed');
    wireSvcBtn('vpn-svc-enable',    '/api/nvpn/service/enable',    'auto-start enabled');
    wireSvcBtn('vpn-svc-disable',   '/api/nvpn/service/disable',   'auto-start disabled');
    wireSvcBtn('vpn-svc-reinstall', '/api/nvpn/service/install',   'service reinstalled');
    wireSvcBtn('vpn-svc-uninstall', '/api/nvpn/service/uninstall', 'service unit removed');

    // Danger zone — Uninstall nvpn entirely. Type-to-confirm so a
    // stray click can't wipe a working install. Sequence: stop daemon
    // → uninstall service unit → uninstall-cli (removes binary).
    const uninstallBtn = bodyEl.querySelector('#vpn-uninstall-all');
    if (uninstallBtn) {
      uninstallBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        const ok = await confirmDestructive({
          title:        'Uninstall nostr-vpn?',
          description:  'This stops the daemon, removes the system service unit, and deletes the nvpn binary from PATH. Your network config + keypair stay in ~/.config/nvpn/ until you delete them manually.',
          typeToConfirm: 'uninstall',
          confirmLabel: 'Uninstall',
        });
        if (!ok) return;
        uninstallBtn.disabled = true;
        try {
          await api('/api/nvpn/stop', { method: 'POST' }).catch(() => null);
          await api('/api/nvpn/service/uninstall', { method: 'POST' }).catch(() => null);
          const r = await api('/api/nvpn/cli/uninstall', { method: 'POST' });
          toast('nvpn uninstalled', r?.detail || '', 'ok');
          refreshHealth();
          [3_000, 10_000].forEach(ms => setTimeout(refreshHealth, ms));
        } catch { /* api() already toasted */ }
        uninstallBtn.disabled = false;
        await refresh();
      });
    }
  };

  function renderDangerZone() {
    return `<div class="vpn-meta-danger" style="margin-top:18px">
      <details>
        <summary>Danger zone</summary>
        <div class="vpn-meta-danger-body">
          <p class="muted">Stops the daemon, removes the system service unit, and deletes the
            <code>nvpn</code> binary from PATH. Network config + keypair stay in
            <code>~/.config/nvpn/</code> until you delete them manually.</p>
          <button id="vpn-uninstall-all" class="danger">Uninstall nvpn entirely</button>
        </div>
      </details>
    </div>`;
  }

  // Diagnostics sub-tab — netcheck / doctor / repair-network / stats /
  // reload / save-bundle. Run-on-click only — these calls make network
  // round-trips against public relays / STUN servers, so we never
  // auto-poll.
  //
  // `nvpn nat-discover` deliberately does NOT have a button here. It's
  // a power-user diagnostic that requires the user to supply a
  // reflector host:port; nvpn's daemon already runs NAT discovery
  // automatically against the configured stun_servers list. The
  // /api/nvpn/nat-discover route remains for advanced curl callers.
  function renderDiagnosticsBody() {
    return `
      <div class="vpn-section">
        <p class="vpn-section-help">
          Run-on-click diagnostics. Output prints below.
        </p>
        <div class="vpn-meta-diag-actions">
          <button id="vpn-diag-netcheck">Run netcheck</button>
          <button id="vpn-diag-doctor">Run doctor</button>
          <button id="vpn-diag-doctor-bundle">Save support bundle</button>
          <button id="vpn-diag-stats">Show stats</button>
          <button id="vpn-diag-reload">Reload config</button>
          <button id="vpn-diag-repair">Repair network</button>
          <button id="vpn-diag-reachability" class="primary">Test reachability</button>
        </div>
        <div id="vpn-diag-out" class="vpn-meta-diag-out muted">click an action to run it</div>
      </div>`;
  }
  renderDiagnosticsBody.wire = () => {
    const diagOut = bodyEl.querySelector('#vpn-diag-out');
    const setDiagOut = (text, level = 'info') => {
      if (!diagOut) return;
      diagOut.textContent = text;
      diagOut.className = `vpn-meta-diag-out ${level === 'err' ? 'vpn-meta-diag-out-err'
                                              : level === 'ok'  ? 'vpn-meta-diag-out-ok'
                                              : 'muted'}`;
    };
    const runDiag = async (label, fetcher) => {
      setDiagOut(`${label}…`);
      try {
        const r = await fetcher();
        if (r?.ok === false) {
          setDiagOut(`${label} failed: ${r?.detail || 'unknown error'}`, 'err');
        } else {
          const body = r?.raw
            ? JSON.stringify(r.raw, null, 2)
            : (r?.output || r?.detail || 'ok');
          setDiagOut(body, 'ok');
        }
      } catch { setDiagOut(`${label} failed (network error)`, 'err'); }
    };
    const ncBtn = bodyEl.querySelector('#vpn-diag-netcheck');
    if (ncBtn) ncBtn.addEventListener('click', (e) => { e.preventDefault(); runDiag('netcheck', () => api('/api/nvpn/netcheck')); });
    const docBtn = bodyEl.querySelector('#vpn-diag-doctor');
    if (docBtn) docBtn.addEventListener('click', (e) => {
      e.preventDefault();
      runDiag('doctor', () => api('/api/nvpn/doctor', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
    });
    const bundleBtn = bodyEl.querySelector('#vpn-diag-doctor-bundle');
    if (bundleBtn) bundleBtn.addEventListener('click', async (e) => {
      e.preventDefault(); bundleBtn.disabled = true;
      setDiagOut('writing support bundle…');
      try {
        const r = await api('/api/nvpn/doctor', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ bundle: true }),
        });
        if (r?.ok && r?.bundlePath) {
          setDiagOut(`bundle written to ${r.bundlePath}`, 'ok');
          toast('support bundle saved', r.bundlePath, 'ok');
        } else {
          setDiagOut(`bundle failed: ${r?.detail || 'unknown'}`, 'err');
        }
      } catch { setDiagOut('bundle failed (network error)', 'err'); }
      bundleBtn.disabled = false;
    });
    const statsBtn = bodyEl.querySelector('#vpn-diag-stats');
    if (statsBtn) statsBtn.addEventListener('click', (e) => { e.preventDefault(); runDiag('stats', () => api('/api/nvpn/stats')); });
    const reloadBtn = bodyEl.querySelector('#vpn-diag-reload');
    if (reloadBtn) reloadBtn.addEventListener('click', async (e) => {
      e.preventDefault(); reloadBtn.disabled = true;
      try {
        const r = await api('/api/nvpn/reload', { method: 'POST' });
        toast('config reloaded', r?.detail || '', r?.ok === false ? 'err' : 'ok');
      } catch { /* api() already toasted */ }
      reloadBtn.disabled = false;
    });
    const repairBtn = bodyEl.querySelector('#vpn-diag-repair');
    if (repairBtn) repairBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      const ok = await confirmDestructive({
        title: 'Repair network?',
        description: 'Resets routes/iface state left behind by a stopped or crashed session. Safe on an idle daemon; brief connectivity blip if running.',
        confirmLabel: 'Repair',
      });
      if (!ok) return;
      repairBtn.disabled = true;
      try {
        const r = await api('/api/nvpn/repair-network', { method: 'POST' });
        toast('repair network', r?.detail || '', r?.ok === false ? 'err' : 'ok');
      } catch { /* api() already toasted */ }
      repairBtn.disabled = false;
    });
    const reachBtn = bodyEl.querySelector('#vpn-diag-reachability');
    if (reachBtn) reachBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      reachBtn.disabled = true;
      try {
        const recipe = await api('/api/nvpn/reachability-recipe', undefined, { silent: true });
        openReachabilityModal(recipe);
      } catch { toast('reachability test', 'could not fetch endpoint info', 'err'); }
      reachBtn.disabled = false;
    });
  };

  // Reachability test modal (issue #59, v0). No hosted probe service yet
  // — the modal walks the user through running `nc -u` from an external
  // network and `tcpdump` on the host, with both commands pre-filled
  // and copy-button next to each. When the daemon's discovered endpoint
  // is missing (STUN didn't land), we say so instead of showing broken
  // commands.
  function openReachabilityModal(recipe) {
    const body = document.createElement('div');
    if (!recipe || !recipe.endpoint) {
      body.innerHTML = `
        <p>No public endpoint discovered yet.</p>
        <p class="muted">nvpn typically learns its public endpoint via STUN within the first 30 seconds of running. If the endpoint never appears, STUN probably can't reach a public server from your network. Check that the daemon is running and that outbound UDP isn't blocked.</p>
      `;
      openModal({ title: 'Test reachability', subtitle: 'No endpoint to test yet', body });
      return;
    }
    const probe = recipe.probeCommand;
    const verify = recipe.hostVerifyCommand;
    const steps = (recipe.instructions || []).map((s, i) => `<li>${escapeHtml(s)}</li>`).join('');
    body.innerHTML = `
      <p>Discovered public endpoint:</p>
      <div class="reach-row">
        <code class="cmd-inline">${escapeHtml(recipe.endpoint)}</code>
        <span class="reach-copy" data-copy="${escapeHtml(recipe.endpoint)}"></span>
      </div>
      <p style="margin-top:14px">Verify packets arrive at the host (run on this machine, leave running):</p>
      <div class="reach-row">
        <code class="cmd-inline reach-cmd">${escapeHtml(verify)}</code>
        <span class="reach-copy" data-copy="${escapeHtml(verify)}"></span>
      </div>
      <p style="margin-top:14px">Probe from outside (run on a phone on cell data, a cloud shell, etc.):</p>
      <div class="reach-row">
        <code class="cmd-inline reach-cmd">${escapeHtml(probe)}</code>
        <span class="reach-copy" data-copy="${escapeHtml(probe)}"></span>
      </div>
      <ol class="reach-steps">${steps}</ol>
    `;
    openModal({
      title: 'Test reachability',
      subtitle: 'Confirm peers can actually dial your endpoint',
      body,
    });
    body.querySelectorAll('.reach-copy').forEach((slot) => {
      const text = slot.getAttribute('data-copy') || '';
      slot.appendChild(copyBtn(text));
    });
  }

  // ── Shared helpers used across sub-tab renderers ────────────────────
  //
  // These used to live inside LogsPanel when the rich nvpn UI rendered
  // in the Logs > nostr-vpn tab. The lifecycle controls + peers +
  // settings + service moved here, so the helpers come with them.
  // `refresh()` (defined above) replaces what was `loadVpnDetail()`.

  // Normalize peer-list shape across upstream nvpn revisions. We've seen:
  //   array of {pubkey,ip,connected,latency_ms,last_seen}
  //   array of {npub,address,online,rtt_ms,seen}
  //   object map keyed by pubkey
  // Project to one shape the renderer can rely on.
  function normalizeNvpnPeers(peers) {
    if (!peers) return [];
    const arr = Array.isArray(peers) ? peers : Object.values(peers);
    const out = [];
    for (const p of arr) {
      if (!p || typeof p !== 'object') continue;
      out.push({
        npub:      typeof p.npub === 'string' ? p.npub : null,
        pubkey:    typeof p.pubkey === 'string' ? p.pubkey : null,
        ip:        typeof p.ip === 'string' ? p.ip
                 : typeof p.address === 'string' ? p.address
                 : typeof p.tunnel_ip === 'string' ? p.tunnel_ip
                 : null,
        connected: !!(p.connected ?? p.online ?? p.up),
        latencyMs: typeof p.latency_ms === 'number' ? p.latency_ms
                 : typeof p.rtt_ms === 'number'     ? p.rtt_ms
                 : null,
        lastSeen:  typeof p.last_seen === 'string' ? p.last_seen
                 : typeof p.seen === 'string'      ? p.seen
                 : null,
        // Extra fields for peer-state classification (#60). Captured
        // permissively so we can fall back to the old behaviour when
        // the upstream nvpn schema doesn't include them.
        reachable:        typeof p.reachable === 'boolean' ? p.reachable : null,
        lastSignalSeenAt: typeof p.last_signal_seen_at === 'string' ? p.last_signal_seen_at
                        : typeof p.last_signal_at === 'string'      ? p.last_signal_at
                        : null,
        lastHandshakeAt:  typeof p.last_handshake_at === 'string' ? p.last_handshake_at
                        : typeof p.last_handshake === 'string'    ? p.last_handshake
                        : null,
        error:            typeof p.error === 'string' ? p.error : null,
      });
    }
    return out;
  }

  // Peer-state classifier (#60). Differentiates "offline" into a small
  // set of states with distinct meanings so the user can tell why a
  // peer isn't connected. Returns one of:
  //   online       — handshake complete, recent presence
  //   reachable    — presence received recently, no active handshake yet
  //   stale        — last presence > 5 min ago
  //   unreachable  — daemon tried and failed (peers[i].reachable === false)
  //   never_seen   — in roster but no presence ever observed
  //   discovered   — live but not in roster (mid-publish race)
  // Pure(-ish) — `now` is injected for tests; defaults to Date.now().
  function classifyPeerState(p, now) {
    const nowMs = typeof now === 'number' ? now : Date.now();
    if (!p.roster) return 'discovered';
    if (p.connected) return 'online';
    const live = p.live;
    if (!live) return 'never_seen';
    if (live.reachable === false) return 'unreachable';
    const lastSeenMs = live.lastSignalSeenAt
      ? Date.parse(live.lastSignalSeenAt)
      : (live.lastSeen ? Date.parse(live.lastSeen) : NaN);
    if (Number.isFinite(lastSeenMs)) {
      const age = nowMs - lastSeenMs;
      if (age < 60_000)    return 'reachable';
      if (age < 5 * 60_000) return 'reachable';
      return 'stale';
    }
    if (live.error && /no signal yet/i.test(live.error)) return 'never_seen';
    if (live.error) return 'reachable';
    return 'never_seen';
  }

  function peerStateUi(state, p) {
    switch (state) {
      case 'online':      return { dot: 'ok',   label: '' };
      case 'discovered':  return { dot: 'warn', label: 'discovered (not in roster)' };
      case 'reachable':   return { dot: 'ok',   label: 'reachable, no handshake' };
      case 'unreachable': return { dot: 'err',  label: 'unreachable' };
      case 'stale': {
        const lastSeenMs = p.live && (p.live.lastSignalSeenAt
          ? Date.parse(p.live.lastSignalSeenAt)
          : (p.live.lastSeen ? Date.parse(p.live.lastSeen) : NaN));
        if (!Number.isFinite(lastSeenMs)) return { dot: 'warn', label: 'stale' };
        const min = Math.round((Date.now() - lastSeenMs) / 60000);
        return { dot: 'warn', label: `stale (${min}m)` };
      }
      case 'never_seen':  return { dot: 'warn', label: 'never seen' };
      default:            return { dot: 'warn', label: 'offline' };
    }
  }

  // Roster + live peers rarely match exactly (live peers may show
  // before the roster updates locally; offline roster entries never
  // appear in live). Merge keys on hex pubkey or npub equivalence so
  // the row count matches the user's mental model: "the people in my
  // network."
  function mergePeers(rosterParts, rosterAdmins, livePeers, aliases = {}) {
    const adminSet = new Set(rosterAdmins.map(s => String(s).toLowerCase()));
    const aliasLookup = new Map();
    for (const [k, v] of Object.entries(aliases)) {
      if (typeof k === 'string' && typeof v === 'string') {
        aliasLookup.set(k.toLowerCase(), { aliasKey: k, alias: v });
      }
    }
    const liveByKey = new Map();
    for (const lp of livePeers) {
      const k = (lp.npub || lp.pubkey || lp.ip || '').toLowerCase();
      if (k) liveByKey.set(k, lp);
    }
    const out = [];
    const seen = new Set();
    for (const p of rosterParts) {
      const k = String(p).toLowerCase();
      seen.add(k);
      const live = liveByKey.get(k);
      const aliasEntry = aliasLookup.get(k);
      out.push({
        id:        p,
        rosterKey: p,
        live,
        alias:     aliasEntry?.alias || null,
        connected: !!live?.connected,
        admin:     adminSet.has(k),
        roster:    true,
      });
    }
    // Anything live but not in roster (mid-import / mid-publish race) —
    // surface so the user can see the discovery happen, but mark as
    // "discovered" so they know it's not yet in their config.
    for (const [k, live] of liveByKey) {
      if (seen.has(k)) continue;
      const aliasEntry = aliasLookup.get(k);
      out.push({
        id:        live.npub || live.pubkey || live.ip || k,
        rosterKey: null,
        live,
        alias:     aliasEntry?.alias || null,
        connected: !!live.connected,
        admin:     false,
        roster:    false,
      });
    }
    return out;
  }

  function renderPeerRow(p) {
    const id  = p.id;
    const live = p.live;
    // Classify the peer state so we can render distinct UI states
    // (never_seen / reachable / stale / unreachable / online), each
    // with its own dot color + label. See classifyPeerState above.
    const state = classifyPeerState(p);
    const ui    = peerStateUi(state, p);
    const dot   = ui.dot;
    const sub = [
      live?.ip,
      live?.latencyMs != null ? `${live.latencyMs}ms` : null,
      live?.lastSeen,
      ui.label || null,
    ].filter(Boolean).join(' · ');
    const adminBadge = p.admin ? '<span class="vpn-meta-peer-badge">admin</span>' : '';
    // Prefer the live tunnel IP for ping (works when online); fall back
    // to npub/pubkey/id (nvpn ping resolves via roster).
    const pingTarget = live?.ip || id;
    const pingBtn = pingTarget
      ? `<button data-action="ping" data-target="${escapeHtml(pingTarget)}" title="Ping ${escapeHtml(pingTarget)}">ping</button>`
      : '';
    // whois — non-mutating peer lookup. Renders into the same inline
    // output slot as ping; runs the local-only fast path
    // (--discover-secs 0) so a click is snappy.
    const whoisBtn = `<button data-action="whois" data-target="${escapeHtml(id)}" title="Whois ${escapeHtml(id)}">whois</button>`;
    const aliasBtn = p.roster
      ? `<button data-action="alias" title="${p.alias ? 'Rename peer' : 'Set alias'}">${p.alias ? 'rename' : 'alias'}</button>`
      : '';
    const promoteBtn = p.roster && !p.admin
      ? '<button data-action="promote" title="Promote to admin">↑ admin</button>' : '';
    const demoteBtn = p.roster && p.admin
      ? '<button data-action="demote" title="Demote from admin">↓ admin</button>' : '';
    const removeBtn = p.roster
      ? '<button data-action="remove" class="danger" title="Remove from roster">remove</button>' : '';
    const truncId = id.length > 20 ? `${id.slice(0, 12)}…${id.slice(-6)}` : id;
    const labelHtml = p.alias
      ? `<span class="vpn-meta-peer-alias">${escapeHtml(p.alias)}</span>
         <code class="cmd-inline vpn-meta-peer-id muted" title="${escapeHtml(id)}">${escapeHtml(truncId)}</code>`
      : `<code class="cmd-inline vpn-meta-peer-id" title="${escapeHtml(id)}">${escapeHtml(truncId)}</code>`;
    return `
      <div class="vpn-meta-peer" data-id="${escapeHtml(id)}" data-alias="${escapeHtml(p.alias || '')}">
        <span class="dot ${dot}"></span>
        ${labelHtml}
        ${adminBadge}
        ${sub ? `<span class="muted vpn-meta-peer-sub">${escapeHtml(sub)}</span>` : ''}
        <span class="vpn-meta-peer-actions">${pingBtn}${whoisBtn}${aliasBtn}${promoteBtn}${demoteBtn}${removeBtn}</span>
        <div class="vpn-meta-peer-pingout" hidden></div>
      </div>`;
  }

  // Client-side gate so we don't ship Rust-panic stack traces from the
  // binary into a toast. Mirrors the server-side validator in nvpn.ts —
  // fast, cheap, and covers the common paste paths.
  function isValidParticipant(s) {
    if (!s || typeof s !== 'string') return false;
    if (/^npub1[023456789acdefghjklmnpqrstuvwxyz]{58}$/.test(s)) return true;
    if (/^[0-9a-f]{64}$/i.test(s)) return true;
    return false;
  }

  // Per-peer kebab actions. Each shape is small; dispatch on `action`
  // here rather than three nearly identical handlers in the per-row
  // wiring.
  async function peerAction(action, id) {
    if (action === 'remove') {
      const ok = await confirmDestructive({
        title: 'Remove peer?',
        description: 'They\'ll lose mesh access until re-added. Roster will be republished.',
        confirmLabel: 'Remove',
      });
      if (!ok) return;
      const r = await api('/api/nvpn/peers/remove', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ participants: [id], publish: true }),
      });
      toast('peer removed', r?.detail || '', 'ok');
    } else if (action === 'promote') {
      const r = await api('/api/nvpn/admins/add', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ participants: [id], publish: true }),
      });
      toast('promoted to admin', r?.detail || '', 'ok');
    } else if (action === 'demote') {
      const r = await api('/api/nvpn/admins/remove', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ participants: [id], publish: true }),
      });
      toast('admin removed', r?.detail || '', 'ok');
    }
  }

  // Alias prompt — set or remove the [peer_aliases] entry for one peer.
  // Validation mirrors the server-side ALIAS_VALUE_RE so we catch bad
  // input before the round-trip. Empty save = remove.
  async function openAliasPrompt(participant, current) {
    return new Promise((resolve) => {
      const body = document.createElement('div');
      body.innerHTML = `
        <p class="muted">Local label for <code class="cmd-inline">${escapeHtml(participant)}</code>. Visible only on this station.</p>
        <input type="text" id="vpn-alias-input" maxlength="64" autocomplete="off"
               placeholder="alice / laptop / vps-frankfurt">
        <p class="muted vpn-alias-hint">Letters, digits, dash, underscore, dot, space — up to 64 chars. Leave blank and Save to remove.</p>
        <div class="vpn-invite-modal-actions">
          <button id="vpn-alias-cancel">Cancel</button>
          <button id="vpn-alias-remove" class="danger" ${current ? '' : 'hidden'}>Remove</button>
          <button id="vpn-alias-save" class="primary">Save</button>
        </div>
      `;
      const modal = openModal({ title: current ? 'Rename peer' : 'Set peer alias', body });
      modal.root.classList.add('vpn-invite-modal');
      const input = body.querySelector('#vpn-alias-input');
      input.value = current || '';
      input.focus();
      input.select();
      body.querySelector('#vpn-alias-cancel').addEventListener('click', () => { modal.close(); resolve(); });
      body.querySelector('#vpn-alias-remove')?.addEventListener('click', async () => {
        try {
          const r = await api('/api/nvpn/aliases/remove', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ participant }),
          });
          toast('alias removed', r?.detail || '', r?.ok === false ? 'err' : 'ok');
        } catch { /* api() already toasted */ }
        modal.close(); resolve();
      });
      body.querySelector('#vpn-alias-save').addEventListener('click', async () => {
        const val = String(input.value || '').trim();
        if (!val) {
          if (current) {
            try {
              await api('/api/nvpn/aliases/remove', {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ participant }),
              });
              toast('alias removed', '', 'ok');
            } catch { /* api() already toasted */ }
          }
          modal.close(); resolve(); return;
        }
        if (!/^[A-Za-z0-9 _\-.]{1,64}$/.test(val)) {
          toast('Invalid alias', 'use letters/digits/space/-_./ up to 64 chars', 'warn');
          input.focus();
          return;
        }
        try {
          const r = await api('/api/nvpn/aliases/set', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ participant, alias: val }),
          });
          toast('alias saved', r?.detail || '', r?.ok === false ? 'err' : 'ok');
        } catch { /* api() already toasted */ }
        modal.close(); resolve();
      });
    });
  }

  // create-invite returns both the nvpn://invite/<base64> string and a
  // pre-rendered SVG QR (server-side; same QR styling as the Amber
  // pairing wizard). Modal is the "Share network" UX — user shows phone,
  // peer scans, peer pastes into their own dashboard's Import.
  async function openShareInviteModal() {
    const body = document.createElement('div');
    body.innerHTML = `<div class="vpn-invite-loading muted">creating invite…</div>`;
    const modal = openModal({ title: 'Share network', subtitle: 'Anyone who imports this invite joins your mesh', body });
    modal.root.classList.add('vpn-invite-modal');
    let r;
    try { r = await api('/api/nvpn/invite/create', { method: 'POST' }); }
    catch { modal.close(); return; }
    if (!r?.ok || !r.invite) {
      body.innerHTML = `<div class="vpn-invite-err">${escapeHtml(r?.detail || 'create-invite failed')}</div>`;
      return;
    }
    body.innerHTML = `
      <div class="vpn-invite-qr"></div>
      <div class="vpn-invite-uri-label muted">Or paste this link into the nvpn app:</div>
      <div class="vpn-invite-uri">
        <code class="cmd-inline">${escapeHtml(r.invite)}</code>
        <span class="vpn-invite-copy"></span>
      </div>
      <div class="muted vpn-invite-hint">
        ${r.networkId ? `Network <code class="cmd-inline">${escapeHtml(r.networkId)}</code> · ` : ''}
        Scan the QR with the nvpn mobile app, or copy the link above and paste into <strong>Import invite</strong>. If QR scanning doesn't seem to do anything, the paste path is the reliable fallback.
      </div>
    `;
    const qrSlot = body.querySelector('.vpn-invite-qr');
    if (r.qrSvg) qrSlot.innerHTML = r.qrSvg;
    body.querySelector('.vpn-invite-copy').appendChild(copyBtn(r.invite));
  }

  async function openImportInviteModal() {
    const body = document.createElement('div');
    body.innerHTML = `
      <p class="muted">Paste an <code>nvpn://invite/…</code> code from another node to join their network.</p>
      <textarea id="vpn-import-invite-input" placeholder="nvpn://invite/…" spellcheck="false" rows="3"></textarea>
      <div class="vpn-invite-modal-actions">
        <button id="vpn-import-invite-cancel">Cancel</button>
        <button id="vpn-import-invite-submit" class="primary">Import</button>
      </div>
    `;
    const modal = openModal({ title: 'Import invite', subtitle: 'Joins the network in your local config', body });
    modal.root.classList.add('vpn-invite-modal');
    const input = body.querySelector('#vpn-import-invite-input');
    input?.focus();
    body.querySelector('#vpn-import-invite-cancel').addEventListener('click', (e) => { e.preventDefault(); modal.close(); });
    body.querySelector('#vpn-import-invite-submit').addEventListener('click', async (e) => {
      e.preventDefault();
      const v = String(input.value || '').trim();
      if (!v) { input.focus(); return; }
      const submit = e.currentTarget;
      submit.disabled = true;
      try {
        const r = await api('/api/nvpn/invite/import', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ invite: v }),
        });
        toast('invite imported', r?.detail || '', 'ok');
        modal.close();
        await refresh();
      } catch { /* api() already toasted */ }
      submit.disabled = false;
    });
  }

  return {
    onEnter() { void refresh(); },
  };
})();

// ── Panel: Config ────────────────────────────────────────────────────────

const ConfigPanel = (() => {
  const container = $('config-sections');

  // The Config panel reload is heavy: 8 parallel fetches, full innerHTML
  // rebuild, plus follower-stat sockets. When the user isn't looking at it,
  // we don't need to do that work — the next onEnter() will pick up fresh
  // data. Background callers (e.g. the ngit-login retry schedule that polls
  // for ~2min after launching the QR scan) call loadIfVisible() and the
  // panel reloads only when the user is actually on it. Otherwise we set
  // dirty so the next onEnter() refreshes instead of serving stale state.
  let dirty = false;
  function loadIfVisible() {
    if (currentPanel() === 'config') return load();
    dirty = true;
    return Promise.resolve();
  }

  async function load() {
    dirty = false;
    container.innerHTML = '<div class="config-section"><div style="color:var(--muted)">loading…</div></div>';
    try {
      // Session fetch is best-effort: the localhost-exemption path has no
      // backing session, and we still want the rest of the panel to render.
      // Most of these are also fetched by the header chip and the dashboard
      // cards. apiCached() coalesces concurrent calls and serves repeats
      // within the TTL, which collapses what used to be 3-4 duplicate
      // round-trips per panel switch into one. Mutators dispatch
      // 'api-config-changed', which clears the cache (see listener below).
      const [rc, cfg, ident, session, profile, ngitAccount, aiList, gitIdent, statusRows] = await Promise.all([
        apiCached('/api/relay-config', 30_000),
        // scope=global so the Context row reflects the station setup
        // regardless of which project is currently open in chat. The
        // chat header still uses the default scope (active project).
        apiCached('/api/config?scope=global', 30_000),
        apiCached('/api/identity/config', 30_000),
        apiCached('/api/auth/session', 30_000).catch(() => null),
        apiCached('/api/identity/profile', 30_000).catch(() => null),
        apiCached('/api/ngit/account', 30_000).catch(() => ({ loggedIn: false, relays: [] })),
        // /api/ai/providers returns the registry + per-provider state.
        // Pre-4.x servers won't have this endpoint; a catch keeps the
        // panel renderable against a stale backend (providers list hides).
        apiCached('/api/ai/providers', 30_000).catch(() => null),
        // Global git identity + presets. Lets the new Git Identity
        // config section render the user's current values + offer
        // npub-synthetic / nip-05 presets without a second round-trip.
        apiCached('/api/git-identity/global', 30_000).catch(() => null),
        // /api/status drives the install-hint visibility in the AI
        // section: rows hide once the binary lights up green so the
        // callout doesn't keep nagging users who already installed.
        apiCached('/api/status', 30_000).catch(() => null),
      ]);
      // Augment presets with the nip-05 from the cached profile if
      // we have one. The backend stays focused on git config; the
      // nip-05 lookup lives on the client where the profile fetch
      // already happens.
      if (gitIdent && profile?.nip05 && profile?.name) {
        gitIdent.presets = gitIdent.presets || {};
        gitIdent.presets.nip05 = {
          name:  profile.name,
          email: profile.nip05,
        };
      } else if (gitIdent && profile?.nip05) {
        gitIdent.presets = gitIdent.presets || {};
        gitIdent.presets.nip05 = {
          // Fall back to nip-05 localpart as the display name when
          // kind-0 metadata didn't carry a separate `name` field.
          name:  (profile.nip05.split('@')[0] || 'nostr-station user'),
          email: profile.nip05,
        };
      }
      render(rc, cfg, ident, session, profile, ngitAccount, aiList, gitIdent, statusRows);
    } catch (e) {
      container.innerHTML = `<div class="config-section"><div style="color:var(--error)">failed to load: ${escapeHtml(e.message)}</div></div>`;
    }
  }

  function row(k, v, cls = '') {
    return `<div class="config-row"><div class="k">${escapeHtml(k)}</div><div class="v ${cls}">${escapeHtml(v)}</div></div>`;
  }

  // ── Station-context editor ──────────────────────────────────────────
  // Modal backed by GET/PUT /api/station-context. The whole file content
  // is editable; the server-side chat path splices only the user-region
  // (between USER_REGION_BEGIN/END) so the persona text above the
  // markers stays as documentation without duplicating into prompts.
  async function openStationContextEditor() {
    let initial;
    try { initial = await api('/api/station-context'); }
    catch { return; }

    const body = document.createElement('div');
    body.innerHTML = `
      <div style="font-size:11px;color:var(--text-dim);margin-bottom:6px">
        File: <code>${escapeHtml(initial.path)}</code>
        ${initial.hasMarkers
          ? '· Splice mode: user-region only'
          : '· Splice mode: whole file (markers absent)'}
      </div>
      <textarea id="station-edit-textarea" spellcheck="false"
        style="width:100%;min-height:380px;font-family:var(--font-mono,monospace);font-size:12px;padding:8px;background:var(--bg-elev);color:var(--text);border:1px solid var(--border);border-radius:4px"
      >${escapeHtml(initial.content || '')}</textarea>
      <div style="font-size:11px;color:var(--text-dim);margin-top:6px">
        Tip: edits between
        <code>${escapeHtml(initial.userRegionBegin)}</code> and
        <code>${escapeHtml(initial.userRegionEnd)}</code>
        are what the model sees. Text outside the markers serves as on-disk reference and is not sent to chat.
      </div>
    `;
    const foot = document.createElement('div');
    foot.style.display = 'flex'; foot.style.gap = '8px';
    const cancel = document.createElement('button'); cancel.textContent = 'Cancel';
    const save   = document.createElement('button'); save.textContent = 'Save';
    save.classList.add('primary');
    foot.appendChild(cancel); foot.appendChild(save);

    const modal = openModal({
      title: 'Edit station context',
      subtitle: 'Always-on notes that layer into every chat turn',
      body,
      footer: foot,
    });
    const ta = body.querySelector('#station-edit-textarea');
    cancel.addEventListener('click', () => modal.close());
    save.addEventListener('click', async () => {
      save.disabled = true;
      try {
        await api('/api/station-context', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content: ta.value }),
        });
        toast('Station context saved', `${ta.value.length} chars`, 'ok');
        modal.close();
        // Refresh the panel + chat header so the "Context" row reflects
        // the new state (e.g. station context now non-empty).
        load();
        refreshHeader();
      } catch {
        save.disabled = false;
      }
    });
  }

  // ── Rendered-prompt preview ─────────────────────────────────────────
  // Shows the exact text /api/ai/chat will use as the system prompt for
  // the next turn. Project dropdown defaults to "Station only" so the
  // Config panel's primary view is the global state.
  async function openPromptPreview() {
    let projects = [];
    try {
      const r = await api('/api/projects');
      // /api/projects returns a bare array of project records.
      projects = Array.isArray(r) ? r : (Array.isArray(r?.projects) ? r.projects : []);
    } catch { /* projects list is optional */ }

    const body = document.createElement('div');
    const projectOptions = projects
      .map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`)
      .join('');
    body.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
        <label for="preview-project" style="font-size:11px;color:var(--text-dim)">View as:</label>
        <select id="preview-project">
          <option value="">Station only (no project)</option>
          ${projectOptions}
        </select>
        <span id="preview-meta" style="font-size:11px;color:var(--text-dim);margin-left:auto"></span>
      </div>
      <pre id="preview-output"
        style="max-height:60vh;overflow:auto;background:var(--bg-elev);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:10px;white-space:pre-wrap;font-size:12px;margin:0"
      >loading…</pre>
    `;
    const foot = document.createElement('div');
    foot.style.display = 'flex'; foot.style.gap = '8px';
    const closeBtn = document.createElement('button'); closeBtn.textContent = 'Close';
    foot.appendChild(closeBtn);

    const modal = openModal({
      title: 'Rendered system prompt',
      subtitle: 'Exactly what the next chat turn will send to the model',
      body,
      footer: foot,
    });
    closeBtn.addEventListener('click', () => modal.close());

    const sel  = body.querySelector('#preview-project');
    const out  = body.querySelector('#preview-output');
    const meta = body.querySelector('#preview-meta');
    async function refresh() {
      out.textContent = 'loading…';
      meta.textContent = '';
      const qs = sel.value ? `?projectId=${encodeURIComponent(sel.value)}` : '';
      try {
        const r = await api(`/api/ai/preview${qs}`);
        out.textContent = r.text || '(empty)';
        const bits = [];
        bits.push(`source: ${r.source}`);
        if (r.projectName) bits.push(`project: ${r.projectName}`);
        bits.push(`${r.bytes} bytes`);
        if (r.model?.fullId) bits.push(r.model.fullId);
        meta.textContent = bits.join(' · ');
      } catch (e) {
        out.textContent = `failed to load preview: ${e?.message || e}`;
      }
    }
    sel.addEventListener('change', refresh);
    refresh();
  }

  // Identity section echoes who the dashboard is signed in as. The server
  // already enforces that session.npub === configured station owner npub,
  // so ident.npub is also the authenticated identity — we surface profile
  // name + nip05 when available and session expiry alongside.
  function renderIdentityBody(ident, session, profile) {
    if (!ident.npub) {
      return `<div class="body" style="font-size:12px;color:var(--warn)">
        No npub configured — click the identity chip in the header to set up.
      </div>`;
    }

    const displayName = profile && profile.name ? profile.name : truncNpub(ident.npub);
    const nip05Html   = profile && profile.nip05
      ? `<div style="font-size:11px;color:${profile.nip05Verified ? 'var(--success)' : 'var(--text-dim)'}">
          ${escapeHtml(profile.nip05)}${profile.nip05Verified ? ' ✓ verified' : ' (unverified)'}
        </div>`
      : '';
    const avatarHtml = profile && profile.picture
      ? `<img src="${escapeHtml(profile.picture)}" style="width:56px;height:56px;border-radius:50%;object-fit:cover" alt="">`
      : pixelAvatar(ident.npub, 56);

    const sessionLine = session
      ? `<span style="color:var(--success)">● signed in</span>
         <span style="color:var(--text-dim);margin-left:8px">expires ${escapeHtml(fmtExpiry(session.expiresAt))}</span>`
      : `<span style="color:var(--text-dim)">no active session (localhost exemption)</span>`;

    // Bio (kind-0 `about`) rendered full-width below the name block when set.
    // Preserve line breaks so multi-paragraph bios read naturally.
    const bioHtml = profile && profile.about
      ? `<div class="cfg-profile-bio">${escapeHtml(profile.about)}</div>`
      : '';

    // Stats slot — filled asynchronously by fetchProfileStats() against the
    // user's read-relays. Hidden when we don't have a hex pubkey to query.
    const statsSlot = profile && profile.hex
      ? `<div class="config-row">
          <div class="k">Stats</div>
          <div class="v cfg-profile-stats" id="cfg-profile-stats">
            <span class="muted">loading…</span>
          </div>
        </div>`
      : '';

    return `
      <div class="body cfg-profile-body" style="font-size:12px">
        <div class="cfg-profile-head">
          <div class="cfg-profile-avatar">${avatarHtml}</div>
          <div class="cfg-profile-namecol">
            <div class="cfg-profile-name">${escapeHtml(displayName)}</div>
            ${nip05Html}
            <div class="cfg-profile-role">
              Station owner · signed in via Amber
            </div>
          </div>
        </div>
        ${bioHtml}
        ${statsSlot}
        <div class="config-row">
          <div class="k">npub</div>
          <div class="v" id="cfg-identity-npub" style="display:flex;align-items:center;gap:6px">
            <span style="font-family:var(--font-mono);color:var(--text-bright);word-break:break-all">${escapeHtml(ident.npub)}</span>
          </div>
        </div>
        <div class="config-row">
          <div class="k">Session</div>
          <div class="v" style="font-size:11px">${sessionLine}</div>
        </div>
      </div>
    `;
  }

  // ── Profile stats (followers / following) ─────────────────────────────
  //
  // Client-side queries against the user's read-relays via raw WebSocket.
  // Tries NIP-45 COUNT first (fast, no event download); for the "following"
  // figure we also fetch the user's own kind-3 and count p-tags as a
  // fallback when COUNT isn't supported by any relay. Each relay gets a
  // short budget so a slow relay can't stall the section.
  //
  // Module-level cache keyed by (hex, relay set) coalesces calls from the
  // dashboard Identity card and the Config Profile section so they don't
  // independently open 5 sockets each whenever either panel is opened.
  // 5-min TTL matches the previous StatusPanel-local cache.
  const PROFILE_STATS_TTL_MS = 5 * 60 * 1000;
  const _profileStatsCache = new Map(); // key -> { value, at }
  const _profileStatsInflight = new Map(); // key -> Promise
  function fetchProfileStats(hex, relays) {
    if (!hex || !Array.isArray(relays) || relays.length === 0) {
      return Promise.resolve({ followers: null, following: null });
    }
    const key = hex + '|' + [...relays].sort().join(',');
    const hit = _profileStatsCache.get(key);
    if (hit && (Date.now() - hit.at) < PROFILE_STATS_TTL_MS) {
      return Promise.resolve(hit.value);
    }
    const inflight = _profileStatsInflight.get(key);
    if (inflight) return inflight;
    const p = Promise.all([
      queryCount(relays, { kinds: [3], '#p': [hex] }),
      queryFollowingCount(relays, hex),
    ]).then(([followers, following]) => {
      const value = { followers, following };
      _profileStatsCache.set(key, { value, at: Date.now() });
      _profileStatsInflight.delete(key);
      return value;
    }).catch(e => {
      _profileStatsInflight.delete(key);
      throw e;
    });
    _profileStatsInflight.set(key, p);
    return p;
  }

  // NIP-45 COUNT across multiple relays. Returns the max non-null count
  // (different relays see different slices of the network — the largest
  // is the best approximation for "global"). null if no relay answered.
  // Resolves early once the first relay has answered + a short coalescing
  // window has passed, instead of waiting for every relay's per-socket
  // budget — the previous Promise.all + 5s timeout meant a single slow
  // relay would freeze the whole stats render for 5s.
  function queryCount(relays, filter) {
    const PER_RELAY_MS = 2500;
    const COALESCE_AFTER_FIRST_MS = 400;
    return new Promise((outerResolve) => {
      const results = [];
      let firstAt = 0;
      let coalesceTimer = 0;
      let outerSettled = false;
      const settleOuter = () => {
        if (outerSettled) return;
        outerSettled = true;
        clearTimeout(hardTimer);
        if (coalesceTimer) clearTimeout(coalesceTimer);
        const nums = results.filter(n => typeof n === 'number');
        outerResolve(nums.length ? Math.max(...nums) : null);
      };
      // Hard cap so the outer Promise always resolves even if every relay
      // accepts the WS but never responds to COUNT.
      const hardTimer = setTimeout(settleOuter, PER_RELAY_MS);
      let pendingRelays = relays.length;
      relays.forEach(url => {
        let ws;
        try { ws = new WebSocket(url); }
        catch { onRelayDone(null); return; }
        const subId = 'cnt-' + Math.random().toString(36).slice(2, 8);
        let settled = false;
        const finish = (val) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try { ws.close(); } catch {}
          onRelayDone(val);
        };
        const timer = setTimeout(() => finish(null), PER_RELAY_MS);
        ws.addEventListener('open', () => {
          try { ws.send(JSON.stringify(['COUNT', subId, filter])); }
          catch { finish(null); }
        });
        ws.addEventListener('message', (e) => {
          try {
            const data = typeof e.data === 'string' ? e.data : e.data.toString();
            const msg  = JSON.parse(data);
            if (Array.isArray(msg) && msg[0] === 'COUNT' && msg[1] === subId) {
              const c = Number(msg[2]?.count);
              finish(Number.isFinite(c) ? c : null);
            } else if (Array.isArray(msg) && (msg[0] === 'CLOSED' || msg[0] === 'NOTICE')) {
              // Relay rejected the verb — fall through to timeout/close.
              finish(null);
            }
          } catch {}
        });
        ws.addEventListener('error', () => finish(null));
        ws.addEventListener('close', () => finish(null));
      });

      function onRelayDone(val) {
        results.push(val);
        pendingRelays--;
        if (pendingRelays <= 0) { settleOuter(); return; }
        // First non-null result starts a short coalescing window so a
        // second-fastest relay with a slightly larger figure still gets
        // a chance, but we don't wait for stragglers.
        if (typeof val === 'number' && !firstAt) {
          firstAt = Date.now();
          coalesceTimer = setTimeout(settleOuter, COALESCE_AFTER_FIRST_MS);
        }
      }
    });
  }

  // Following count = number of p-tags in the user's own latest kind 3.
  // COUNT can't give us this directly (it'd return event count, not p-tag
  // count), so we fetch the newest kind-3 across all read-relays and tally
  // its tags. Replaceable-event semantics mean we want the freshest copy.
  function queryFollowingCount(relays, hex) {
    return new Promise((resolve) => {
      // Tighter per-relay budget than the original 5s — for a kind-3 fetch
      // a healthy relay answers in well under a second, and a slow relay
      // shouldn't hold the whole stats panel hostage.
      const PER_RELAY_MS = 2500;
      let bestCount = null;
      let bestAt    = -1;
      let remaining = relays.length;
      let outerDone = false;
      const finalize = () => {
        if (outerDone) return;
        if (remaining <= 0) {
          outerDone = true;
          clearTimeout(coalesceTimer);
          clearTimeout(hardTimer);
          resolve(bestCount);
        }
      };
      // Hard cap mirrors the per-relay budget so a hung WS doesn't pin
      // the outer promise forever.
      const hardTimer = setTimeout(() => {
        outerDone = true;
        clearTimeout(coalesceTimer);
        resolve(bestCount);
      }, PER_RELAY_MS);
      // Once we have any answer, give the rest a brief grace window then
      // resolve — this turns "wait for the slowest relay" into "answer
      // as soon as the network is sure".
      let coalesceTimer = 0;
      const armCoalesce = () => {
        if (coalesceTimer || outerDone) return;
        coalesceTimer = setTimeout(() => {
          if (outerDone) return;
          outerDone = true;
          clearTimeout(hardTimer);
          resolve(bestCount);
        }, 400);
      };
      relays.forEach(url => {
        let ws;
        try { ws = new WebSocket(url); }
        catch { remaining--; finalize(); return; }
        const subId = 'flw-' + Math.random().toString(36).slice(2, 8);
        let done = false;
        const close = () => {
          if (done) return;
          done = true;
          try { ws.close(); } catch {}
          remaining--;
          finalize();
        };
        const timer = setTimeout(close, PER_RELAY_MS);
        ws.addEventListener('open', () => {
          try { ws.send(JSON.stringify(['REQ', subId, { authors: [hex], kinds: [3], limit: 1 }])); }
          catch { clearTimeout(timer); close(); }
        });
        ws.addEventListener('message', (e) => {
          try {
            const data = typeof e.data === 'string' ? e.data : e.data.toString();
            const msg  = JSON.parse(data);
            if (Array.isArray(msg) && msg[0] === 'EVENT' && msg[1] === subId && msg[2]?.kind === 3) {
              const ev = msg[2];
              const at = ev.created_at || 0;
              if (at > bestAt) {
                bestAt = at;
                const pTags = (ev.tags || []).filter(t => Array.isArray(t) && t[0] === 'p' && t[1]);
                bestCount = pTags.length;
              }
            } else if (Array.isArray(msg) && msg[0] === 'EOSE' && msg[1] === subId) {
              clearTimeout(timer); close();
              if (bestCount != null) armCoalesce();
            }
          } catch {}
        });
        ws.addEventListener('error', () => { clearTimeout(timer); close(); });
        ws.addEventListener('close', () => { clearTimeout(timer); close(); });
      });
      if (remaining === 0) { outerDone = true; clearTimeout(hardTimer); resolve(null); }
    });
  }

  function fmtCount(n) {
    if (n == null) return '—';
    if (n < 1000) return String(n);
    if (n < 10_000)  return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
    if (n < 1_000_000) return Math.round(n / 1000) + 'K';
    return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  }

  // "in 7h 22m" / "in 45m" / "now" — matches the identity-chip hover tooltip.
  function fmtExpiry(ts) {
    if (!ts) return 'unknown';
    const ms = ts - Date.now();
    if (ms <= 0) return 'now';
    const mins = Math.floor(ms / 60000);
    const hrs  = Math.floor(mins / 60);
    if (hrs > 0) return `in ${hrs}h ${mins % 60}m`;
    return `in ${mins}m`;
  }

  function render(rc, cfg, ident, session, profile, ngitAccount, aiList, gitIdent, statusRows) {
    const whitelistHtml = rc.whitelist && rc.whitelist.length
      ? `<a href="#relay" style="color:var(--accent-bright)">${rc.whitelist.length} npub${rc.whitelist.length !== 1 ? 's' : ''} →</a>`
      : `<a href="#relay" style="color:var(--warn)">empty — add one →</a>`;

    const relayItems = (ident.readRelays || []).map(url => `
      <div class="item" data-url="${escapeHtml(url)}">
        <span class="url">${escapeHtml(url)}</span>
        <button class="danger rm">×</button>
      </div>`).join('');

    // Section order is now driven by usage frequency / conceptual grouping:
    //   1. Profile      — who you are
    //   2. Relay        — your station's relay + read-relay list
    //   3. AI           — providers + Stacks (configure → use)
    //   4. Git          — global git identity + ngit (signer/grasp)
    //   5. Templates    — rarely touched after first run
    //   6. Appearance   — purely cosmetic, pushed last
    // Each section is a <details> rendered collapsed by default so the
    // panel opens compact — the summary line carries an at-a-glance
    // status (name, count, "ok"/"off") so users rarely need to expand.
    container.innerHTML = `
      <details class="config-section cfg-collapsible" id="cfg-profile-section">
        <summary>
          <h3>Profile</h3>
          <span class="cfg-summary-meta" id="cfg-profile-summary-meta">
            ${escapeHtml(profile?.name || (ident.npub ? truncNpub(ident.npub) : 'no identity'))}
          </span>
        </summary>
        <div class="cfg-section-body">
          ${renderIdentityBody(ident, session, profile)}
          <div class="callout" style="margin-top:10px">
            Bunker URL is managed inside ngit. Configure via the setup wizard or <code>ngit init</code>.
            Test signing from your mobile signer (Amber) on first push.
          </div>
        </div>
      </details>

      <details class="config-section cfg-collapsible" id="cfg-relay-section">
        <summary>
          <h3>Relay</h3>
          <span class="cfg-summary-meta">${escapeHtml(rc.name || rc.url || '—')}</span>
        </summary>
        <div class="cfg-section-body">
          ${row('Name', rc.name || '—')}
          ${row('URL',  rc.url  || '—')}
          <div class="config-row">
            <div class="k">Write gating</div>
            <div class="v">
              <label class="toggle"><input type="checkbox" id="cfg-auth" checked disabled><span class="slider"></span></label>
              <span style="margin-left:10px;font-size:11px;color:var(--text-dim)">Always on — only the station owner and whitelisted pubkeys can publish. Reads stay open to anyone.</span>
            </div>
          </div>
          <div class="config-row">
            <div class="k">DM read gating</div>
            <div class="v">
              <label class="toggle"><input type="checkbox" id="cfg-dm-auth" disabled><span class="slider"></span></label>
              <span style="margin-left:10px;font-size:11px;color:var(--text-dim)">Reserved for a future read-gating layer (kind 4/44/1059). Not implemented.</span>
            </div>
          </div>
          <div class="config-row"><div class="k">Whitelist</div><div class="v">${whitelistHtml}</div></div>
          ${row('Data dir',    rc.dataDir || '—')}
          ${row('Config file', rc.configPath || '—')}
          <div class="callout" style="margin-top:10px">
            This section configures the <b>private, local Nostr relay</b> running inside nostr-station.
            For the public relays the /client panel reads from, see <b>Client Relays</b> below.
          </div>
        </div>
      </details>

      <details class="config-section cfg-collapsible" id="cfg-client-relays-section">
        <summary>
          <h3>Client Relays</h3>
          <span class="cfg-summary-meta">
            ${(ident.appRelaysEnabled !== false ? (ident.appRelays?.length || 3) : 0) + (ident.readRelays?.length || 0)} effective
          </span>
        </summary>
        <div class="cfg-section-body">
          <div style="font-size:12px;color:var(--text-dim);margin-bottom:14px">
            These relays power the <a href="#client" style="color:var(--accent-bright)">/client panel</a>
            (feed, notifications, profile lookups, publishing) and the dashboard's behind-the-scenes
            profile / maintainer lookups. Reads + writes go here — <b>not</b> to the private local relay.
          </div>

          <div class="cfg-subsection" id="cfg-app-relays">
            <div class="cfg-subsection-head" style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px">
              <h4 style="margin:0">App Relays</h4>
              <label class="toggle" title="Include nostr-station's default relays in client reads">
                <input type="checkbox" id="cfg-app-relays-toggle" ${(ident.appRelaysEnabled !== false) ? 'checked' : ''}>
                <span class="slider"></span>
              </label>
            </div>
            <div style="font-size:11px;color:var(--text-dim);margin-bottom:10px">
              Curated defaults that ship with nostr-station — picked for reliable public-Nostr connectivity.
              Fixed list (analogous to nostr-station's <a href="#" class="cfg-link-grasp" style="color:var(--accent-bright)">GRASP server defaults</a> for git).
              Toggle off to use <b>only</b> your relays below.
            </div>
            <div class="relay-list relay-list-readonly" id="app-relays">
              ${(ident.appRelays || []).map(url => `
                <div class="item">
                  <span class="url">${escapeHtml(url)}</span>
                  <span class="muted" style="font-size:10px">read · write · default</span>
                </div>`).join('')}
            </div>
          </div>

          <div class="cfg-subsection" id="cfg-your-relays" style="margin-top:18px">
            <div class="cfg-subsection-head" style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px">
              <h4 style="margin:0">Your Relays</h4>
              <button id="cfg-sync-relays" type="button" title="Fetch your NIP-65 outbox list (kind 10002) and merge into this list">
                ↻ sync from Nostr
              </button>
            </div>
            <div style="font-size:11px;color:var(--text-dim);margin-bottom:10px">
              Your personal relays. Merged with App Relays (above) when the toggle is on, otherwise used alone.
              Use <b>sync from Nostr</b> to import your existing NIP-65 outbox list.
            </div>
            <div class="relay-list" id="read-relays">
              ${relayItems || '<div style="color:var(--muted);font-size:11px">no personal relays — App Relays will be used alone</div>'}
              <div class="add">
                <input id="read-relay-input" placeholder="wss://relay.example.com" autocomplete="off">
                <button id="read-relay-paste">paste</button>
                <button class="primary" id="read-relay-add">add</button>
              </div>
            </div>
          </div>
        </div>
      </details>

      <details class="config-section cfg-collapsible" id="cfg-blossom-section">
        <summary>
          <h3>Blossom (local blob storage)</h3>
          <span class="cfg-summary-meta" id="cfg-blossom-summary">loading…</span>
        </summary>
        <div class="cfg-section-body" id="cfg-blossom-body">
          <div class="muted">loading blossom status…</div>
        </div>
      </details>

      <!-- nsite section. Mirrors Titan Browser's Settings tab: content
           relays, profile-discovery relays, Blossom fallback servers,
           and the NSIT name indexer pubkey. Body filled lazily by JS. -->
      <details class="config-section cfg-collapsible" id="cfg-nsite-section">
        <summary>
          <h3>nsite</h3>
          <span class="cfg-summary-meta" id="cfg-nsite-summary">loading…</span>
        </summary>
        <div class="cfg-section-body" id="cfg-nsite-body">
          <div class="muted">loading nsite config…</div>
        </div>
      </details>

      <!-- PR 11: Mail section. Status line + the two toggles agreed
           in the planning round: enable-at-boot and read-state-sync.
           Folder management + inbox-relay editing stay in the Mail
           panel itself (those are operational settings; Config holds
           the on/off switches). -->
      <details class="config-section cfg-collapsible" id="cfg-mail-section">
        <summary>
          <h3>Mail</h3>
          <span class="cfg-summary-meta" id="cfg-mail-summary">loading…</span>
        </summary>
        <div class="cfg-section-body" id="cfg-mail-body">
          <div class="muted">loading mail status…</div>
        </div>
      </details>

      <details class="config-section cfg-collapsible" id="cfg-ai-section">
        <summary>
          <h3>AI</h3>
          <span class="cfg-summary-meta">${escapeHtml(summarizeAi(aiList))}</span>
        </summary>
        <div class="cfg-section-body">
          <div style="font-size:11px;color:var(--text-dim);margin-bottom:10px">
            Terminal-native tools (Claude Code, OpenCode) launch in the terminal panel with cwd scoped to the selected project.
            API providers stream through the Chat pane via <code>/api/ai/chat</code>.
          </div>
          ${renderTerminalInstallHints(statusRows)}
          ${renderAiProviders(aiList)}
          <div class="config-row" style="margin-top:10px">
            <div class="k">Context</div>
            <div class="v ${cfg.hasContext ? 'on' : 'off'}" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
              <span>${describeContext(cfg)}</span>
              <button id="cfg-station-edit" type="button">Edit notes</button>
              <button id="cfg-prompt-preview" type="button">Preview prompt</button>
            </div>
          </div>
          <div class="callout">
            Per-provider keys live in the OS keychain as <code>ai:&lt;provider&gt;</code>.
            Config file: <code>~/.nostr-station/ai-config.json</code>.
          </div>

          <div class="cfg-subsection" id="cfg-stacks-section">
            <h4>Stacks AI (Dork)</h4>
            <div style="font-size:11px;color:var(--text-dim);margin-bottom:10px">
              Stacks ships its own AI provider config (separate from the providers above) at
              <code>~/Library/Preferences/stacks/config.json</code>. The Dork agent that runs inside
              mkstack projects uses this. Provider list is decided by Stacks itself —
              <code>stacks configure</code> shows the current options (Anthropic, OpenRouter,
              Routstr, PayPerQ, etc.).
            </div>
            <div class="config-row" style="margin-bottom:10px">
              <div class="k">Status</div>
              <div class="v" id="cfg-stacks-status">checking…</div>
            </div>
            <div class="keyrow">
              <button id="cfg-stacks-configure">Configure Stacks AI</button>
              <span style="font-size:11px;color:var(--muted);align-self:center">
                opens <code>stacks configure</code> in a terminal tab
              </span>
            </div>
          </div>
        </div>
      </details>

      <details class="config-section cfg-collapsible" id="cfg-git-section">
        <summary>
          <h3>Git</h3>
          <span class="cfg-summary-meta">
            ${escapeHtml(gitIdent?.current?.email || 'not set')}${ngitAccount?.loggedIn ? ' · ngit signed in' : ''}
          </span>
        </summary>
        <div class="cfg-section-body">

          <div class="cfg-subsection" id="cfg-git-identity-section">
            <h4>Git Identity</h4>
            <div style="font-size:11px;color:var(--text-dim);margin-bottom:10px">
              Author name + email baked into every <code>git commit</code> on this machine. Git records ONE author per commit — when you push to multiple platforms (GitHub, ngit, etc.), all of them see this same author. Per-project overrides are managed in each project's Settings tab.
            </div>
            <div class="config-row">
              <div class="k">Global identity</div>
              <div class="v">
                <div class="keyrow">
                  <div class="keyfield">
                    <input id="cfg-git-identity-name" type="text" autocomplete="off" placeholder="Your Name" value="${escapeHtml(gitIdent?.current?.name || '')}">
                  </div>
                </div>
                <div class="keyrow" style="margin-top:6px">
                  <div class="keyfield">
                    <input id="cfg-git-identity-email" type="text" autocomplete="off" spellcheck="false" placeholder="you@example.com" value="${escapeHtml(gitIdent?.current?.email || '')}">
                  </div>
                  <button class="primary" id="cfg-git-identity-save">save</button>
                </div>
                <div class="key-status-line ${gitIdent?.current?.name && gitIdent?.current?.email ? 'ok' : ''}" id="cfg-git-identity-status">
                  ${gitIdent?.current?.name && gitIdent?.current?.email ? '✓ saved (~/.gitconfig)' : 'not set — projects nostr-station scaffolds will auto-seed an npub-synthetic identity per repo'}
                </div>
                <div style="margin-top:10px">
                  <span class="muted" style="font-size:11px">Presets:</span>
                  <div class="keyrow" style="margin-top:6px;flex-wrap:wrap;gap:6px">
                    ${gitIdent?.presets?.npubSynthetic ? `
                      <button id="cfg-git-identity-preset-npub" type="button"
                              title="${escapeHtml(gitIdent.presets.npubSynthetic.name)} &lt;${escapeHtml(gitIdent.presets.npubSynthetic.email)}&gt;">
                        Use npub shorthand
                      </button>
                    ` : ''}
                    ${gitIdent?.presets?.nip05 ? `
                      <button id="cfg-git-identity-preset-nip05" type="button"
                              title="${escapeHtml(gitIdent.presets.nip05.email)}">
                        Use my nip-05 (${escapeHtml(gitIdent.presets.nip05.email)})
                      </button>
                    ` : ''}
                  </div>
                  <div class="muted" style="font-size:11px;margin-top:6px">
                    <strong>npub shorthand</strong> — pure Nostr identity, links to your npub but not to any GitHub user.<br>
                    <strong>nip-05</strong> — your Nostr handle as an email-shaped identifier; links to your npub via DNS, AND can link to a GitHub user if that exact email is registered there.<br>
                    <strong>Set my own</strong> — type a real email above (e.g. your GitHub-registered address) for full GitHub user attribution.
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div class="cfg-subsection" id="cfg-ngit-section">
            <h4>NGIT</h4>
            <div style="font-size:11px;color:var(--text-dim);margin-bottom:10px">
              Configure git-over-Nostr: pick which GRASP servers host your repos
              and pair an Amber signer for push/clone.
            </div>

            <div class="config-row">
              <div class="k">GRASP servers</div>
              <div class="v">
                <div style="font-size:11px;color:var(--text-dim);margin-bottom:8px">
                  Where your git+nostr data is hosted. The Initialize ngit form on
                  each project pre-checks these — uncheck per-project if a particular
                  server doesn't host that repo. Two public defaults are seeded;
                  add your own grasp (self-hosted or otherwise) below.
                </div>
                <div class="relay-list" id="grasp-servers">
                  ${(ident.graspServers || []).map(url => `
                    <div class="item" data-url="${escapeHtml(url)}">
                      <span class="url">${escapeHtml(url)}</span>
                      <button class="danger rm-grasp">×</button>
                    </div>`).join('')}
                  <div class="add">
                    <input id="grasp-server-input" placeholder="wss://your-grasp-server.example" autocomplete="off">
                    <button id="grasp-server-paste">paste</button>
                    <button class="primary" id="grasp-server-add">add</button>
                  </div>
                </div>
              </div>
            </div>

            <div class="config-row" style="margin-top:14px">
              <div class="k">Account (signer)</div>
              <div class="v">
                ${ngitAccount && ngitAccount.loggedIn ? `
                  <div class="key-status-line ok">✓ signer configured</div>
                  <div style="font-size:11px;color:var(--text-dim);margin-top:6px">
                    Relays: ${(ngitAccount.relays || []).length
                      ? (ngitAccount.relays || []).map(r => `<code>${escapeHtml(r)}</code>`).join(' · ')
                      : '<em>none declared</em>'}
                  </div>
                  ${ngitAccount.remotePubkey ? `<div style="font-size:11px;color:var(--text-dim);margin-top:4px">Remote pubkey: <code>${escapeHtml(ngitAccount.remotePubkey.slice(0, 12))}…</code></div>` : ''}
                  <div class="keyrow" style="margin-top:10px">
                    <button id="cfg-ngit-relogin">Re-login</button>
                    <button class="danger" id="cfg-ngit-logout">Logout</button>
                  </div>
                  <div class="muted" style="font-size:11px;margin-top:6px">
                    Re-login refreshes a stale bunker session — fixes <code>git-remote-nostr</code>
                    panics during clone/push.
                  </div>
                ` : `
                  <div class="key-status-line err">✗ not logged in</div>
                  <div class="muted" style="font-size:11px;margin-top:6px">
                    A signer is required before you can clone ngit repos. Login connects Amber (or another NIP-46 signer) to ngit.
                  </div>
                  <div class="keyrow" style="margin-top:10px">
                    <button class="primary" id="cfg-ngit-relogin">Login</button>
                  </div>
                `}
              </div>
            </div>
          </div>
        </div>
      </details>

      <details class="config-section cfg-collapsible" id="cfg-templates-section">
        <summary>
          <h3>Project Templates</h3>
          <span class="cfg-summary-meta" id="cfg-templates-summary">loading…</span>
        </summary>
        <div class="cfg-section-body">
          <div style="font-size:11px;color:var(--text-dim);margin-bottom:10px">
            Templates available to the New Project flow (and to the AI when
            it picks a starting point for a fresh project). Built-in
            templates can be edited or reset; user-added ones can be
            deleted. Stored at <code>~/.config/nostr-station/templates.json</code>.
          </div>
          <div id="cfg-templates-list">loading…</div>
        </div>
      </details>

      <details class="config-section cfg-collapsible" id="cfg-appearance-section">
        <summary>
          <h3>Appearance</h3>
          <span class="cfg-summary-meta">${escapeHtml(summarizeTheme())}</span>
        </summary>
        <div class="cfg-section-body">
          <div class="config-row">
            <div class="k">Accent color</div>
            <div class="v">
              ${renderThemePicker()}
              <div style="font-size:11px;color:var(--text-dim);margin-top:8px">
                Recolors UI accents (links, active nav, primary buttons). Persists in this browser.
              </div>
            </div>
          </div>
          ${renderDittoCard()}
        </div>
      </details>

      <details class="config-section cfg-collapsible" id="cfg-about-section">
        <summary>
          <h3>About</h3>
          <span class="cfg-summary-meta" id="cfg-about-summary">${escapeHtml(summarizeUpdates())}</span>
        </summary>
        <div class="cfg-section-body">
          <div class="config-row">
            <div class="k">Check for updates</div>
            <div class="v">
              <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                <button id="cfg-check-updates" class="primary">Check for updates</button>
                <span id="cfg-updates-result" class="cfg-updates-result"></span>
              </div>
              <div style="font-size:11px;color:var(--text-dim);margin-top:8px">
                Pulls from <code>origin/main</code> on GitHub, rebuilds, and restarts the dashboard. Your identity, keychain, projects, and relay data are kept; the tab reloads logged-in.
              </div>
            </div>
          </div>
        </div>
      </details>
    `;

    // Appearance — accent theme picker + Ditto sync card
    wireThemePicker();
    wireDittoCard();

    // About — manual update check. Forces a server-side re-poll
    // (so we don't have to wait for the 30-min background tick),
    // shows the result inline, and offers an Install button that
    // hands off to the same modal the header pill uses.
    wireCheckUpdates();

    // Wire toggles
    $('cfg-auth').addEventListener('change', (e) => saveRelayFlag('auth', e.target.checked));
    $('cfg-dm-auth').addEventListener('change', (e) => saveRelayFlag('dmAuth', e.target.checked));

    // Stacks AI → Configure — runs `stacks configure` in a terminal tab.
    // Stacks's configure flow is interactive (provider picker + key entry
    // + Lightning/Cashu options for Routstr/PayPerQ), so terminal-only.
    $('cfg-stacks-configure')?.addEventListener('click', () => {
      if (window.NSTerminal?.isAvailable?.()) {
        window.NSTerminal.open('stacks-configure');
      } else {
        toast('Terminal unavailable',
          window.NSTerminal?.getUnavailableReason?.() || 'Run from your shell: `stacks configure`',
          'err');
      }
    });

    // Stacks AI → status line. Reads ~/Library/Preferences/stacks/config.json
    // server-side and shows configured provider ids (no keys leak through
    // the API). Refreshable by re-rendering the panel — Stacks doesn't
    // emit a change event when configure exits, so the user has to switch
    // tabs and back, or we poll. For now, fetch on render is enough; if
    // it becomes a friction point a one-shot post-terminal-close refresh
    // would be the next step.
    api('/api/stacks/config').then(r => {
      const el = $('cfg-stacks-status');
      if (!el) return;
      if (r.configured) {
        el.innerHTML = `<span style="color:var(--success)">✓ configured</span>` +
          ` <span style="color:var(--text-dim);font-size:11px">— ${escapeHtml(r.providers.join(', '))}</span>`;
      } else {
        el.innerHTML = `<span style="color:var(--text-dim)">not configured yet</span>`;
      }
    }).catch(() => {
      const el = $('cfg-stacks-status');
      if (el) el.textContent = '—';
    });

    // Copy button on the identity npub row — only rendered when an npub is
    // actually configured (guarded by the same branch in renderIdentityBody).
    const idRow = $('cfg-identity-npub');
    if (idRow && ident.npub) idRow.appendChild(copyBtn(ident.npub));

    // Profile stats — kick off the follower / following queries against
    // the user's read-relays. Render row is already in the DOM (slot
    // emitted in renderIdentityBody when we have a hex pubkey).
    const statsEl = $('cfg-profile-stats');
    if (statsEl && profile?.hex) {
      const relays = Array.isArray(ident.readRelays) && ident.readRelays.length
        ? ident.readRelays
        : [];
      if (relays.length === 0) {
        statsEl.innerHTML = `<span class="muted">add read relays to query stats</span>`;
      } else {
        fetchProfileStats(profile.hex, relays).then(({ followers, following }) => {
          if (followers == null && following == null) {
            statsEl.innerHTML = `<span class="muted">stats unavailable (relays didn't answer)</span>`;
            return;
          }
          statsEl.innerHTML = `
            <span class="cfg-stat"><b>${fmtCount(following)}</b> following</span>
            <span class="cfg-stat-sep">·</span>
            <span class="cfg-stat"><b>${fmtCount(followers)}</b> followers</span>
          `;
        }).catch(() => {
          statsEl.innerHTML = `<span class="muted">stats unavailable</span>`;
        });
      }
    }

    // Read-relays list ("Your Relays" — under the Client Relays section)
    $$('#read-relays .rm').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const url = e.target.closest('.item').dataset.url;
        removeReadRelay(url);
      });
    });
    $('read-relay-add').addEventListener('click', addReadRelayFromInput);
    $('read-relay-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') addReadRelayFromInput(); });
    $('read-relay-paste').addEventListener('click', async () => {
      try { $('read-relay-input').value = (await navigator.clipboard.readText()).trim(); }
      catch { toast('Clipboard blocked', 'paste manually', 'warn'); }
    });

    // App Relays toggle — flips identity.appRelaysEnabled. The /client panel
    // (and other public-relay consumers via getEffectiveReadRelays) pick up
    // the change on their next call; nothing else on this page needs to
    // re-render, so we just update the summary count + toast.
    const appRelaysToggle = $('cfg-app-relays-toggle');
    if (appRelaysToggle) {
      appRelaysToggle.addEventListener('change', async (e) => {
        const enabled = !!e.target.checked;
        try {
          await api('/api/identity/app-relays/toggle', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled }),
          });
          apiInvalidate('/api/identity/config');
          document.dispatchEvent(new CustomEvent('api-config-changed'));
          toast('App Relays', enabled ? 'Enabled' : 'Disabled', 'ok');
          // Reload Config so the effective count + the relay-list-readonly
          // visual state stays consistent with the persisted toggle.
          load();
        } catch { /* api() already toasted; revert checkbox to match server */
          e.target.checked = !enabled;
        }
      });
    }

    // Sync from Nostr — pulls the owner's kind 10002 NIP-65 outbox list and
    // merges new entries into Your Relays. Defensive against the "no kind
    // 10002 found" empty case + the nak-missing / no-relays unavailable
    // shape from the server.
    const syncBtn = $('cfg-sync-relays');
    if (syncBtn) {
      syncBtn.addEventListener('click', async () => {
        const orig = syncBtn.textContent;
        syncBtn.disabled = true;
        syncBtn.textContent = 'syncing…';
        try {
          const r = await api('/api/client/sync-relays', { method: 'POST' });
          if (r.unavailable) {
            toast('Sync skipped', r.hint || r.empty || r.reason, 'warn');
            return;
          }
          if (r.empty) {
            toast('Nothing to sync', r.empty, 'warn');
            return;
          }
          const n = Array.isArray(r.added) ? r.added.length : 0;
          toast('Synced from Nostr', n === 0 ? 'No new relays — your list is up to date' : `Added ${n} relay${n === 1 ? '' : 's'}`, 'ok');
          apiInvalidate('/api/identity/config');
          document.dispatchEvent(new CustomEvent('api-config-changed'));
          load();
        } catch { /* api() toasted */ }
        finally {
          syncBtn.disabled = false;
          syncBtn.textContent = orig;
        }
      });
    }

    // The "GRASP server defaults" inline link in App Relays explainer text —
    // scrolls to the existing GRASP servers UI in the Git section so users
    // see the parallel structure without leaving the page.
    document.querySelectorAll('.cfg-link-grasp').forEach(a => {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        const git = document.getElementById('cfg-git-section');
        if (git) { git.open = true; git.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
      });
    });

    // Grasp servers list — same wire shape as the read-relay list above
    // (item row .rm-grasp button per entry, add input + paste button at
    // the bottom). Reload after each mutation so the list re-renders
    // from /api/identity/config — that endpoint already handles the
    // default-fallback for empty stored state.
    $$('#grasp-servers .rm-grasp').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const url = e.target.closest('.item').dataset.url;
        removeGraspServerFromList(url);
      });
    });
    $('grasp-server-add').addEventListener('click', addGraspServerFromInput);
    $('grasp-server-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') addGraspServerFromInput(); });
    $('grasp-server-paste').addEventListener('click', async () => {
      try { $('grasp-server-input').value = (await navigator.clipboard.readText()).trim(); }
      catch { toast('Clipboard blocked', 'paste manually', 'warn'); }
    });

    // Multi-provider AI list — see renderAiProviders() for the markup.
    // Wire up all row actions + the "Add provider" dropdown in one place.
    // aiList is captured explicitly; wireAiProviders() lives at the panel
    // scope and can't reach render()'s param otherwise.
    wireAiProviders(aiList);

    // Edit station context — opens a modal backed by NOSTR_STATION.md.
    // Saves go through PUT /api/station-context; the chat path picks up
    // edits on the next turn (no restart needed).
    const editStationBtn = $('cfg-station-edit');
    if (editStationBtn) editStationBtn.addEventListener('click', openStationContextEditor);

    // Preview rendered prompt — calls GET /api/ai/preview and shows the
    // exact text the next chat turn will receive. Project selector lets
    // the user inspect any project's resolved prompt, not just station.
    const previewPromptBtn = $('cfg-prompt-preview');
    if (previewPromptBtn) previewPromptBtn.addEventListener('click', openPromptPreview);

    // Templates registry section — fetched + rendered after the rest of
    // the panel paints. Failures are non-fatal (the section shows an
    // inline error). The /api/templates endpoint self-heals so the
    // first render after a fresh install seeds the built-ins.
    refreshTemplates();

    // ── Git Identity — global config view + edit + presets ──────────
    //
    // Persists to ~/.gitconfig via PUT /api/git-identity/global. The
    // form values are pre-filled from the readGlobalGitIdentity()
    // response baked into the Config-panel render. Save validates
    // server-side (empty / missing-@ / control-char rejected) and
    // reloads the panel so the status line + presets re-render with
    // the new state.
    const gidName  = $('cfg-git-identity-name');
    const gidEmail = $('cfg-git-identity-email');
    const gidSave  = $('cfg-git-identity-save');
    async function saveGitIdentity() {
      const name  = gidName.value.trim();
      const email = gidEmail.value.trim();
      if (!name || !email) {
        toast('Name and email are required', '', 'err');
        return;
      }
      gidSave.disabled = true;
      try {
        const r = await api('/api/git-identity/global', {
          method:  'PUT',
          headers: { 'content-type': 'application/json' },
          body:    JSON.stringify({ name, email }),
        });
        if (!r.ok) throw new Error(r.error || 'save failed');
        toast('Git identity saved', `~/.gitconfig — ${email}`, 'ok');
        load();    // re-render so status line + presets reflect the new state
      } catch (e) {
        toast('Save failed', e?.message || '', 'err');
      } finally {
        gidSave.disabled = false;
      }
    }
    gidSave?.addEventListener('click', saveGitIdentity);
    gidEmail?.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveGitIdentity(); });
    gidName?.addEventListener('keydown',  (e) => { if (e.key === 'Enter') saveGitIdentity(); });

    // Preset buttons — fill the form fields from the npub-synthetic /
    // nip-05 derivations the backend (and, for nip-05, the cached
    // profile) provided. User still has to click Save to persist; we
    // don't write silently from a preset click.
    const presetNpub  = $('cfg-git-identity-preset-npub');
    const presetNip05 = $('cfg-git-identity-preset-nip05');
    if (presetNpub && gitIdent?.presets?.npubSynthetic) {
      presetNpub.addEventListener('click', () => {
        gidName.value  = gitIdent.presets.npubSynthetic.name;
        gidEmail.value = gitIdent.presets.npubSynthetic.email;
        gidEmail.focus();
      });
    }
    if (presetNip05 && gitIdent?.presets?.nip05) {
      presetNip05.addEventListener('click', () => {
        gidName.value  = gitIdent.presets.nip05.name;
        gidEmail.value = gitIdent.presets.nip05.email;
        gidEmail.focus();
      });
    }

    // ngit account (signer).
    //
    //   - Login is INTERACTIVE: ngit renders a `█`-block QR code to the PTY
    //     for scanning in Amber and then prompts for signer-relay choices.
    //     Requires a real terminal, which the streaming exec modal isn't
    //     (it's a line-buffered SSE renderer with no TTY underneath). We
    //     route it into the xterm.js terminal panel instead — the first
    //     trigger wired to that panel. When the terminal is unavailable
    //     (node-pty missing), fall back to the exec modal; ngit degrades
    //     into a URL-only path that's still usable even without a TTY.
    //
    //   - Logout is non-interactive — strips nostr.* keys from global git
    //     config — so the lightweight SSE modal remains the right tool.
    //
    // After either operation completes, re-fetch ngit status + service
    // health so the UI reflects the new signer state.
    const loginBtn  = $('cfg-ngit-relogin');
    const logoutBtn = $('cfg-ngit-logout');
    if (loginBtn) {
      loginBtn.addEventListener('click', () => {
        if (window.NSTerminal?.isAvailable?.()) {
          window.NSTerminal.open('ngit-login');
          // Re-fetch signer status when the terminal session ends. We don't
          // know exactly when that is (PTY process lifecycle is owned by
          // the server), so kick off a few polls over the next ~2min —
          // enough to cover the typical scan + approve round trip.
          //
          // Crucially these polls invalidate the cached snapshots and call
          // loadIfVisible(), so the heavy Config rebuild only happens when
          // the user is actually on the Config panel. While they're staring
          // at the QR in the terminal, we don't churn the panel underneath.
          //
          // Schedule chosen to feel snappy on the happy path (Amber confirms
          // within ~1-5s of the user scanning the QR) while still covering
          // the slow path (user puts phone down, comes back later). Tight
          // early polls hit the "I just logged in, why is the panel stale?"
          // window; the longer tail covers >1-minute delays.
          const refetch = () => {
            apiInvalidate('/api/ngit/account');
            apiInvalidate('/api/identity/config');
            apiInvalidate('/api/identity/profile');
            loadIfVisible();
            refreshHealth();
          };
          [1_000, 2_500, 5_000, 10_000, 25_000, 60_000, 120_000].forEach(ms => setTimeout(refetch, ms));
          return;
        }
        // Fallback path — terminal unavailable. Fire the old modal; ngit
        // will print the nostrconnect:// URL (no QR) and the user can
        // copy/paste it into Amber.
        const reason = window.NSTerminal?.getUnavailableReason?.();
        if (reason) toast('Terminal unavailable — falling back to streaming modal', reason, 'warn');
        openExecModal({
          title: 'ngit account login',
          subtitle: 'Streams ngit account login — scan the nostrconnect URL with Amber',
          endpoint: '/api/ngit/account/login',
        }).then(() => { apiInvalidate('/api/ngit/account'); load(); refreshHealth(); });
      });
    }
    if (logoutBtn) {
      logoutBtn.addEventListener('click', async () => {
        const ok = await confirmDestructive({
          title: 'Logout from ngit?',
          description: 'Removes the bunker URI + app key from your global git config. ngit clone/push will stop working until you log in again.',
          confirmLabel: 'Logout',
        });
        if (!ok) return;
        openExecModal({
          title: 'ngit account logout',
          subtitle: 'Streaming ngit account logout',
          endpoint: '/api/ngit/account/logout',
        }).then(() => { apiInvalidate('/api/ngit/account'); load(); refreshHealth(); });
      });
    }

    // ── Local Blossom (Phase C) ────────────────────────────────────────
    // Paint into the slot reserved by #cfg-blossom-section. Async since
    // it round-trips to /api/blossom-config — failures degrade to a
    // muted "not running" line with an enable button.
    paintBlossomConfigSection();
    paintMailConfigSection();
    paintNsiteConfigSection();
  }

  // ── nsite section ─────────────────────────────────────────────────────
  // Five fields, mirroring Titan Browser's Settings tab. Edits are
  // staged in <textarea> / <input> and committed via Save → PUT
  // /api/nsite/config, which atomically replaces the on-disk file.
  // Env-var overrides (NSITE_NSIT_INDEXER_PUBKEY / NSITE_NSIT_RELAYS)
  // win at request time — when active, the affected fields render with
  // a small "overridden by env" tag and are disabled.
  async function paintNsiteConfigSection() {
    const body    = $('cfg-nsite-body');
    const summary = $('cfg-nsite-summary');
    if (!body) return;
    const data = await api('/api/nsite/config', undefined, { silent: true }).catch(() => null);
    if (!data) {
      if (summary) summary.textContent = 'unavailable';
      body.innerHTML = `<div class="muted">nsite endpoint not reachable.</div>`;
      return;
    }
    const cfg = data.config, def = data.defaults, env = data.envOverrides || {};
    const linesOf = (arr) => Array.isArray(arr) ? arr.join('\n') : '';
    const nsitOff = (cfg.nsitIndexerPubkey || '').toLowerCase() === 'disabled' || cfg.nsitIndexerPubkey === '';
    if (summary) {
      summary.textContent = nsitOff
        ? `${cfg.contentRelays.length} content relays · NSIT off`
        : `${cfg.contentRelays.length} content relays · NSIT on`;
    }
    const envBadge = (active) => active
      ? `<span class="cfg-env-badge" title="Overridden by env var — edit ignored until env is unset">env</span>` : '';
    body.innerHTML = `
      <div class="cfg-nsite-intro">
        These settings govern the <strong>nsite browser panel</strong> only —
        how it resolves <code>nsite://</code> addresses, finds an author's
        published files, and fetches blob bytes. They are <strong>separate
        from your Client / Identity read relays</strong> (Config → Identity),
        which power your own feed, notifications, and outbound posts. Editing
        the lists below does not change which relays your station publishes
        to or reads its own social feed from. Defaults mirror Titan Browser's
        Settings tab so an address that works in Titan also works here.
      </div>

      <div class="cfg-nsite-grid">
        <div class="cfg-nsite-field">
          <div class="cfg-nsite-label">Content relays</div>
          <div class="cfg-nsite-help muted">
            Always-on relays queried for the author's <code>kind:34128</code>
            file events (the per-file path → SHA256 manifest). These are
            <strong>unioned</strong> with your Identity read relays and the
            author's own NIP-65 outbox — they don't replace either, they're
            an additional safety net so nsites whose authors publish to
            specialized relays (like <code>relay.westernbtc.com</code> for
            Titan-ecosystem sites) still resolve even when those relays
            aren't in your Identity config.
          </div>
          <textarea id="cfg-nsite-content" rows="4" spellcheck="false"
            placeholder="${escapeHtml(def.contentRelays.join('\n'))}">${escapeHtml(linesOf(cfg.contentRelays))}</textarea>
          <div class="cfg-nsite-hint muted">one <code>wss://</code> URL per line</div>
        </div>

        <div class="cfg-nsite-field">
          <div class="cfg-nsite-label">Discovery relays</div>
          <div class="cfg-nsite-help muted">
            Profile-relay indexers (purplepag.es, user.kindpag.es) consulted
            to bootstrap the NIP-65 outbox lookup — i.e., to find
            <em>where the author themselves publishes</em>. Without these,
            we'd only know about an author's outbox if their
            <code>kind:10002</code> announcement happened to be on a relay
            you already subscribe to via Identity. This is the same role
            Titan Browser uses these relays for.
          </div>
          <textarea id="cfg-nsite-discovery" rows="3" spellcheck="false"
            placeholder="${escapeHtml(def.discoveryRelays.join('\n'))}">${escapeHtml(linesOf(cfg.discoveryRelays))}</textarea>
          <div class="cfg-nsite-hint muted">one <code>wss://</code> URL per line</div>
        </div>

        <div class="cfg-nsite-field">
          <div class="cfg-nsite-label">Blossom fallback servers</div>
          <div class="cfg-nsite-help muted">
            HTTP servers (NOT Nostr relays) where SHA256-addressed blob
            bytes are fetched. The author's own announced Blossom servers
            (from their <code>kind:10063</code>) are tried first; if those
            return 404 or are unreachable, these fallbacks are tried in
            order. Every byte is hash-verified against the on-relay SHA256
            before the iframe renders it. Independent of any relay
            configuration.
          </div>
          <textarea id="cfg-nsite-blossom" rows="4" spellcheck="false"
            placeholder="${escapeHtml(def.blossomServers.join('\n'))}">${escapeHtml(linesOf(cfg.blossomServers))}</textarea>
          <div class="cfg-nsite-hint muted">one <code>https://</code> URL per line</div>
        </div>

        <div class="cfg-nsite-field">
          <div class="cfg-nsite-label">NSIT indexer pubkey ${envBadge(env.nsitIndexerPubkey)}</div>
          <div class="cfg-nsite-help muted">
            64-character hex pubkey of the service whose <code>kind:35129</code>
            events we trust for NSIT (Bitcoin-native) name resolution.
            This is the pubkey that tells us, e.g., <code>nsite://titan</code>
            maps to <code>bec1a370…</code>. The default is Titan's hosted
            indexer; set to <code>disabled</code> to refuse NSIT name
            lookups entirely (npub / NIP-05 / hex addresses still work).
            Leave blank to use the default. Trust model: an honest
            indexer always agrees with the Bitcoin chain, so a different
            indexer should produce the same answer — change this only if
            you run your own.
          </div>
          <input type="text" id="cfg-nsite-indexer-pk" spellcheck="false"
            ${env.nsitIndexerPubkey ? 'disabled' : ''}
            placeholder="${escapeHtml(def.nsitIndexerPubkey)}"
            value="${escapeHtml(cfg.nsitIndexerPubkey || '')}">
        </div>

        <div class="cfg-nsite-field">
          <div class="cfg-nsite-label">NSIT indexer relays ${envBadge(env.nsitIndexerRelays)}</div>
          <div class="cfg-nsite-help muted">
            Relays where the NSIT indexer publishes its
            <code>kind:35129</code> name→pubkey events. Used <em>only</em>
            during name resolution (the <code>titan</code> /
            <code>westernbtc</code> step of <code>nsite://titan</code>) —
            once a name resolves to a pubkey, content fetch falls back to
            the Content relays / Identity read relays / author outbox set
            above.
          </div>
          <textarea id="cfg-nsite-indexer-relays" rows="3" spellcheck="false"
            ${env.nsitIndexerRelays ? 'disabled' : ''}
            placeholder="${escapeHtml(def.nsitIndexerRelays.join('\n'))}">${escapeHtml(linesOf(cfg.nsitIndexerRelays))}</textarea>
          <div class="cfg-nsite-hint muted">one <code>wss://</code> URL per line</div>
        </div>
      </div>

      <div class="cfg-nsite-actions">
        <button class="primary" id="cfg-nsite-save">Save</button>
        <button id="cfg-nsite-reset">Reset to defaults</button>
        <span class="muted cfg-nsite-path" id="cfg-nsite-path">${escapeHtml(data.configPath)}</span>
      </div>
    `;

    const linesFrom = (id) => ($(id)?.value || '').split('\n').map(s => s.trim()).filter(Boolean);
    $('cfg-nsite-save')?.addEventListener('click', async () => {
      const payload = {
        contentRelays:     linesFrom('cfg-nsite-content'),
        discoveryRelays:   linesFrom('cfg-nsite-discovery'),
        blossomServers:    linesFrom('cfg-nsite-blossom'),
        nsitIndexerPubkey: ($('cfg-nsite-indexer-pk')?.value || '').trim(),
        nsitIndexerRelays: linesFrom('cfg-nsite-indexer-relays'),
      };
      try {
        await api('/api/nsite/config', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        toast('nsite config saved', 'Cleared resolve cache — next nsite open uses the new settings.');
        paintNsiteConfigSection();
      } catch (e) {
        // api() already surfaced a red toast with the server's message.
      }
    });
    $('cfg-nsite-reset')?.addEventListener('click', async () => {
      try {
        await api('/api/nsite/config', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            contentRelays:     def.contentRelays,
            discoveryRelays:   def.discoveryRelays,
            blossomServers:    def.blossomServers,
            nsitIndexerPubkey: def.nsitIndexerPubkey,
            nsitIndexerRelays: def.nsitIndexerRelays,
          }),
        });
        toast('nsite config reset', 'Restored Titan-mirrored defaults.');
        paintNsiteConfigSection();
      } catch { /* api() already toasted */ }
    });
  }

  async function paintBlossomConfigSection() {
    const body    = $('cfg-blossom-body');
    const summary = $('cfg-blossom-summary');
    if (!body) return;
    let snapshot = null;
    try { snapshot = await api('/api/blossom-config'); }
    catch { /* surface as "unavailable" below */ }

    if (!snapshot) {
      if (summary) summary.textContent = 'unavailable';
      body.innerHTML = `<div class="muted">Blossom config endpoint not reachable.</div>`;
      return;
    }

    if (!snapshot.running) {
      if (summary) summary.textContent = 'off';
      body.innerHTML = `
        <div class="muted" style="margin-bottom:10px">
          Local Blossom is the blob-storage half of the dev stack — apps
          spawned via the dashboard see <code>NOSTR_STATION_BLOSSOM=http://localhost:&lt;port&gt;</code>
          when it's enabled. Off by default; turn on once you actually
          need blob hosting locally (e.g. testing avatar uploads
          without polluting public Blossom servers).
        </div>
        <div class="step-actions">
          <button class="primary" id="cfg-blossom-enable">Enable Blossom</button>
        </div>
      `;
      $('cfg-blossom-enable')?.addEventListener('click', async () => {
        try {
          await api('/api/blossom/start', { method: 'POST' });
          apiInvalidate('/api/blossom-config');
          apiInvalidate('/api/status');
          paintBlossomConfigSection();
          refreshHealth?.();
          // Lockstep refresh: the Dashboard card might also be in view.
          try { await StatusPanel?._fillBlossomCard?.(); } catch {}
        } catch (e) {
          toast('Failed to start Blossom', e?.message || '', 'err');
        }
      });
      return;
    }

    const stats = snapshot.stats || { blobCount: 0, totalBytes: 0, quotaBytes: 0, dataDir: '', uploadsByKind: {} };
    const pct = stats.quotaBytes ? Math.min(100, Math.round((stats.totalBytes / stats.quotaBytes) * 100)) : 0;
    if (summary) summary.textContent = `${stats.blobCount} blob${stats.blobCount === 1 ? '' : 's'} · ${fmtBytes(stats.totalBytes)}`;
    body.innerHTML = `
      <div class="config-row"><div class="k">URL</div><div class="v"><code>${escapeHtml(snapshot.url || '')}</code></div></div>
      <div class="config-row"><div class="k">Stored</div><div class="v">
        <b>${stats.blobCount}</b> blob${stats.blobCount === 1 ? '' : 's'} · <b>${fmtBytes(stats.totalBytes)}</b>
        of <b>${fmtBytes(stats.quotaBytes)}</b> (${pct}%)
      </div></div>
      <div class="config-row"><div class="k">Uploaders</div><div class="v">
        <span class="muted">owner ${stats.uploadsByKind.owner || 0} · whitelist ${stats.uploadsByKind.whitelist || 0} · test ${stats.uploadsByKind['test-identity'] || 0}</span>
      </div></div>
      <div class="config-row"><div class="k">Data dir</div><div class="v"><code>${escapeHtml(stats.dataDir || '')}</code></div></div>
      <div class="step-actions" style="margin-top:10px">
        <button id="cfg-blossom-stop">Stop</button>
        <button id="cfg-blossom-restart">Restart</button>
        <button class="danger" id="cfg-blossom-wipe">Wipe all blobs</button>
      </div>
    `;
    // After any Blossom action: invalidate the SWR caches the three
    // surfaces read from (so the next poll returns fresh state without
    // waiting out the 3s TTL), repaint this section, refresh sidebar
    // Health, and re-fill the Dashboard card. The trio updates in
    // lockstep regardless of which control the user clicked.
    const refreshBlossomSurfaces = async () => {
      apiInvalidate('/api/blossom-config');
      apiInvalidate('/api/status');
      paintBlossomConfigSection();
      refreshHealth?.();
      try { await StatusPanel?._fillBlossomCard?.(); } catch {}
    };
    $('cfg-blossom-stop')?.addEventListener('click', async () => {
      try { await api('/api/blossom/stop', { method: 'POST' }); await refreshBlossomSurfaces(); }
      catch (e) { toast('Stop failed', e?.message || '', 'err'); }
    });
    $('cfg-blossom-restart')?.addEventListener('click', async () => {
      try { await api('/api/blossom/restart', { method: 'POST' }); await refreshBlossomSurfaces(); }
      catch (e) { toast('Restart failed', e?.message || '', 'err'); }
    });
    $('cfg-blossom-wipe')?.addEventListener('click', async () => {
      const ok = await confirmDestructive({
        title: 'Wipe all local blobs?',
        description: `Deletes ${stats.blobCount} blob(s) (${fmtBytes(stats.totalBytes)}) from the local store. Cannot be undone.`,
        confirmLabel: 'Wipe',
      });
      if (!ok) return;
      try { await api('/api/blossom/wipe', { method: 'POST' }); paintBlossomConfigSection(); }
      catch (e) { toast('Wipe failed', e?.message || '', 'err'); }
    });
  }

  // ── Mail section (PR 11) ───────────────────────────────────────────────
  async function paintMailConfigSection() {
    const body    = $('cfg-mail-body');
    const summary = $('cfg-mail-summary');
    if (!body) return;
    let status   = null;
    let settings = null;
    try {
      [status, settings] = await Promise.all([
        api('/api/mail/status',   undefined, { silent: true }).catch(() => null),
        api('/api/mail/settings', undefined, { silent: true }).catch(() => null),
      ]);
    } catch { /* fall through to unavailable */ }

    if (!status || !settings) {
      if (summary) summary.textContent = 'unavailable';
      body.innerHTML = `<div class="muted">Mail endpoints not reachable.</div>`;
      return;
    }

    const stats   = status.stats || {};
    const enabled = status.enabled !== false;
    const set     = settings.settings || {};
    const readSync = set.readStateSync !== false;

    if (summary) {
      summary.textContent = enabled
        ? `${stats.relaysConnected || 0} relay${(stats.relaysConnected || 0) === 1 ? '' : 's'} · ${stats.decryptedOk || 0} decrypted`
        : 'disabled';
    }

    body.innerHTML = `
      <div class="muted" style="margin-bottom:10px">
        Encrypted email over Nostr (kind 1301 + NIP-59 gift wrap). Folder
        management + inbox-relay editing live in the
        <a href="#mail">Mail panel</a>; this section holds the on/off
        switches.
      </div>

      <div class="config-row">
        <div class="k">Status</div>
        <div class="v">
          ${enabled
            ? `<span class="ok">running</span> · ${stats.relaysConnected || 0} inbox relay${(stats.relaysConnected || 0) === 1 ? '' : 's'} connected`
            : `<span class="muted">worker stopped</span>`}
        </div>
      </div>
      <div class="config-row">
        <div class="k">Decrypted</div>
        <div class="v">${stats.decryptedOk || 0}${stats.decryptFailed ? ` · ${stats.decryptFailed} dropped` : ''}</div>
      </div>

      <div class="cfg-toggle-row" style="margin-top:12px">
        <label class="cfg-toggle">
          <input type="checkbox" id="cfg-mail-enabled" ${enabled ? 'checked' : ''}>
          <span>Enable Mail at boot</span>
        </label>
        <div class="muted" style="font-size:11px">
          Starts the inbox worker on station launch. Turning off here also
          stops the running worker immediately.
        </div>
      </div>

      <div class="cfg-toggle-row" style="margin-top:8px">
        <label class="cfg-toggle">
          <input type="checkbox" id="cfg-mail-readsync" ${readSync ? 'checked' : ''}>
          <span>Sync read state across devices</span>
        </label>
        <div class="muted" style="font-size:11px">
          Publishes a NIP-32 (kind 1985) label when you mark mail as read
          so other nostr-station instances on this npub stay in sync.
          Turn off to keep read state local-only.
        </div>
      </div>

      <div class="step-actions" style="margin-top:14px">
        <a class="primary" href="#mail" style="text-decoration:none">Open Mail panel</a>
      </div>
    `;

    $('cfg-mail-enabled')?.addEventListener('change', async (e) => {
      const want = !!e.target.checked;
      try {
        await api('/api/mail/enabled', {
          method:  'PUT',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ enabled: want }),
        });
        toast(want ? 'Mail enabled' : 'Mail disabled',
              want ? 'Inbox worker started.' : 'Inbox worker stopped; will not restart at boot.',
              'ok');
        paintMailConfigSection();
        refreshHealth?.();
      } catch (err) {
        toast('Failed to toggle Mail', err?.message || '', 'err');
        e.target.checked = !want;
      }
    });

    $('cfg-mail-readsync')?.addEventListener('change', async (e) => {
      const want = !!e.target.checked;
      try {
        await api('/api/mail/settings', {
          method:  'PUT',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ readStateSync: want }),
        });
        toast('Saved', want ? 'Read state will sync across devices.' : 'Read state stays local-only.', 'ok');
      } catch (err) {
        toast('Save failed', err?.message || '', 'err');
        e.target.checked = !want;
      }
    });
  }

  function fmtBytes(n) {
    if (!n || n < 0) return '0 B';
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    let i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
  }

  // ── AI providers list ───────────────────────────────────────────────
  //
  // Renders ai-config + registry state from /api/ai/providers. Callers
  // render the list HTML then call wireAiProviders() to attach actions.
  // Keep this in ConfigPanel so the close-over of load() + toast is free.

  // One-liner shown in the AI <details> summary so the user can tell at
  // a glance how many providers are wired up without expanding the
  // section. Falls back gracefully if the API list isn't available.
  function summarizeAi(aiList) {
    if (!aiList || !Array.isArray(aiList.providers)) return 'provider list unavailable';
    const configured = aiList.providers.filter(p => p.configured);
    if (configured.length === 0) return 'no providers configured';
    if (configured.length === 1) return `1 provider · ${configured[0].displayName}`;
    return `${configured.length} providers`;
  }

  // Current accent theme — shown collapsed so users see at-a-glance which
  // colorway is active without expanding Appearance. "ditto" reflects a
  // user-published kind-16767 theme so we surface its title when known.
  function summarizeTheme() {
    const id = getTheme();
    if (id === 'ditto') {
      const t = getDittoTheme();
      return t?.title ? `Ditto · ${t.title}` : 'Ditto';
    }
    const t = THEMES.find(x => x.id === id);
    return t ? t.label : id;
  }

  // About-section at-a-glance: prefers the cached Updates status (already
  // polled by Updates.init() / the 30-min background tick) so the summary
  // line shows "up to date" / "N updates available" without forcing a
  // fresh network round-trip on Config-panel open.
  function summarizeUpdates() {
    try {
      const status = Updates?.lastStatus?.();
      if (!status) return 'updates · check to see';
      if (!status.supported) return 'self-update unavailable';
      if (Updates.anyAvailable(status)) {
        const n = Updates.totalCount(status);
        return `${n} update${n === 1 ? '' : 's'} available`;
      }
      return 'up to date';
    } catch {
      return 'updates · check to see';
    }
  }

  // Install-command callout for terminal-native AIs. Mirrors the
  // Status panel's claude/opencode rows so users who land on Config
  // first (e.g. through the AI summary chip) hit a one-click Install
  // + copy-able curl without bouncing to Status. Rows hide once the
  // binary lights up green in /api/status — keeps the section quiet
  // for users who already have both installed; the whole callout
  // collapses when nothing's missing. Wiring lives in
  // wireAiProviders() via event delegation on .ai-install-go +
  // .ai-install-copy.
  const TERMINAL_AI_INSTALL_HINTS = [
    { name: 'Claude Code', statusId: 'claude',   slug: 'claude-code', cmd: 'curl -fsSL https://claude.ai/install.sh | bash' },
    { name: 'OpenCode',    statusId: 'opencode', slug: 'opencode',    cmd: 'curl -fsSL https://opencode.ai/install | bash' },
  ];

  function renderTerminalInstallHints(statusRows) {
    // statusRows is the /api/status payload; a row with state 'ok'
    // means findBin() resolved the binary. Null payload (pre-status
    // server / fetch failed) → render all rows so users still see
    // the install option rather than hiding it on us.
    const byId = new Map(
      Array.isArray(statusRows) ? statusRows.map(r => [r.id, r]) : []
    );
    const missing = TERMINAL_AI_INSTALL_HINTS.filter(h => {
      const row = byId.get(h.statusId);
      // Render when we can't tell (no row found) OR when state is
      // explicitly not-ok.
      return !row || row.state !== 'ok';
    });
    if (missing.length === 0) return '';
    const rows = missing.map(h => `
      <div class="ai-install-row">
        <span class="ai-install-name">${escapeHtml(h.name)}</span>
        <button class="primary ai-install-go" type="button"
          data-slug="${escapeHtml(h.slug)}"
          data-label="${escapeHtml(h.name)}">Install</button>
        <code class="cmd-inline ai-install-cmd">${escapeHtml(h.cmd)}</code>
        <button class="ai-install-copy" type="button" data-cmd="${escapeHtml(h.cmd)}">copy</button>
      </div>
    `).join('');
    return `
      <div class="ai-install-hints">
        <div class="ai-install-hints-head">Install a terminal-native AI</div>
        <div class="ai-install-hints-body">${rows}</div>
      </div>
    `;
  }

  function renderAiProviders(aiList) {
    if (!aiList || !Array.isArray(aiList.providers)) {
      return `<div style="color:var(--warn);font-size:12px">AI provider list unavailable — server may be pre-Step-4.</div>`;
    }
    // Split into "configured" (shown at top) and "available" (in the Add
    // dropdown). A provider is configured when it has ANY opt-in signal —
    // a keyRef on API, or enabled:true on terminal-native. bareKey locals
    // count as configured only when the user explicitly added them.
    const configured = aiList.providers.filter(p => p.configured);
    const available  = aiList.providers.filter(p => !p.configured);

    const rows = configured.length === 0
      ? `<div class="ai-empty">No AI providers configured yet. Add one below.</div>`
      : configured.map(renderAiRow).join('');

    // Add dropdown grouped by type.
    const termOpts = available.filter(p => p.type === 'terminal-native')
      .map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.displayName)}</option>`).join('');
    const apiOpts = available.filter(p => p.type === 'api')
      .map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.displayName)}</option>`).join('');

    const addSelect = (termOpts || apiOpts) ? `
      <div class="ai-add-row" style="margin-top:12px">
        <select id="ai-add-select" style="min-width:220px">
          <option value="">+ Add a provider…</option>
          ${termOpts ? `<optgroup label="Terminal-native">${termOpts}</optgroup>` : ''}
          ${apiOpts  ? `<optgroup label="API">${apiOpts}</optgroup>` : ''}
        </select>
        <div id="ai-add-customrow" class="ai-add-custom" style="display:none;margin-top:8px;display:none">
          <div class="np-hint" style="margin-bottom:8px">
            Custom Provider — point at any OpenAI-compatible endpoint.
            Examples: <code>https://api.openai.com/v1</code>,
            <code>https://api.groq.com/openai/v1</code>,
            <code>http://localhost:11434/v1</code> (Ollama).
          </div>
          <label class="field-label">Base URL</label>
          <input id="ai-add-baseurl" type="text" autocomplete="off" placeholder="https://api.example.com/v1">
          <label class="field-label">Default model id</label>
          <input id="ai-add-model" type="text" autocomplete="off" placeholder="gpt-4o-mini, llama3.2, etc.">
        </div>
        <div id="ai-add-keyrow" class="keyrow" style="margin-top:8px;display:none">
          <div class="keyfield">
            <input id="ai-add-key" type="password" autocomplete="off" placeholder="paste provider key (sk-…)">
            <button class="eye" id="ai-add-eye" aria-label="toggle visibility" type="button">
              <svg viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>
            </button>
          </div>
          <button class="primary" id="ai-add-save" type="button">add</button>
          <button id="ai-add-cancel" type="button">cancel</button>
        </div>
        <div class="np-hint" id="ai-add-keyhint" style="margin-top:6px;display:none">
          For local daemons that don't need a key, type <code>none</code>.
        </div>
      </div>
    ` : '';

    return `
      <div class="ai-providers-list" id="ai-providers-list">${rows}</div>
      ${addSelect}
    `;
  }

  function renderAiRow(p) {
    const typeLabel  = p.type === 'terminal-native' ? 'terminal' : 'api';
    const typeClass  = p.type === 'terminal-native' ? 'term' : 'api';
    const isChatDef  = !!p.isDefault?.chat;
    const isTermDef  = !!p.isDefault?.terminal;
    // Action buttons — only show "set default" when it's not already set
    // AND the provider type matches (chat defaults are API-only; terminal
    // defaults are terminal-native only). "Fetch models" lives on API
    // rows and pulls the live list from /v1/models, caching into
    // ai-config.knownModels for the Chat pane's dropdown.
    const actions = [];
    if (p.type === 'api') {
      actions.push(`<button class="ai-fetch-models" data-id="${escapeHtml(p.id)}">Fetch models</button>`);
    }
    if (p.type === 'api' && !isChatDef) {
      actions.push(`<button class="ai-set-default" data-kind="chat" data-id="${escapeHtml(p.id)}">Use for Chat</button>`);
    }
    if (p.type === 'terminal-native' && !isTermDef) {
      actions.push(`<button class="ai-set-default" data-kind="terminal" data-id="${escapeHtml(p.id)}">Use for Terminal</button>`);
    }
    actions.push(`<button class="danger ai-remove" data-id="${escapeHtml(p.id)}">Remove</button>`);

    const badges = [];
    badges.push(`<span class="ai-badge type-${typeClass}">${typeLabel}</span>`);
    // Status badge — three distinct states so bareKey locals don't claim
    // to have a key that never existed:
    //   api + keyRef    → "key set"
    //   api + bareKey   → "local"
    //   terminal-native → "enabled"
    if (p.type === 'api' && p.hasKey) {
      badges.push(`<span class="ai-badge status-ok">✓ key set</span>`);
    } else if (p.type === 'api' && p.bareKey) {
      badges.push(`<span class="ai-badge status-ok">local</span>`);
    } else if (p.type === 'terminal-native') {
      badges.push(`<span class="ai-badge status-ok">enabled</span>`);
    } else {
      // Edge case: api provider in config but no keyRef and no bareKey.
      // Shouldn't happen normally, but badge something so users know
      // they need to set a key.
      badges.push(`<span class="ai-badge">needs key</span>`);
    }
    if (isChatDef)  badges.push(`<span class="ai-badge default">chat default</span>`);
    if (isTermDef)  badges.push(`<span class="ai-badge default">terminal default</span>`);

    const model = p.model ? `<span class="ai-model">${escapeHtml(p.model)}</span>` : '';

    return `
      <div class="ai-provider-row" data-id="${escapeHtml(p.id)}" data-type="${typeClass}">
        <div class="ai-provider-head">
          <span class="ai-provider-name">${escapeHtml(p.displayName)}</span>
          ${badges.join('')}
        </div>
        ${model ? `<div class="ai-provider-meta">${model}</div>` : ''}
        <div class="ai-provider-actions">${actions.join('')}</div>
      </div>
    `;
  }

  function wireAiProviders(aiList) {
    // Copy buttons for the static "Install a terminal-native AI" hints —
    // these live in the AI section header, outside ai-providers-list, so
    // they need their own delegation point. Section body is stable across
    // provider-list re-renders, so binding here is one-shot per Config
    // panel mount.
    const aiSection = document.getElementById('cfg-ai-section');
    if (aiSection && !aiSection.dataset.installHintsWired) {
      aiSection.dataset.installHintsWired = '1';
      aiSection.addEventListener('click', async (e) => {
        // One-click Install — fires the same SSE modal the Status panel
        // uses, then refreshes health on close so the AI section's
        // provider state catches up (terminal-native rows light up as
        // "enabled" once the binary is on PATH).
        const goBtn = e.target.closest('button.ai-install-go');
        if (goBtn) {
          const slug  = goBtn.dataset.slug;
          const label = goBtn.dataset.label || slug;
          if (!slug) return;
          openExecModal({
            title:    `Install ${label}`,
            subtitle: `Installing ${slug}…`,
            endpoint: `/api/exec/install/${slug}`,
          }).then(r => {
            if (r.ok) toast(`${label} install finished`, '', 'ok');
            else      toast(`${label} install exited ${r.code}`, '', 'err');
            refreshHealth();
            // Drop the providers + status caches and re-render Config
            // → AI so the newly-installed binary flips green and the
            // install-hint row disappears in the same tick instead of
            // waiting for the 30s apiCached TTL.
            apiInvalidate('/api/ai/providers');
            apiInvalidate('/api/status');
            load();
            [30_000, 120_000, 300_000].forEach(ms => setTimeout(refreshHealth, ms));
          });
          return;
        }
        const copyHintBtn = e.target.closest('button.ai-install-copy');
        if (copyHintBtn) {
          const cmd = copyHintBtn.dataset.cmd;
          if (!cmd) return;
          try {
            await navigator.clipboard.writeText(cmd);
            toast('Copied', cmd, 'ok');
          } catch {
            toast('Copy failed', 'select the command and copy manually', 'warn');
          }
          return;
        }
      });
    }

    // Row-level actions (Remove, Set-default) via event delegation —
    // renderAiProviders re-renders the whole list on every change, so
    // keeping listeners on the container dodges the re-bind dance.
    const list = $('ai-providers-list');
    if (list) {
      list.addEventListener('click', async (e) => {
        const btn = e.target.closest('button');
        if (!btn) return;
        const id = btn.dataset.id;
        if (!id) return;
        if (btn.classList.contains('ai-remove')) {
          const ok = await confirmDestructive({
            title: `Remove ${id}?`,
            description: 'Deletes the keychain entry (if any) and removes it from the provider list.',
            confirmLabel: 'Remove',
          });
          if (!ok) return;
          await removeAiProvider(id);
          return;
        }
        if (btn.classList.contains('ai-set-default')) {
          await setAiDefault(btn.dataset.kind, id);
          return;
        }
        if (btn.classList.contains('ai-fetch-models')) {
          await fetchModelsForProvider(id, btn);
          return;
        }
      });
    }

    // Add dropdown — selecting a terminal-native provider adds it
    // directly (no key needed). Selecting an API provider reveals the
    // inline key input.
    const sel = $('ai-add-select');
    if (!sel) return;
    const keyRow      = $('ai-add-keyrow');
    const keyInput    = $('ai-add-key');
    const keyEye      = $('ai-add-eye');
    const keyHint     = $('ai-add-keyhint');
    const customRow   = $('ai-add-customrow');
    const baseUrlInp  = $('ai-add-baseurl');
    const modelInp    = $('ai-add-model');
    const saveBtn     = $('ai-add-save');
    const cancelBtn   = $('ai-add-cancel');

    function hideAdd() {
      keyRow.style.display = 'none';
      if (customRow) customRow.style.display = 'none';
      if (keyHint)   keyHint.style.display   = 'none';
    }
    hideAdd();

    sel.addEventListener('change', async () => {
      const id = sel.value;
      if (!id) { hideAdd(); return; }
      // Find the chosen provider's type by matching against the current
      // aiList closure — cheap linear search is fine, <20 entries.
      const chosen = (aiList?.providers || []).find(x => x.id === id);
      if (!chosen) { hideAdd(); return; }

      if (chosen.type === 'terminal-native') {
        // No key. Enable immediately.
        await enableTerminalProvider(id);
        sel.value = '';
      } else if (chosen.bareKey) {
        // bareKey providers don't need a real key — adding them just
        // means creating an ai-config entry so they appear in the Chat
        // dropdown. Server fills in the bareKey sentinel at request
        // time. (No curated provider currently sets bareKey, but the
        // registry shape supports it.)
        await addBareKeyProvider(id);
        sel.value = '';
      } else {
        // Show key input — user types, hits save.
        keyRow.style.display = '';
        keyInput.value = '';
        keyInput.type  = 'password';
        if (id === 'custom') {
          // Custom Provider needs baseUrl + model id alongside the key.
          // Pre-fill from the registry default if any (empty for custom).
          customRow.style.display = '';
          baseUrlInp.value = chosen.baseUrl || '';
          modelInp.value   = chosen.model   || '';
          if (keyHint) keyHint.style.display = '';
          baseUrlInp.focus();
        } else {
          customRow.style.display = 'none';
          if (keyHint) keyHint.style.display = 'none';
          keyInput.focus();
        }
      }
    });

    keyEye?.addEventListener('click', () => {
      keyInput.type = keyInput.type === 'password' ? 'text' : 'password';
    });

    saveBtn?.addEventListener('click', async () => {
      const id  = sel.value;
      const key = keyInput.value;
      if (!id || !key) return;

      // Custom Provider: baseUrl is required (registry has no default).
      // Model is strongly recommended; if the user leaves it blank we
      // still save — they can set it later via Fetch Models.
      if (id === 'custom') {
        const baseUrl = (baseUrlInp.value || '').trim();
        if (!baseUrl) {
          toast('Base URL required', 'Custom Provider needs an OpenAI-compat endpoint URL.', 'warn');
          return;
        }
        if (!/^https?:\/\//i.test(baseUrl)) {
          toast('Bad base URL', 'Must start with http:// or https://', 'warn');
          return;
        }
      }

      saveBtn.disabled = true;
      try {
        // For Custom Provider, persist baseUrl + model FIRST so the
        // entry exists when the key-save below references it. POST
        // /api/ai/config is keyRef-safe (rejects keys), so this is
        // a clean two-step.
        if (id === 'custom') {
          const baseUrl = baseUrlInp.value.trim();
          const model   = modelInp.value.trim();
          await api('/api/ai/config', {
            method:  'POST',
            headers: { 'content-type': 'application/json' },
            body:    JSON.stringify({
              providers: { [id]: { baseUrl, ...(model ? { model } : {}) } },
            }),
          });
        }
        const r = await api(`/api/ai/providers/${encodeURIComponent(id)}/key`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ key }),
        });
        if (!r.ok) throw new Error(r.error || 'save failed');
        toast('Provider added', id, 'ok');
        // Notify the Chat panel so its populateProvider() re-runs. Without
        // this, the Chat pane stays stuck on the "No AI provider configured"
        // callout until the next full page reload — populateProvider is
        // `initialized`-guarded so plain panel re-entry doesn't refresh.
        // setAiDefault below also dispatches this, but only fires when
        // there's no existing chat default (fresh install). A returning
        // user adding a second key (or fixing a keyless entry the wizard
        // left behind with defaults.chat already set) needs the dispatch here too.
        document.dispatchEvent(new CustomEvent('api-config-changed'));
        // If no chat default yet, this one becomes it so users with a
        // fresh install get working chat immediately after adding their
        // first API provider. Server-side rule would be stricter; client
        // opts in explicitly.
        const list2 = await api('/api/ai/providers');
        if (!list2?.defaults?.chat) await setAiDefault('chat', id);
        load();
      } catch (e) {
        toast('Add failed', e.message, 'err');
      }
      saveBtn.disabled = false;
    });

    cancelBtn?.addEventListener('click', () => {
      hideAdd();
      sel.value = '';
      keyInput.value = '';
      if (baseUrlInp) baseUrlInp.value = '';
      if (modelInp)   modelInp.value   = '';
    });
  }

  // Provider ids that accept a sentinel / empty key and don't need a
  // keychain entry. Derived from the live /api/ai/providers payload
  // (each entry carries `bareKey: true|false`). The curated registry
  // currently has no bareKey providers — kept as a helper because the
  // registry shape supports them, and the setup wizard pre-loads its
  // own provider list earlier than this helper runs.
  function isBareKeyProvider(id, list) {
    const p = (list?.providers || []).find(x => x.id === id);
    return !!(p && p.bareKey);
  }

  async function addBareKeyProvider(id) {
    try {
      await api('/api/ai/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ providers: { [id]: {} } }),  // presence = opted-in
      });
      // Auto-set as chat default if none is set.
      const list2 = await api('/api/ai/providers');
      if (!list2?.defaults?.chat) await setAiDefault('chat', id);
      toast('Provider added', id, 'ok');
      load();
    } catch (e) {
      toast('Add failed', e.message, 'err');
    }
  }

  async function enableTerminalProvider(id) {
    try {
      await api('/api/ai/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ providers: { [id]: { enabled: true } } }),
      });
      // Auto-set as terminal default if none is set yet.
      const list2 = await api('/api/ai/providers');
      if (!list2?.defaults?.terminal) await setAiDefault('terminal', id);
      toast('Provider enabled', id, 'ok');
      load();
    } catch (e) {
      toast('Enable failed', e.message, 'err');
    }
  }

  // ── Templates registry section ──────────────────────────────────────
  //
  // Renders the Project Templates list under the AI Providers section.
  // Builtins (currently MKStack) get a "Reset" affordance instead of
  // "Delete" — readTemplates() guarantees they always exist on disk so
  // delete is a server-rejected no-op anyway. User-added templates get
  // edit + delete; new ones are added via the inline form.

  async function refreshTemplates() {
    const root    = $('cfg-templates-list');
    const summary = $('cfg-templates-summary');
    if (!root) return;
    let templates = [];
    try {
      const r = await api('/api/templates');
      templates = Array.isArray(r?.templates) ? r.templates : [];
    } catch (e) {
      root.innerHTML = `<div style="color:var(--warn);font-size:12px">Failed to load templates: ${escapeHtml(e.message)}</div>`;
      if (summary) summary.textContent = 'unavailable';
      return;
    }
    if (summary) {
      summary.textContent = templates.length
        ? `${templates.length} template${templates.length === 1 ? '' : 's'}`
        : 'none';
    }
    root.innerHTML = renderTemplatesList(templates);
    wireTemplatesList(root, templates);
  }

  function renderTemplatesList(templates) {
    const cards = templates.map(renderTemplateCard).join('');
    return `
      <div class="tmpl-list">${cards}</div>
      <details class="tmpl-add" style="margin-top:14px">
        <summary style="cursor:pointer;color:var(--accent)">+ Add Project Template</summary>
        <div class="tmpl-add-form" style="margin-top:10px;display:flex;flex-direction:column;gap:8px;max-width:560px">
          <label class="np-field">
            <span class="np-label">ID</span>
            <input class="tmpl-new-id" type="text" placeholder="my-template" autocomplete="off" />
            <div class="np-hint">Lowercase letters, digits, dashes. Used as the registry key.</div>
          </label>
          <label class="np-field">
            <span class="np-label">Name</span>
            <input class="tmpl-new-name" type="text" placeholder="My Template" autocomplete="off" />
          </label>
          <label class="np-field">
            <span class="np-label">Description</span>
            <textarea class="tmpl-new-desc" rows="3" placeholder="What this template is for. The AI sees this text when picking a template."></textarea>
          </label>
          <label class="np-field">
            <span class="np-label">Git URL</span>
            <input class="tmpl-new-url" type="text" placeholder="https://github.com/you/template.git" autocomplete="off" />
          </label>
          <div style="display:flex;gap:8px;justify-content:flex-end">
            <button class="primary tmpl-new-save" type="button">Add template</button>
          </div>
        </div>
      </details>
    `;
  }

  function renderTemplateCard(t) {
    const sourceLabel = t.source?.type === 'git-url'
      ? `<code class="cmd-inline">${escapeHtml(t.source.url)}</code>`
      : '<em>local-only (blank canvas)</em>';
    const builtinChip = t.builtin
      ? '<span class="chip" style="background:var(--accent-soft);color:var(--accent);margin-left:8px">built-in</span>'
      : '';
    const actions = t.builtin
      ? `<button class="tmpl-edit" data-id="${escapeHtml(t.id)}">Edit</button>
         <button class="tmpl-reset" data-id="${escapeHtml(t.id)}">Reset</button>`
      : `<button class="tmpl-edit" data-id="${escapeHtml(t.id)}">Edit</button>
         <button class="danger tmpl-delete" data-id="${escapeHtml(t.id)}">Delete</button>`;
    return `
      <div class="tmpl-card" data-id="${escapeHtml(t.id)}">
        <div class="tmpl-head">
          <div class="tmpl-name">${escapeHtml(t.name)}${builtinChip}</div>
          <div class="tmpl-id" style="color:var(--text-dim);font-size:11px"><code>${escapeHtml(t.id)}</code></div>
        </div>
        <div class="tmpl-desc" style="font-size:12px;color:var(--text-dim);margin-top:6px;white-space:pre-wrap">${escapeHtml(t.description)}</div>
        <div class="tmpl-source" style="margin-top:8px;font-size:11px">${sourceLabel}</div>
        <div class="tmpl-actions" style="margin-top:10px;display:flex;gap:6px">${actions}</div>
      </div>
    `;
  }

  function wireTemplatesList(root, templates) {
    root.querySelectorAll('.tmpl-edit').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id;
        const t = templates.find(x => x.id === id);
        if (t) openEditTemplateModal(t);
      });
    });
    root.querySelectorAll('.tmpl-delete').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        if (!confirm(`Delete template "${id}"?`)) return;
        try {
          await api(`/api/templates/${encodeURIComponent(id)}`, { method: 'DELETE' });
          toast('Template deleted', id, 'ok');
          refreshTemplates();
        } catch (e) {
          toast('Delete failed', e.message, 'err');
        }
      });
    });
    root.querySelectorAll('.tmpl-reset').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        if (!confirm(`Reset built-in template "${id}" to its default values? Your edits will be lost.`)) return;
        try {
          await api(`/api/templates/${encodeURIComponent(id)}/reset`, { method: 'POST' });
          toast('Template reset', id, 'ok');
          refreshTemplates();
        } catch (e) {
          toast('Reset failed', e.message, 'err');
        }
      });
    });

    // Add form submit.
    const saveBtn = root.querySelector('.tmpl-new-save');
    if (saveBtn) {
      saveBtn.addEventListener('click', async () => {
        const id   = root.querySelector('.tmpl-new-id')?.value.trim() || '';
        const name = root.querySelector('.tmpl-new-name')?.value.trim() || '';
        const desc = root.querySelector('.tmpl-new-desc')?.value.trim() || '';
        const url  = root.querySelector('.tmpl-new-url')?.value.trim() || '';
        if (!id || !name || !desc || !url) {
          toast('All fields required', '', 'warn');
          return;
        }
        const body = {
          id, name, description: desc,
          source: { type: 'git-url', url },
        };
        try {
          await api('/api/templates', {
            method:  'POST',
            headers: { 'content-type': 'application/json' },
            body:    JSON.stringify(body),
          });
          toast('Template added', id, 'ok');
          refreshTemplates();
        } catch (e) {
          toast('Add failed', e.message, 'err');
        }
      });
    }
  }

  function openEditTemplateModal(t) {
    const body = document.createElement('div');
    body.className = 'tmpl-edit-form';
    body.style.display = 'flex';
    body.style.flexDirection = 'column';
    body.style.gap = '10px';
    body.innerHTML = `
      <label class="np-field">
        <span class="np-label">Name</span>
        <input class="tmpl-edit-name" type="text" value="${escapeHtml(t.name)}" autocomplete="off" />
      </label>
      <label class="np-field">
        <span class="np-label">Description</span>
        <textarea class="tmpl-edit-desc" rows="5">${escapeHtml(t.description)}</textarea>
      </label>
      ${t.source?.type === 'git-url' ? `
      <label class="np-field">
        <span class="np-label">Git URL</span>
        <input class="tmpl-edit-url" type="text" value="${escapeHtml(t.source.url)}" autocomplete="off" />
      </label>
      ` : ''}
      <div class="np-hint">ID and source type are immutable. To change them, delete this template and create a new one.</div>
    `;

    const foot = document.createElement('div');
    foot.style.display = 'flex';
    foot.style.gap = '8px';
    foot.style.justifyContent = 'flex-end';
    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    const saveBtn = document.createElement('button');
    saveBtn.className = 'primary';
    saveBtn.textContent = 'Save';
    foot.appendChild(cancelBtn);
    foot.appendChild(saveBtn);

    const modal = openModal({
      title: `Edit template: ${t.name}`,
      subtitle: t.builtin ? 'Built-in template — editable; click Reset to restore defaults.' : 'User-added template',
      body, footer: foot,
    });
    cancelBtn.addEventListener('click', () => modal.close());
    saveBtn.addEventListener('click', async () => {
      const patch = {
        name:        body.querySelector('.tmpl-edit-name')?.value.trim() || t.name,
        description: body.querySelector('.tmpl-edit-desc')?.value.trim() || t.description,
      };
      const urlEl = body.querySelector('.tmpl-edit-url');
      if (urlEl) {
        patch.source = { type: 'git-url', url: urlEl.value.trim() };
      }
      try {
        await api(`/api/templates/${encodeURIComponent(t.id)}`, {
          method:  'PATCH',
          headers: { 'content-type': 'application/json' },
          body:    JSON.stringify(patch),
        });
        toast('Template updated', t.id, 'ok');
        modal.close();
        refreshTemplates();
      } catch (e) {
        toast('Update failed', e.message, 'err');
      }
    });
  }

  async function setAiDefault(kind, id) {
    try {
      await api('/api/ai/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ defaults: { [kind]: id } }),
      });
      toast(`${kind} default set`, id, 'ok');
      document.dispatchEvent(new CustomEvent('api-config-changed'));
      load();
    } catch (e) {
      toast('Default update failed', e.message, 'err');
    }
  }

  async function fetchModelsForProvider(id, btn) {
    // Visual feedback — the round trip can take a few seconds on
    // Anthropic, and silent hangs feel broken.
    const orig = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Fetching…';
    try {
      const r = await api(`/api/ai/providers/${encodeURIComponent(id)}/models`);
      const count = Array.isArray(r?.models) ? r.models.length : 0;
      if (count === 0) throw new Error('no models returned');
      toast(`${id}: ${count} models`, r.models.slice(0, 3).join(', ') + (count > 3 ? '…' : ''), 'ok');
      // The server already persisted knownModels into ai-config.json;
      // our client cache needs to drop so the Chat dropdown re-reads
      // from disk on its next populate call.
      invalidateAiCfg();
      document.dispatchEvent(new CustomEvent('api-config-changed'));
      // No full panel re-render needed — the list membership hasn't
      // changed, just the per-provider model data.
    } catch (e) {
      toast('Fetch failed', e.message || String(e), 'err');
    }
    btn.disabled = false;
    btn.textContent = orig;
  }

  async function removeAiProvider(id) {
    try {
      // Clear the key first (no-op for terminal-native; idempotent for
      // already-missing entries). Then strip the config entry so it
      // disappears from the list. {silent:true} suppresses the api()
      // helper's auto-toast for the expected 400 on terminal-native
      // providers — the server rejects key ops on those by design, and
      // the user's already seen the success toast from the config strip.
      await api(`/api/ai/providers/${encodeURIComponent(id)}/key`, { method: 'DELETE' }, { silent: true })
        .catch(() => {});
      await api('/api/ai/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ providers: { [id]: null } }),
      });
      toast('Provider removed', id, 'ok');
      document.dispatchEvent(new CustomEvent('api-config-changed'));
      load();
    } catch (e) {
      toast('Remove failed', e.message, 'err');
    }
  }

  async function addReadRelayFromInput() {
    const url = $('read-relay-input').value.trim();
    if (!url) return;
    try {
      const r = await api('/api/identity/relays/add', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      if (!r.ok) throw new Error(r.error || 'add failed');
      toast('Relay added', url, 'ok');
      load();
    } catch (e) { toast('Add failed', e.message, 'err'); }
  }

  async function removeReadRelay(url) {
    try {
      await api('/api/identity/relays/remove', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      toast('Relay removed', url, 'ok');
      load();
    } catch (e) { toast('Remove failed', e.message, 'err'); }
  }

  // Grasp server list — POST /api/identity/grasp/{add,remove}. Same
  // contract as read-relays (returns the new list); we just reload
  // the panel so the markup re-renders from /api/identity/config.
  async function addGraspServerFromInput() {
    const url = $('grasp-server-input').value.trim();
    if (!url) return;
    try {
      const r = await api('/api/identity/grasp/add', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      if (!r.ok) throw new Error(r.error || 'add failed');
      toast('Grasp server added', url, 'ok');
      load();
    } catch (e) { toast('Add failed', e.message, 'err'); }
  }

  async function removeGraspServerFromList(url) {
    try {
      await api('/api/identity/grasp/remove', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      toast('Grasp server removed', url, 'ok');
      load();
    } catch (e) { toast('Remove failed', e.message, 'err'); }
  }

  async function saveRelayFlag(key, value) {
    try {
      const body = key === 'auth' ? { auth: value } : { dmAuth: value };
      const r = await api('/api/relay-config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error((r.errors || []).join('; ') || 'save failed');
      relayApplyToast(
        `${key === 'auth' ? 'NIP-42' : 'DM'} auth ${value ? 'enabled' : 'disabled'}`,
        r,
      );
    } catch (e) { toast('Save failed', e.message, 'err'); load(); }
  }

  // About section — manual update check. Server-side poll runs every
  // 30 min; this button forces an immediate re-poll so the user doesn't
  // have to wait. Result renders inline. When updates are available, an
  // Install button hands off to the shared Updates.openModal flow so
  // the UX is identical to clicking the header pill.
  function wireCheckUpdates() {
    const btn = $('cfg-check-updates');
    const result = $('cfg-updates-result');
    if (!btn || !result) return;
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const prev = btn.textContent;
      btn.textContent = 'Checking…';
      result.textContent = '';
      result.className = 'cfg-updates-result';
      try {
        const status = await Updates.refresh(true);
        if (!status) {
          result.textContent = 'Check failed — see console.';
          result.classList.add('err');
          return;
        }
        if (!status.supported) {
          result.textContent = 'Self-update is unavailable (install is not a git checkout).';
          result.classList.add('warn');
          return;
        }
        if (status.lastError) {
          result.textContent = `Check failed: ${status.lastError}`;
          result.classList.add('err');
          return;
        }
        if (Updates.anyAvailable(status)) {
          const n = Updates.totalCount(status);
          result.innerHTML = `<span class="ok-strong">${n} update${n === 1 ? '' : 's'} available</span> `;
          const install = document.createElement('button');
          install.className = 'primary';
          install.textContent = 'Install update';
          install.addEventListener('click', () => Updates.openModal(status));
          result.appendChild(install);
        } else {
          result.textContent = 'You’re up to date.';
          result.classList.add('ok');
        }
      } finally {
        btn.disabled = false;
        btn.textContent = prev;
      }
    });
  }

  // Keep the collapsed About-section summary in sync with the latest
  // Updates poll. Registered once at module load so subsequent panel
  // re-renders (which only swap `container.innerHTML`) don't leak
  // listeners. The summary element may not exist yet — we just no-op
  // when it isn't mounted.
  document.addEventListener('updates-status-changed', () => {
    const summary = $('cfg-about-summary');
    if (summary) summary.textContent = summarizeUpdates();
  });

  return {
    onEnter() { load(); },
    reload: load,
    // Background callers that mutate Config-shaped state (e.g. the
    // ngit-login terminal-flow retry schedule) use this to defer the
    // panel rebuild until the user is actually on Config. See loadIfVisible.
    reloadIfVisible: loadIfVisible,
    // Re-paint only the Blossom subsection — used when the user toggled
    // enable/disable from the Dashboard card and the Config panel
    // happens to be mounted. Lockstep update across the three surfaces
    // (Dashboard card / sidebar Health / this section).
    refreshBlossomSection: paintBlossomConfigSection,
    refreshMailSection:    paintMailConfigSection,
    isDirty() { return dirty; },
    // Re-exported so the Dashboard's Identity card can drive the same
    // follower / following lookup without duplicating the helper.
    fetchProfileStats,
    // Lets callers bust the (hex, relay-set) memoize — the Status panel's
    // explicit refresh button uses this so a click actually re-queries.
    clearProfileStatsCache() {
      _profileStatsCache.clear();
      _profileStatsInflight.clear();
    },
  };
})();

// ── Auth screen ──────────────────────────────────────────────────────────
//
// Full-viewport overlay shown whenever /api/auth/status reports the user
// isn't authenticated. Offers three sign-in paths:
//   1. NIP-07 browser extension (Alby, nos2x, ...) — when window.nostr exists
//   2. Amber QR (nostrconnect://) — server-generated URI + SVG QR, polled
//   3. Bunker URL paste (nsecBunker, Keycast, ...) — POSTed to /api/auth/bunker-url
//
// The screen also handles the "no npub configured" bootstrap case by showing
// an inline npub input that POSTs /api/identity/set (same route as the
// identity drawer setup flow).

AuthScreen = (() => {
  const root = $('auth-root');
  let pollTimer = null;
  let pollAbort = null;

  // QR session is pinned for the lifetime of the screen: one POST to
  // /api/auth/bunker-connect per displayed code. Polling, tab switching,
  // and section collapse all reuse the same ephemeralPubkey. Only an
  // explicit refresh, a timeout/error, or a successful sign-in drops it.
  //
  // Shape: { ephemeralPubkey, qrSvg, nostrconnectUri, expiresAt, challenge }
  let qrSession = null;

  function detectExtension() {
    if (typeof window === 'undefined' || !window.nostr) return null;
    // Lightweight fingerprint — extensions patch window in predictable ways.
    if (window.alby)   return 'Alby';
    if (window.nos2x)  return 'nos2x';
    return 'extension';
  }

  function show() {
    stopPoll();
    root.hidden = false;
    render();
  }

  function hide() {
    stopPoll();
    root.hidden = true;
    root.innerHTML = '';
  }

  function stopPoll() {
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    if (pollAbort) { pollAbort.abort(); pollAbort = null; }
  }

  async function render() {
    let status;
    try { status = await fetch('/api/auth/status').then(r => r.json()); }
    catch {
      root.innerHTML = `<div class="auth-card">
        <div class="auth-head">
          <img class="nori" src="/nori.svg" alt="">
          <div>
            <div class="wordmark">nostr-station</div>
            <div class="subtitle" style="color:var(--error)">Server unreachable</div>
          </div>
        </div>
      </div>`;
      return;
    }

    if (status.authenticated) {
      // Either a session was restored (server has our token) or localhost
      // exemption is in effect. Tear down the auth screen and hand off.
      hide();
      bootDashboard(status.localhostExempt);
      return;
    }

    if (!status.configured) {
      renderSetup();
    } else {
      renderSignIn(status.npub);
    }
  }

  // ── npub setup (shown when identity.json has no npub) ────────────────
  function renderSetup() {
    root.innerHTML = `
      <div class="auth-card">
        <div class="auth-head">
          <img class="nori" src="/nori.svg" alt="">
          <div>
            <div class="wordmark">nostr-station</div>
            <div class="subtitle">Sign in to continue</div>
          </div>
        </div>
        <div class="auth-warn">No identity configured. Set your npub first.</div>
        <div class="auth-setup">
          <label>Your npub</label>
          <input id="auth-npub-input" placeholder="npub1…" autocomplete="off" spellcheck="false">
          <div class="actions">
            <button id="auth-npub-paste">paste</button>
            <button class="primary" id="auth-npub-save">save</button>
          </div>
        </div>
        <div class="auth-footnote">
          Or visit <code>/setup</code> for the Amber QR pairing wizard
          (ngit, Amber, relays in one flow).
        </div>
      </div>
    `;
    $('auth-npub-paste').addEventListener('click', async () => {
      try { $('auth-npub-input').value = (await navigator.clipboard.readText()).trim(); }
      catch { toast('Clipboard blocked', 'paste manually', 'warn'); }
    });
    const save = async () => {
      const val = $('auth-npub-input').value.trim();
      if (!val) return;
      try {
        // /api/identity/set is public-ish here: without an npub configured
        // there's no station owner yet, so the bootstrap write is allowed.
        // (The route requires auth post-configuration — intentional: once
        // a station owner exists, only they can rotate the npub.)
        const r = await fetch('/api/identity/set', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ npub: val }),
        }).then(r => r.json());
        if (!r.ok) throw new Error(r.error || 'save failed');
        toast('Identity saved', val, 'ok');
        render();
      } catch (e) {
        toast('Save failed', e.message, 'err');
      }
    };
    $('auth-npub-save').addEventListener('click', save);
    $('auth-npub-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
  }

  // ── Sign-in options ──────────────────────────────────────────────────
  function renderSignIn(npub) {
    const ext = detectExtension();
    const truncated = truncNpub(npub);

    root.innerHTML = `
      <div class="auth-card">
        <div class="auth-head">
          <img class="nori" src="/nori.svg" alt="">
          <div>
            <div class="wordmark">nostr-station</div>
            <div class="subtitle">Sign in to continue</div>
          </div>
        </div>
        <div class="auth-owner">
          <div class="avatar" id="auth-owner-avatar">${pixelAvatar(npub, 32)}</div>
          <div class="meta">
            <div class="role">Station owner</div>
            <div class="name" id="auth-owner-name">${escapeHtml(truncated)}</div>
            <div class="nip05" id="auth-owner-nip05" hidden></div>
            <div class="npub muted" id="auth-owner-npub" hidden>${escapeHtml(truncated)}</div>
          </div>
        </div>

        ${ext ? `
          <button class="primary auth-primary-btn" id="auth-ext-btn">
            Sign in with ${escapeHtml(ext === 'extension' ? 'browser extension' : ext)}
          </button>
          <div class="auth-status-line" id="auth-ext-status" style="display:none"></div>
        ` : `
          <div class="auth-warn" style="color:var(--text-dim);background:var(--bg-elev);border-color:var(--border)">
            No browser extension detected — install
            <a href="https://getalby.com" target="_blank" rel="noreferrer">Alby</a>
            or <a href="https://github.com/fiatjaf/nos2x" target="_blank" rel="noreferrer">nos2x</a>
            for one-click sign-in, or use Amber below.
          </div>
        `}

        <div class="auth-section ${ext ? 'collapsed' : ''}" id="auth-bunker-section">
          <div class="auth-section-head">
            <h4 style="margin:0">Sign in with Amber or bunker</h4>
            <span class="chev">▾</span>
          </div>
          <div class="auth-section-body" style="margin-top:12px">
            <div class="auth-tabs">
              <button data-tab="qr" class="active">Scan QR (Amber)</button>
              <button data-tab="url">Paste bunker URL</button>
            </div>
            <div id="auth-bunker-body"></div>
          </div>
        </div>

        <div class="auth-footnote">
          nostr-station never stores your nsec. Signing happens in your
          extension, phone (Amber), or bunker service.
        </div>
      </div>
    `;

    if (ext) {
      $('auth-ext-btn').addEventListener('click', () => signInWithExtension(ext));
    }

    // Collapsible bunker section
    const section = $('auth-bunker-section');
    section.querySelector('.auth-section-head').addEventListener('click', () => {
      const collapsed = section.classList.toggle('collapsed');
      if (!collapsed) activateTab(section.querySelector('.auth-tabs button.active').dataset.tab);
      else stopPoll();
    });

    // Tab switching
    section.querySelectorAll('.auth-tabs button').forEach(btn => {
      btn.addEventListener('click', () => {
        section.querySelectorAll('.auth-tabs button').forEach(b => b.classList.toggle('active', b === btn));
        activateTab(btn.dataset.tab);
      });
    });

    if (!ext) {
      // No extension → expand bunker section and default to QR tab.
      activateTab('qr');
    }

    hydrateOwnerProfile(npub);
  }

  // Fetch kind-0 metadata for the configured owner and swap the placeholder
  // avatar / truncated-npub for the real picture + display name + NIP-05.
  // Endpoint is the same one the setup wizard preview uses; it's pre-auth
  // safe and the server already sanitizes picture URLs via safeHttpUrl.
  async function hydrateOwnerProfile(npub) {
    if (!npub) return;
    let p;
    try {
      const res = await fetch(`/api/identity/profile/preview?npub=${encodeURIComponent(npub)}`);
      if (!res.ok) return;
      p = await res.json();
    } catch { return; }
    if (!p || p.error || p.empty) return;

    // DOM may have been torn down (successful sign-in races with the fetch).
    const avatarEl = $('auth-owner-avatar');
    const nameEl   = $('auth-owner-name');
    const nip05El  = $('auth-owner-nip05');
    const npubEl   = $('auth-owner-npub');
    if (!avatarEl || !nameEl) return;

    if (p.picture) {
      avatarEl.innerHTML =
        `<img src="${escapeHtml(p.picture)}" alt="" width="32" height="32">`;
    }
    if (p.name) {
      nameEl.textContent = p.name;
      // Move the truncated npub to its own line so the display name is primary.
      if (npubEl) npubEl.hidden = false;
    }
    if (p.nip05 && nip05El) {
      nip05El.hidden = false;
      nip05El.innerHTML = escapeHtml(p.nip05) +
        (p.nip05Verified ? ' <span class="ok">✓</span>' : '');
    }
  }

  function activateTab(tab) {
    // Tab switches pause polling but do NOT invalidate qrSession — a user
    // glancing at "Paste bunker URL" and coming back to QR should see the
    // same code, not a regenerated one.
    stopPoll();
    const body = $('auth-bunker-body');
    if (!body) return;
    if (tab === 'qr')  renderQrTab(body);
    else                renderUrlTab(body);
  }

  // ── NIP-07 flow ──────────────────────────────────────────────────────
  async function signInWithExtension(extName) {
    const status = $('auth-ext-status');
    const btn    = $('auth-ext-btn');
    const setStatus = (text, kind = '') => {
      status.style.display = 'flex';
      status.className = 'auth-status-line' + (kind ? ' ' + kind : '');
      status.innerHTML = kind === 'err'
        ? `<span class="pulse"></span>${escapeHtml(text)}`
        : `<span class="pulse"></span>${escapeHtml(text)}`;
    };

    btn.disabled = true;
    setStatus(`Requesting signature from ${extName}…`);

    try {
      const { challenge, expectedUrl } = await fetch('/api/auth/challenge', { method: 'POST' }).then(r => r.json());
      // Server pins its expected `u` tag to the canonical loopback URL
      // (`http://127.0.0.1:PORT`) regardless of which hostname the browser
      // is using, so sign against that — not window.location.origin.
      const template = {
        kind: 27235,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['u', expectedUrl || window.location.origin],
          ['method', 'POST'],
        ],
        content: challenge,
      };
      const event = await window.nostr.signEvent(template);
      const res = await fetch('/api/auth/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ challenge, event }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `verify ${res.status}`);
      // Browser-extension sign-in → record source so publish routes
      // back to window.nostr.signEvent (no Amber pairing required).
      completeSignIn(data, 'nip07');
    } catch (e) {
      setStatus(e.message || 'sign-in failed', 'err');
      btn.disabled = false;
    }
  }

  // ── Amber QR flow ────────────────────────────────────────────────────
  //
  // Two responsibilities, kept separate on purpose:
  //   ensureQrSession() — owns the ephemeral keypair. Only POSTs when no
  //                       pinned session exists (or we just invalidated one).
  //                       Tab switches and section collapses never call it.
  //   renderQrTab()     — paints the current session's QR/URI and hooks up
  //                       the refresh button + poll loop. Idempotent: called
  //                       again with the same pinned session is a no-op on
  //                       the server.
  async function ensureQrSession() {
    if (qrSession) return qrSession;
    const res = await fetch('/api/auth/bunker-connect', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `${res.status}`);
    // mode: 'silent-ok' means the server silently re-authed via a saved
    // bunker client (Amber push + tap on the user's phone) and issued a
    // session token directly — no QR needed. We complete sign-in on the
    // spot and leave qrSession null so any subsequent renderQrTab would
    // re-POST and try silent again. mode: 'qr' is the traditional flow.
    if (data.mode === 'silent-ok' && data.token) {
      completeSignIn(data, 'bunker');
      return { silent: true };
    }
    qrSession = data;
    return qrSession;
  }

  async function renderQrTab(body) {
    body.innerHTML = `<div class="auth-status-line"><span class="pulse"></span>Sending sign-in request to your bunker…</div>`;
    let start;
    try { start = await ensureQrSession(); }
    catch (e) {
      body.innerHTML = `<div class="auth-status-line err"><span class="pulse"></span>${escapeHtml(e.message || 'failed')}</div>`;
      return;
    }
    // Silent path already called completeSignIn — the auth screen is
    // hidden and the dashboard is mounting. Nothing else to paint.
    if (start?.silent) return;

    body.innerHTML = `
      <div class="auth-qr">
        <div class="qr-frame">${start.qrSvg || 'QR unavailable'}</div>
        <div class="uri-row">
          <code title="${escapeHtml(start.nostrconnectUri)}">${escapeHtml(start.nostrconnectUri)}</code>
        </div>
        <div class="auth-status-line" id="auth-qr-status">
          <span class="pulse"></span>Waiting for Amber…
        </div>
        <button id="auth-qr-refresh" style="display:none">refresh QR</button>
      </div>
    `;
    body.querySelector('.uri-row').appendChild(copyBtn(start.nostrconnectUri, 'copy URI'));
    $('auth-qr-refresh').addEventListener('click', () => {
      // User-initiated refresh is the ONLY path that drops the pinned
      // session. Stops the current poll, clears state, re-renders.
      qrSession = null;
      stopPoll();
      renderQrTab(body);
    });

    pollBunkerSession(start.ephemeralPubkey, {
      onTimeout: () => {
        qrSession = null;   // 120s expiry — next paint needs a fresh code
        const s = $('auth-qr-status');
        if (s) { s.className = 'auth-status-line warn'; s.innerHTML = '<span class="pulse"></span>Connection timed out. Try again.'; }
        const r = $('auth-qr-refresh');
        if (r) r.style.display = 'inline-block';
      },
      onError: (msg) => {
        qrSession = null;   // whatever went wrong, the server session is gone
        const s = $('auth-qr-status');
        if (s) { s.className = 'auth-status-line err'; s.innerHTML = `<span class="pulse"></span>${escapeHtml(msg)}`; }
        const r = $('auth-qr-refresh');
        if (r) r.style.display = 'inline-block';
      },
    });
  }

  function pollBunkerSession(eph, { onTimeout, onError }) {
    stopPoll();
    const tick = async () => {
      // Guard: if the pinned session was invalidated (refresh, timeout)
      // while a tick was queued, skip this round entirely.
      if (!qrSession || qrSession.ephemeralPubkey !== eph) return;
      pollAbort = new AbortController();
      try {
        const r = await fetch(`/api/auth/bunker-session/${eph}`, { signal: pollAbort.signal });
        const data = await r.json();
        if (data.status === 'ok') {
          qrSession = null;
          completeSignIn(data, 'bunker');
          return;
        }
        if (data.status === 'waiting') {
          pollTimer = setTimeout(tick, 2000);
          return;
        }
        if (data.status === 'timeout') { onTimeout?.(); return; }
        onError?.(data.error || 'bunker sign-in failed');
      } catch (e) {
        if (e?.name === 'AbortError') return;
        onError?.(e.message || 'poll failed');
      }
    };
    tick();
  }

  // ── Bunker URL flow ──────────────────────────────────────────────────
  function renderUrlTab(body) {
    body.innerHTML = `
      <div class="auth-bunker-paste">
        <input id="auth-bunker-input" placeholder="bunker://…" autocomplete="off" spellcheck="false">
        <div class="actions">
          <button id="auth-bunker-paste">paste</button>
          <button class="primary" id="auth-bunker-connect" style="flex:1">Connect</button>
        </div>
        <div class="auth-status-line" id="auth-bunker-status" style="display:none"></div>
      </div>
    `;
    $('auth-bunker-paste').addEventListener('click', async () => {
      try { $('auth-bunker-input').value = (await navigator.clipboard.readText()).trim(); }
      catch { toast('Clipboard blocked', 'paste manually', 'warn'); }
    });
    const connect = async () => {
      const val = $('auth-bunker-input').value.trim();
      if (!/^bunker:\/\//i.test(val)) {
        toast('Invalid URL', 'must start with bunker://', 'err');
        return;
      }
      const status = $('auth-bunker-status');
      const btn    = $('auth-bunker-connect');
      status.style.display = 'flex';
      status.className = 'auth-status-line';
      status.innerHTML = `<span class="pulse"></span>Connecting to bunker…`;
      btn.disabled = true;
      try {
        const res = await fetch('/api/auth/bunker-url', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ bunkerUrl: val }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `${res.status}`);
        completeSignIn(data, 'bunker');
      } catch (e) {
        status.className = 'auth-status-line err';
        status.innerHTML = `<span class="pulse"></span>${escapeHtml(e.message || 'bunker failed')}`;
        btn.disabled = false;
      }
    };
    $('auth-bunker-connect').addEventListener('click', connect);
    $('auth-bunker-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') connect(); });
  }

  // ── Completion ───────────────────────────────────────────────────────
  function completeSignIn(data, source) {
    if (!data?.token) { toast('Sign-in failed', 'no token', 'err'); return; }
    // `source` is 'nip07' or 'bunker' — recorded so publish + future
    // signing flows route to the matching signer. Falls back to
    // 'bunker' for legacy call sites that don't pass it (silent paths
    // / older cookies); the publish handler treats 'bunker' as the
    // server-signs default.
    setSessionToken(data.token, data.expiresAt, source || 'bunker');
    hide();
    bootDashboard(false);
    toast('Signed in', truncNpub(data.npub || ''), 'ok');
  }

  return { show, hide, render };
})();

// ── Setup wizard ─────────────────────────────────────────────────────────
//
// Full-viewport overlay shown on /setup for first-run onboarding. Walks
// the user through: welcome → identity → relay → ai → ngit → done. Each
// stage advances `stageIdx`; the final stage unlocks the dashboard.
//
// The wizard writes directly to identity.json / ai-config.json via the
// same routes the post-auth panels use — /api/identity/set is already
// bootstrap-exempt when no station owner exists; later stages extend
// that exemption during setup (built out in Step 6.5).

const SetupWizard = (() => {
  const root = $('setup-root');
  // The in-process relay starts inside the dashboard process before the
  // wizard renders. First-run pairing is the Amber QR followed by a live
  // signing-pipeline verification — together those replace the legacy
  // "paste an npub" identity stage with "scan, tap, proven." nvpn is the
  // last optional step; users can skip it and still complete onboarding.
  const STAGES = ['welcome', 'amber', 'verify', 'ai', 'gitident', 'ngit', 'vpn', 'done'];
  let stageIdx = 0;
  const state = { npub: '', profile: null };

  // Preview retry state (A2). Lives at module scope — NOT inside
  // renderIdentity — because every renderIdentity() call replaces the
  // form's DOM, which would otherwise reset the closure on every render
  // and re-fire the auto-fetch into a storm.
  //
  // Pre-A2, a 500ing /api/identity/profile/preview triggered the loop:
  // runPreview → fetch fails → render() → component remounts → on-mount
  // auto-fetch fires → fetch fails → render() → … 33k+ requests in
  // short windows, fans-on, devtools-locked. The fix is two pieces:
  //   1. don't render() on the failure path itself (only on success or
  //      when the circuit ultimately breaks);
  //   2. gate the on-mount auto-fetch on `!previewBroken`.
  const previewRetry = {
    attempt:     0,        // consecutive failures for `lastNpub`
    broken:      false,    // circuit broken — only manual click re-arms
    lastNpub:    '',       // npub the counter is scoped to
    pendingTimer: null,    // pending setTimeout id for the next retry
  };

  async function show() {
    // If the station is already set up AND the viewer is authenticated,
    // there's nothing for the wizard to do — redirect to dashboard. We
    // check both because a fresh browser on an already-set-up box still
    // needs to hit the normal sign-in screen, not this wizard.
    try {
      const st = await fetch('/api/auth/status').then(r => r.json());
      if (st.configured && st.authenticated && st.session) {
        location.href = '/';
        return;
      }
    } catch { /* fall through — render wizard anyway */ }

    stageIdx = 0;
    root.hidden = false;
    render();
  }

  function hide() {
    root.hidden = true;
    root.innerHTML = '';
  }

  function next() { if (stageIdx < STAGES.length - 1) { stageIdx++; render(); } }
  function back() { if (stageIdx > 0)                  { stageIdx--; render(); } }

  function progressDots() {
    return STAGES.map((s, i) => {
      const cls = i === stageIdx ? 'active' : (i < stageIdx ? 'done' : '');
      return `<span class="setup-dot ${cls}" title="${escapeHtml(s)}"></span>`;
    }).join('');
  }

  function shell(title, subtitle, inner) {
    return `
      <div class="setup-card">
        <div class="setup-head">
          <img class="nori" src="/nori.svg" alt="">
          <div>
            <div class="wordmark">nostr-station</div>
            <div class="subtitle">${escapeHtml(subtitle)}</div>
          </div>
        </div>
        <div class="setup-progress">
          ${progressDots()}
          <span class="setup-step-count">Step ${stageIdx + 1} of ${STAGES.length}</span>
        </div>
        <div class="setup-stage-title">${escapeHtml(title)}</div>
        <div class="setup-stage">${inner}</div>
      </div>
    `;
  }

  function render() {
    const stage = STAGES[stageIdx];
    if      (stage === 'welcome')  renderWelcome();
    else if (stage === 'amber')    renderAmber();
    else if (stage === 'verify')   renderVerify();
    else if (stage === 'identity') renderIdentity();
    else if (stage === 'relay')    renderRelay();
    else if (stage === 'ai')       renderAi();
    else if (stage === 'gitident') renderGitIdent();
    else if (stage === 'ngit')     renderNgit();
    else if (stage === 'vpn')      renderVpn();
    else if (stage === 'done')     renderDone();
    else                           renderStub(stage);
  }

  // ── Amber QR pairing ─────────────────────────────────────────────────
  // The hero step. One full-size QR code, one instruction. The user scans
  // in Amber, taps approve once, and the wizard captures their npub via
  // the NIP-46 nostr-connect handshake. No paste field, no fallback —
  // this is THE sign-in for the in-process deployment.
  let amberPollTimer = null;
  function renderAmber() {
    if (amberPollTimer) { clearTimeout(amberPollTimer); amberPollTimer = null; }
    root.innerHTML = shell(
      'Pair Amber',
      'Open Amber on your phone, scan this QR, tap approve.',
      `
        <div class="setup-amber-stage">
          <div id="setup-amber-qr" class="setup-amber-qr">
            <div class="muted">Generating QR…</div>
          </div>
          <div id="setup-amber-status" class="setup-amber-status muted">
            Waiting for Amber…
          </div>
          <div class="setup-amber-help muted">
            No Amber yet?
            <a href="https://github.com/greenart7c3/Amber" target="_blank" rel="noreferrer">Install Amber</a>
            on your Android phone, create or import a key, then come back.
          </div>
        </div>
      `,
    );
    // Kick off the start request. On success, render the QR and begin
    // polling. Errors surface inline.
    fetch('/api/setup/amber/start', { method: 'POST' })
      .then(r => r.json())
      .then(j => {
        if (!j.ok) throw new Error(j.error || 'start failed');
        const qrBox = document.getElementById('setup-amber-qr');
        if (qrBox) qrBox.innerHTML = j.qrSvg;
        startAmberPolling(j.ephemeralPubkey);
      })
      .catch(err => {
        const status = document.getElementById('setup-amber-status');
        if (status) {
          status.innerHTML = `<span class="err">Couldn't start pairing: ${escapeHtml(err.message)}</span>`;
        }
      });
  }

  function startAmberPolling(eph) {
    let stopped = false;
    const status = () => document.getElementById('setup-amber-status');
    const poll = async () => {
      if (stopped) return;
      try {
        const res = await fetch(`/api/setup/amber/session/${eph}`);
        const j   = await res.json();
        if (j.status === 'waiting') {
          amberPollTimer = setTimeout(poll, 1500);
          return;
        }
        stopped = true;
        if (j.status === 'ok' && j.npub) {
          state.npub = j.npub;
          if (status()) {
            status().innerHTML = `<span class="ok">✓ Paired as ${escapeHtml(truncNpub(j.npub))}</span>`;
          }
          // Brief pause so the user registers the success state before
          // the wizard advances. Matches the "✓ pair → next" rhythm of
          // the spec.
          setTimeout(() => next(), 900);
        } else if (j.status === 'timeout') {
          if (status()) {
            status().innerHTML = `<span class="err">Pairing timed out — </span><a href="#" id="amber-retry">try again</a>`;
            const retry = document.getElementById('amber-retry');
            if (retry) retry.addEventListener('click', e => { e.preventDefault(); render(); });
          }
        } else {
          if (status()) {
            status().innerHTML = `<span class="err">Pairing failed: ${escapeHtml(j.error || 'unknown error')}</span> · <a href="#" id="amber-retry">retry</a>`;
            const retry = document.getElementById('amber-retry');
            if (retry) retry.addEventListener('click', e => { e.preventDefault(); render(); });
          }
        }
      } catch (e) {
        // Network blip — retry once before giving up.
        amberPollTimer = setTimeout(poll, 2000);
      }
    };
    poll();
  }

  // ── Live verification ────────────────────────────────────────────────
  // The trust-earning moment per the user-journey spec. Generates a
  // kind-1 test event, signs via Amber (second phone tap, last in
  // onboarding), publishes to the local relay, reads it back. User sees
  // a live checklist; on success the wizard advances.
  function renderVerify() {
    root.innerHTML = shell(
      'Verify the pipeline',
      'One tap on your phone confirms Amber, the relay, and signing all work end-to-end.',
      `
        <div class="setup-verify-stage">
          <div id="setup-verify-steps" class="setup-verify-steps">
            <div class="setup-verify-step pending"><span class="bullet">•</span> Sign a test event via Amber</div>
            <div class="setup-verify-step pending"><span class="bullet">•</span> Publish to ws://localhost:7777</div>
            <div class="setup-verify-step pending"><span class="bullet">•</span> Read it back from the relay</div>
          </div>
          <div id="setup-verify-status" class="setup-verify-status muted">
            Approve the signing prompt on your phone…
          </div>
          <div class="setup-actions">
            <button class="setup-back" id="verify-back">← Back</button>
            <button class="primary setup-next" id="verify-next" disabled>Continue →</button>
          </div>
        </div>
      `,
    );
    document.getElementById('verify-back').addEventListener('click', back);
    document.getElementById('verify-next').addEventListener('click', next);

    fetch('/api/setup/verify', { method: 'POST' })
      .then(async r => {
        const j = await r.json();
        return { ok: r.ok, body: j };
      })
      .then(({ ok, body }) => {
        const stepEls = document.querySelectorAll('#setup-verify-steps .setup-verify-step');
        const stepNames = ['sign-via-amber', 'publish-to-relay', 'read-back-from-relay'];
        const status = document.getElementById('setup-verify-status');
        for (let i = 0; i < stepNames.length; i++) {
          const result = (body.steps || []).find(s => s.name === stepNames[i]);
          if (!result) continue;
          stepEls[i].classList.remove('pending');
          stepEls[i].classList.add(result.ok ? 'ok' : 'err');
          stepEls[i].querySelector('.bullet').textContent = result.ok ? '✓' : '✗';
          if (result.detail) {
            const detail = document.createElement('span');
            detail.className = 'muted';
            detail.style.marginLeft = '0.5em';
            detail.textContent = result.detail;
            stepEls[i].appendChild(detail);
          }
        }
        if (ok && body.ok) {
          status.innerHTML = '<span class="ok">Signing works. Relay is live. You\'re ready.</span>';
          document.getElementById('verify-next').disabled = false;
        } else {
          status.innerHTML = `<span class="err">${escapeHtml(body.error || 'verification failed')}</span> · <a href="#" id="verify-retry">retry</a>`;
          const retry = document.getElementById('verify-retry');
          if (retry) retry.addEventListener('click', e => { e.preventDefault(); render(); });
        }
      })
      .catch(err => {
        const status = document.getElementById('setup-verify-status');
        if (status) status.innerHTML = `<span class="err">Couldn't run verification: ${escapeHtml(err.message)}</span>`;
      });
  }

  // ── Welcome ──────────────────────────────────────────────────────────
  function renderWelcome() {
    root.innerHTML = shell(
      "Let's set up your station",
      'A one-time walkthrough — takes about two minutes.',
      `
        <p class="setup-copy">
          nostr-station runs a local Nostr relay, wires up AI-assisted
          dev tools, and links your git + nsite signing via Amber.
          Nothing you enter here leaves this machine.
        </p>
        <ul class="setup-list">
          <li>Station identity (your npub)</li>
          <li>Local relay (already running)</li>
          <li>AI providers (chat + terminal defaults)</li>
          <li>ngit signing via Amber</li>
        </ul>
        <div class="setup-actions">
          <button class="primary setup-next">Get started →</button>
        </div>
      `,
    );
    root.querySelector('.setup-next').addEventListener('click', next);
  }

  // ── Identity ─────────────────────────────────────────────────────────
  function renderIdentity() {
    const hasPreview = !!state.profile && !state.profile.empty;
    const displayName = hasPreview
      ? (state.profile.name || truncNpub(state.npub))
      : '';
    const nip05Line = hasPreview && state.profile.nip05
      ? `<div class="nip05">${escapeHtml(state.profile.nip05)}${state.profile.nip05Verified ? ' <span class="ok">✓ verified</span>' : ''}</div>`
      : '';

    root.innerHTML = shell(
      'Sign in as the station owner',
      'Your npub is public. Your nsec stays on your phone (Amber).',
      `
        <div class="setup-field">
          <label>Your npub</label>
          <div class="setup-row">
            <input id="setup-npub" type="text" placeholder="npub1…"
              autocomplete="off" spellcheck="false" value="${escapeHtml(state.npub)}">
            <button id="setup-paste">paste</button>
          </div>
          <div class="setup-hint muted">
            No npub yet? Install <a href="https://getalby.com" target="_blank" rel="noreferrer">Alby</a>
            or <a href="https://github.com/greenart7c3/Amber" target="_blank" rel="noreferrer">Amber</a>
            to create one.
          </div>
        </div>

        <div class="setup-preview ${hasPreview ? '' : 'empty'}" id="setup-preview">
          ${hasPreview ? `
            <div class="avatar">
              ${state.profile.picture
                ? `<img src="${escapeHtml(state.profile.picture)}" alt="">`
                : pixelAvatar(state.npub, 48)}
            </div>
            <div class="meta">
              <div class="name">${escapeHtml(displayName)}</div>
              ${nip05Line}
              <div class="npub muted">${escapeHtml(truncNpub(state.npub))}</div>
            </div>
          ` : previewRetry.broken ? `
            <div class="muted">
              Couldn't load profile preview after 3 retries.
              The npub is still saveable — this only affects the avatar shown above.
            </div>
            <button class="setup-preview-retry">Retry preview</button>
          ` : `
            <div class="muted">Paste an npub above to preview your profile.</div>
          `}
        </div>

        <div class="setup-actions">
          <button class="setup-back">← Back</button>
          <button class="primary setup-save" ${state.npub ? '' : 'disabled'}>
            Save &amp; continue
          </button>
        </div>
      `,
    );

    const input = $('setup-npub');
    const saveBtn = root.querySelector('.setup-save');

    // Debounced profile preview — fires ~400ms after the user stops
    // typing so we don't spam the relay query on every keystroke.
    //
    // Failure handling (A2): on a 500/network error we backoff (1 s,
    // 3 s, 10 s) and circuit-break after 3 attempts. We deliberately
    // do NOT call render() inside the failure path — render() remounts
    // the component which fires the on-mount auto-preview, which would
    // immediately reissue the failed fetch. Only the success path and
    // the final circuit-break call render(). See preview-retry.js for
    // the decision helper.
    let previewTimer = null;
    const runPreview = async (opts = {}) => {
      const val = input.value.trim();
      state.npub = val;
      saveBtn.disabled = !val;

      // Reset retry budget when the user changes the npub. A fresh
      // subject deserves a fresh circuit.
      if (val !== previewRetry.lastNpub) {
        previewRetry.attempt = 0;
        previewRetry.broken = false;
        previewRetry.lastNpub = val;
        if (previewRetry.pendingTimer) {
          clearTimeout(previewRetry.pendingTimer);
          previewRetry.pendingTimer = null;
        }
      }

      if (!val || !/^(npub1|[0-9a-f]{64})/i.test(val)) {
        state.profile = null;
        return render();
      }

      // Circuit broken — auto-retry is disabled. Only an explicit user
      // click (opts.manual=true, e.g. the Retry button) re-arms it.
      if (previewRetry.broken && !opts.manual) return;
      if (opts.manual) {
        previewRetry.attempt = 0;
        previewRetry.broken = false;
      }

      try {
        const res = await fetch(`/api/identity/profile/preview?npub=${encodeURIComponent(val)}`);
        if (!res.ok) throw new Error(`http ${res.status}`);
        const p = await res.json();
        if (p && !p.error) {
          state.profile = p;
          previewRetry.attempt = 0;
          previewRetry.broken = false;
          render();
          return;
        }
        // Body present but flagged error / empty — treat as failure so
        // the user gets feedback rather than a quiet stuck-on-blank.
        throw new Error(p?.error || 'empty preview');
      } catch {
        const decision = previewRetryDecision(previewRetry.attempt);
        if (decision.action === 'break') {
          previewRetry.broken = true;
          // ONE render at break time so the user sees the error state
          // and the manual Retry button. The on-mount guard below skips
          // the auto-fetch because previewRetry.broken is now true.
          render();
          return;
        }
        previewRetry.attempt = decision.nextAttempt;
        previewRetry.pendingTimer = setTimeout(() => {
          previewRetry.pendingTimer = null;
          // Re-fire only if the input still shows the npub we were
          // retrying (user may have edited mid-backoff).
          if (input.value.trim() === val && !previewRetry.broken) {
            runPreview();
          }
        }, decision.delayMs);
      }
    };

    input.addEventListener('input', () => {
      state.npub = input.value.trim();
      saveBtn.disabled = !state.npub;
      clearTimeout(previewTimer);
      previewTimer = setTimeout(runPreview, 400);
    });

    root.querySelector('#setup-paste').addEventListener('click', async () => {
      try {
        input.value = (await navigator.clipboard.readText()).trim();
        input.dispatchEvent(new Event('input'));
      } catch { toast('Clipboard blocked', 'paste manually', 'warn'); }
    });

    root.querySelector('.setup-back').addEventListener('click', back);
    saveBtn.addEventListener('click', async () => {
      const val = state.npub;
      if (!val) return;
      saveBtn.disabled = true;
      saveBtn.innerHTML = '<span class="spinner"></span> Saving…';
      try {
        // Writing setupComplete=false here keeps the localhost exemption
        // alive for the rest of the wizard (relay/ai/ngit stages) even
        // after npub is set. It flips to true in the Done stage via
        // /api/setup/complete, at which point normal auth takes over.
        const r = await fetch('/api/identity/set', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ npub: val, setupComplete: false }),
        }).then(r => r.json());
        if (!r.ok) throw new Error(r.error || 'save failed');
        toast('Identity saved', truncNpub(val), 'ok');
        next();
      } catch (e) {
        toast('Save failed', e.message, 'err');
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save & continue';
      }
    });

    // Auto-run preview on mount if we already have an npub in state
    // (re-entering this stage via Back). Skip when the circuit is
    // broken — only a manual Retry click should re-fire from here on.
    if (state.npub && !state.profile && !previewRetry.broken) runPreview();

    // Retry button — only present in the broken-circuit branch below.
    // Manual clicks re-arm the circuit and start fresh from attempt 0.
    root.querySelector('.setup-preview-retry')?.addEventListener('click', () => {
      runPreview({ manual: true });
    });
  }

  // ── Relay ────────────────────────────────────────────────────────────
  // The in-process relay starts inside the dashboard process before the
  // wizard renders, so this stage is informational: confirm the relay is
  // listening on its socket, surface the URL the user's apps will publish
  // to, and let them continue. We keep it as a wizard step because it's a
  // useful "yes, this works end-to-end" beat between identity and AI.
  async function renderRelay() {
    root.innerHTML = shell(
      'Local relay',
      'Your private Nostr relay, running in-process with the dashboard.',
      `
        <div class="setup-relay" id="setup-relay-body">
          <div class="muted"><span class="spinner"></span> Checking relay…</div>
        </div>
        <div class="setup-actions">
          <button class="setup-back">← Back</button>
          <button class="primary setup-next" id="setup-relay-next" disabled>Continue →</button>
        </div>
      `,
    );
    root.querySelector('.setup-back').addEventListener('click', back);
    root.querySelector('.setup-next').addEventListener('click', next);

    const bodyEl = $('setup-relay-body');
    const nextBtn = $('setup-relay-next');

    const paint = async () => {
      let relay = null;
      let errTitle = null;
      let errMsg   = null;
      try {
        const res = await fetch('/api/status');
        if (res.status === 401) {
          errTitle = 'Sign in required';
          errMsg   = 'Finish the identity step first — the dashboard needs auth before it can report status.';
        } else if (!res.ok) {
          errTitle = 'Status unavailable';
          errMsg   = `Local API returned ${res.status}. Try refreshing.`;
        } else {
          const status = await res.json();
          relay = Array.isArray(status) ? status.find(s => s.id === 'relay') : null;
          if (!relay) {
            errTitle = 'Status unavailable';
            errMsg   = 'Status response missing relay info. Try refreshing.';
          }
        }
      } catch {
        errTitle = 'Status unavailable';
        errMsg   = "Couldn't reach the local API. Is the server still running?";
      }

      if (errTitle) {
        bodyEl.innerHTML = `<div class="setup-relay-row err">
          <span class="dot err"></span>
          <div>
            <div class="title">${escapeHtml(errTitle)}</div>
            <div class="muted">${escapeHtml(errMsg)}</div>
          </div>
        </div>`;
        nextBtn.disabled = false;
        return;
      }

      if (relay.state === 'ok') {
        // relay.value is the canonical "ws://host:port ✓" string from
        // gatherStatus. Strip the trailing checkmark for inline rendering;
        // the dot to its left already conveys the ok state.
        const url = (relay.value || '').replace(/\s*✓\s*$/, '').trim();
        bodyEl.innerHTML = `<div class="setup-relay-row ok">
          <span class="dot ok"></span>
          <div>
            <div class="title">Relay running · <code>${escapeHtml(url)}</code></div>
            <div class="muted">In-process — starts and stops with the dashboard.</div>
          </div>
        </div>`;
        nextBtn.disabled = false;
        return;
      }

      // Anything other than 'ok' means the in-process relay didn't start.
      // There's no installer to run from the wizard — the relay starts
      // with the dashboard. Surface the failure + a Continue so the
      // wizard isn't a hard stop.
      bodyEl.innerHTML = `
        <div class="setup-relay-row ${relay.state}">
          <span class="dot ${stateClass(relay.state)}"></span>
          <div>
            <div class="title">Relay didn't start with the dashboard</div>
            <div class="muted">${escapeHtml(relay.value || '')}</div>
          </div>
        </div>
        <div class="setup-hint muted" style="margin-top:12px">
          Check the Logs panel after onboarding for the underlying error.
          You can continue setup — most steps don't require the relay to be live.
        </div>
      `;
      nextBtn.disabled = false;
    };
    paint();
  }

  // ── AI providers ─────────────────────────────────────────────────────
  // Thin wizard-only UI over the same /api/ai/providers endpoint the
  // Config panel uses. Skippable — users can configure later in Config.
  async function renderAi() {
    root.innerHTML = shell(
      'AI providers',
      'Add at least one so Chat + "Open in AI" work. Skip and configure later if you like.',
      `
        <div class="setup-ai-body" id="setup-ai-body">
          <div class="muted"><span class="spinner"></span> Loading providers…</div>
        </div>
        <div class="setup-actions">
          <button class="setup-back">← Back</button>
          <div style="display:flex;gap:8px;align-items:center">
            <button class="setup-skip" id="setup-ai-skip">Skip for now</button>
            <button class="primary setup-next" id="setup-ai-next">Continue →</button>
          </div>
        </div>
      `,
    );
    root.querySelector('.setup-back').addEventListener('click', back);
    root.querySelector('#setup-ai-skip').addEventListener('click', next);
    root.querySelector('#setup-ai-next').addEventListener('click', next);

    const body = $('setup-ai-body');
    const paint = async () => {
      let list;
      try { list = await fetch('/api/ai/providers').then(r => r.ok ? r.json() : null); }
      catch { list = null; }
      if (!list || !Array.isArray(list.providers)) {
        body.innerHTML = `<div class="muted" style="color:var(--warn)">Provider list unavailable — skip and configure later from Config.</div>`;
        return;
      }
      const configured = list.providers.filter(p => p.configured);
      const available  = list.providers.filter(p => !p.configured);

      const rows = configured.length === 0
        ? `<div class="muted setup-ai-empty">No providers yet. Add one below — or skip and configure later.</div>`
        : configured.map(p => `
            <div class="setup-ai-row" data-id="${escapeHtml(p.id)}">
              <div class="setup-ai-head">
                <span class="setup-ai-name">${escapeHtml(p.displayName)}</span>
                <span class="ai-badge type-${p.type === 'terminal-native' ? 'term' : 'api'}">
                  ${p.type === 'terminal-native' ? 'terminal' : 'api'}
                </span>
                ${p.isDefault?.chat     ? '<span class="ai-badge default">chat default</span>' : ''}
                ${p.isDefault?.terminal ? '<span class="ai-badge default">terminal default</span>' : ''}
              </div>
              <div class="setup-ai-actions">
                ${p.type === 'api' && !p.isDefault?.chat
                  ? `<button class="setup-ai-default" data-kind="chat" data-id="${escapeHtml(p.id)}">Use for Chat</button>`
                  : ''}
                ${p.type === 'terminal-native' && !p.isDefault?.terminal
                  ? `<button class="setup-ai-default" data-kind="terminal" data-id="${escapeHtml(p.id)}">Use for Terminal</button>`
                  : ''}
                <button class="danger setup-ai-remove" data-id="${escapeHtml(p.id)}">Remove</button>
              </div>
            </div>
          `).join('');

      const termOpts = available.filter(p => p.type === 'terminal-native')
        .map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.displayName)}</option>`).join('');
      const apiOpts = available.filter(p => p.type === 'api')
        .map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.displayName)}</option>`).join('');

      body.innerHTML = `
        <div class="setup-ai-list">${rows}</div>
        ${(termOpts || apiOpts) ? `
          <div class="setup-ai-add">
            <select id="setup-ai-add-select">
              <option value="">+ Add a provider…</option>
              ${termOpts ? `<optgroup label="Terminal-native">${termOpts}</optgroup>` : ''}
              ${apiOpts  ? `<optgroup label="API">${apiOpts}</optgroup>` : ''}
            </select>
            <div id="setup-ai-keyrow" style="margin-top:8px;display:none">
              <div class="keyrow">
                <div class="keyfield">
                  <input id="setup-ai-key" type="password" autocomplete="off" placeholder="paste provider key (sk-…)">
                </div>
                <button class="primary" id="setup-ai-save">add</button>
                <button id="setup-ai-cancel">cancel</button>
              </div>
            </div>
          </div>
        ` : ''}
      `;

      // Row actions — the /api/ai/config POST endpoint is what the
      // Config panel uses (merge-patch on providers + defaults); we
      // target it directly so behaviour matches the main dashboard.
      const patchConfig = async (patch) => {
        await fetch('/api/ai/config', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch),
        });
      };

      body.querySelectorAll('.setup-ai-remove').forEach(btn => {
        btn.addEventListener('click', async () => {
          const id = btn.dataset.id;
          if (!confirm(`Remove ${id}?`)) return;
          try {
            // Clear any keychain entry, then drop the config row.
            await fetch(`/api/ai/providers/${encodeURIComponent(id)}/key`, { method: 'DELETE' })
              .catch(() => {});
            await patchConfig({ providers: { [id]: null } });
            toast(`Removed ${id}`, '', 'ok');
          } catch (e) { toast('Remove failed', e.message, 'err'); }
          paint();
        });
      });

      body.querySelectorAll('.setup-ai-default').forEach(btn => {
        btn.addEventListener('click', async () => {
          const id = btn.dataset.id;
          const kind = btn.dataset.kind;
          try {
            await patchConfig({ defaults: { [kind]: id } });
            toast(`${kind} default → ${id}`, '', 'ok');
          } catch (e) { toast('Set default failed', e.message, 'err'); }
          paint();
        });
      });

      const sel = $('setup-ai-add-select');
      if (!sel) return;
      const keyRow = $('setup-ai-keyrow');
      const keyInput = $('setup-ai-key');
      const saveBtn = $('setup-ai-save');
      const cancelBtn = $('setup-ai-cancel');

      // bareKey providers don't need an API key — derived from the
      // /api/ai/providers payload (`chosen.bareKey`). The curated
      // registry currently has none, but the branch stays for future
      // additions.

      sel.addEventListener('change', async () => {
        const id = sel.value;
        if (!id) { keyRow.style.display = 'none'; return; }
        const chosen = list.providers.find(p => p.id === id);
        if (!chosen) return;
        if (chosen.type === 'terminal-native') {
          try {
            await patchConfig({ providers: { [id]: { enabled: true } } });
            toast(`Added ${chosen.displayName}`, '', 'ok');
          } catch (e) { toast('Add failed', e.message, 'err'); }
          sel.value = '';
          paint();
          return;
        }
        if (chosen.bareKey) {
          try {
            await patchConfig({ providers: { [id]: {} } });
            toast(`Added ${chosen.displayName}`, '', 'ok');
          } catch (e) { toast('Add failed', e.message, 'err'); }
          sel.value = '';
          paint();
          return;
        }
        keyRow.style.display = '';
        keyInput.value = '';
        keyInput.focus();
      });

      saveBtn?.addEventListener('click', async () => {
        const id  = sel.value;
        const key = keyInput.value;
        if (!id || !key) return;
        saveBtn.disabled = true;
        try {
          await fetch(`/api/ai/providers/${encodeURIComponent(id)}/key`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ key }),
          });
          toast(`Added ${id}`, '', 'ok');
          sel.value = '';
          keyRow.style.display = 'none';
          paint();
        } catch (e) {
          toast('Add failed', e.message, 'err');
        } finally {
          saveBtn.disabled = false;
        }
      });
      cancelBtn?.addEventListener('click', () => {
        sel.value = '';
        keyRow.style.display = 'none';
      });
    };
    paint();
  }

  // ── Git identity ─────────────────────────────────────────────────────
  // Optional step. Sets the user's global git identity (~/.gitconfig)
  // before they start scaffolding/cloning projects. Surfaces three
  // explicit choices + skip:
  //   - npub shorthand (synthetic, pure Nostr-native)
  //   - nip-05 (when cached) — bridges Nostr + GitHub via one string
  //   - custom name + email — for users with a separate GitHub identity
  //   - skip — auto-seed kicks in per-repo for nostr-station-managed
  //     projects, user can configure later via Config → Git Identity.
  // Skippable so "I just want to play with Nostr stuff" users aren't
  // blocked.
  async function renderGitIdent() {
    let gitIdent = null;
    let profile  = null;
    try {
      [gitIdent, profile] = await Promise.all([
        fetch('/api/git-identity/global').then(r => r.ok ? r.json() : null),
        fetch('/api/identity/profile').then(r => r.ok ? r.json() : null),
      ]);
    } catch {}

    const nip05Preset = profile?.nip05
      ? { name: profile.name || (profile.nip05.split('@')[0] || 'nostr-station user'), email: profile.nip05 }
      : null;
    const npubPreset  = gitIdent?.presets?.npubSynthetic ?? null;
    const current     = gitIdent?.current ?? { name: '', email: '' };
    const alreadySet  = !!(current.name && current.email);

    root.innerHTML = shell(
      'Git identity (optional)',
      'Author info baked into every git commit on this machine.',
      `
        ${alreadySet ? `
          <div class="setup-hint" style="margin-bottom:14px">
            Already configured: <code>${escapeHtml(current.name)} &lt;${escapeHtml(current.email)}&gt;</code>.
            You can change it below or continue.
          </div>
        ` : ''}

        <div class="setup-field">
          <label>Choose how commits attribute</label>
          <div class="setup-hint muted" style="margin-bottom:10px">
            Git records ONE author per commit. You can override per-project later
            in each project's Settings tab.
          </div>

          <label class="radio-row">
            <input type="radio" name="setup-git-ident-mode" value="custom" checked>
            <div>
              <div class="radio-title">Set my own (best for GitHub users)</div>
              <div class="radio-sub">Type a real email below. GitHub will link commits to that user.</div>
            </div>
          </label>
          <div class="setup-row" style="gap:8px;margin:6px 0 12px 26px">
            <input id="setup-git-ident-name"  type="text" placeholder="Your Name"
                   value="${escapeHtml(current.name || profile?.name || '')}">
            <input id="setup-git-ident-email" type="text" placeholder="you@example.com"
                   value="${escapeHtml(current.email || '')}">
          </div>

          ${nip05Preset ? `
            <label class="radio-row">
              <input type="radio" name="setup-git-ident-mode" value="nip05">
              <div>
                <div class="radio-title">Use my nip-05 (<code>${escapeHtml(nip05Preset.email)}</code>)</div>
                <div class="radio-sub">Bridges Nostr + GitHub: links to your npub via DNS lookup, AND to a GitHub user if that exact email is registered there.</div>
              </div>
            </label>
          ` : ''}

          ${npubPreset ? `
            <label class="radio-row">
              <input type="radio" name="setup-git-ident-mode" value="npub">
              <div>
                <div class="radio-title">Use npub shorthand (<code>${escapeHtml(npubPreset.email)}</code>)</div>
                <div class="radio-sub">Pure Nostr-native identity. No real-world info, no GitHub user link.</div>
              </div>
            </label>
          ` : ''}

          <label class="radio-row">
            <input type="radio" name="setup-git-ident-mode" value="skip">
            <div>
              <div class="radio-title">Skip — let auto-seed handle it</div>
              <div class="radio-sub">nostr-station-managed projects get an npub-synthetic identity per repo until you configure one in <strong>Config → Git Identity</strong>.</div>
            </div>
          </label>
        </div>

        <div class="setup-actions">
          <button class="setup-back">← Back</button>
          <div style="display:flex;gap:8px;align-items:center">
            <button class="primary setup-next" id="setup-git-ident-next">Save &amp; continue →</button>
          </div>
        </div>
      `,
    );

    root.querySelector('.setup-back').addEventListener('click', back);
    root.querySelector('#setup-git-ident-next').addEventListener('click', async () => {
      const mode = root.querySelector('input[name="setup-git-ident-mode"]:checked')?.value || 'skip';
      let payload = null;
      if (mode === 'custom') {
        const name  = $('setup-git-ident-name')?.value.trim();
        const email = $('setup-git-ident-email')?.value.trim();
        if (!name || !email) {
          toast('Name and email are required for "Set my own"', 'or pick a different option', 'err');
          return;
        }
        payload = { name, email };
      } else if (mode === 'nip05' && nip05Preset) {
        payload = nip05Preset;
      } else if (mode === 'npub' && npubPreset) {
        payload = npubPreset;
      }
      // mode === 'skip' → payload stays null, no PUT, just advance.
      if (payload) {
        try {
          const r = await fetch('/api/git-identity/global', {
            method:  'PUT',
            headers: { 'content-type': 'application/json' },
            body:    JSON.stringify(payload),
          }).then(r => r.json());
          if (!r.ok) throw new Error(r.error || 'save failed');
          toast('Git identity saved', payload.email, 'ok');
        } catch (e) {
          toast('Save failed', e?.message || '', 'err');
          return;
        }
      }
      next();
    });
  }

  // ── ngit signing ─────────────────────────────────────────────────────
  // Three jobs: install the ngit binary (was a separate Status-panel
  // step pre-fix; promoted here so first-run users hit the install path
  // before they ever see Status), stash the default ngit relay (used
  // when initialising new repos), and hand off to the embedded terminal
  // for `ngit account login`. The terminal drawer renders the
  // nostrconnect QR — the user scans with Amber on their phone and the
  // session completes in the same browser tab, no shell hand-off
  // required.
  async function renderNgit() {
    // Probe ngit binary presence via /api/status. The 'ngit' row's
    // state is 'ok' when the binary is on PATH, 'err' otherwise.
    const probeNgitInstalled = async () => {
      try {
        const rows = await api('/api/status');
        const row  = (rows || []).find(r => r.id === 'ngit');
        return row && row.state !== 'err';
      } catch { return false; }
    };
    let ngitInstalled = await probeNgitInstalled();

    const termAvailable = !!window.NSTerminal?.isAvailable?.();

    root.innerHTML = shell(
      'ngit signing via Amber',
      'ngit publishes repo events to Nostr — signed by your phone.',
      `
        <div class="setup-field" id="setup-ngit-binary-field">
          <label>ngit binary</label>
          <div id="setup-ngit-binary-state"></div>
          <div class="setup-hint muted" style="margin-top:8px">
            Downloads the verified release binary from
            <code>github.com/DanConwayDev/ngit-cli</code>
            (sha256-pinned in versions.ts) and installs to
            <code>/usr/local/bin/ngit</code>.
          </div>
        </div>

        <div class="setup-field">
          <label>Amber signing</label>
          ${termAvailable ? `
            <div class="setup-ngit-amber">
              <button class="primary" id="setup-ngit-amber-btn">Connect Amber →</button>
              <div class="setup-hint muted" style="margin-top:8px"
                id="setup-ngit-amber-gate-hint">
                Install ngit first — Amber pairing runs <code>ngit account login</code>.
              </div>
              <div class="setup-hint muted" style="margin-top:8px">
                Opens a terminal and runs <code>ngit account login</code>.
                Scan the nostrconnect:// QR with Amber, approve on your phone,
                then return here and continue.
              </div>
            </div>
          ` : `
            <div class="setup-hint muted">
              Terminal PTY unavailable in this browser session — finish
              Amber pairing later via Config → ngit → Re-login.
            </div>
          `}
        </div>

        <div class="setup-actions">
          <button class="setup-back">← Back</button>
          <div style="display:flex;gap:8px;align-items:center">
            <button class="setup-skip" id="setup-ngit-skip">Skip for now</button>
            <button class="primary setup-next" id="setup-ngit-next">Continue →</button>
          </div>
        </div>
      `,
    );

    // Render the binary-state row. Re-runnable so a successful install
    // flips the row from "Install" to "✓ installed" without re-mounting
    // the whole stage and losing the relay input the user already typed.
    // Also drives the Connect Amber gate below: `ngit account login`
    // can't run while the binary is missing, so the button stays
    // disabled with a hint until install completes.
    const renderBinaryState = () => {
      const host = $('setup-ngit-binary-state');
      if (!host) return;
      if (ngitInstalled) {
        host.innerHTML = `
          <div class="setup-row" style="align-items:center;gap:8px">
            <span class="bin-indicator bin-indicator-ok">✓</span>
            <span>installed</span>
          </div>
        `;
      } else {
        host.innerHTML = `
          <div class="setup-row" style="align-items:center;gap:8px">
            <span class="bin-indicator bin-indicator-err">✗</span>
            <span>not installed</span>
            <button class="primary" id="setup-ngit-install-btn"
              style="margin-left:auto">Install ngit</button>
          </div>
        `;
        const btn = $('setup-ngit-install-btn');
        btn.addEventListener('click', async () => {
          const r = await openExecModal({
            title:    'Install ngit',
            subtitle: 'Installing ngit…',
            endpoint: '/api/exec/install/ngit',
          });
          if (r.ok) {
            toast('ngit install finished', '', 'ok');
            ngitInstalled = await probeNgitInstalled();
            renderBinaryState();
            syncAmberGate();
          } else {
            toast(`ngit install exited ${r.code}`, '', 'err');
          }
        });
      }
    };

    // Connect Amber depends on `ngit account login` being executable.
    // Disabling the button (rather than hiding it) keeps the affordance
    // visible so the user understands the dependency, with a hint
    // pointing back at the install row above. Re-enabled by
    // renderBinaryState's post-install handler.
    const syncAmberGate = () => {
      const btn  = $('setup-ngit-amber-btn');
      const hint = $('setup-ngit-amber-gate-hint');
      if (!btn) return;
      if (ngitInstalled) {
        btn.disabled = false;
        btn.title    = '';
        if (hint) hint.style.display = 'none';
      } else {
        btn.disabled = true;
        btn.title    = 'Install ngit first (above)';
        if (hint) hint.style.display = '';
      }
    };

    renderBinaryState();
    syncAmberGate();

    root.querySelector('.setup-back').addEventListener('click', back);
    root.querySelector('#setup-ngit-skip').addEventListener('click', next);
    root.querySelector('#setup-ngit-next').addEventListener('click', next);

    const amberBtn = $('setup-ngit-amber-btn');
    if (amberBtn) {
      amberBtn.addEventListener('click', async () => {
        if (!window.NSTerminal?.isAvailable?.()) {
          toast('Terminal unavailable', 'Use Config → ngit → Re-login after setup', 'warn');
          return;
        }
        // Raise the terminal drawer above the wizard overlay so the QR
        // is actually visible; a small "Return to setup" pill lets the
        // user jump back without closing the terminal.
        document.body.classList.add('setup-term-hoist');
        window.NSTerminal.expand();
        window.NSTerminal.open('ngit-login');
        mountReturnPill();
      });
    }
  }

  function mountReturnPill() {
    let pill = document.getElementById('setup-return-pill');
    if (pill) return;
    pill = document.createElement('button');
    pill.id = 'setup-return-pill';
    pill.className = 'setup-return-pill';
    pill.textContent = '← Return to setup';
    pill.addEventListener('click', () => {
      document.body.classList.remove('setup-term-hoist');
      window.NSTerminal?.collapse?.();
      pill.remove();
    });
    document.body.appendChild(pill);
  }

  // ── VPN ──────────────────────────────────────────────────────────────
  // Optional stage. Downloads + installs the nvpn binary into ~/.cargo/bin
  // and runs `sudo -n nvpn service install` to register the systemd unit.
  // Skippable — users who don't need the mesh VPN can advance to Done.
  //
  // Reads a newline-delimited JSON stream from /api/setup/nvpn/install and
  // renders one row per `{type:"progress"}` event so the user sees each
  // step (download / extract / locate / copy / verify / init / service)
  // live instead of a 60-second freeze. The final `{type:"done"}` event
  // carries the overall ok/detail and closes the stream.
  async function renderVpn() {
    root.innerHTML = shell(
      'nostr-vpn (optional)',
      'Mesh VPN over Nostr — connect dev machines without port forwarding.',
      `
        <p class="setup-copy">
          nostr-vpn creates an encrypted mesh between machines using Nostr as
          the signalling layer. Useful if you run projects across laptop +
          server; skip it if you only develop locally. You can always run
          this step again later by revisiting <code>/setup</code>.
        </p>
        <div class="setup-vpn-steps" id="setup-vpn-steps"></div>
        <div class="setup-actions">
          <button class="setup-back">← Back</button>
          <div style="display:flex;gap:8px">
            <button class="setup-skip" id="setup-vpn-skip">Skip for now</button>
            <button class="primary" id="setup-vpn-install">Install nvpn</button>
          </div>
        </div>
      `,
    );
    root.querySelector('.setup-back').addEventListener('click', back);
    root.querySelector('#setup-vpn-skip').addEventListener('click', next);

    const installBtn = $('setup-vpn-install');
    const stepsEl = $('setup-vpn-steps');

    installBtn.addEventListener('click', async () => {
      installBtn.disabled = true;
      installBtn.innerHTML = '<span class="spinner"></span> Installing…';
      stepsEl.innerHTML = '';

      // Flip the currently-running row to the terminal state (ok/err) so
      // the next progress event starts on a fresh row. `cls` is the CSS
      // modifier to apply ('ok' when we advance past, 'err' when a failure
      // closes out the stream).
      const settleCurrent = (cls) => {
        const cur = stepsEl.querySelector('.setup-step-row.current');
        if (!cur) return;
        cur.classList.remove('current');
        cur.classList.add(cls);
      };

      const appendStep = (label) => {
        const row = document.createElement('div');
        row.className = 'setup-step-row current';
        row.innerHTML = `
          <span class="dot"><span class="spinner"></span></span>
          <span class="label">${escapeHtml(label)}</span>
        `;
        stepsEl.appendChild(row);
      };

      let finalMsg = null;
      try {
        const resp = await fetch('/api/setup/nvpn/install', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
        });
        if (!resp.ok || !resp.body) throw new Error(`HTTP ${resp.status}`);

        // NDJSON reader — split by \n, JSON.parse each line, render. Buffer
        // the partial tail across chunks so a single event split across
        // two TCP reads still parses cleanly.
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.trim()) continue;
            let msg;
            try { msg = JSON.parse(line); }
            catch { continue; }
            if (msg.type === 'progress') {
              settleCurrent('ok');
              appendStep(msg.step);
            } else if (msg.type === 'done') {
              finalMsg = msg;
              settleCurrent(msg.ok ? 'ok' : 'err');
              if (!msg.ok && msg.detail) {
                const last = stepsEl.querySelector('.setup-step-row:last-child');
                if (last) {
                  const det = document.createElement('span');
                  det.className = 'muted';
                  det.textContent = msg.detail;
                  last.appendChild(det);
                }
              }
            }
          }
        }
      } catch (e) {
        settleCurrent('err');
        toast('Install failed', e.message || String(e), 'err');
        installBtn.disabled = false;
        installBtn.textContent = 'Retry install';
        return;
      }

      installBtn.disabled = false;
      if (finalMsg?.ok) {
        installBtn.textContent = 'Installed ✓';
        toast('nvpn installed', finalMsg.detail || '', 'ok');
        setTimeout(next, 800);
      } else {
        installBtn.textContent = 'Retry install';
        toast('Install did not complete', finalMsg?.detail || 'see log at ~/logs/nvpn-install.log', 'warn');
      }
    });
  }

  // ── Done ─────────────────────────────────────────────────────────────
  // POSTs /api/setup/complete which flips setupComplete=true and hands
  // us a session token — we store it exactly like a normal sign-in and
  // navigate to '/' so the dashboard boots under real auth.
  function renderDone() {
    root.innerHTML = shell(
      'Your station is ready',
      'Setup complete — the dashboard is unlocking.',
      `
        <div class="setup-done">
          <div class="setup-done-icon">✓</div>
          <div class="setup-done-body">
            <p class="setup-copy">
              Everything's wired up. Click below to sign in and open the
              dashboard. You can revisit any of these settings any time
              from <strong>Config</strong>.
            </p>
          </div>
        </div>
        <div class="setup-actions">
          <button class="setup-back">← Back</button>
          <button class="primary" id="setup-done-go">Open dashboard →</button>
        </div>
        <div class="setup-done-status muted" id="setup-done-status"></div>
      `,
    );
    root.querySelector('.setup-back').addEventListener('click', back);

    const goBtn = $('setup-done-go');
    const statusEl = $('setup-done-status');
    goBtn.addEventListener('click', async () => {
      goBtn.disabled = true;
      goBtn.innerHTML = '<span class="spinner"></span> Unlocking…';
      statusEl.textContent = '';
      try {
        const r = await fetch('/api/setup/complete', { method: 'POST' })
          .then(r => r.json());
        if (!r.ok || !r.token) throw new Error(r.error || 'setup completion failed');
        // Store the token the same way AuthScreen does so the dashboard
        // picks it up on load.
        setSessionToken(r.token, r.expiresAt);
        toast('Welcome to nostr-station', truncNpub(r.npub || ''), 'ok');
        // Clean up any hoisted terminal state before handing off.
        document.body.classList.remove('setup-term-hoist');
        document.getElementById('setup-return-pill')?.remove();
        location.href = '/';
      } catch (e) {
        statusEl.textContent = e.message;
        statusEl.classList.add('err');
        goBtn.disabled = false;
        goBtn.textContent = 'Retry';
      }
    });
  }

  // ── Stage stubs (unused once all stages are live) ────────────────────
  function renderStub(stage) {
    root.innerHTML = shell(
      stage,
      'Placeholder stage.',
      `
        <div class="setup-actions">
          <button class="setup-back">← Back</button>
          <button class="primary setup-next">Continue →</button>
        </div>
      `,
    );
    root.querySelector('.setup-back').addEventListener('click', back);
    root.querySelector('.setup-next').addEventListener('click', next);
  }

  return { show, hide };
})();

// ── Panel: client (Nostr social client) ──────────────────────────────────
//
// Slim built-in Nostr client: feed (kind-1 from owner's follows), notifications
// (mentions/reactions/zaps tagging the owner), profile lookup, and compose +
// publish. Reads from the station owner's identity.readRelays — NOT the
// in-process relay, which has no inbound sync. Publishes through the persisted
// bunker pairing and auto-stamps ["client","nostr-station"].
//
// Private DMs (NIP-17) are intentionally NOT in v1. The "DMs" tab is rendered
// as a disabled placeholder so the IA is visible.

// ── Panel: Client ────────────────────────────────────────────────────────
//
// Slim shell around the embedded Ditto SPA. The dashboard keeps the
// header row (title + public chip + refresh button); everything else
// is Ditto, served same-origin from /ditto/* by serveDitto() in
// web-server-static.ts. Ditto handles its own auth (NIP-07 passes
// through from any installed browser extension; NIP-46 pairs inside
// Ditto's own settings if the user wants server-side signing here).
//
// When the Ditto bundle is missing — scripts/fetch-ditto.mjs failed at
// build time, or the user has STATION_SKIP_DITTO=1 — the server's
// /ditto/ route 404s with `{ error: 'ditto-not-bundled' }`. The panel
// HEAD-probes that endpoint on first mount and swaps the iframe for an
// inline instruction block in that case.
const ClientPanel = (() => {
  const frame      = $('client-ditto-frame');
  const missing    = $('client-ditto-missing');
  const refreshBtn = $('client-refresh');
  const retryBtn   = $('client-ditto-retry');
  const installBtn = $('client-ditto-install');

  let probed = false;

  async function probeDittoBundle() {
    if (probed) return;
    probed = true;
    try {
      const r = await fetch('/ditto/', { method: 'HEAD', cache: 'no-store' });
      if (r.ok) { showFrame(); return; }   // bundle present
      showMissing();
    } catch {
      // Network / aborted — leave the iframe alone (it surfaces its own
      // error). probed=true prevents thrashing on repeated panel-enters.
    }
  }

  function showMissing() {
    if (frame)   frame.hidden = true;
    if (missing) missing.hidden = false;
  }
  function showFrame() {
    if (frame)   frame.hidden = false;
    if (missing) missing.hidden = true;
  }

  // Refresh = reload the embedded SPA without leaving the dashboard.
  // Re-setting src is cheaper than a full page reload and keeps the
  // dashboard session intact. Brief empty-src step forces the browser
  // to actually re-mount (some engines no-op an identical src write).
  function reloadFrame() {
    if (!frame) return;
    const url = frame.getAttribute('src') || '/ditto/';
    frame.setAttribute('src', '');
    requestAnimationFrame(() => frame.setAttribute('src', url));
  }

  // Bounce nsite-gateway navigations from inside Ditto into our own
  // nsite browser panel. The injected script in Ditto's <head>
  // (web-server-static.ts:DITTO_PREFIX_STRIP_SCRIPT) catches window.open
  // and <a> clicks targeting *.nsite.lol / *.nsite.run / *.nsite.cloud /
  // *.nosto.re / *.nwb.tf / *.nostr.hu and postMessages the URL up here.
  // We re-validate origin, source, and the gateway pattern before
  // accepting, then drop the URL onto #nsite/<encoded-url>. The nsite
  // panel's existing maybeConsumeDeepLink() flow takes it from there:
  // address bar, resolver, iframe boot — same code path as if the user
  // typed the URL in directly.
  const NSITE_GATEWAY_HOST = /^[^.]+\.(?:nsite\.lol|nsite\.run|nsite\.cloud|nosto\.re|nwb\.tf|nostr\.hu)$/i;
  window.addEventListener('message', (event) => {
    if (!frame || event.source !== frame.contentWindow) return;
    if (event.origin !== location.origin) return;
    const m = event.data;
    if (!m || typeof m !== 'object') return;
    if (m.type !== 'station:open-nsite' || typeof m.url !== 'string') return;
    let host;
    try { host = new URL(m.url, location.origin).hostname; } catch { return; }
    if (!NSITE_GATEWAY_HOST.test(host)) return;
    location.hash = '#nsite/' + encodeURIComponent(m.url);
  });

  refreshBtn?.addEventListener('click', reloadFrame);
  retryBtn?.addEventListener('click', () => {
    // User just ran `npm run update-ditto` and clicked Reload — re-probe
    // + remount in case the bundle is now present.
    probed = false;
    void probeDittoBundle().then(() => reloadFrame());
  });
  // In-dashboard fetch — spawns scripts/fetch-ditto.mjs server-side and
  // streams the output through the existing exec modal. Saves the user
  // from SSH'ing to the VM when the build-time fetch failed. After the
  // exec modal closes successfully, we re-probe + reload the iframe so
  // the freshly-bundled Ditto mounts without a page refresh.
  installBtn?.addEventListener('click', () => {
    openExecModal({
      title:    'Fetch Ditto',
      subtitle: 'Downloads + extracts Ditto into dist/ditto/ (~6 MiB from GitLab)',
      endpoint: '/api/ditto/install',
    }).then(r => {
      if (r.ok) {
        toast('Ditto installed', 'Reloading the Client panel…', 'ok');
        probed = false;
        void probeDittoBundle().then(() => reloadFrame());
      } else {
        toast('Fetch failed', `exit code ${r.code}`, 'err');
      }
    });
  });

  return {
    onEnter() { void probeDittoBundle(); },
  };
})();

// ── Panel: Mail ──────────────────────────────────────────────────────────
//
// Encrypted NIP-17 mail. Two-pane layout — thread list on the left,
// active thread on the right. Reads from /api/mail/inbox + /api/mail/thread;
// the inbox worker decrypts gift wraps in the background and persists
// rumors to mail.db, so the panel only needs to render decrypted state.
//
// This PR ships read-only. Compose + send arrive in the follow-up patch
// that wires up the recipient resolver + the send pipeline.

const MailPanel = (() => {
  let threads        = [];
  let requests       = [];        // PR 7: quarantine bucket
  let blocked        = [];        // PR 7: blocklist entries
  let folders        = { defaults: [], custom: [] };  // PR 10: folder counts
  let activeTab      = 'inbox';   // 'inbox' | 'requests' | 'blocked'
  let activeFolder   = 'inbox';   // PR 10: active folder when activeTab === 'inbox'
  let activeCounter  = null;      // hex pubkey of the open thread, or null
  let activeMessages = [];
  let lastStatus     = null;

  function npubShort(hex) {
    if (!hex) return '';
    return `${hex.slice(0, 8)}…${hex.slice(-4)}`;
  }
  function fmtAge(epochS) {
    if (!epochS) return '';
    const s = Math.max(0, Date.now() / 1000 - epochS);
    if (s < 60)     return `${Math.floor(s)}s`;
    if (s < 3600)   return `${Math.floor(s / 60)}m`;
    if (s < 86400)  return `${Math.floor(s / 3600)}h`;
    return `${Math.floor(s / 86400)}d`;
  }
  function preview(s) {
    return String(s || '').replace(/\s+/g, ' ').slice(0, 120);
  }

  async function load() {
    try {
      // Fetch inbox (filtered by active folder) + requests + folder
      // counts + status in parallel. Blocked list is fetched lazily.
      const inboxPath = activeTab === 'inbox' && activeFolder !== 'inbox'
        ? `/api/mail/inbox?bucket=inbox&folder=${encodeURIComponent(activeFolder)}`
        : '/api/mail/inbox?bucket=inbox';
      const [inbox, reqs, foldersResp, status] = await Promise.all([
        api(inboxPath,                            undefined, { silent: true }),
        api('/api/mail/requests',                 undefined, { silent: true }).catch(() => ({ threads: [] })),
        api('/api/mail/folders',                  undefined, { silent: true }).catch(() => null),
        api('/api/mail/status',                   undefined, { silent: true }).catch(() => null),
      ]);
      threads    = Array.isArray(inbox?.threads) ? inbox.threads : [];
      requests   = Array.isArray(reqs?.threads)  ? reqs.threads  : [];
      if (foldersResp) folders = {
        defaults: Array.isArray(foldersResp.defaults) ? foldersResp.defaults : [],
        custom:   Array.isArray(foldersResp.custom)   ? foldersResp.custom   : [],
      };
      lastStatus = status?.stats || null;
      renderStatus();
      renderTabBadges();
      renderFolders();
      renderThreads();
      updateBadge();
      // If a thread is open, reload its messages too — new arrivals are
      // surfaced live by re-rendering from the store.
      if (activeCounter) await loadThread(activeCounter);
    } catch (e) {
      const el = $('mail-threads');
      if (el) el.innerHTML = `<div class="mail-empty">Failed to load: ${escapeHtml(e?.message || e)}</div>`;
    }
  }

  // ── Folder sidebar (PR 10) ─────────────────────────────────────────────
  const FOLDER_LABELS = {
    inbox:   'Inbox',
    sent:    'Sent',
    archive: 'Archive',
    trash:   'Trash',
  };
  // Lucide-style stroke SVGs to match the rest of the dashboard's icon
  // grammar (nav-icons, terminal bar, etc.). Sized + colored via CSS;
  // every path uses currentColor so active/hover states inherit naturally.
  const SVG_OPEN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
  const FOLDER_ICONS = {
    inbox:   `${SVG_OPEN}<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11Z"/></svg>`,
    sent:    `${SVG_OPEN}<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`,
    archive: `${SVG_OPEN}<rect x="2" y="4" width="20" height="5" rx="1"/><path d="M4 9v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9"/><line x1="10" y1="13" x2="14" y2="13"/></svg>`,
    trash:   `${SVG_OPEN}<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`,
  };
  const FOLDER_ICON_DEFAULT = `${SVG_OPEN}<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`;
  const ICON_PAPERCLIP = `${SVG_OPEN}<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 17.93 8.83l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>`;
  const ICON_LOCK      = `${SVG_OPEN}<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`;
  function renderFolders() {
    const el = $('mail-folders');
    if (!el) return;
    // Folder sidebar is only visible in the Inbox tab; Requests and
    // Blocked are flat lists by design.
    if (activeTab !== 'inbox') { el.hidden = true; return; }
    el.hidden = false;
    const renderRow = (f, isCustom) => {
      const label = FOLDER_LABELS[f.id] ?? f.id;
      const icon  = FOLDER_ICONS[f.id]  ?? FOLDER_ICON_DEFAULT;
      const active = f.id === activeFolder ? ' active' : '';
      const unread = f.unread > 0
        ? `<span class="mail-folder-unread">${f.unread > 99 ? '99+' : f.unread}</span>`
        : '';
      return `<button class="mail-folder-row${active}" data-folder="${escapeHtml(f.id)}">
        <span class="mail-folder-icon">${icon}</span>
        <span class="mail-folder-label">${escapeHtml(label)}</span>
        ${unread}
        <span class="mail-folder-total" title="${f.total} total">${f.total || ''}</span>
      </button>`;
    };
    el.innerHTML = `
      <div class="mail-folder-section">
        ${(folders.defaults || []).map(f => renderRow(f, false)).join('')}
      </div>
      ${(folders.custom || []).length > 0 ? `
        <div class="mail-folder-section">
          <div class="mail-folder-section-title">Folders</div>
          ${folders.custom.map(f => renderRow(f, true)).join('')}
        </div>` : ''}
      <button class="mail-folder-add" id="mail-folder-add">+ new folder</button>
    `;
    for (const btn of $$('.mail-folder-row', el)) {
      btn.addEventListener('click', () => {
        const f = btn.getAttribute('data-folder');
        if (!f || f === activeFolder) return;
        activeFolder = f;
        activeCounter  = null;
        activeMessages = [];
        renderFolders();
        void load();
        renderThread();
      });
    }
    $('mail-folder-add')?.addEventListener('click', async () => {
      const name = prompt('New folder name (a-z, 0-9, dash, underscore; max 32 chars):');
      if (!name) return;
      if (!/^[a-z0-9_-]{1,32}$/i.test(name)) {
        toast('Bad folder name', 'Use only letters, numbers, dash, underscore (max 32).', 'warn');
        return;
      }
      if (folders.defaults.find(f => f.id === name) || folders.custom.find(f => f.id === name)) {
        toast('Folder exists', `"${name}" is already in your list.`, 'warn');
        return;
      }
      try {
        const next = [...folders.custom.map(f => f.id), name];
        await api('/api/mail/settings', {
          method:  'PUT',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ customFolders: next }),
        });
        toast('Folder created', `"${name}" added.`, 'ok');
        await load();
      } catch { /* api() already toasted */ }
    });
  }

  async function loadBlocked() {
    try {
      const r = await api('/api/mail/lists', undefined, { silent: true });
      blocked = Array.isArray(r?.blocklist) ? r.blocklist : [];
      if (activeTab === 'blocked') renderThreads();
    } catch {
      blocked = [];
    }
  }

  function renderTabBadges() {
    const b = $('mail-tab-badge-requests');
    if (!b) return;
    if (requests.length > 0) {
      b.hidden = false;
      b.textContent = String(requests.length > 99 ? '99+' : requests.length);
    } else {
      b.hidden = true;
    }
  }

  function setTab(tab) {
    if (tab !== 'inbox' && tab !== 'requests' && tab !== 'blocked') return;
    activeTab = tab;
    activeCounter  = null;
    activeMessages = [];
    for (const btn of $$('.mail-tab')) {
      const on = btn.getAttribute('data-tab') === tab;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    renderFolders();
    renderThreads();
    renderThread();
    if (tab === 'blocked') void loadBlocked();
    // Switching back to Inbox re-fetches with the current folder filter.
    if (tab === 'inbox') void load();
  }

  async function loadThread(counterparty) {
    try {
      const r = await api(`/api/mail/thread?counterparty=${encodeURIComponent(counterparty)}`,
                          undefined, { silent: true });
      activeMessages = Array.isArray(r?.messages) ? r.messages : [];
      renderThread();
      // Auto-mark incoming as read on open. Best-effort — failure here
      // just leaves them unread until the next click.
      const unreadIds = activeMessages.filter(m => m.direction === 'in' && !m.read).map(m => m.id);
      if (unreadIds.length) {
        await api('/api/mail/mark-read', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ ids: unreadIds }),
        }, { silent: true }).catch(() => {});
        // Reflect read-state in the in-memory cache without refetching.
        for (const m of activeMessages) if (unreadIds.includes(m.id)) m.read = true;
        const t = threads.find(t => t.counterparty === counterparty);
        if (t) t.unread = 0;
        renderThreads();
        updateBadge();
      }
    } catch (e) {
      const el = $('mail-thread');
      if (el) el.innerHTML = `<div class="mail-empty">Failed to load thread: ${escapeHtml(e?.message || e)}</div>`;
    }
  }

  function renderStatus() {
    const el = $('mail-status');
    if (!el) return;
    if (!lastStatus) { el.textContent = ''; return; }
    const bits = [];
    bits.push(`${lastStatus.relaysConnected} inbox relay${lastStatus.relaysConnected === 1 ? '' : 's'} connected`);
    bits.push(`${lastStatus.decryptedOk} decrypted`);
    if (lastStatus.decryptFailed) bits.push(`${lastStatus.decryptFailed} dropped`);
    el.textContent = bits.join(' · ');
    if (lastStatus.lastError) el.title = lastStatus.lastError;
  }

  function renderThreads() {
    const el = $('mail-threads');
    if (!el) return;

    // Blocked tab: pubkey list with Unblock buttons. No threads view.
    if (activeTab === 'blocked') {
      if (!blocked.length) {
        el.innerHTML = `<div class="mail-empty">No blocked senders.</div>`;
        return;
      }
      el.innerHTML = blocked.map(b => `
        <div class="mail-thread-item mail-block-row">
          <div class="mail-thread-row1">
            <span class="mail-thread-who">${escapeHtml(npubShort(b.pubkey))}</span>
            <span class="mail-thread-age">${escapeHtml(fmtAge(Math.floor(b.added_at / 1000)))}</span>
          </div>
          <div class="mail-thread-actions">
            <button class="mail-thread-unblock" data-pubkey="${escapeHtml(b.pubkey)}">unblock</button>
          </div>
        </div>`).join('');
      for (const btn of $$('.mail-thread-unblock', el)) {
        btn.addEventListener('click', async () => {
          const pk = btn.getAttribute('data-pubkey');
          try {
            await api('/api/mail/unblock', {
              method:  'POST',
              headers: { 'Content-Type': 'application/json' },
              body:    JSON.stringify({ pubkey: pk }),
            });
            toast('Unblocked', `${npubShort(pk)} can send mail again.`, 'ok');
            await loadBlocked();
          } catch { /* api() already toasted */ }
        });
      }
      return;
    }

    const list = activeTab === 'requests' ? requests : threads;
    if (!list.length) {
      const msg = activeTab === 'requests'
        ? 'No requests yet. Mail from senders you don\'t follow lands here.'
        : 'No mail yet. Encrypted messages addressed to your npub will appear here.';
      el.innerHTML = `<div class="mail-empty">${escapeHtml(msg)}</div>`;
      return;
    }
    const items = list.map(t => {
      const active = activeCounter === t.counterparty ? ' active' : '';
      const unreadDot = t.unread > 0 ? '<span class="mail-unread-dot" aria-label="unread"></span>' : '';
      const requestActions = activeTab === 'requests' ? `
        <div class="mail-thread-actions">
          <button class="mail-thread-accept" data-pubkey="${escapeHtml(t.counterparty)}">accept</button>
          <button class="mail-thread-block danger" data-pubkey="${escapeHtml(t.counterparty)}">block</button>
        </div>` : '';
      return `<button class="mail-thread-item${active}" data-counter="${escapeHtml(t.counterparty)}">
        ${unreadDot}
        <div class="mail-thread-row1">
          <span class="mail-thread-who">${escapeHtml(npubShort(t.counterparty))}</span>
          <span class="mail-thread-age">${escapeHtml(fmtAge(t.last_created_at))}</span>
        </div>
        <div class="mail-thread-subj">${escapeHtml(t.last_subject || '(no subject)')}</div>
        <div class="mail-thread-prev">${escapeHtml(preview(t.last_preview))}</div>
        ${requestActions}
      </button>`;
    }).join('');
    el.innerHTML = items;
    for (const btn of $$('.mail-thread-item', el)) {
      btn.addEventListener('click', (e) => {
        // The inner accept/block buttons stop propagation themselves;
        // this fires for clicks on the body of the chip.
        const c = btn.getAttribute('data-counter');
        if (!c) return;
        activeCounter = c;
        renderThreads();
        void loadThread(c);
      });
    }
    for (const btn of $$('.mail-thread-accept', el)) {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const pk = btn.getAttribute('data-pubkey');
        try {
          await api('/api/mail/accept', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ pubkey: pk }),
          });
          toast('Accepted', `${npubShort(pk)} moved to inbox.`, 'ok');
          await load();
        } catch { /* api() already toasted */ }
      });
    }
    for (const btn of $$('.mail-thread-block', el)) {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const pk = btn.getAttribute('data-pubkey');
        try {
          await api('/api/mail/block', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ pubkey: pk }),
          });
          toast('Blocked', `${npubShort(pk)} is blocked and their history was deleted.`, 'ok');
          if (activeCounter === pk) {
            activeCounter  = null;
            activeMessages = [];
            renderThread();
          }
          await load();
        } catch { /* api() already toasted */ }
      });
    }
  }

  function renderThread() {
    const el = $('mail-thread');
    if (!el) return;
    if (!activeCounter) {
      el.innerHTML = `<div class="mail-empty">Pick a conversation to view messages.</div>`;
      return;
    }
    if (!activeMessages.length) {
      el.innerHTML = `<div class="mail-empty">No messages in this thread yet.</div>`;
      return;
    }
    // Subject of the most recent message is shown at the top.
    const lastSubj = activeMessages[activeMessages.length - 1].subject;
    const head = `<div class="mail-thread-head">
      <div>
        <div class="mail-thread-counter">${escapeHtml(npubShort(activeCounter))}</div>
        <div class="mail-thread-headsubj">${escapeHtml(lastSubj || '(no subject)')}</div>
      </div>
      <div class="mail-thread-head-actions">
        <select id="mail-thread-move" title="Move thread to folder">
          <option value="">Move to…</option>
          ${[...(folders.defaults || []), ...(folders.custom || [])]
            .map(f => `<option value="${escapeHtml(f.id)}">${escapeHtml(FOLDER_LABELS[f.id] ?? f.id)}</option>`)
            .join('')}
        </select>
        <button class="primary mail-thread-reply" id="mail-thread-reply">reply</button>
      </div>
    </div>`;
    function fmtSize(size) {
      return size > 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)} MiB`
           : size > 1024        ? `${(size / 1024).toFixed(1)} KiB`
                                 : `${size} B`;
    }
    function renderAttachmentChip(m, a) {
      const tok = getSessionToken();
      let href;
      if (a.blossom) {
        // Blossom-hosted, AES-256-GCM encrypted. Route through the
        // proxy-decrypt endpoint so the browser sees plaintext.
        href = `/api/mail/download?id=${encodeURIComponent(m.id)}&sha=${encodeURIComponent(a.blossom.sha256)}${tok ? `&token=${tok}` : ''}`;
      } else if (a.inlineBase64 != null) {
        // Inline base64 — decode to a data URL for direct download. The
        // bytes were already E2E-encrypted at rest inside the gift wrap;
        // there's nothing to fetch.
        href = `data:${a.mime};base64,${a.inlineBase64}`;
      } else {
        href = '#';
      }
      const name = a.name || (a.blossom?.sha256 || '').slice(0, 12) || 'attachment';
      return `<a class="mail-msg-fileChip" href="${escapeHtml(href)}"
                 ${a.blossom ? 'target="_blank" rel="noopener noreferrer"' : `download="${escapeHtml(name)}"`}>
        <span class="mail-att-icon">${ICON_PAPERCLIP}</span>
        <div class="mail-msg-fileMeta">
          <div class="mail-msg-fileName">${escapeHtml(name)} <span class="mail-att-lock" title="end-to-end encrypted">${ICON_LOCK}</span></div>
          <div class="mail-msg-fileSub">${escapeHtml(a.mime || 'application/octet-stream')} · ${escapeHtml(fmtSize(a.size || 0))}</div>
        </div>
      </a>`;
    }

    const msgs = activeMessages.map(m => {
      const side  = m.direction === 'out' ? ' mail-msg-out' : ' mail-msg-in';
      const at    = new Date(m.created_at * 1000).toLocaleString();
      const subj  = m.subject ? `<div class="mail-msg-subj">${escapeHtml(m.subject)}</div>` : '';
      const body  = renderMarkdown
        ? renderMarkdown(String(m.body || ''))
        : escapeHtml(String(m.body || ''));
      const atts  = Array.isArray(m.attachments) && m.attachments.length > 0
        ? `<div class="mail-msg-attachments">${m.attachments.map(a => renderAttachmentChip(m, a)).join('')}</div>`
        : '';
      return `<div class="mail-msg${side}">
        <div class="mail-msg-meta">
          <span class="mail-msg-who">${m.direction === 'out' ? 'You' : escapeHtml(npubShort(activeCounter))}</span>
          <span class="mail-msg-at">${escapeHtml(at)}</span>
        </div>
        ${subj}
        <div class="mail-msg-body">${body}</div>
        ${atts}
      </div>`;
    }).join('');
    el.innerHTML = `${head}<div class="mail-msgs">${msgs}</div>`;
    const moveSel = $('mail-thread-move');
    if (moveSel) {
      moveSel.addEventListener('change', async () => {
        const target = moveSel.value;
        if (!target) return;
        const ids = activeMessages.map(m => m.id);
        try {
          await api('/api/mail/folder', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ ids, folder: target }),
          });
          toast('Moved', `Thread moved to ${FOLDER_LABELS[target] ?? target}.`, 'ok');
          activeCounter  = null;
          activeMessages = [];
          await load();
          renderThread();
        } catch { /* api() already toasted */ }
        moveSel.value = '';
      });
    }
    const replyBtn = $('mail-thread-reply');
    if (replyBtn) {
      replyBtn.addEventListener('click', () => {
        const subj = lastSubj && !/^re:\s/i.test(lastSubj) ? `Re: ${lastSubj}` : lastSubj;
        // PR 9: thread the reply via RFC 2822 Message-ID + References.
        // Most recent message's message-id becomes In-Reply-To; we walk
        // backwards collecting the chain so other RFC 2822 clients can
        // thread correctly.
        const lastWithId = [...activeMessages].reverse().find(m => m.message_id);
        const refs = activeMessages
          .map(m => m.message_id)
          .filter(id => !!id);
        onCompose({
          to:         activeCounter,
          subject:    subj,
          inReplyTo:  lastWithId?.message_id,
          references: refs,
        });
      });
    }
  }

  function updateBadge() {
    const badge = $('mail-badge');
    if (!badge) return;
    const totalUnread = threads.reduce((n, t) => n + (t.unread || 0), 0);
    if (totalUnread > 0) {
      badge.textContent = String(totalUnread > 99 ? '99+' : totalUnread);
      badge.style.display = '';
    } else {
      badge.style.display = 'none';
    }
  }

  // Live updates via SSE. The inbox worker fires events when new mail
  // arrives; we trigger a fresh load() so the inbox/threads/badge all
  // refresh together. A 60s safety-net poll catches the rare case where
  // the SSE socket drops silently (mobile suspend, NAT timeout) without
  // the EventSource onerror firing — refresh-on-arrival is exact, the
  // safety net is a backstop only.
  let eventStream = null;
  let safetyTimer = null;
  function startStream() {
    stopStream();
    const tok = getSessionToken();
    if (!tok) return;  // no session yet — load() will retry on next nav
    try {
      eventStream = new EventSource(`/api/mail/stream?token=${tok}`);
    } catch { return; }
    eventStream.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      // We never trust the rumorId from the frame as a source of truth —
      // the inbox worker has already persisted it. Just reload the
      // visible state. Same response handles "hello", "mail-received",
      // and "relay-retry" — the UI only needs to refresh status + threads.
      if (msg?.type === 'mail-received' || msg?.type === 'hello') {
        void load();
      } else if (msg?.type === 'relay-retry' || msg?.type === 'relay-closed') {
        // No reload needed; relay reconnect status is reflected in the
        // next /api/mail/status poll. We could opportunistically refresh
        // just the status line here, but keeping the SSE handler dumb
        // means fewer surprising re-renders.
      }
    };
    eventStream.onerror = () => {
      // EventSource auto-reconnects with exponential backoff; we let it
      // handle that. If the connection is fully dead, the safety-net
      // poll below picks up the slack.
    };
    // Safety net: re-fetch the inbox once a minute even if SSE is
    // silent. Cheap (one GET per minute) and self-healing.
    safetyTimer = setInterval(() => { void load(); }, 60_000);
  }
  function stopStream() {
    if (eventStream)  { try { eventStream.close(); } catch {} eventStream = null; }
    if (safetyTimer)  { clearInterval(safetyTimer); safetyTimer = null; }
  }

  // ── Compose modal ─────────────────────────────────────────────────────
  //
  // Resolves the recipient on `to` blur so the user gets immediate
  // feedback about delivery viability ("recipient has no inbox relay
  // advertised — delivery may fail"), then runs the full send pipeline
  // on submit via POST /api/mail/send.
  function onCompose(prefill) {
    const body = document.createElement('div');
    body.className = 'mail-compose';
    body.innerHTML = `
      <div class="mail-compose-field">
        <label for="mail-compose-to">to</label>
        <input id="mail-compose-to" type="text" autocomplete="off" spellcheck="false"
               placeholder="npub1… · hex pubkey · alice@example.com">
        <div class="mail-compose-tohint" id="mail-compose-tohint"></div>
      </div>
      <div class="mail-compose-field">
        <label for="mail-compose-subject">subject</label>
        <input id="mail-compose-subject" type="text" autocomplete="off">
      </div>
      <div class="mail-compose-field mail-compose-body-field">
        <label for="mail-compose-body">message</label>
        <textarea id="mail-compose-body" rows="10"
                  placeholder="Plain text. Markdown renders on receipt."></textarea>
      </div>
      <div class="mail-compose-field">
        <label>attachments</label>
        <div class="mail-compose-attachments" id="mail-compose-attachments"></div>
        <div class="mail-compose-attach-bar">
          <input type="file" id="mail-compose-file" multiple style="display:none">
          <button type="button" id="mail-compose-attach-btn">+ add file</button>
          <span class="mail-compose-attach-hint">
            Files go through your Blossom server. URL is encrypted inside the message.
          </span>
        </div>
      </div>
    `;
    const foot = document.createElement('div');
    foot.style.display = 'flex'; foot.style.gap = '8px'; foot.style.width = '100%';
    foot.style.justifyContent = 'flex-end';
    const cancel = document.createElement('button'); cancel.textContent = 'cancel';
    const send   = document.createElement('button'); send.textContent   = 'send'; send.className = 'primary';
    foot.appendChild(cancel); foot.appendChild(send);

    const modal = openModal({
      title:    'Compose mail',
      subtitle: 'NIP-17 · end-to-end encrypted',
      body, footer: foot,
    });
    modal.root.classList.add('mail-compose-modal');

    const toEl   = body.querySelector('#mail-compose-to');
    const subjEl = body.querySelector('#mail-compose-subject');
    const bodyEl = body.querySelector('#mail-compose-body');
    const hintEl = body.querySelector('#mail-compose-tohint');
    const attEl  = body.querySelector('#mail-compose-attachments');
    const fileEl = body.querySelector('#mail-compose-file');
    const attBtn = body.querySelector('#mail-compose-attach-btn');

    // Pending attachments: array of { url, sha256, mime, size, name }.
    // Each is uploaded to /api/mail/attachment as the user picks files;
    // on send, the array is included in the POST body.
    const attachments = [];

    function fmtBytes(n) {
      if (n < 1024)        return `${n} B`;
      if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
      return `${(n / 1024 / 1024).toFixed(1)} MiB`;
    }
    function renderAttachments() {
      if (!attEl) return;
      if (attachments.length === 0) {
        attEl.innerHTML = `<div class="mail-compose-attach-empty">No attachments yet.</div>`;
        return;
      }
      attEl.innerHTML = attachments.map((a, i) => `
        <div class="mail-att-chip" data-i="${i}">
          <span class="mail-att-icon">${ICON_PAPERCLIP}</span>
          <span class="mail-att-name">${escapeHtml(a.name || a.sha256.slice(0, 12))}</span>
          <span class="mail-att-size">${escapeHtml(fmtBytes(a.size))}</span>
          <button class="mail-att-remove" data-i="${i}" aria-label="remove attachment">×</button>
        </div>`).join('');
      for (const btn of $$('.mail-att-remove', attEl)) {
        btn.addEventListener('click', () => {
          const i = Number(btn.getAttribute('data-i'));
          attachments.splice(i, 1);
          renderAttachments();
        });
      }
    }
    renderAttachments();

    // PR 9: files ≤32 KiB get base64-encoded client-side and inlined in
    // the outgoing RFC 2822 multipart body — no Blossom round-trip
    // needed because the gift-wrap NIP-44 encryption already protects
    // the bytes end-to-end. Larger files go through /api/mail/attachment
    // for AES-GCM + Blossom upload as before.
    const INLINE_THRESHOLD = 32 * 1024;
    function arrayBufferToBase64(buf) {
      // Chunked toString to avoid stack blowup on multi-MiB buffers
      // (Function.apply with too many args throws on some engines).
      const bytes = new Uint8Array(buf);
      let binary = '';
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      }
      return btoa(binary);
    }

    attBtn?.addEventListener('click', () => fileEl.click());
    fileEl?.addEventListener('change', async () => {
      const files = Array.from(fileEl.files || []);
      fileEl.value = '';  // reset so picking the same file twice still fires change
      for (const f of files) {
        try {
          attBtn.disabled = true;
          if (f.size <= INLINE_THRESHOLD) {
            // Inline path: base64 client-side, no upload.
            attBtn.textContent = `encoding ${f.name}…`;
            const ab     = await f.arrayBuffer();
            const base64 = arrayBufferToBase64(ab);
            attachments.push({
              kind:   'inline',
              name:   f.name,
              mime:   f.type || 'application/octet-stream',
              size:   f.size,
              base64,
            });
          } else {
            // Blossom path: server encrypts + uploads ciphertext.
            attBtn.textContent = `uploading ${f.name}…`;
            const r = await api(
              `/api/mail/attachment?mime=${encodeURIComponent(f.type || 'application/octet-stream')}&name=${encodeURIComponent(f.name)}`,
              { method: 'POST', headers: { 'Content-Type': f.type || 'application/octet-stream' }, body: f },
            );
            attachments.push({
              kind:            'blossom',
              name:            r.name || f.name,
              mime:            r.mime,
              size:            r.size,
              url:             r.url,
              sha256:          r.sha256,
              encryptionKey:   r.encryptionKey,
              encryptionNonce: r.encryptionNonce,
            });
          }
          renderAttachments();
        } catch (e) {
          // api() already toasted with the HTTP status — surface a hint
          // for the common case (Blossom not running).
          const msg = e?.message || String(e);
          if (/409/.test(msg)) {
            toast('Blossom is off', 'Files larger than 32 KiB need Blossom. Enable it in Config → Blossom or pick a smaller file.', 'warn');
          }
        } finally {
          attBtn.disabled = false;
          attBtn.textContent = '+ add file';
        }
      }
    });

    if (prefill) {
      // When replying we pre-fill `to` with the counterparty's npub-ish
      // hex; clicking "compose" from a thread keeps the user in flow.
      if (prefill.to)      toEl.value   = prefill.to;
      if (prefill.subject) subjEl.value = prefill.subject;
      if (prefill.body)    bodyEl.value = prefill.body;
    }
    setTimeout(() => toEl.focus(), 50);

    let resolvedRecipient = null;
    let resolving         = false;
    async function resolveNow() {
      const v = toEl.value.trim();
      if (!v) { hintEl.textContent = ''; resolvedRecipient = null; return; }
      if (resolving) return;
      resolving = true;
      hintEl.textContent = 'resolving…';
      hintEl.className = 'mail-compose-tohint';
      try {
        const r = await api('/api/mail/resolve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ to: v }),
        }, { silent: true });
        resolvedRecipient = r;
        const short = `${r.pubkey.slice(0, 8)}…${r.pubkey.slice(-4)}`;
        const inboxN = Array.isArray(r.inboxRelays) ? r.inboxRelays.length : 0;
        if (r.hasInbox) {
          hintEl.textContent = `✓ ${short} · ${inboxN} inbox relay${inboxN === 1 ? '' : 's'}`;
          hintEl.className = 'mail-compose-tohint ok';
        } else {
          hintEl.textContent = `⚠ ${short} · no inbox relays advertised; delivery may fail`;
          hintEl.className = 'mail-compose-tohint warn';
        }
      } catch (e) {
        const msg = (e?.message || String(e)).replace(/^.* 400.*?: /, '');
        hintEl.textContent = `✗ ${msg.slice(0, 120)}`;
        hintEl.className = 'mail-compose-tohint err';
        resolvedRecipient = null;
      } finally {
        resolving = false;
      }
    }
    toEl.addEventListener('blur', () => { void resolveNow(); });

    cancel.addEventListener('click', () => modal.close());
    send.addEventListener('click', async () => {
      const to   = toEl.value.trim();
      const subj = subjEl.value.trim();
      const msg  = bodyEl.value;
      if (!to) { toast('Missing recipient', 'Enter an npub, hex pubkey, or NIP-05 address.', 'warn'); return; }
      if (!msg.trim() && attachments.length === 0) {
        toast('Empty message', 'Write something or attach a file.', 'warn');
        return;
      }

      send.disabled = true; send.textContent = 'sending…';
      try {
        const r = await api('/api/mail/send', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({
            to, subject: subj, body: msg, attachments,
            inReplyTo:  prefill?.inReplyTo,
            references: prefill?.references,
          }),
        });
        const okRecipients = (r.recipient?.results || []).filter(x => x.ok).length;
        const totalRecipients = (r.recipient?.results || []).length;
        if (okRecipients > 0) {
          toast('Mail sent', `${okRecipients}/${totalRecipients} recipient inbox relays accepted.`, 'ok');
          modal.close();
          await load();
        } else {
          const reasons = (r.recipient?.results || []).map(x => x.reason).filter(Boolean).slice(0, 2);
          toast('Send failed', reasons.join(' · ') || 'all recipient relays rejected the wrap', 'err');
        }
      } catch (e) {
        // api() already toasts non-2xx — nothing more to do here.
      } finally {
        send.disabled = false; send.textContent = 'send';
      }
    });
  }

  function wireButtons() {
    const refresh = $('mail-refresh');
    if (refresh && !refresh.__wired) {
      refresh.__wired = true;
      refresh.addEventListener('click', () => { void load(); });
    }
    const compose = $('mail-compose');
    if (compose && !compose.__wired) {
      compose.__wired = true;
      compose.addEventListener('click', () => onCompose());
    }
    const settings = $('mail-settings');
    if (settings && !settings.__wired) {
      settings.__wired = true;
      settings.addEventListener('toggle', () => {
        if (settings.open) void loadInboxRelays();
      });
    }
    const tabs = $('mail-tabs');
    if (tabs && !tabs.__wired) {
      tabs.__wired = true;
      tabs.addEventListener('click', (e) => {
        const btn = e.target?.closest?.('.mail-tab');
        if (!btn) return;
        const tab = btn.getAttribute('data-tab');
        if (tab) setTab(tab);
      });
    }
  }

  // ── Inbox-relay management ─────────────────────────────────────────────
  //
  // Renders an editable list of wss:// URLs plus "publish kind 10050 now"
  // and "reset to defaults" buttons. The PUT call persists locally and
  // tries to publish a fresh kind 10050 in one shot; the publish button
  // is a manual retry hook for when the signed-publish step failed.

  async function loadInboxRelays() {
    const el = $('mail-settings-body');
    const sub = $('mail-settings-sub');
    if (!el) return;
    el.innerHTML = '<div class="mail-empty">loading…</div>';
    try {
      const r = await api('/api/mail/inbox-relays', undefined, { silent: true });
      const relays   = Array.isArray(r?.relays)   ? r.relays   : [];
      const defaults = Array.isArray(r?.defaults) ? r.defaults : [];
      if (sub) sub.textContent = `${relays.length} relay${relays.length === 1 ? '' : 's'}`;

      const rows = relays.map((u, i) => `
        <div class="mail-relay-row" data-i="${i}">
          <input type="text" class="mail-relay-url" value="${escapeHtml(u)}" spellcheck="false">
          <button class="danger mail-relay-remove" data-i="${i}">remove</button>
        </div>`).join('');

      el.innerHTML = `
        <div class="mail-relay-list" id="mail-relay-list">${rows}</div>
        <div class="mail-relay-add">
          <input type="text" id="mail-relay-new" placeholder="wss://…" spellcheck="false">
          <button id="mail-relay-add-btn">add</button>
        </div>
        <div class="mail-relay-actions">
          <button id="mail-relay-save" class="primary">save + publish</button>
          <button id="mail-relay-publish">publish only</button>
          <button id="mail-relay-reset">reset to defaults</button>
        </div>
        <div class="mail-relay-defaults">
          Defaults: <code>${escapeHtml(defaults.join('  '))}</code>
        </div>`;

      const readLocal = () => $$('.mail-relay-url', $('mail-relay-list'))
        .map(i => i.value.trim()).filter(Boolean);

      for (const btn of $$('.mail-relay-remove', el)) {
        btn.addEventListener('click', () => {
          btn.closest('.mail-relay-row')?.remove();
          if (sub) sub.textContent = `${readLocal().length} relay${readLocal().length === 1 ? '' : 's'}`;
        });
      }
      $('mail-relay-add-btn')?.addEventListener('click', () => {
        const input = $('mail-relay-new');
        const v = (input.value || '').trim();
        if (!/^wss?:\/\//.test(v)) {
          toast('Bad relay URL', 'must start with wss:// or ws://', 'warn');
          return;
        }
        const list = $('mail-relay-list');
        const i = $$('.mail-relay-row', list).length;
        const row = document.createElement('div');
        row.className = 'mail-relay-row';
        row.dataset.i = String(i);
        row.innerHTML = `<input type="text" class="mail-relay-url" value="${escapeHtml(v)}" spellcheck="false">
                         <button class="danger mail-relay-remove" data-i="${i}">remove</button>`;
        row.querySelector('.mail-relay-remove').addEventListener('click', () => row.remove());
        list.appendChild(row);
        input.value = '';
        if (sub) sub.textContent = `${readLocal().length} relay${readLocal().length === 1 ? '' : 's'}`;
      });

      async function save(publish) {
        const next = readLocal();
        if (next.length === 0) {
          toast('Need at least one inbox relay', 'Add a wss:// URL before saving.', 'warn');
          return;
        }
        try {
          const r = await api('/api/mail/inbox-relays', {
            method:  'PUT',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ relays: next, publish }),
          });
          if (publish && r?.publish?.attempted) {
            if (r.publish.ok) toast('Saved + published', 'kind 10050 accepted.', 'ok');
            else              toast('Saved (publish failed)', r.publish.error || 'no relays accepted the event', 'warn');
          } else {
            toast('Saved', 'Inbox relays updated locally.', 'ok');
          }
          // Refresh the worker stats so "N inbox relays connected" reflects
          // the new set on the very next render tick.
          await load();
          await loadInboxRelays();
        } catch { /* api() already toasted */ }
      }

      $('mail-relay-save')?.addEventListener('click', () => save(true));
      $('mail-relay-publish')?.addEventListener('click', async () => {
        try {
          const r = await api('/api/mail/inbox-relays/publish', { method: 'POST' });
          if (r.ok) toast('Published', 'kind 10050 broadcast to inbox + discovery relays.', 'ok');
          else      toast('Publish failed', r.error || 'no relays accepted', 'err');
        } catch { /* api() already toasted */ }
      });
      $('mail-relay-reset')?.addEventListener('click', () => {
        const list = $('mail-relay-list');
        list.innerHTML = defaults.map((u, i) => `
          <div class="mail-relay-row" data-i="${i}">
            <input type="text" class="mail-relay-url" value="${escapeHtml(u)}" spellcheck="false">
            <button class="danger mail-relay-remove" data-i="${i}">remove</button>
          </div>`).join('');
        for (const btn of $$('.mail-relay-remove', list)) {
          btn.addEventListener('click', () => {
            btn.closest('.mail-relay-row')?.remove();
            if (sub) sub.textContent = `${readLocal().length} relay${readLocal().length === 1 ? '' : 's'}`;
          });
        }
        if (sub) sub.textContent = `${defaults.length} relay${defaults.length === 1 ? '' : 's'} (defaults)`;
      });
    } catch (e) {
      el.innerHTML = `<div class="mail-empty">Failed to load relays: ${escapeHtml(e?.message || e)}</div>`;
    }
  }

  return {
    onEnter() {
      wireButtons();
      void load();
      startStream();
    },
    // Exposed for cleanup / tests. activatePanel() doesn't currently
    // call this — the SSE connection survives panel switches, which is
    // what we want (badge stays accurate).
    _stop: stopStream,
  };
})();

// ── nsite browser ────────────────────────────────────────────────────────
// Sandboxed iframe that renders NIP-5A v1 nsites. Address bar accepts
// `npub1…`, NIP-05 (`name@host`), `nsite://<x>`, or a bare NSIT name (the
// latter only when a name indexer is configured server-side).
//
// The iframe sandbox attribute is deliberately set WITHOUT
// `allow-same-origin`, so the rendered nsite runs in an opaque origin and
// cannot read this dashboard's cookies, localStorage, or fetch our /api/*
// endpoints with credentials. Subresources still load from
// /nsite-content/<siteId>/* on this server because that's an HTTP-fetch
// rule, not an origin check.
//
// Address bar history is panel-local (back/forward via in-memory stack).
// Persisting recent addresses is a future polish — sessionStorage-friendly
// once the panel proves out.
const NsitePanel = (() => {
  const els = {};

  // ── Multi-tab model ────────────────────────────────────────────────────
  //
  // Each tab owns its own complete browsing context: address-bar value,
  // resolve response (`body`), per-iframe CSP-violation / script-error
  // reports, nav history + cursor, and a dedicated <iframe> DOM element.
  // The single-tab module-level state (`history`, `cursor`, `reports`,
  // `currentBody`) became per-Tab fields; functions that previously
  // touched module state now operate on the result of `activeTab()`.
  //
  // Iframe-per-tab is intentional: switching tabs MUST NOT cause a
  // reload (no scroll-position loss, no re-fetch, no SPA re-hydration)
  // — that's the whole point of having tabs. The container holds N
  // iframes; only the active one is `display: block`, others stay
  // `display: none` and keep their full state.
  class Tab {
    constructor(id) {
      this.id = id;
      this.addr = '';           // last value typed in the address bar
      this.display = '';        // canonical display form (post-resolve)
      this.originalAddr = '';   // raw input for trust-toggle re-resolve
      this.title = 'New tab';   // shown in the tab strip
      this.history = [];        // [{ siteId, display, path, originalAddr }]
      this.cursor = -1;
      this.body = null;         // last /api/nsite/resolve response
      // Per-iframe report bucket — keyed by the snapshot's siteId so the
      // postMessage listener can fan messages back to the right tab even
      // when several iframes are alive simultaneously.
      this.reports = { siteId: '', cspViolations: [], scriptErrors: [], loaded: false };
      this.frameEl = null;      // <iframe> element, lazily created
      // Cached UI strings so activating a tab can restore exactly what
      // was on screen when it was last active without re-fetching.
      this.metaHtml = '';
      this.statusText = '';
      this.statusErr = false;
    }
  }

  const tabs = [];
  let activeId = null;
  let nextTabSeq = 0;

  function activeTab() { return tabs.find(t => t.id === activeId) || null; }

  // Track whether the next iframe `load` is from our own navigation (we
  // already updated the address bar) or from a link click inside the
  // iframe (we need to sync the address bar from iframe.contentWindow's
  // URL). Set when WE drive iframe.src. Lives at module scope rather
  // than per-tab because only the active tab's frame can fire load
  // events the user sees, and the next set-then-load pair is always
  // atomic within go() / loadIframe().
  let drivenLoad = false;

  function setStatus(msg, isError = false) {
    const tab = activeTab();
    if (tab) {
      tab.statusText = msg || '';
      tab.statusErr  = !!isError;
    }
    if (!els.status) return;
    els.status.textContent = msg || '';
    els.status.classList.toggle('err', !!isError);
  }
  function setMeta(text) {
    const tab = activeTab();
    if (tab) { tab.metaContent = text || ''; tab.metaIsHtml = false; }
    if (!els.meta) return;
    if (text) { els.meta.hidden = false; els.meta.textContent = text; }
    else      { els.meta.hidden = true;  els.meta.textContent = ''; }
  }

  // HTML variant — used when the meta line needs to embed interactive
  // bits (the inline "trusted · revoke" segment from the PR-1 banner-slim
  // work). Same shape as setMeta but uses innerHTML; callers that need
  // HTML must build it themselves with escapeHtml on any non-trusted
  // input. textContent is the default elsewhere to keep XSS surface
  // at zero for the common case.
  function setMetaHtml(html) {
    const tab = activeTab();
    if (tab) { tab.metaContent = html || ''; tab.metaIsHtml = true; }
    if (!els.meta) return;
    if (html) { els.meta.hidden = false; els.meta.innerHTML = html; }
    else      { els.meta.hidden = true;  els.meta.innerHTML  = ''; }
  }

  // Render the expandable "Diagnostics" block under the meta line. Lets the
  // user see exactly which kind:34128 events were found (paths, hashes,
  // ages) and which relays were consulted — invaluable for "I published
  // but the panel shows stale content" debugging, since you can spot a
  // year-old event lingering on one relay while your fresh publish never
  // reached the queried set.
  function setDiagnostics(body) {
    if (!els.diag || !els.diagBody) return;
    if (!body) {
      els.diag.hidden = true;
      els.diagBody.innerHTML = '';
      const t = activeTab();
      if (t) t.body = null;
      // Clear the standalone trust banner alongside Diagnostics so a
      // fresh Go() doesn't leave a stale Trust state visible while the
      // new resolve is in flight.
      refreshTrustBanner();
      return;
    }
    // Stash for re-render when CSP / script-error reports arrive from
    // the iframe asynchronously after the initial resolve.
    const t = activeTab();
    if (t) t.body = body;
    const fmtAge = (sec) => {
      if (!sec) return 'unknown';
      const diff = Math.max(0, Math.floor(Date.now() / 1000) - sec);
      if (diff < 60)        return `${diff}s ago`;
      if (diff < 3600)      return `${Math.floor(diff / 60)}m ago`;
      if (diff < 86400)     return `${Math.floor(diff / 3600)}h ago`;
      if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`;
      return `${Math.floor(diff / 86400 / 7)}w ago`;
    };
    const fmtDate = (sec) =>
      sec ? new Date(sec * 1000).toLocaleString() : '—';

    const entries = body.entries || [];
    const eventsHtml = entries.length
      ? `<div class="nsite-diag-table">
           <div class="head">path</div>
           <div class="head">age</div>
           <div class="head">sha256</div>
           ${entries.map(e => `
             <div title="${escapeHtml(e.path)}">${escapeHtml(e.path)}</div>
             <div title="${escapeHtml(fmtDate(e.createdAt))}">${escapeHtml(fmtAge(e.createdAt))}</div>
             <div title="${escapeHtml(e.sha256)}">${escapeHtml(e.sha256.slice(0, 12))}…</div>
           `).join('')}
         </div>`
      : '<div class="muted">No kind:34128 events found.</div>';

    const relayLines = (label, arr) => arr && arr.length
      ? `<div class="nsite-diag-section">
           <div class="nsite-diag-section-title">${escapeHtml(label)} (${arr.length})</div>
           <div class="nsite-diag-relays">
             ${arr.map(r => `<span class="nsite-diag-relay">${escapeHtml(r)}</span>`).join('')}
           </div>
         </div>`
      : '';
    const r = body.relays || {};
    const stale = (body.oldestAt && body.latestAt && body.oldestAt !== body.latestAt)
      ? `<div class="muted" style="margin-top:6px">Oldest event ${fmtAge(body.oldestAt)}, newest ${fmtAge(body.latestAt)} — multiple publishes detected.</div>`
      : '';

    // Kind shown in the diag counter depends on which probe served the
    // result: v2-named manifest is kind:35128, v2-root is kind:15128,
    // v1 per-file is kind:34128. Without this hint the user sees the
    // wrong kind number in the diagnostic — confusing when comparing
    // against `nak` output for the same author.
    const kindLabel = body.format === 'v2-named' ? 'kind:35128'
                    : body.format === 'v2-root'  ? 'kind:15128'
                    : 'kind:34128';
    els.diagBody.innerHTML = `
      <div class="nsite-diag-section">
        <div class="nsite-diag-section-title">Files (${entries.length} of ${body.totalEventsSeen || entries.length} ${kindLabel} seen)</div>
        ${eventsHtml}
        ${stale}
      </div>
      ${relayLines('Your read relays',    r.owner)}
      ${relayLines('Author NIP-65 outbox', r.authorOutbox)}
      ${relayLines('Manifest relay tags', r.manifest)}
      ${relayLines('Queried (union)',     r.queried)}
      ${reportsHtml()}
    `;
    els.diag.hidden = false;
    // Trust banner lives outside Diagnostics — refresh it in lockstep
    // since both react to the same body/reports state.
    refreshTrustBanner();
    // Site Info sidebar (PR-3) reads from the same body — keep it in
    // sync if currently open AND showing siteinfo (not settings; we
    // don't want a fresh resolve to clobber a half-edited form).
    if (els.siteInfo && !els.siteInfo.hidden && paneMode === 'siteinfo') {
      renderSiteInfo();
    }
  }

  // Tooltip text for the `?` icon next to the trust toggle. Intentionally
  // brief — three short sentences covering "what changes", "where it's
  // stored", and "why it's safe". Hover-only, no popover JS needed.
  const TRUST_TOOLTIP = (
    'Allow this nsite to fetch resources from any HTTPS URL ' +
    '(esm.sh modules, nostr.build images, Google Fonts, etc.). ' +
    'Saved per-author in nsite.json — once per nsite, ever. ' +
    'The station itself stays isolated either way: each nsite runs in ' +
    'its own browser origin and cannot reach the dashboard or your session.'
  );

  // Render the per-site trust control. Surfaces only when there's a
  // reason to show it — either the iframe reported a CSP violation that
  // the user could resolve by trusting, or the nsite is already trusted
  // (so the user can revoke). Otherwise we keep the block silent to
  // avoid cluttering the panel on the many nsites that never need it
  // (Ditto, Nostrord, jaredlogan, etc.).
  //
  // The output is rendered into #nsite-trust-banner (a dedicated slot
  // between Diagnostics and the iframe viewport), NOT into the
  // Diagnostics block itself. Prior placement at the bottom of
  // Diagnostics meant users had to expand the collapsed twirly to
  // discover the Trust button at all — invisible UX. The dedicated
  // banner slot is always visible when relevant.
  function trustControlHtml() {
    const tab = activeTab();
    if (!tab || !tab.body) return '';
    const pk = String(tab.body.pubkey || '');
    if (!pk) return '';
    const trusted = !!tab.body.trusted;
    const hasViolations = tab.reports.cspViolations.length > 0;
    // Only the call-to-action case earns the prominent banner now:
    // untrusted nsite that just got blocked from loading something the
    // user might want to allow. The trusted-status case moved into the
    // meta line (built in go() above) so it doesn't claim 40px of
    // vertical space for an action the user already took. Banner is
    // suppressed whenever (a) the nsite is already trusted, or (b)
    // there are no violations yet (untrusted-and-clean is rendering
    // fine under strict mode).
    if (trusted || !hasViolations) return '';
    const help = `<span class="nsite-trust-help" title="${escapeHtml(TRUST_TOOLTIP)}" aria-label="What does trust mean?">?</span>`;
    return `<div class="nsite-trust nsite-trust-off">
      <span>External content: <strong>strict</strong> · ${tab.reports.cspViolations.length} blocked</span>
      <button class="nsite-trust-btn primary" type="button"
              data-pk="${escapeHtml(pk)}" data-allow="true">Trust this nsite</button>
      ${help}
    </div>`;
  }

  // Render the trust control into its dedicated banner slot, OR hide
  // the slot entirely if there's nothing to surface. Called from
  // setDiagnostics + the message-listener re-render paths.
  function refreshTrustBanner() {
    if (!els.trustBanner) return;
    const html = trustControlHtml();
    if (html) {
      els.trustBanner.innerHTML = html;
      els.trustBanner.hidden = false;
    } else {
      els.trustBanner.innerHTML = '';
      els.trustBanner.hidden = true;
    }
  }

  // Renders the iframe-reported CSP violations and script errors. Empty
  // string when nothing's been reported yet (page may still be loading,
  // or the reporter hasn't fired). The trust toggle is NOT rendered
  // here — it lives in #nsite-trust-banner via refreshTrustBanner so
  // it's visible without expanding Diagnostics.
  function reportsHtml() {
    const tab = activeTab();
    if (!tab) return '';
    const cv = tab.reports.cspViolations;
    const se = tab.reports.scriptErrors;
    if (cv.length === 0 && se.length === 0) {
      if (tab.reports.loaded) {
        return `<div class="nsite-diag-section"><div class="nsite-diag-section-title">Sandbox clean</div><div class="muted" style="font-size:11px">No CSP violations or script errors reported by the iframe — render is unconstrained by the lockdown.</div></div>`;
      }
      return '';
    }
    const cvHtml = cv.length ? `
      <div class="nsite-diag-section-title">CSP blocked (${cv.length})</div>
      <div class="nsite-diag-table" style="grid-template-columns: 110px minmax(0,1fr)">
        <div class="head">directive</div>
        <div class="head">resource</div>
        ${cv.map(v => `
          <div title="${escapeHtml(v.violatedDirective)}">${escapeHtml(v.effectiveDirective || v.violatedDirective.split(' ')[0] || '?')}</div>
          <div title="${escapeHtml(v.blockedURI)}" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(v.blockedURI || '(inline)')}</div>
        `).join('')}
      </div>
      <div class="muted" style="font-size:10px;margin-top:4px">
        Authors: republish blocked assets through this nsite's Blossom servers and reference them as <code>/path</code>.
      </div>
    ` : '';
    const seHtml = se.length ? `
      <div class="nsite-diag-section-title" style="margin-top:8px">Script errors (${se.length})</div>
      <div style="display:flex;flex-direction:column;gap:2px;font-size:10px">
        ${se.map(e => `<div class="muted" title="${escapeHtml(e.filename)}:${e.lineno}" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(e.message)}</div>`).join('')}
      </div>
    ` : '';
    return `<div class="nsite-diag-section">${cvHtml}${seHtml}</div>`;
  }
  function setEmpty(visible) {
    const tab = activeTab();
    if (els.empty) els.empty.style.display = visible ? '' : 'none';
    if (tab?.frameEl) tab.frameEl.style.display = visible ? 'none' : '';
  }
  function updateNavButtons() {
    const tab = activeTab();
    const cur = tab ? tab.cursor : -1;
    const len = tab ? tab.history.length : 0;
    if (els.back)    els.back.disabled    = !(cur > 0);
    if (els.forward) els.forward.disabled = !(cur >= 0 && cur < len - 1);
  }

  // Resolve an address through the backend and, on success, load the
  // returned siteId's entry path in the iframe.
  async function go(rawAddr) {
    const addr = String(rawAddr || '').trim();
    if (!addr) return;
    // Ensure there's an active tab to write into. (init() should have
    // primed one already, but defensive.)
    let tab = activeTab();
    if (!tab) { tab = freshTab(); activateTab(tab.id); tab = activeTab(); }
    tab.addr = addr;
    setStatus('Resolving…');
    setMeta('');
    setDiagnostics(null);
    // Reset the report bucket on the ACTIVE tab — leftover CSP
    // violations / script errors from a previous nsite would be
    // misleading on a fresh resolve. Other tabs' report buckets are
    // intentionally untouched so they keep their state intact.
    tab.reports.siteId = '';
    tab.reports.cspViolations = [];
    tab.reports.scriptErrors = [];
    tab.reports.loaded = false;
    tab.body = null;
    try {
      const url = `/api/nsite/resolve?addr=${encodeURIComponent(addr)}`;
      // Bearer header is required: web-server.ts gates all /api/* paths
      // (except a tiny PUBLIC_API_PREFIXES list) behind requireSession.
      // The shared `api()` helper would add it automatically but also
      // throws + toasts on non-2xx, and we want to render the resolver's
      // structured errors (`name_indexer_disabled`, `no_files`,
      // `bad_address`, …) inline in the status pill instead of as a
      // global red toast.
      const token = getSessionToken();
      const headers = { 'Accept': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const res = await fetch(url, { headers });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = body?.message || body?.error || `HTTP ${res.status}`;
        setStatus(msg, true);
        // For no_files (404 with relay context) the server attaches the
        // relay tiers that were tried — render the Diagnostics block so
        // the user can see WHERE we looked, not just that we came up
        // empty. Useful for spotting "I see my publish on damus.io but
        // we didn't query it" situations.
        if (body?.relays) setDiagnostics(body);
        return;
      }
      const { siteId, display, fileCount, latestAt, source, entry,
              blossomServers, relays, format } = body;
      const entryPath = entry || 'index.html';
      // Bind the reporter bucket to the new siteId so postMessage events
      // from the iframe land in the right channel.
      tab.reports.siteId = siteId;
      tab.display = display;
      tab.originalAddr = addr;
      // Push new history entry (trim forward tail on fresh nav). Keep
      // BOTH the canonical display form (what the address bar shows)
      // AND the original raw input the user typed (`addr`). The original
      // matters for the trust-toggle re-resolve path: a gateway URL like
      // `https://<pubkey-base36><name>.nsite.lol/` decodes to display
      // `nsite://<name>`, but feeding that display back into the resolver
      // tries an NSIT lookup that fails ("name not found on indexer
      // relays") for non-Bitcoin names. Re-resolving via the original
      // `addr` always hits the same successful path.
      if (tab.cursor < tab.history.length - 1) tab.history.splice(tab.cursor + 1);
      tab.history.push({ siteId, display, path: entryPath, originalAddr: addr });
      tab.cursor = tab.history.length - 1;
      // Update the tab strip label with the new display name.
      tab.title = display || '(loading…)';
      renderTabStrip();
      setStatus(`✓ ${fileCount} file${fileCount === 1 ? '' : 's'} — ${source}`);
      const ts = latestAt ? new Date(latestAt * 1000).toLocaleString() : '';
      // Build a single-line summary of what was queried where. Counts
      // beat lists for legibility — full host names spill out of the
      // narrow meta line on every nsite with more than 2 relays.
      const ownerN  = relays?.owner?.length        ?? 0;
      const outboxN = relays?.authorOutbox?.length ?? 0;
      const blossomN = (blossomServers ?? []).length;
      const relayBits = [];
      relayBits.push(`Index: ${ownerN} your relay${ownerN === 1 ? '' : 's'}`);
      if (outboxN > 0) relayBits.push(`+ ${outboxN} author outbox`);
      relayBits.push(`Blossom: ${blossomN} server${blossomN === 1 ? '' : 's'}`);
      const tsBit = `Latest event: ${ts || 'unknown'}`;
      // Format hint — v2-named/v2-root means we found a kind:35128/15128
      // manifest (one event, all paths in tags). v1 means kind:34128
      // per-file events.
      const fmtBit = format === 'v2-named' ? 'NIP-5A v2 (named manifest)'
                   : format === 'v2-root'  ? 'NIP-5A v2 (root manifest)'
                   : format === 'v1'       ? 'NIP-5A v1 (per-file)'
                   : '';
      // Sandbox posture badge — shows the user that the iframe runs
      // with a strict CSP (no external HTTP, only same-origin assets
      // + WSS to Nostr relays). Trust signal: "the page you're about
      // to see can't phone home with your IP via tracking pixels."
      //
      // When the nsite is trusted (user previously clicked Trust on the
      // banner), inline the trust state + Revoke link here INSTEAD OF
      // shipping the prominent banner above the viewport. Status without
      // a call-to-action shouldn't push the iframe down 40px on every
      // load — the inline form is a single segment in a line the user
      // already reads, Revoke is one click away, and the banner reappears
      // automatically if a new violation surfaces.
      const trusted = !!body.trusted;
      const sandboxBit = trusted
        ? `<span class="nsite-meta-trusted">trusted sandbox</span> · <button class="nsite-meta-revoke" type="button" data-pk="${escapeHtml(String(body.pubkey || ''))}">revoke</button>`
        : (body.sandbox?.csp === 'strict-nsite' ? 'strict sandbox' : '');
      const bits = [fmtBit, tsBit, ...relayBits].filter(Boolean);
      // Build the plain-text portion with escapeHtml then append the
      // sandbox segment (which is the only place we intentionally emit
      // markup). Avoids any chance of an escaped relay URL or display
      // string sneaking interactive content into the meta line.
      const textPart = bits.map(escapeHtml).join(' · ');
      const metaHtml = sandboxBit ? `${textPart} · ${sandboxBit}` : textPart;
      setMetaHtml(metaHtml);
      setDiagnostics(body);
      loadIframe(siteId, entryPath, display);
      updateNavButtons();
    } catch (e) {
      setStatus(`Error: ${e?.message || e}`, true);
    }
  }

  // Build the per-nsite subdomain URL. Each siteId gets its own
  // <siteId>.nsite.localhost:<port> origin (server-side handler in
  // routes/nsite.ts:handleNsiteSubdomain). Browsers resolve *.localhost
  // to 127.0.0.1 per RFC 6761, treat it as Secure Context, and SOP
  // isolates it from the dashboard root via the subdomain. Net effect:
  // real localStorage / crypto.subtle / `Origin:` on WebSocket. The
  // server-side handler ensures /api/* paths return 404 on these
  // hostnames so a hostile nsite payload can't probe the dashboard API.
  function nsiteFrameUrl(siteId, path) {
    let safePath = String(path || '').replace(/^\/+/, '');
    // SPA routers (React Router, Vue Router, Next.js client navigation,
    // SvelteKit, ...) read `window.location.pathname` and match against
    // the route table. A bundle entry of `/index.html` resolves to
    // pathname=`/index.html`, which most route tables treat as a 404 —
    // visible on Shakespeare-built nsites as "Oops! Page not found"
    // on first load that only goes away after clicking "Return to Home".
    //
    // Strip the trailing `index.html` so the iframe URL is `/` instead.
    // The SPA router then matches its home route, and the server's
    // `normalizePath('')` rule maps the empty path back to `index.html`
    // for the SHA256 lookup, so the file resolution is unchanged. Same
    // convention nsite.lol / Cloudflare Pages / Netlify static hosting
    // use; the browser-visible URL gets the canonical trailing slash
    // while disk-stored content keeps its index.html filename.
    if (safePath === 'index.html' || safePath === '') {
      safePath = '';
    } else if (safePath.endsWith('/index.html')) {
      safePath = safePath.slice(0, -'index.html'.length);
    }
    const proto = window.location.protocol;
    const port = window.location.port ? `:${window.location.port}` : '';
    return `${proto}//${siteId}.nsite.localhost${port}/${safePath}`;
  }

  function loadIframe(siteId, path, display) {
    const tab = activeTab();
    if (!tab) return;
    // Lazily create the iframe element on the active tab. Sandbox flags
    // mirror what we used to hard-code in index.html for the single
    // #nsite-frame element; per-tab iframes need the same posture.
    if (!tab.frameEl) {
      const fr = document.createElement('iframe');
      fr.className = 'nsite-frame';
      fr.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-same-origin');
      fr.setAttribute('referrerpolicy', 'no-referrer');
      fr.title = 'nsite content';
      fr.dataset.tabId = tab.id;
      fr.addEventListener('load', onIframeLoad);
      if (els.frames) els.frames.appendChild(fr);
      tab.frameEl = fr;
    }
    // Make this tab's frame the only visible one in case activation
    // raced ahead of loadIframe.
    for (const t of tabs) {
      if (t.frameEl) t.frameEl.style.display = (t.id === tab.id) ? '' : 'none';
    }
    setEmpty(false);
    drivenLoad = true;
    tab.frameEl.src = nsiteFrameUrl(siteId, path);
    if (els.addr) els.addr.value = display || els.addr.value;
  }

  function navigate(delta) {
    const tab = activeTab();
    if (!tab) return;
    const target = tab.cursor + delta;
    if (target < 0 || target >= tab.history.length) return;
    tab.cursor = target;
    const h = tab.history[tab.cursor];
    loadIframe(h.siteId, h.path, h.display);
    updateNavButtons();
  }

  function reload() {
    const tab = activeTab();
    if (!tab || tab.cursor < 0 || tab.cursor >= tab.history.length) {
      // Nothing in history yet — re-run the typed address.
      if (els.addr?.value) void go(els.addr.value);
      return;
    }
    const h = tab.history[tab.cursor];
    loadIframe(h.siteId, h.path, h.display);
  }

  function onIframeLoad(ev) {
    // Each tab's iframe gets its own load listener so we know which
    // tab fired. The internal-nav path update only applies to the
    // tab that owns the loaded iframe — not unconditionally to the
    // active tab (a background tab might be navigating without us
    // having activated it).
    const fr = ev?.currentTarget;
    const tabId = fr?.dataset?.tabId;
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) { drivenLoad = false; return; }
    try {
      const href = fr.contentWindow?.location?.href || '';
      const m = href.match(/\/nsite-content\/([a-f0-9]{16})\/(.*)$/);
      if (m && !drivenLoad) {
        const [, sid, p] = m;
        if (tab.cursor >= 0 && tab.history[tab.cursor]?.siteId === sid) {
          tab.history[tab.cursor] = { ...tab.history[tab.cursor], path: p };
        }
      }
    } catch { /* sandboxed cross-origin read — ignore */ }
    drivenLoad = false;
  }

  // Listen for postMessage from the iframe's injected reporter. The
  // iframe is in an opaque origin so event.origin is "null" — we
  // authenticate the message by shape + siteId match (the iframe
  // received the siteId from us when we set its src). Mounted once at
  // panel-init so it survives multiple Go() navigations.
  //
  // Each filter rejection logs WHY in the top-context console (visible
  // without switching frames in devtools) so a "Diagnostics never
  // shows Sandbox clean" symptom can be diagnosed end-to-end without
  // hunting through iframe-context consoles. The reporter on the
  // iframe side does the same: one `[nsite-report] boot` line at
  // script entry → if it's missing, the script never ran (CSP block,
  // injection miss); if it's present, the panel-side log tells us
  // whether the message arrived and matched the active siteId.
  function mountReporterListener() {
    if (els._reporterMounted) return;
    els._reporterMounted = true;
    window.addEventListener('message', (event) => {
      const m = event.data;
      if (!m || typeof m !== 'object') return;
      if (typeof m.type !== 'string' || !m.type.startsWith('nsite-')) return;
      // From here on the message is shaped like one of ours — worth
      // logging whether the siteId matches the active resolve.
      if (typeof m.siteId !== 'string') {
        try { console.warn('[nsite-report parent] drop: missing siteId', m); } catch (_) {}
        return;
      }
      // Find the tab whose snapshot owns this siteId. With multiple tabs
      // open, the message could be from a background iframe — we need
      // to route the update to the correct per-tab report bucket, not
      // unconditionally to the active tab.
      const tab = tabs.find(t => t.reports.siteId === m.siteId);
      if (!tab) {
        try { console.info('[nsite-report parent] drop: no tab for siteId', { got: m.siteId, type: m.type }); } catch (_) {}
        return;
      }
      try { console.info('[nsite-report parent] accept', m.type, m, 'tab', tab.id); } catch (_) {}
      if (m.type === 'nsite-csp-violation') {
        // Cap to avoid runaway floods if a page is broken in a way
        // that fires thousands of violations.
        if (tab.reports.cspViolations.length < 50) {
          tab.reports.cspViolations.push({
            blockedURI:         String(m.blockedURI || ''),
            violatedDirective:  String(m.violatedDirective || ''),
            effectiveDirective: String(m.effectiveDirective || ''),
          });
        }
      } else if (m.type === 'nsite-script-error') {
        if (tab.reports.scriptErrors.length < 30) {
          tab.reports.scriptErrors.push({
            message:  String(m.message || ''),
            filename: String(m.filename || ''),
            lineno:   m.lineno || 0,
          });
        }
      } else if (m.type === 'nsite-loaded') {
        tab.reports.loaded = true;
      } else {
        return;
      }
      // Re-render Diagnostics with the new data attached — but only
      // if this is the active tab. A background tab's reports stay
      // cached and get rendered when the user activates it.
      if (tab.id === activeId && tab.body) setDiagnostics(tab.body);
    });
  }

  // ── Tab management ─────────────────────────────────────────────────────

  function freshTab() {
    const id = 't' + (++nextTabSeq);
    const tab = new Tab(id);
    tabs.push(tab);
    return tab;
  }

  function activateTab(id) {
    if (id === activeId) return;
    const tab = tabs.find(t => t.id === id);
    if (!tab) return;
    activeId = id;
    // Swap iframe visibility: only the active tab's frame should paint.
    for (const t of tabs) {
      if (t.frameEl) t.frameEl.style.display = (t.id === id) ? '' : 'none';
    }
    // Restore the address bar + status + meta + diag + trust banner
    // from the activated tab's cached state.
    if (els.addr) els.addr.value = tab.addr || tab.display || '';
    if (els.status) {
      els.status.textContent = tab.statusText || '';
      els.status.classList.toggle('err', !!tab.statusErr);
    }
    if (els.meta) {
      if (tab.metaContent) {
        els.meta.hidden = false;
        if (tab.metaIsHtml) els.meta.innerHTML = tab.metaContent;
        else                els.meta.textContent = tab.metaContent;
      } else {
        els.meta.hidden = true;
        els.meta.textContent = '';
      }
    }
    if (tab.body) {
      setDiagnostics(tab.body);
    } else if (els.diag) {
      els.diag.hidden = true;
      if (els.diagBody) els.diagBody.innerHTML = '';
    }
    refreshTrustBanner();
    updateNavButtons();
    // Empty-state visible when this tab has nothing to show yet.
    setEmpty(!tab.frameEl);
    renderTabStrip();
  }

  function closeTab(id) {
    const idx = tabs.findIndex(t => t.id === id);
    if (idx < 0) return;
    const tab = tabs[idx];
    // Tear down the iframe + its load listener.
    if (tab.frameEl) tab.frameEl.remove();
    tabs.splice(idx, 1);
    if (tabs.length === 0) {
      // Always keep at least one tab so the user has a place to type.
      const fresh = freshTab();
      activeId = null;
      activateTab(fresh.id);
      return;
    }
    if (activeId === id) {
      // Activate the neighbor that took the closed tab's slot, or the
      // one before it if we closed the last.
      const next = tabs[idx] || tabs[idx - 1];
      activeId = null;
      activateTab(next.id);
    } else {
      renderTabStrip();
    }
  }

  function renderTabStrip() {
    if (!els.tabs) return;
    // Build tab chips + the "+" new-tab button. Single innerHTML write
    // keeps the listener-on-container delegation pattern intact.
    els.tabs.innerHTML = tabs.map(t => {
      const cls = 'nsite-tab' + (t.id === activeId ? ' active' : '');
      const title = t.title || t.display || t.addr || 'New tab';
      const titleStr = title.length > 28 ? title.slice(0, 27) + '…' : title;
      return `<div class="${cls}" data-tab-id="${escapeHtml(t.id)}" title="${escapeHtml(title)}">
        <span class="nsite-tab-title">${escapeHtml(titleStr)}</span>
        <button class="nsite-tab-close" type="button" data-close-tab="${escapeHtml(t.id)}" aria-label="Close tab" tabindex="-1">&times;</button>
      </div>`;
    }).join('') + `<button class="nsite-tab-new" type="button" id="nsite-tab-new" aria-label="New tab" title="New tab">+</button>`;
  }

  function init() {
    if (els._wired) return;
    els._wired   = true;
    els.tabs     = $('nsite-tabs');
    els.frames   = $('nsite-frames');
    els.addr     = $('nsite-addr');
    els.go       = $('nsite-go');
    els.back     = $('nsite-back');
    els.forward  = $('nsite-forward');
    els.reload   = $('nsite-reload');
    els.status   = $('nsite-status');
    els.meta     = $('nsite-meta');
    els.diag        = $('nsite-diag');
    els.diagBody    = $('nsite-diag-body');
    els.trustBanner = $('nsite-trust-banner');
    els.empty       = $('nsite-empty');
    els.pubLink     = $('nsite-publish-link');
    // Browser-style menu (≡) — Site Info / Settings / Dev Tools.
    els.menuBtn        = $('nsite-menu-btn');
    els.menu           = $('nsite-menu');
    els.siteInfo       = $('nsite-siteinfo');
    els.siteInfoTitle  = $('nsite-siteinfo-title');
    els.siteInfoBody   = $('nsite-siteinfo-body');
    els.siteInfoClose  = $('nsite-siteinfo-close');
    if (!els.addr) return;

    // Prime an initial empty tab so the panel always has somewhere to
    // type, mirroring how a browser opens with a "new tab" page. The
    // user can open more via the "+" button in the tab strip.
    if (tabs.length === 0) {
      const t = freshTab();
      activeId = t.id;
    }
    renderTabStrip();
    setEmpty(true);

    els.go?.addEventListener('click', () => void go(els.addr.value));
    els.addr.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); void go(els.addr.value); }
    });
    // Mirror typed input into the active tab's addr so the value
    // sticks across tab switches even before Go fires.
    els.addr.addEventListener('input', () => {
      const t = activeTab();
      if (t) t.addr = els.addr.value;
    });
    els.back?.addEventListener('click',    () => navigate(-1));
    els.forward?.addEventListener('click', () => navigate(+1));
    els.reload?.addEventListener('click',  () => reload());
    els.pubLink?.addEventListener('click', () => {
      // Light-weight hint — link to the publish-flow docs in the CLI help.
      // The publish surface itself is the CLI (`nostr-station nsite init/publish`),
      // so the dashboard's job here is just to point users at it.
      toast('Publish from a terminal', '`nostr-station nsite init` → build → `nsite publish`.');
    });

    // Tab strip — single delegated click handler covers tab activation,
    // close-button clicks, and the new-tab "+" button. Survives
    // renderTabStrip()'s innerHTML rewrites.
    els.tabs?.addEventListener('click', (ev) => {
      const target = ev.target;
      // New tab button.
      if (target?.id === 'nsite-tab-new' || target?.closest?.('#nsite-tab-new')) {
        const t = freshTab();
        activeId = null;
        activateTab(t.id);
        els.addr?.focus();
        return;
      }
      // Close-tab button (inside a chip).
      const closeBtn = target?.closest?.('[data-close-tab]');
      if (closeBtn) {
        ev.stopPropagation();
        closeTab(closeBtn.getAttribute('data-close-tab') || '');
        return;
      }
      // Tab activation (click anywhere else on the chip).
      const chip = target?.closest?.('[data-tab-id]');
      if (chip) activateTab(chip.getAttribute('data-tab-id') || '');
    });

    // Trust toggle — delegated click handler on the trust banner so it
    // survives the repeated innerHTML re-renders that refreshTrustBanner
    // does. The button carries the target pubkey + desired allow state
    // as data attributes; the handler POSTs to /api/nsite/trust and
    // re-resolves the current address so the new CSP posture takes
    // effect for the iframe load.
    els.trustBanner?.addEventListener('click', (ev) => {
      const btn = ev.target?.closest?.('.nsite-trust-btn');
      if (!btn || btn.disabled) return;
      const pk = btn.getAttribute('data-pk') || '';
      const allow = btn.getAttribute('data-allow') === 'true';
      if (!/^[0-9a-f]{64}$/i.test(pk)) return;
      void toggleTrust(btn, pk, allow);
    });

    wireMenu();

    // Inline "revoke" link in the meta line — same toggle action as the
    // banner button, fires when a previously-trusted nsite is loaded.
    // Delegated on the meta element so it survives setMetaHtml's
    // repeated innerHTML rewrites.
    els.meta?.addEventListener('click', (ev) => {
      const btn = ev.target?.closest?.('.nsite-meta-revoke');
      if (!btn || btn.disabled) return;
      const pk = btn.getAttribute('data-pk') || '';
      if (!/^[0-9a-f]{64}$/i.test(pk)) return;
      void toggleTrust(btn, pk, /* allow= */ false);
    });

    // Hash deep-link support: `#nsite/<addr>` auto-loads on panel enter.
    // Used by `nostr-station nsite publish` to print a one-click preview
    // link after a successful publish.
    maybeConsumeDeepLink();
    mountReporterListener();
  }

  // ── Browser-style menu (Site Info / Settings / Dev Tools) ───────────────
  //
  // Slimmed-down version of Titan Browser's right-side menu. We do NOT
  // duplicate Settings here — the Config panel already has an
  // nsite-browsing section that mirrors Titan's Settings layout
  // (relays / discovery / Blossom / indexer pubkey), so the menu item
  // deep-links there instead. Same for Dev Tools: the existing
  // Diagnostics block in this panel already covers files / CSP /
  // script errors / relay tiers, so the menu just opens it.
  // Site Info IS new — a dedicated sidebar pane showing the
  // hosting npub + manifest metadata (title / description / source /
  // published / file count / relays / Blossom servers / trust state).
  function wireMenu() {
    if (!els.menuBtn || !els.menu) return;
    function openMenu()  { els.menu.hidden = false; els.menuBtn.setAttribute('aria-expanded', 'true'); }
    function closeMenu() { els.menu.hidden = true;  els.menuBtn.setAttribute('aria-expanded', 'false'); }
    function toggleMenu(){ els.menu.hidden ? openMenu() : closeMenu(); }

    els.menuBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      toggleMenu();
    });
    // Outside-click closes the menu. Attached to document so it fires
    // for clicks anywhere outside the popover. The stopPropagation on
    // the trigger above prevents this handler from immediately closing
    // a menu we just opened.
    document.addEventListener('click', (ev) => {
      if (els.menu.hidden) return;
      if (els.menu.contains(ev.target)) return;
      if (els.menuBtn.contains(ev.target)) return;
      closeMenu();
    });
    // Esc closes when focus is in the panel.
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && !els.menu.hidden) closeMenu();
    });

    // Item dispatch — single delegated click handler.
    els.menu.addEventListener('click', (ev) => {
      const item = ev.target?.closest?.('.nsite-menu-item');
      if (!item) return;
      closeMenu();
      const which = item.getAttribute('data-menu');
      if      (which === 'siteinfo') openSiteInfo();
      else if (which === 'settings') openSettings();
      else if (which === 'devtools') openDevTools();
    });

    els.siteInfoClose?.addEventListener('click', closeSiteInfo);
  }

  // Track which mode the side pane is currently in so a resolve doesn't
  // accidentally rewrite a Settings form with Site Info content.
  let paneMode = null;  // 'siteinfo' | 'settings' | null

  function openSettings() {
    // Render the editable settings form into the side pane, in-place,
    // so the user can adjust relays / Blossom servers / indexer pubkey
    // without leaving the browser. Mirrors the same /api/nsite/config
    // surface the Config panel uses, so values stay consistent
    // whichever entry point the user edits from. The fuller help text
    // and env-override badges live in Config → nsite (one click via
    // the "Open in Config panel" footer link), but the essentials are
    // here.
    paneMode = 'settings';
    if (els.siteInfoTitle) els.siteInfoTitle.textContent = 'Settings';
    if (els.siteInfo) els.siteInfo.hidden = false;
    void renderSettings();
  }

  async function renderSettings() {
    if (!els.siteInfoBody) return;
    els.siteInfoBody.innerHTML = `<div class="nsite-siteinfo-empty">Loading…</div>`;
    try {
      const token = getSessionToken();
      const headers = { 'Accept': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const res = await fetch('/api/nsite/config', { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const cfg = data.config   || {};
      const def = data.defaults || {};
      const env = data.envOverrides || {};
      const linesOf = (arr) => Array.isArray(arr) ? arr.join('\n') : '';
      const envBadge = (active) => active
        ? `<span class="cfg-env-badge" title="Overridden by env var — edit ignored until env is unset">env</span>`
        : '';
      els.siteInfoBody.innerHTML = `
        <div class="nsite-settings-help muted" style="font-size:11px;line-height:1.45">
          Resolve / Blossom config for the nsite browser. Mirrors
          <a href="#config" class="nsite-settings-deeplink">Config → nsite</a>
          — edits here save to the same <code>nsite.json</code>.
        </div>
        <div class="nsite-settings-field">
          <label class="nsite-settings-label">Content relays</label>
          <textarea id="nsite-cfg-content" rows="3" spellcheck="false"
            placeholder="${escapeHtml(linesOf(def.contentRelays))}">${escapeHtml(linesOf(cfg.contentRelays))}</textarea>
          <div class="nsite-settings-hint muted">one <code>wss://</code> per line · unioned with Identity relays + author outbox</div>
        </div>
        <div class="nsite-settings-field">
          <label class="nsite-settings-label">Discovery relays</label>
          <textarea id="nsite-cfg-discovery" rows="2" spellcheck="false"
            placeholder="${escapeHtml(linesOf(def.discoveryRelays))}">${escapeHtml(linesOf(cfg.discoveryRelays))}</textarea>
          <div class="nsite-settings-hint muted">profile-relay indexers for NIP-65 outbox bootstrap</div>
        </div>
        <div class="nsite-settings-field">
          <label class="nsite-settings-label">Blossom servers</label>
          <textarea id="nsite-cfg-blossom" rows="3" spellcheck="false"
            placeholder="${escapeHtml(linesOf(def.blossomServers))}">${escapeHtml(linesOf(cfg.blossomServers))}</textarea>
          <div class="nsite-settings-hint muted">one <code>https://</code> per line · fallback when author's kind:10063 404s</div>
        </div>
        <div class="nsite-settings-field">
          <label class="nsite-settings-label">NSIT indexer pubkey ${envBadge(env.nsitIndexerPubkey)}</label>
          <input type="text" id="nsite-cfg-indexer-pk" spellcheck="false"
            ${env.nsitIndexerPubkey ? 'disabled' : ''}
            placeholder="${escapeHtml(def.nsitIndexerPubkey || '')}"
            value="${escapeHtml(cfg.nsitIndexerPubkey || '')}">
          <div class="nsite-settings-hint muted">64-hex · or <code>disabled</code> to refuse NSIT lookups</div>
        </div>
        <div class="nsite-settings-field">
          <label class="nsite-settings-label">NSIT indexer relays ${envBadge(env.nsitIndexerRelays)}</label>
          <textarea id="nsite-cfg-indexer-relays" rows="2" spellcheck="false"
            ${env.nsitIndexerRelays ? 'disabled' : ''}
            placeholder="${escapeHtml(linesOf(def.nsitIndexerRelays))}">${escapeHtml(linesOf(cfg.nsitIndexerRelays))}</textarea>
          <div class="nsite-settings-hint muted">where the indexer publishes <code>kind:35129</code></div>
        </div>
        <div class="nsite-settings-actions">
          <button class="primary" id="nsite-cfg-save" type="button">Save</button>
          <button id="nsite-cfg-reset" type="button">Reset to defaults</button>
          <span id="nsite-cfg-status" class="muted" aria-live="polite"></span>
        </div>
      `;
      const linesFrom = (id) => ($(id)?.value || '').split('\n').map(s => s.trim()).filter(Boolean);
      const setStatusPill = (msg, isError) => {
        const el = $('nsite-cfg-status');
        if (!el) return;
        el.textContent = msg || '';
        el.classList.toggle('err', !!isError);
      };
      $('nsite-cfg-save')?.addEventListener('click', async () => {
        const payload = {
          contentRelays:     linesFrom('nsite-cfg-content'),
          discoveryRelays:   linesFrom('nsite-cfg-discovery'),
          blossomServers:    linesFrom('nsite-cfg-blossom'),
          nsitIndexerPubkey: ($('nsite-cfg-indexer-pk')?.value || '').trim(),
          nsitIndexerRelays: linesFrom('nsite-cfg-indexer-relays'),
        };
        setStatusPill('Saving…');
        try {
          const tk = getSessionToken();
          const hdr = { 'Content-Type': 'application/json' };
          if (tk) hdr['Authorization'] = `Bearer ${tk}`;
          const r = await fetch('/api/nsite/config', { method: 'PUT', headers: hdr, body: JSON.stringify(payload) });
          if (!r.ok) {
            const b = await r.json().catch(() => ({}));
            throw new Error(b?.message || b?.error || `HTTP ${r.status}`);
          }
          setStatusPill('✓ Saved · reload an nsite to pick up new relays');
        } catch (e) {
          setStatusPill(`Save failed: ${e?.message || e}`, true);
        }
      });
      $('nsite-cfg-reset')?.addEventListener('click', async () => {
        // "Reset to defaults" wipes user overrides by writing the
        // defaults the server already exposed in `data.defaults`.
        const payload = {
          contentRelays:     def.contentRelays     || [],
          discoveryRelays:   def.discoveryRelays   || [],
          blossomServers:    def.blossomServers    || [],
          nsitIndexerPubkey: def.nsitIndexerPubkey || '',
          nsitIndexerRelays: def.nsitIndexerRelays || [],
        };
        setStatusPill('Resetting…');
        try {
          const tk = getSessionToken();
          const hdr = { 'Content-Type': 'application/json' };
          if (tk) hdr['Authorization'] = `Bearer ${tk}`;
          const r = await fetch('/api/nsite/config', { method: 'PUT', headers: hdr, body: JSON.stringify(payload) });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          // Re-render with the fresh defaults visible in the form.
          void renderSettings();
        } catch (e) {
          setStatusPill(`Reset failed: ${e?.message || e}`, true);
        }
      });
    } catch (e) {
      els.siteInfoBody.innerHTML = `<div class="nsite-siteinfo-empty">Couldn't load settings: ${escapeHtml(String(e?.message || e))}</div>`;
    }
  }

  function openDevTools() {
    if (!els.diag) return;
    // The Diagnostics block is `hidden` until the first resolve. If the
    // user opens Dev Tools before browsing anything, surface a small
    // hint via toast rather than expanding an empty pane.
    if (els.diag.hidden) {
      toast('Dev tools', 'Browse an nsite first — Diagnostics populates from the first resolve.');
      return;
    }
    try { els.diag.open = true; } catch {}
    els.diag.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function openSiteInfo() {
    if (!els.siteInfo || !els.siteInfoBody) return;
    paneMode = 'siteinfo';
    if (els.siteInfoTitle) els.siteInfoTitle.textContent = 'Site info';
    renderSiteInfo();
    els.siteInfo.hidden = false;
  }
  function closeSiteInfo() {
    if (els.siteInfo) els.siteInfo.hidden = true;
    paneMode = null;
  }

  // Render the Site Info sidebar from the active resolve response.
  // Intentionally brief and information-dense — pubkey, npub, title,
  // description, source link, published date, file count, format,
  // relay tiers, Blossom servers, trust state. The full Diagnostics
  // block stays the source of truth for per-file events; this pane is
  // about WHO published the site and WHERE its content lives.
  function renderSiteInfo() {
    if (!els.siteInfoBody) return;
    // Source-of-truth shifted from a module-level `currentBody` to the
    // active tab's body when #128 landed multi-tab. Read from the
    // active tab so the Site Info pane reflects whichever tab the
    // user is currently looking at.
    const tab = activeTab();
    if (!tab || !tab.body) {
      els.siteInfoBody.innerHTML = `<div class="nsite-siteinfo-empty">Browse an nsite to see its info.</div>`;
      return;
    }
    const b = tab.body;
    const pk = String(b.pubkey || '');
    let npub = '';
    try { if (window.NostrTools?.nip19 && pk) npub = window.NostrTools.nip19.npubEncode(pk); } catch {}
    const fmtDate = (sec) => sec ? new Date(sec * 1000).toLocaleString() : '—';
    const fmtAge = (sec) => {
      if (!sec) return '';
      const diff = Math.max(0, Math.floor(Date.now() / 1000) - sec);
      if (diff < 60)        return `${diff}s ago`;
      if (diff < 3600)      return `${Math.floor(diff / 60)}m ago`;
      if (diff < 86400)     return `${Math.floor(diff / 3600)}h ago`;
      if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`;
      return `${Math.floor(diff / 86400 / 7)}w ago`;
    };
    const fmt = b.format === 'v2-named' ? 'NIP-5A v2 (named manifest)'
              : b.format === 'v2-root'  ? 'NIP-5A v2 (root manifest)'
              : b.format === 'v1'       ? 'NIP-5A v1 (per-file)'
              : (b.format || 'unknown');
    const r = b.relays || {};
    const blossom = b.blossomServers || [];
    const relayList = (label, arr) => arr && arr.length
      ? `<div class="nsite-siteinfo-row">
           <div class="nsite-siteinfo-key">${escapeHtml(label)} (${arr.length})</div>
           <div class="nsite-siteinfo-list">${arr.map(u => escapeHtml(u)).join('<br>')}</div>
         </div>`
      : '';
    const trustState = b.trusted
      ? `<span style="color: rgba(70, 200, 130, 0.95); font-weight: 600">allowed for this nsite</span>`
      : `<span>strict (default)</span>`;
    els.siteInfoBody.innerHTML = `
      <div class="nsite-siteinfo-row">
        <div class="nsite-siteinfo-key">Display</div>
        <div class="nsite-siteinfo-val proseval">${escapeHtml(b.display || '—')}</div>
      </div>
      <div class="nsite-siteinfo-row">
        <div class="nsite-siteinfo-key">Manifest</div>
        <div class="nsite-siteinfo-val proseval">${escapeHtml(fmt)}</div>
      </div>
      <div class="nsite-siteinfo-row">
        <div class="nsite-siteinfo-key">Author npub</div>
        <div class="nsite-siteinfo-val long">${escapeHtml(npub || '—')}</div>
      </div>
      <div class="nsite-siteinfo-row">
        <div class="nsite-siteinfo-key">Author pubkey</div>
        <div class="nsite-siteinfo-val long">${escapeHtml(pk || '—')}</div>
      </div>
      <div class="nsite-siteinfo-row">
        <div class="nsite-siteinfo-key">Published</div>
        <div class="nsite-siteinfo-val proseval">${escapeHtml(fmtDate(b.latestAt))} ${b.latestAt ? `(${escapeHtml(fmtAge(b.latestAt))})` : ''}</div>
      </div>
      <div class="nsite-siteinfo-row">
        <div class="nsite-siteinfo-key">Files</div>
        <div class="nsite-siteinfo-val proseval">${escapeHtml(String(b.fileCount ?? '—'))} file${b.fileCount === 1 ? '' : 's'}</div>
      </div>
      <div class="nsite-siteinfo-row">
        <div class="nsite-siteinfo-key">External content</div>
        <div class="nsite-siteinfo-val proseval">${trustState}</div>
      </div>
      ${relayList('Author NIP-65 outbox', r.authorOutbox)}
      ${relayList('Manifest relay tags',  r.manifest)}
      ${relayList('Queried (union)',      r.queried)}
      ${relayList('Blossom servers',      blossom)}
    `;
  }

  async function toggleTrust(btn, pubkey, allow) {
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = allow ? 'Trusting…' : 'Revoking…';
    try {
      const token = getSessionToken();
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const res = await fetch('/api/nsite/trust', {
        method: 'POST',
        headers,
        body: JSON.stringify({ pubkey, allow }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.message || body?.error || `HTTP ${res.status}`);
      }
      // Re-resolve so the iframe reloads with the new CSP posture. The
      // server clears the snapshot cache on a successful trust write,
      // so this re-resolve hits fresh state.
      //
      // Use the ORIGINAL input the user typed (stored on the history
      // entry), not whatever the address bar currently shows. The
      // address bar holds the canonical display form, which for some
      // inputs (gateway URLs decoded to `nsite://<name>`) doesn't
      // round-trip back through the resolver because the name is a
      // subdomain-suffix convention, not an NSIT-registered Bitcoin
      // name. Re-resolving via the original always works.
      const tab = activeTab();
      const reResolveAddr = (tab && tab.cursor >= 0 && tab.history[tab.cursor]?.originalAddr)
        || tab?.originalAddr
        || els.addr?.value
        || '';
      if (reResolveAddr) {
        await go(reResolveAddr);
      }
    } catch (e) {
      toast('Trust update failed', String(e?.message || e));
      btn.disabled = false;
      btn.textContent = original;
    }
  }

  function maybeConsumeDeepLink() {
    const hash = String(location.hash || '');
    const m = hash.match(/^#nsite\/(.+)$/);
    if (!m || !els.addr) return;
    const addr = decodeURIComponent(m[1]);
    els.addr.value = addr;
    // Reset the active tab's history so a reload doesn't keep
    // re-loading the deep-linked address.
    const tab = activeTab();
    if (tab) { tab.history.length = 0; tab.cursor = -1; }
    try { location.hash = '#nsite'; } catch {}
    void go(addr);
  }

  return {
    onEnter() {
      init();
      maybeConsumeDeepLink();
    },
    // For tests / dev tools.
    _state: () => {
      const t = activeTab();
      return {
        tabs:    tabs.length,
        activeId,
        history: t ? t.history.slice() : [],
        cursor:  t ? t.cursor : -1,
      };
    },
  };
})();

// ── Registry + boot ──────────────────────────────────────────────────────

const Panels = {
  status:   StatusPanel,
  chat:     ChatPanel,
  relay:    RelayPanel,
  blossom:  BlossomPanel,
  projects: ProjectsPanel,
  vpn:      VpnPanel,
  logs:     LogsPanel,
  client:   ClientPanel,
  nsite:    NsitePanel,
  mail:     MailPanel,
  config:   ConfigPanel,
};

// Dashboard boot path — called once auth is confirmed (or the localhost
// exemption is active). Idempotent: re-invoking just re-kicks the panel
// loaders, which each already de-dupe their fetches.
let __bootStarted = false;
function bootDashboard(localhostExempt) {
  if (!__bootStarted) {
    __bootStarted = true;
    refreshHeader();
    refreshHealth();
    Updates.init();
    activatePanel(currentPanel());
    // Terminal panel is opt-in per session (user clicks to open) but the
    // capability probe + reconnect-if-live runs during boot so a refreshed
    // dashboard with a live ngit/Claude session resumes without user action.
    // Fire-and-forget; terminal.js owns its own error surfacing.
    window.NSTerminal?.init?.().then(() => {
      // Tell any panel that gates buttons on NSTerminal availability to
      // re-render. activatePanel() runs BEFORE this init resolves, so
      // panels (Projects in particular — Stacks Dork/dev buttons +
      // Open in Claude Code button) paint with isAvailable() returning
      // false. Without a re-render, those buttons stay hidden until the
      // user manually switches panels and back. Custom event keeps the
      // coupling loose; ProjectsPanel adds the listener in its own
      // closure (alongside the existing api-config-changed listener).
      document.dispatchEvent(new CustomEvent('terminal-available'));
      // Unhide the sidebar Terminal nav item once we know node-pty is
      // available. Checked AFTER init so the async capability probe has
      // settled — panels using a click-time check don't need this, but
      // the nav item would flicker if we showed it early and hid it.
      const navTerm = $('nav-terminal');
      if (navTerm && window.NSTerminal?.isAvailable?.()) {
        navTerm.hidden = false;
        navTerm.addEventListener('click', (e) => {
          // No panel to activate — just toggle the terminal drawer, open
          // a shell tab if none exists. Prevent the hash from changing so
          // the currently-viewed panel stays put.
          e.preventDefault();
          if (!window.NSTerminal.isAvailable()) return;
          window.NSTerminal.expand();
          // Only spawn a shell if the terminal has no live tabs yet — if
          // the user already has a Claude session or ngit login running,
          // we just raise the drawer, we don't pile on a new tab.
          if ((window.NSTerminal.tabCount?.() ?? 0) === 0) {
            window.NSTerminal.open('shell');
          }
        });
      }
    });
  }
  toggleLocalhostBanner(localhostExempt);
}

// Toast helper exposed so terminal.js (loaded before app.js) can surface
// errors through the same UI as the rest of the dashboard.
window.toast = toast;

function toggleLocalhostBanner(on) {
  let el = document.getElementById('auth-localhost-banner');
  if (on && !el) {
    el = document.createElement('div');
    el.id = 'auth-localhost-banner';
    el.className = 'auth-localhost-banner';
    el.textContent = 'Auth disabled for localhost — enable in Config';
    document.body.appendChild(el);
  } else if (!on && el) {
    el.remove();
  }
}

// ── One-click update ─────────────────────────────────────────────────────
//
// Server-side, an update-check poller hits the GitHub compare API every
// ~30 min; that result is cached and read here via /api/update-status.
// The browser additionally re-checks the local cache every 5 minutes so
// the pill clears promptly after the user updates (no network cost — it's
// just a local HTTP GET against the in-memory snapshot).
//
// Clicking the pill opens a modal that POSTs /api/update, streams progress
// SSE-style, and on a successful restart polls /api/auth/status until the
// dashboard comes back, then reloads the tab. The browser-side session
// token lives in localStorage and the server snapshots in-memory sessions
// across the restart (see auth.ts) so the reload lands logged-in.
const Updates = (() => {
  const PILL_ID = 'update-pill';
  const BROWSER_REPOLL_MS = 5 * 60 * 1000;
  const RESTART_POLL_MS   = 1000;
  const RESTART_POLL_MAX  = 120; // 2 min ceiling
  let inited = false;
  // Cached on each refresh() so the Config panel's About-section
  // collapsed summary can render "up to date" / "N updates available"
  // without forcing another network round-trip.
  let lastStatus = null;

  function pill() { return document.getElementById(PILL_ID); }

  // Total updates surfaced to the user: nostr-station commits + each
  // pinned-binary tool with current < pinned. Helper so the three
  // entry points (pill, drawer, config) all count the same way.
  function totalCount(status) {
    if (!status) return 0;
    const self  = status.available ? (status.behindBy || 1) : 0;
    const tools = (status.toolUpdates || []).filter(t => t.updateAvailable).length;
    return self + tools;
  }

  function anyAvailable(status) {
    return totalCount(status) > 0;
  }

  function renderPill(status) {
    const el = pill();
    if (!el) return;
    if (!status?.supported || !anyAvailable(status)) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    const textEl = el.querySelector('.update-pill-text');
    const n = totalCount(status);
    if (textEl) {
      textEl.textContent = n > 1 ? `${n} updates available` : 'Update available';
    }
    const toolLines = (status.toolUpdates || [])
      .filter(t => t.updateAvailable)
      .map(t => `· ${t.name} ${t.currentVersion ?? '?'} → ${t.pinnedVersion}`);
    const commitLines = (status.commits || []).slice(0, 5).map(c => `· ${c.message}`);
    el.title = [...toolLines, ...commitLines].join('\n')
      || 'New commits available on origin/main';
  }

  async function refresh(force) {
    try {
      // Optional: kick a server-side re-poll when the user opens the
      // modal so any commits merged since the last 30-min tick show up.
      if (force) {
        try {
          await fetch('/api/update-status/refresh', {
            method:  'POST',
            headers: { 'Authorization': `Bearer ${getSessionToken() || ''}` },
          });
        } catch {}
        // Small grace for the async poll started by the refresh endpoint
        // to land before we read /api/update-status.
        await new Promise(r => setTimeout(r, 1500));
      }
      // Two independent checks: nostr-station's GitHub-compare poll
      // (cached, 30-min cadence) and a fresh per-tool version probe
      // (cheap — three spawns in parallel server-side). Run them in
      // parallel so the slower one doesn't dominate the UI latency.
      const [selfStatus, toolsRes] = await Promise.all([
        api('/api/update-status', undefined, { silent: true }),
        api('/api/tools/updates',  undefined, { silent: true }).catch(() => ({ tools: [] })),
      ]);
      const status = {
        ...selfStatus,
        toolUpdates: Array.isArray(toolsRes?.tools) ? toolsRes.tools : [],
      };
      lastStatus = status;
      renderPill(status);
      // The Config panel's About-section summary listens for this so it
      // can flip from the initial "check to see" label to a live status
      // line once the first poll lands, without re-rendering the panel.
      document.dispatchEvent(new CustomEvent('updates-status-changed', { detail: status }));
      return status;
    } catch {
      // Auth or network — pill stays hidden, no toast (background poll).
      renderPill(null);
      return null;
    }
  }

  function openUpdateModal(initialStatus) {
    const body = document.createElement('div');
    body.className = 'exec-body';
    const pendingTools = (initialStatus?.toolUpdates || []).filter(t => t.updateAvailable);
    const hasSelfUpdate = !!initialStatus?.available;
    const commits = (initialStatus?.commits || [])
      .slice(0, 10)
      .map(c => `<li><code class="upd-sha">${escapeHtml(c.sha.slice(0,7))}</code> ${escapeHtml(c.message)}</li>`)
      .join('');
    // Tool updates render above commits as a separate "Tool upgrades"
    // section. Each row shows id, currentVersion → pinnedVersion. The
    // server's tool-updates probe is fresh per modal open, so this is
    // always up to date — no need for a refresh button here.
    const toolsHtml = pendingTools.length
      ? `<div class="upd-commits"><div class="upd-commits-title">Tool upgrades</div><ul class="upd-commit-list">${
          pendingTools.map(t =>
            `<li><code class="upd-sha">${escapeHtml(t.name)}</code> ${escapeHtml(t.currentVersion ?? '?')} → ${escapeHtml(t.pinnedVersion)}</li>`,
          ).join('')
        }</ul></div>`
      : '';
    body.innerHTML = `
      ${toolsHtml}
      ${commits ? `<div class="upd-commits"><div class="upd-commits-title">What's new</div><ul class="upd-commit-list">${commits}</ul></div>` : ''}
      <div class="term exec-term"><span class="line sys">Ready to update. Click Install to begin.</span><span class="cursor"></span></div>
    `;
    const statusPill = document.createElement('span');
    statusPill.className = 'status-pill';
    statusPill.textContent = 'idle';

    const foot = document.createElement('div');
    foot.style.display = 'flex'; foot.style.alignItems = 'center'; foot.style.width = '100%';
    const statusWrap = document.createElement('div'); statusWrap.style.flex = '1';
    statusWrap.appendChild(statusPill);
    const installBtn = document.createElement('button');
    installBtn.textContent = 'Install update'; installBtn.className = 'primary';
    const closeBtn = document.createElement('button'); closeBtn.textContent = 'close';
    closeBtn.style.marginLeft = '8px';
    foot.appendChild(statusWrap); foot.appendChild(closeBtn); foot.appendChild(installBtn);

    // Subtitle summarises everything the Install button will do, in
    // order. nostr-station's commit count comes first because it's the
    // primary update channel; tool upgrades are tagged onto it.
    const subtitleBits = [];
    if (hasSelfUpdate) {
      const n = initialStatus.behindBy || 1;
      subtitleBits.push(`${n} commit${n === 1 ? '' : 's'} behind origin/main`);
    }
    if (pendingTools.length) {
      subtitleBits.push(`${pendingTools.length} tool upgrade${pendingTools.length === 1 ? '' : 's'}`);
    }
    const modal = openModal({
      title:    'Update nostr-station',
      subtitle: subtitleBits.join(' · ') || 'Pulling origin/main',
      body, footer: foot,
    });
    modal.root.classList.add('exec-modal');

    const term = body.querySelector('.exec-term');
    const cursor = term.querySelector('.cursor');
    const addLine = (text, cls = '') => {
      const span = document.createElement('span');
      span.className = 'line ' + cls;
      span.textContent = text + '\n';
      if (cursor.parentNode === term) term.insertBefore(span, cursor);
      else term.appendChild(span);
      term.scrollTop = term.scrollHeight;
    };

    let running = false;
    let reader = null;

    closeBtn.addEventListener('click', () => {
      if (running) return; // disabled visually too
      modal.close();
    });

    // Stream a tool installer's SSE/NDJSON response into the modal
    // terminal. Returns ok/error. The two pinned-binary install endpoints
    // use different wire formats:
    //   - /api/exec/install/<slug>  — SSE: `data: { line, stream, done, code }`
    //   - /api/setup/nvpn/install   — NDJSON: `{ type: progress|done, step|ok|detail }`
    // Both are streamed line-by-line into the same addLine() sink, so
    // the user just sees a single continuous log scroll.
    async function streamToolUpdate(tool) {
      addLine(`• Updating ${tool.name} (${tool.currentVersion ?? '?'} → ${tool.pinnedVersion})…`, 'sys');
      const sep = tool.installEndpoint.includes('?') ? '&' : '?';
      let res;
      try {
        res = await fetch(tool.installEndpoint + sep + 'force=1', {
          method:  'POST',
          headers: { 'Authorization': `Bearer ${getSessionToken() || ''}` },
        });
      } catch (e) {
        addLine(`${tool.name}: ${e?.message || e}`, 'err');
        return { ok: false, error: String(e?.message || e) };
      }
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        addLine(`${tool.name}: HTTP ${res.status} — ${txt}`, 'err');
        return { ok: false, error: `HTTP ${res.status}` };
      }
      const isNdjson = tool.installEndpoint === '/api/setup/nvpn/install';
      const r = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let result = { ok: false, error: null };
      while (true) {
        let read;
        try { read = await r.read(); } catch { break; }
        if (read.done) break;
        buf += dec.decode(read.value, { stream: true });
        const lines = buf.split('\n'); buf = lines.pop();
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          if (isNdjson) {
            let msg;
            try { msg = JSON.parse(trimmed); } catch { continue; }
            if (msg.type === 'progress' && msg.step) {
              addLine(`${tool.name}: ${msg.step}`);
            } else if (msg.type === 'done') {
              // nvpn returns warn:true (binary placed, service install
              // needs sudo) as a partial success; treat as ok so the
              // overall flow doesn't bail when the user has a usable
              // updated binary.
              result = {
                ok:    !!msg.ok || !!msg.warn,
                error: msg.ok ? null : (msg.detail || 'install failed'),
              };
            }
          } else {
            if (!line.startsWith('data: ')) continue;
            const raw = line.slice(6).trim();
            if (!raw) continue;
            let msg;
            try { msg = JSON.parse(raw); } catch { continue; }
            if (msg.line) {
              const cls = msg.stream === 'stderr' ? 'err' : '';
              addLine(`${tool.name}: ${msg.line.replace(/\x1b\[[0-9;]*m/g, '')}`, cls);
            }
            if (msg.done) {
              result = { ok: msg.code === 0, error: msg.code === 0 ? null : `exit ${msg.code}` };
            }
          }
        }
      }
      if (result.ok) {
        addLine(`${tool.name}: updated to ${tool.pinnedVersion}`, 'ok');
      } else {
        addLine(`${tool.name}: update failed${result.error ? ` — ${result.error}` : ''}`, 'err');
      }
      return result;
    }

    installBtn.addEventListener('click', async () => {
      if (running) return;
      running = true;
      installBtn.disabled = true;
      closeBtn.disabled = true;
      statusPill.className = 'status-pill running';
      statusPill.innerHTML = '<span class="spinner"></span>running';
      // Clear the placeholder line.
      while (term.firstChild && term.firstChild !== cursor) term.removeChild(term.firstChild);

      // Stage 1: per-tool updates, sequentially. Done first because the
      // nostr-station self-update exits the server (UPDATE_RESTART_EXIT_CODE)
      // and we want every tool upgrade to land before that happens. A
      // single tool failing does NOT abort the rest — the user gets a
      // diagnostic per row and can re-run.
      let toolFailures = 0;
      for (const tool of pendingTools) {
        const r = await streamToolUpdate(tool);
        if (!r.ok) toolFailures++;
      }

      // Stage 2: nostr-station self-update. Skip when there's nothing
      // committed upstream — keeps the modal honest when the only
      // pending work was tool upgrades.
      if (!hasSelfUpdate) {
        try { cursor.remove(); } catch {}
        running = false;
        if (toolFailures === 0) {
          addLine('All tool upgrades complete.', 'ok');
          statusPill.className = 'status-pill done'; statusPill.textContent = 'done';
        } else {
          addLine(`${toolFailures} tool upgrade${toolFailures === 1 ? '' : 's'} failed.`, 'err');
          statusPill.className = 'status-pill error'; statusPill.textContent = `${toolFailures} failed`;
        }
        installBtn.disabled = false;
        closeBtn.disabled = false;
        // Refresh so the pill recounts whatever's left.
        void refresh(false);
        return;
      }

      let res;
      try {
        res = await fetch('/api/update', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${getSessionToken() || ''}` },
        });
      } catch (e) {
        addLine(String(e.message || e), 'err');
        running = false;
        statusPill.className = 'status-pill error'; statusPill.textContent = 'error';
        installBtn.disabled = false; closeBtn.disabled = false;
        return;
      }
      if (!res.ok) {
        addLine(`HTTP ${res.status} — ${await res.text().catch(() => '')}`, 'err');
        running = false;
        statusPill.className = 'status-pill error'; statusPill.textContent = 'error';
        installBtn.disabled = false; closeBtn.disabled = false;
        return;
      }

      reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let result = { ok: false, restart: false, error: null };
      outer: while (true) {
        let read;
        try { read = await reader.read(); } catch { break outer; }
        if (read.done) break;
        buf += dec.decode(read.value, { stream: true });
        const lines = buf.split('\n'); buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (!raw) continue;
          let msg;
          try { msg = JSON.parse(raw); } catch { continue; }
          if (msg.done) {
            result = { ok: !!msg.ok, restart: !!msg.restart, error: msg.error || null };
            break outer;
          }
          if (msg.phase) {
            const label = {
              fetch:    'Fetching latest changes…',
              pull:     'Applying changes…',
              install:  'Installing dependencies…',
              build:    'Building…',
              rollback: 'Rolling back…',
              restart:  'Restarting…',
              step:     null,
            }[msg.phase];
            if (label) addLine(`• ${label}`, 'sys');
          }
          if (msg.line) {
            const cls = msg.stream === 'stderr' ? 'err' : '';
            addLine(msg.line.replace(/\x1b\[[0-9;]*m/g, ''), cls);
          }
        }
      }
      try { cursor.remove(); } catch {}

      if (result.ok && result.restart) {
        statusPill.className = 'status-pill running';
        statusPill.innerHTML = '<span class="spinner"></span>restarting';
        addLine('Waiting for dashboard to come back online…', 'sys');
        await waitForServerBack();
        addLine('Server is back. Reloading…', 'ok');
        statusPill.className = 'status-pill done'; statusPill.textContent = 'done';
        // localStorage session survives the reload; server-side persisted
        // sessions survive the restart — landing here logged-in.
        setTimeout(() => location.reload(), 250);
        return;
      }

      running = false;
      if (result.ok) {
        addLine('Already up to date.', 'ok');
        statusPill.className = 'status-pill done'; statusPill.textContent = 'up to date';
        // Pill should have already been cleared by the server's poll
        // refresh; do a UI refresh to be sure.
        void refresh(false);
      } else {
        addLine(result.error ? `Update failed: ${result.error}` : 'Update failed.', 'err');
        statusPill.className = 'status-pill error'; statusPill.textContent = 'error';
      }
      installBtn.disabled = false;
      closeBtn.disabled = false;
    });
  }

  async function waitForServerBack() {
    for (let i = 0; i < RESTART_POLL_MAX; i++) {
      await new Promise(r => setTimeout(r, RESTART_POLL_MS));
      try {
        const res = await fetch('/api/auth/status', { cache: 'no-store' });
        if (res.ok) return true;
      } catch {}
    }
    return false;
  }

  function init() {
    if (inited) return;
    inited = true;
    const el = pill();
    if (el) {
      el.addEventListener('click', async () => {
        const status = await refresh(true);
        if (!anyAvailable(status)) {
          toast('Already up to date', '', 'ok');
          return;
        }
        openUpdateModal(status);
      });
    }
    void refresh(false);
    setInterval(() => { void refresh(false); }, BROWSER_REPOLL_MS);
  }

  return {
    init, refresh, openModal: openUpdateModal, totalCount, anyAvailable,
    lastStatus: () => lastStatus,
  };
})();

// Entry point: /setup launches the first-run wizard; anywhere else
// falls through to the auth gate → either dashboard or sign-in.
(async function authGate() {
  if (location.pathname === '/setup') {
    SetupWizard.show();
    return;
  }
  let status;
  try { status = await fetch('/api/auth/status').then(r => r.json()); }
  catch {
    // Server unreachable — show auth screen; render() will display the
    // same error surface a retry will clear.
    AuthScreen.show();
    return;
  }
  if (status.authenticated) {
    bootDashboard(status.localhostExempt);
  } else {
    AuthScreen.show();
  }
})();
