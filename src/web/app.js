// nostr-station dashboard — single-file client.
// No framework, no build step. Organized as per-panel modules + shared
// utilities (toast, modal, copy-button) at the bottom.

const $  = (id) => document.getElementById(id);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const PANELS = ['status', 'chat', 'relay', 'projects', 'logs', 'config'];

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

function getSessionToken() { return localStorage.getItem(SESSION_KEY); }
function setSessionToken(token, expiresAt) {
  localStorage.setItem(SESSION_KEY, token);
  localStorage.setItem(SESSION_EXPIRES_KEY, String(expiresAt));
}
function clearSessionToken() {
  localStorage.removeItem(SESSION_KEY);
  localStorage.removeItem(SESSION_EXPIRES_KEY);
}

// Drop-in fetch wrapper that surfaces non-2xx + network errors as toasts.
// Adds the Bearer session token on every call (unauthenticated requests to
// public /api/auth/* paths still work — the server ignores the header).
// On 401, clears the token and shows the auth screen without a page reload.
async function api(path, init) {
  const token = getSessionToken();
  const headers = new Headers(init?.headers || {});
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  let res;
  try { res = await fetch(path, { ...init, headers }); }
  catch (e) { toast('Network error', path, 'err'); throw e; }

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
    toast(`${path} → ${res.status}`, body, 'err');
    throw new Error(`${path} ${res.status}`);
  }
  const ct = res.headers.get('content-type') || '';
  return ct.includes('json') ? res.json() : res.text();
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
  const hash = (location.hash || '#status').slice(1);
  // Old #git bookmarks land on the new Projects panel.
  if (hash === 'git') return 'projects';
  return PANELS.includes(hash) ? hash : 'status';
}

function activatePanel(name) {
  $$('.panel').forEach(el => el.classList.toggle('active', el.dataset.panel === name));
  $$('#nav a').forEach(a => a.classList.toggle('active', a.dataset.panel === name));
  if (name === 'logs') clearLogsBadge();
  Panels[name]?.onEnter?.();
}

window.addEventListener('hashchange', () => activatePanel(currentPanel()));

// ── Providers (mirrors src/lib/web-server.ts PROVIDERS) ──────────────────
// Display labels + per-provider default model lists for the chat/config
// switcher. Ollama models are hydrated live via /api/ollama/models.

// Model lists per provider-id — client-side lookup for the Chat pane's
// model dropdown. Ollama is dynamic (probes the local daemon's /api/tags
// via /api/ollama/models); everything else is a hand-curated list of the
// models we expect users to want, with the first entry matching the
// registry default in src/lib/ai-providers.ts.
//
// IDs must match the ai-providers.ts registry (not the v0.x PROVIDER_LIST
// names — 'payperq' not 'ppq').
const PROVIDER_LIST = [
  { value: 'anthropic',    label: 'Anthropic',    models: ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5'] },
  { value: 'openai',       label: 'OpenAI',       models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'o1-preview', 'o1-mini'] },
  { value: 'openrouter',   label: 'OpenRouter',   models: ['anthropic/claude-sonnet-4', 'openai/gpt-4o', 'google/gemini-2.5-pro', 'deepseek/deepseek-chat'] },
  { value: 'opencode-zen', label: 'OpenCode Zen', models: ['claude-opus-4-6', 'claude-sonnet-4-6', 'gpt-4o', 'gemini-2.5-pro'] },
  { value: 'groq',         label: 'Groq',         models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'] },
  { value: 'gemini',       label: 'Google Gemini', models: ['gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash'] },
  { value: 'mistral',      label: 'Mistral',      models: ['mistral-large-latest', 'mistral-small-latest', 'codestral-latest'] },
  { value: 'routstr',      label: 'Routstr ⚡',    models: ['claude-sonnet-4', 'gpt-4o', 'llama-3.3-70b'] },
  { value: 'payperq',      label: 'PayPerQ ⚡',    models: ['claude-sonnet-4', 'gpt-4o', 'llama-3.3-70b'] },
  { value: 'ollama',       label: 'Ollama (local)', models: [], dynamic: true },
  { value: 'lmstudio',     label: 'LM Studio',    models: ['default'] },
  { value: 'maple',        label: 'Maple 🔒',      models: ['claude-sonnet-4', 'claude-opus-4-6'] },
  { value: 'custom',       label: 'Custom',       models: ['default'] },
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
  try {
    const cfg = await getAiCfg();
    const known = cfg?.providers?.[provider]?.knownModels;
    if (Array.isArray(known) && known.length) return known;
  } catch {}
  // 2. Hand-curated fallback from PROVIDER_LIST.
  const p = PROVIDER_LIST.find(x => x.value === provider);
  if (!p) return [];
  if (!p.dynamic) return p.models;
  // 3. Ollama: dynamic probe of the local daemon.
  try {
    const { models } = await api('/api/ollama/models');
    return models.length ? models : ['llama3.2'];
  } catch { return ['llama3.2']; }
}

// ── Header (AI config chips removed — identity chip + relay dot only) ────

async function refreshHeader() {
  try {
    const cfg = await api('/api/config');
    const parts = [];
    if (!cfg.configured) parts.push('⚠ AI not configured');
    parts.push(cfg.hasContext ? 'NOSTR_STATION.md loaded' : '⚠ no NOSTR_STATION.md');
    parts.push(`${cfg.provider} · ${cfg.model}`);
    $('chat-subtitle').textContent = parts.join(' · ');
    window.__lastConfig = cfg;
  } catch {}
  refreshIdentityChip();
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
  try { cfg = await api('/api/identity/config'); } catch { return; }
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
    const p = await api('/api/identity/profile');
    if (p && !p.empty) {
      __profile = p;
      if (p.picture) {
        avatar.innerHTML = `<img src="${p.picture}" alt="">`;
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

    // Signing
    const signing = document.createElement('div');
    signing.className = 'drawer-section';
    signing.innerHTML = `
      <h4>Signing</h4>
      <div class="body">Bunker URL: <span class="muted" id="signing-bunker">managed by ngit</span></div>
      <div class="muted" style="margin-top:6px">
        Amber is configured through <code>nostr-station onboard</code> → ngit. The bunker URL is stored inside ngit; nostr-station does not read or modify it.
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
          Or run <code>nostr-station onboard</code> to configure everything (ngit, Amber, relays).
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
    if (s.id === 'ngit')  return 'ngit not configured — set a default relay in Config';
    if (s.id === 'relay') return 'Relay installed but not running — start it in the Relay panel';
    if (s.id === 'vpn')   return 'nostr-vpn installed but not connected';
    return `${s.label}: ${s.value}`;
  }
  // state === 'ok'
  if (/^v?\d/.test(s.value)) return `${s.label} ${s.value}`;
  if (s.value) return `${s.label} · ${s.value}`;
  return `${s.label} running`;
}

async function refreshHealth() {
  try {
    const status = await api('/api/status');
    const relay = status.find(s => s.id === 'relay');
    $('hdr-relay-dot').className = 'dot ' + stateClass(relay?.state || 'err');
    $('hdr-relay').textContent   = relay?.state === 'ok' ? 'relay up' : relay?.state === 'warn' ? 'relay down' : 'not installed';

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

const SERVICE_CTAS = {
  'relay':     { installSlug: 'relay',   configHint: 'nostr-station relay start' },
  'vpn':       { installSlug: 'nvpn',    configHint: 'sudo nvpn service install' },
  // Watchdog is installed as part of onboard, not via a standalone
  // doctor --fix target — if it's missing, the right fix is re-running
  // onboard so the plist/timer gets written and loaded with matching
  // keypair + whitelist state. No install slug; the Status row falls
  // through to the configHint path which surfaces the exact command.
  'watchdog':  { installSlug: null,      configHint: 'nostr-station onboard' },
  'ngit':      { installSlug: 'ngit',    configHint: null /* inline-form handled below */ },
  'claude':    { installSlug: 'claude',  configHint: null },
  'nak':       { installSlug: 'nak',     configHint: null },
  'relay-bin': { installSlug: 'relay',   configHint: 'nostr-station relay start' },
  'stacks':    { installSlug: 'stacks',  configHint: null },
};

// Human-friendly summary + deep-link target for each service. The summary
// is a sentence-level restatement of what `s.value` already says, pitched
// at what the user would want to do next. `panelLink` shows up as a
// follow-through hint so the expanded card is actionable without the user
// having to remember which sidebar item to click.
const SERVICE_DETAILS = {
  'relay': {
    summaryOk:   s => `Running at <code class="cmd-inline">${s.value.replace(/\s*✓\s*$/, '')}</code>. WebSocket publishing is live.`,
    summaryWarn: _ => 'Binary is installed but the relay isn\'t listening on :8080. Start it from the Relay panel or via CLI.',
    summaryErr:  _ => 'nostr-rs-relay isn\'t on this machine yet. Install sets up the service, config, and launch agent.',
    panel: { hash: '#relay', label: 'Open Relay panel' },
  },
  'vpn': {
    summaryOk:   s => `Connected to the nostr-mesh. Your tunnel IP is <code class="cmd-inline">${escapeHtml(s.value)}</code>.`,
    summaryWarn: _ => 'nvpn binary is here but the daemon isn\'t routing traffic. Start it with the command below or see the Logs panel.',
    summaryErr:  _ => 'nostr-vpn isn\'t installed. The mesh VPN lets other stations reach your relay over WireGuard.',
    panel: { hash: '#logs', label: 'Open Logs → nostr-vpn' },
  },
  'ngit': {
    summaryOk:   s => `Git-over-Nostr ready. Default ngit relay: <code class="cmd-inline">${escapeHtml(s.value.replace(/^relay:\s*/, ''))}</code>.`,
    summaryWarn: _ => 'ngit is installed but no default relay is set — push/clone will prompt every time. Configure in the Config panel.',
    summaryErr:  _ => 'ngit isn\'t installed. It lets you push signed git commits to Nostr relays instead of a central host.',
    panel: { hash: '#config', label: 'Open Config → ngit' },
  },
  'claude': {
    summaryOk:   s => `Installed: <code class="cmd-inline">${escapeHtml(s.value)}</code>. Launch from project cards or the sidebar Terminal.`,
    summaryErr:  _ => 'Claude Code is Anthropic\'s CLI agent. Install hooks it up as the default AI editor for your projects.',
    panel: { hash: '#projects', label: 'Open Projects' },
  },
  'nak': {
    summaryOk:   s => `Installed: <code class="cmd-inline">${escapeHtml(s.value)}</code>. Used by <em>seed</em>, <em>watchdog</em>, and the whitelist helpers.`,
    summaryErr:  _ => '<code class="cmd-inline">nak</code> is the Go CLI for signing, publishing, and querying Nostr events. The seed and watchdog flows depend on it.',
  },
  'relay-bin': {
    summaryOk:   s => `Binary version: <code class="cmd-inline">${escapeHtml(s.value)}</code>. See <em>Relay</em> row above for the running service state.`,
    summaryErr:  _ => '<code class="cmd-inline">nostr-rs-relay</code> isn\'t on this machine. Install unlocks the Relay row above.',
  },
  'watchdog': {
    summaryOk:   _ => 'Scheduled every 5 minutes. Probes the relay\'s listening socket and DMs you if it\'s down (via a throwaway keypair kept in your keychain).',
    summaryErr:  _ => 'Watchdog isn\'t installed. Normally onboard writes the launchd timer + keychain keypair + whitelist entry; re-run onboard to restore it.',
    panel: { hash: '#logs', label: 'Open Logs → watchdog' },
  },
  'stacks': {
    summaryOk:   s => `Installed: <code class="cmd-inline">${escapeHtml(s.value)}</code>. Scaffold a Nostr React app with <code class="cmd-inline">stacks mkstack &lt;name&gt;</code>.`,
    summaryErr:  _ => 'Stacks is Soapbox\'s Nostr app scaffolding CLI (ships the mkstack React template). Optional — install adds the <code class="cmd-inline">stacks</code> command to <code class="cmd-inline">~/.cargo/bin</code>.',
    panel: { hash: '#projects', label: 'Open Projects' },
  },
};

const StatusPanel = {
  // Signature of the last payload we rendered. refreshHealth() ticks every
  // 5s; the status rarely changes between ticks, and re-rendering on every
  // tick was blowing away the user's <details> open state. Comparing
  // signatures lets us short-circuit when the payload is unchanged — the
  // DOM stays untouched, expanded rows stay expanded.
  _sig: null,
  async onEnter() {
    try {
      const status = await api('/api/status');
      this.render(status);
    } catch (e) {
      $('status-cards').innerHTML = `<div class="empty-state">failed to load status: ${escapeHtml(e.message)}</div>`;
    }
  },
  render(status) {
    const cards = $('status-cards');
    // Signature now includes kind so a future hotfix that re-categorizes
    // an entry does force a re-render instead of silently sticking.
    const nextSig = status.map(s => `${s.id}:${s.kind}:${s.state}:${s.value}`).join('|');
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

  if (s.state === 'err' && cta.installSlug) {
    const btn = document.createElement('button');
    btn.className = 'primary';
    btn.textContent = 'Install';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      openExecModal({
        title: `Install ${s.label}`,
        subtitle: 'Running doctor --fix to repair missing tools',
        endpoint: `/api/exec/install/${cta.installSlug}`,
      }).then(r => {
        if (r.ok) toast(`${s.label} install finished`, '', 'ok');
        else      toast(`${s.label} install exited ${r.code}`, '', 'err');
        refreshHealth();
      });
    });
    ctaRow.appendChild(btn);
  } else if (s.state === 'warn' && cta.configHint) {
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.innerHTML = `run: <span class="cmd-inline">${escapeHtml(cta.configHint)}</span>`;
    ctaRow.appendChild(meta);
    ctaRow.appendChild(copyBtn(cta.configHint));
  } else if (s.state === 'warn' && s.id === 'ngit') {
    const btn = document.createElement('button');
    btn.className = 'primary';
    btn.textContent = 'Configure in Config';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      location.hash = '#config';
      setTimeout(() => {
        const sec = document.getElementById('cfg-ngit-section');
        if (sec) {
          sec.scrollIntoView({ behavior: 'smooth', block: 'center' });
          const input = document.getElementById('cfg-ngit-relay-input');
          if (input) input.focus();
        }
      }, 120);
    });
    ctaRow.appendChild(btn);
  }

  if (detail.panel) {
    const link = document.createElement('a');
    link.href = detail.panel.hash;
    link.textContent = detail.panel.label + ' →';
    link.style.marginLeft = ctaRow.childElementCount > 0 ? 'auto' : '0';
    ctaRow.appendChild(link);
  }

  if (ctaRow.childElementCount > 0) details.appendChild(ctaRow);

  row.appendChild(details);
  return row;
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

$('status-refresh').addEventListener('click', () => refreshHealth());
$('status-doctor').addEventListener('click', () => {
  // Prefer the terminal panel — `doctor` is an Ink TUI with coloured
  // status rows + interactive --fix prompts, and the SSE modal can only
  // render the --plain line-oriented fallback. When node-pty isn't
  // available we drop back to the modal path so the feature still works.
  if (window.NSTerminal?.isAvailable?.()) {
    window.NSTerminal.open('doctor');
    // Doctor may take a bit + the user may run --fix interactively. Trigger
    // a couple of delayed health refreshes so Status reflects any repairs
    // without the user clicking refresh themselves.
    [15_000, 60_000].forEach(ms => setTimeout(refreshHealth, ms));
    return;
  }
  openExecModal({
    title: 'nostr-station doctor',
    subtitle: 'Checks every component + surfaces quick fixes',
    endpoint: '/api/exec/doctor',
  }).then(r => {
    if (r.ok) toast('Doctor: all checks passed', '', 'ok');
    else      toast('Doctor: issues found', 'See modal output', 'warn');
    refreshHealth();
  });
});

// ── Panel: Chat (with provider/model switcher) ───────────────────────────

const ChatPanel = (() => {
  const feed  = $('chat-feed');
  const input = $('chat-input');
  const send  = $('chat-send');
  const provSel = $('chat-provider');
  const modelSel = $('chat-model');
  const warnEl = $('chat-key-warning');

  // Per-project message history. 'global' is the default bucket (no project).
  const chatHistories = { global: [] };
  let activeProject = null;         // { id, name } or null
  let busy = false;

  function activeKey() { return activeProject?.id || 'global'; }
  function currentHistory() {
    const k = activeKey();
    if (!chatHistories[k]) chatHistories[k] = [];
    return chatHistories[k];
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
    const h = currentHistory();
    h.length = 0;
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
      setActiveProject(null);
    };
  }

  async function setActiveProject(p) {
    activeProject = p || null;
    try {
      await api('/api/chat/context', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId: p?.id || null }),
      });
    } catch {}
    renderBadge();
    renderHistory();
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

    const history = currentHistory();
    history.push({ role: 'user', content: text });
    addMsg('user', text);
    const bodyEl = addMsg('asst', '');
    const cur = document.createElement('span');
    cur.className = 'cursor';
    bodyEl.appendChild(cur);
    let full = '';

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
            if (p.model) {
              // Server emits this twice: once at stream-open with the
              // requested model, and again if the upstream API returns a
              // more fully-qualified id (Anthropic's message_start carries
              // e.g. "claude-opus-4-6-20240229"). Always overwrite — the
              // later value is the more accurate one.
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
            }
            if (p.content) {
              full += p.content;
              bodyEl.textContent = full;
              bodyEl.appendChild(cur);
              feed.scrollTop = feed.scrollHeight;
            }
          } catch (e) {
            if (e.message && !e.message.startsWith('{')) throw e;
          }
        }
      }
    } catch (e) {
      bodyEl.textContent = '✗ ' + e.message;
      bodyEl.parentElement.className = 'msg error';
      full = '';
    }
    cur.remove();
    if (full) history.push({ role: 'assistant', content: full });
    busy = false; updateSendDisabled();
    input.focus();
  }

  // Config panel emits this after a successful provider add / key update /
  // default change. Re-run populateProvider() so the Chat dropdown reflects
  // the new state without the user having to leave + re-enter the panel.
  document.addEventListener('api-config-changed', () => {
    populateProvider();
  });

  let initialized = false;
  return {
    onEnter() {
      if (!initialized) {
        initialized = true;
        populateProvider();
        renderBadge();
      }
      input.focus();
    },
    setActiveProject,
    getActiveProject() { return activeProject; },
  };
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

  function connect() {
    disconnect();
    const url = `ws://${location.hostname}:8080`;
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
      el.innerHTML = `<div class="empty-state">Waiting for events…<div class="hint">Publish one: <code>nak event -k 1 --sec &lt;nsec&gt; "hello" ws://localhost:8080</code></div></div>`;
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
      $('relay-status').textContent = r?.state === 'ok' ? 'up · ws://localhost:8080' : r?.state === 'warn' ? 'installed (down)' : 'not installed';
      $('relay-status').style.color = r?.state === 'ok' ? 'var(--success)' : r?.state === 'warn' ? 'var(--warn)' : 'var(--error)';
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
      else           toast('Added to whitelist', 'Relay restarted', 'ok');
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
      toast('Removed', 'Relay restarted', 'ok');
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
        window.NSTerminal?.getUnavailableReason?.() || 'Run `nostr-station doctor --fix`',
        'err');
    }
  });

  // Relay logs in the terminal panel — alternative to the Logs panel's
  // EventSource tail. Runs `nostr-station relay logs -f` which renders a
  // coloured Ink TUI and keeps following until the tab closes.
  $('relay-logs-term')?.addEventListener('click', () => {
    if (window.NSTerminal?.isAvailable?.()) {
      window.NSTerminal.open('relay-logs');
    } else {
      toast('Terminal unavailable',
        window.NSTerminal?.getUnavailableReason?.() || 'Logs panel still works',
        'warn');
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
    render();
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
      <div class="pc-badges">${projectCapBadges(p.capabilities)}</div>
      <div class="pc-meta">
        <div class="pc-meta-row"><span class="k">identity</span><span class="v">${escapeHtml(projectIdentityLabel(p))}</span></div>
        <div class="pc-meta-row"><span class="k">last activity</span><span class="v pc-last-activity">${lastAct}</span></div>
      </div>
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

    if (p.capabilities.git || p.capabilities.ngit) {
      const pushBtn = iconBtn('publish', 'Publish',
        `<svg viewBox="0 0 24 24"><path d="M12 19V5M6 11l6-6 6 6"/></svg>`);
      pushBtn.addEventListener('click', (e) => { e.stopPropagation(); runProjectPublish(p); });
      actionsEl.appendChild(pushBtn);
    }
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

  // ── Detail view ──────────────────────────────────────────────────────
  function openDetail(id) {
    state.view = 'detail';
    state.projectId = id;
    state.tab = 'overview';
    projectStatus = null; projectGitLog = null;
    render();
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
    const tabs = [
      { key: 'overview', label: 'Overview' },
      p.capabilities.git   && { key: 'git',   label: 'Git' },
      p.capabilities.ngit  && { key: 'ngit',  label: 'ngit' },
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
      `<button class="tab ${t.key === state.tab ? 'active' : ''}" data-tab="${t.key}">${escapeHtml(t.label)}</button>`
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
    container.innerHTML = '';
    if (state.tab === 'overview') renderOverview(container, p);
    else if (state.tab === 'git')     renderGitTab(container, p);
    else if (state.tab === 'ngit')    renderNgitTab(container, p);
    else if (state.tab === 'nsite')   renderNsiteTab(container, p);
    else if (state.tab === 'settings') renderSettingsTab(container, p);
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

  function renderNgitTab(container, p) {
    // When ngit capability is enabled but we haven't detected a nostr remote
    // yet, the tab swaps to an Initialize form. The station-level default
    // relay (identity.ngitRelay) pre-fills the field when available.
    if (p.capabilities.ngit && !p.remotes.ngit) {
      renderNgitInitForm(container, p);
      return;
    }
    const remote = p.remotes.ngit || '(not configured)';
    const signing = p.identity.useDefault
      ? 'station identity'
      : `${truncNpub(p.identity.npub || '')}${p.identity.bunkerUrl ? ' · bunker configured' : ''}`;
    const alsoGit = p.capabilities.git
      ? `<div class="muted" style="margin-top:8px"><code>nostr-station publish</code> handles both the GitHub and ngit remotes simultaneously. The "Publish to ngit" button below only pushes ngit.</div>`
      : '';
    container.innerHTML = `
      <div class="tab-section">
        <h3>Nostr remote</h3>
        <div class="remote-row">
          <span class="k">ngit</span><span class="v"><code>${escapeHtml(remote)}</code></span>
          ${p.remotes.ngit ? `<span class="copy-slot" data-copy="${escapeHtml(remote)}"></span>` : ''}
        </div>
      </div>
      <div class="tab-section">
        <h3>Signing</h3>
        <div class="overview-kv"><div class="k">identity</div><div class="v">${escapeHtml(signing)}</div></div>
        <div class="muted">Pushes to the ngit remote trigger Amber signing on your phone.</div>
        ${alsoGit}
      </div>
      <div class="tab-section">
        <button class="primary ngit-push-btn">Publish to ngit</button>
      </div>
    `;
    container.querySelectorAll('.copy-slot').forEach(s => s.appendChild(copyBtn(s.dataset.copy)));
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

  async function renderNgitInitForm(container, p) {
    const owner = await api('/api/identity/config').catch(() => ({ npub: '', ngitRelay: '' }));
    const prefill = owner.ngitRelay || '';
    const noPath  = !p.path;
    container.innerHTML = `
      <div class="tab-section">
        <h3>Initialize ngit for this project</h3>
        <div class="muted" style="margin-bottom:10px">
          ngit is enabled for this project but no nostr remote is configured yet.
          Publish the repo announcement to a relay to create one.
        </div>

        <label class="field-label">Nostr relay for this repo</label>
        <div class="field-row">
          <input type="text" class="ngit-init-relay" placeholder="wss://relay.damus.io" value="${escapeHtml(prefill)}" ${noPath ? 'disabled' : ''}>
        </div>
        ${prefill ? `<div class="muted" style="font-size:11px;margin-top:4px">Pre-filled from Config → NGIT.</div>` : ''}

        <label class="field-label" style="margin-top:12px">npub</label>
        <div class="field-row">
          <input type="text" value="${escapeHtml(p.identity.useDefault ? (owner.npub || '') : (p.identity.npub || ''))}" disabled>
        </div>

        <label class="field-label" style="margin-top:12px">Signing</label>
        <div class="muted" style="font-size:11px">Amber will sign on first push.</div>

        <div class="step-actions" style="margin-top:14px">
          <button class="primary ngit-init-btn" ${noPath ? 'disabled title="ngit requires a local repository path."' : ''}>Initialize ngit</button>
        </div>
      </div>
    `;

    if (noPath) return;

    container.querySelector('.ngit-init-btn').addEventListener('click', () => {
      const relay = container.querySelector('.ngit-init-relay').value.trim();
      if (!relay || !/^wss?:\/\//i.test(relay)) {
        toast('Invalid relay URL', 'must start with wss:// or ws://', 'err');
        return;
      }
      openExecModal({
        title: `Initialize ngit · ${p.name}`,
        subtitle: `ngit init --relay ${relay}`,
        endpoint: `/api/projects/${p.id}/ngit/init`,
        body: { relay },
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

  function renderSettingsTab(container, p) {
    container.innerHTML = `
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

      <div class="tab-section">
        <h3>Read relays</h3>
        <div class="muted">Override station read relays (optional). Empty means inherit station defaults.</div>
        <div class="relay-list-editor"></div>
        <div class="field-row">
          <input type="text" class="relay-add-input" placeholder="wss://…">
          <button class="add-relay">add</button>
        </div>
      </div>

      <div class="danger-zone">
        <h4>Danger zone</h4>
        <div class="row">
          <div>
            <div>Remove project</div>
            <div class="desc">Removes the project from nostr-station. Does not delete any files.</div>
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

    // Relay list editor
    const listEl = container.querySelector('.relay-list-editor');
    const relays = p.readRelays || [];
    if (relays.length === 0) {
      listEl.innerHTML = `<div class="muted">inheriting station defaults</div>`;
    } else {
      listEl.innerHTML = relays.map(r =>
        `<div class="relay-row"><code>${escapeHtml(r)}</code><button class="relay-remove" data-url="${escapeHtml(r)}">remove</button></div>`
      ).join('');
      listEl.querySelectorAll('.relay-remove').forEach(btn => {
        btn.addEventListener('click', async () => {
          const next = (p.readRelays || []).filter(u => u !== btn.dataset.url);
          await patchAndReload(p.id, { readRelays: next.length ? next : null });
        });
      });
    }
    container.querySelector('.add-relay').addEventListener('click', async () => {
      const input = container.querySelector('.relay-add-input');
      const v = input.value.trim();
      if (!v) return;
      if (!/^wss?:\/\//.test(v)) return toast('Relay URL must start with wss://', '', 'warn');
      const next = [...(p.readRelays || []), v];
      await patchAndReload(p.id, { readRelays: next });
    });

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

  async function openInChat(p) {
    try {
      await api('/api/chat/context', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId: p.id }),
      });
    } catch {}
    ChatPanel.setActiveProject({ id: p.id, name: p.name });
    location.hash = '#chat';
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
        resultsEl.innerHTML = `
          <div class="discover-empty">
            <div class="big">No ngit repositories found under your npub.</div>
            <div class="muted" style="margin-top:8px;font-size:11px">Queried: ${escapeHtml(queried || '(no relays)')}</div>
            <a href="#config" class="config-link" style="display:inline-block;margin-top:10px">Check your read relay config →</a>
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
          <button class="primary add-to-projects" title="Open the Add Project drawer pre-filled with this repo's metadata">Add to Projects</button>
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
        Creates a fresh git repo with a minimal README and <code>.gitignore</code>.
        Use any editor or AI agent from there — Claude Code, Dork, aider, whatever.
        Push to ngit or another git host from the project card when you're ready.
      </div>
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

    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !createBtn.disabled) { e.preventDefault(); createBtn.click(); }
    });

    createBtn.addEventListener('click', async () => {
      const name = nameInput.value.trim();
      if (!name) return;
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
        body: { name, source: { type: 'local-only' } },
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
  // The "Use MKStack" button quick-fills the gitlab URL for Soapbox's
  // MKStack React template — the same URL shakespeare.diy clones. This
  // bypasses the broken stacks-mkstack nostr-lookup flow entirely.
  //
  // "Scan my ngit repos" closes this modal and opens the Discover flow
  // — slightly faster than pasting an naddr for users who just want to
  // pick from their own published repos.
  const MKSTACK_URL = 'https://gitlab.com/soapbox-pub/mkstack.git';

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
  async function registerAfterNgitClone(resolvedPath, name, ngitUrl) {
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
      identity: { useDefault: true, npub: null, bunkerUrl: null },
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
      <label class="np-field">
        <span class="np-label">Repository URL</span>
        <input id="ir-url" type="text" autocomplete="off"
               placeholder="https://github.com/you/repo.git  ·  nostr://…  ·  naddr1…" />
        <div class="ir-url-actions">
          <button type="button" class="ir-quick-mkstack">Use MKStack</button>
          <button type="button" class="ir-quick-scan">Scan my ngit repos…</button>
        </div>
      </label>
      <div class="np-hint">
        Any git URL works — GitHub, GitLab, self-hosted, or a Nostr-native ngit address.
        After import, history is reset so the initial commit is yours (stops you
        accidentally pushing back to the source).
      </div>
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
    const mkstackBtn = body.querySelector('.ir-quick-mkstack');
    const scanBtn    = body.querySelector('.ir-quick-scan');

    const updateState = () => {
      const slug = slugifyClient(nameInput.value);
      preview.textContent = slug ? `~/projects/${slug}` : '~/projects/…';
      const url = urlInput.value.trim();
      const urlOk = isNostrCloneUrl(url) || isStandardGitUrl(url);
      createBtn.disabled = !slug || !urlOk;
    };
    nameInput.addEventListener('input', updateState);
    urlInput.addEventListener('input',  updateState);
    nameInput.focus();

    cancelBtn.addEventListener('click', () => modal.close());
    mkstackBtn.addEventListener('click', () => {
      urlInput.value = MKSTACK_URL;
      if (!nameInput.value.trim()) nameInput.value = 'mkstack-app';
      updateState();
      nameInput.focus();
    });
    scanBtn.addEventListener('click', () => {
      modal.close();
      openDiscoverModal();
    });

    [nameInput, urlInput].forEach(el => el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !createBtn.disabled) { e.preventDefault(); createBtn.click(); }
    }));

    createBtn.addEventListener('click', async () => {
      const name = nameInput.value.trim();
      const url  = urlInput.value.trim();
      if (!name || !url) return;
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
          const project = await registerAfterNgitClone(resolved, name, url);
          toast('Project imported', project.name, 'ok');
          await reload();
          try { openDetail(project.id); } catch {}
        } catch (e) {
          toast('Registration failed', e.message, 'err');
        }
      } else {
        // Standard git URL — goes through the scaffold endpoint which
        // clones, wipes inherited history, and registers in one shot.
        const result = await openExecModal({
          title: `Importing ${coll.slug}`,
          subtitle: `git clone ${url} → ${coll.path}`,
          endpoint: '/api/projects/new',
          body: { name, source: { type: 'git-url', url } },
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

  const ANSI_RE = /\x1b\[[0-9;]*m/g;
  function classify(line) {
    if (/error|ERR|fail|panic/i.test(line)) return 'err';
    if (/WARN|warn/.test(line)) return 'warn';
    if (/OK|started|listening|ready/i.test(line)) return 'ok';
    return '';
  }
  function append(lines) {
    if (paused) return;
    const autoScroll = $('logs-autoscroll').checked;
    for (const rawLine of lines) {
      const line = (rawLine || '').replace(ANSI_RE, '');
      if (!line) continue;
      const cls = classify(line);
      if (cls === 'err') bumpLogsBadge();
      const el = document.createElement('div');
      el.className = 'log-line ' + cls;
      el.textContent = line;
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
      const cmd = s.service === 'vpn' ? 'nostr-station onboard' : 'nostr-station onboard';
      return {
        level: 'err',
        title: `${svcLabel} is not installed on this machine.`,
        hint:  `Run <code>${cmd}</code> in a terminal to set it up. The log file will light up here once the service starts.`,
      };
    }
    if (!s.running) {
      const fix = s.service === 'relay' ? 'nostr-station relay start'
                : s.service === 'watchdog' ? 'launchctl start com.nostr-station.watchdog'
                : 'nvpn start --daemon';
      const tail = s.service === 'vpn'
        ? ' — or <code>nvpn service install</code> for a supervised system service.'
        : ' — or use the Relay panel\'s start button.';
      return {
        level: 'warn',
        title: `${svcLabel} is installed but not running.`,
        hint:  `Start it: <code>${fix}</code>${tail}`,
      };
    }
    if (!s.logExists) {
      return {
        level: 'warn',
        title: `${svcLabel} is running but hasn't written a log yet.`,
        hint:  `Expected at <code>${s.logPath}</code>. New lines will appear here as soon as the service logs something.`,
      };
    }
    if (s.stale) {
      const age = humanAge(Date.now() - s.logMtimeMs);
      return {
        level: 'warn',
        title: `${svcLabel} log is stale — last write ${age} ago.`,
        hint:  `The service is loaded but may be wedged. Check <code>nostr-station doctor</code>, or restart via the Relay panel.`,
      };
    }
    return null;
  }

  function renderMeta(status) {
    if (!meta) return;
    // Watchdog tab: surface the watchdog npub so the user can follow it on
    // their phone / preferred Nostr client and actually receive the
    // relay-down DMs the watchdog is there to send. No other service has
    // meta worth showing yet; this slot is ready for them when they do.
    if (status.service === 'watchdog' && status.watchdogNpub) {
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
    } else {
      meta.hidden = true;
      meta.innerHTML = '';
    }
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

// ── Panel: Config ────────────────────────────────────────────────────────

const ConfigPanel = (() => {
  const container = $('config-sections');

  async function load() {
    container.innerHTML = '<div class="config-section"><div style="color:var(--muted)">loading…</div></div>';
    try {
      // Session fetch is best-effort: the localhost-exemption path has no
      // backing session, and we still want the rest of the panel to render.
      const [rc, cfg, ident, session, profile, ngitAccount, aiList] = await Promise.all([
        api('/api/relay-config'),
        api('/api/config'),
        api('/api/identity/config'),
        api('/api/auth/session').catch(() => null),
        api('/api/identity/profile').catch(() => null),
        api('/api/ngit/account').catch(() => ({ loggedIn: false, relays: [] })),
        // /api/ai/providers returns the registry + per-provider state.
        // Pre-4.x servers won't have this endpoint; a catch keeps the
        // panel renderable against a stale backend (providers list hides).
        api('/api/ai/providers').catch(() => null),
      ]);
      render(rc, cfg, ident, session, profile, ngitAccount, aiList);
    } catch (e) {
      container.innerHTML = `<div class="config-section"><div style="color:var(--error)">failed to load: ${escapeHtml(e.message)}</div></div>`;
    }
  }

  function row(k, v, cls = '') {
    return `<div class="config-row"><div class="k">${escapeHtml(k)}</div><div class="v ${cls}">${escapeHtml(v)}</div></div>`;
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
      ? `<img src="${escapeHtml(profile.picture)}" style="width:40px;height:40px;border-radius:50%;object-fit:cover" alt="">`
      : pixelAvatar(ident.npub, 40);

    const sessionLine = session
      ? `<span style="color:var(--success)">● signed in</span>
         <span style="color:var(--text-dim);margin-left:8px">expires ${escapeHtml(fmtExpiry(session.expiresAt))}</span>`
      : `<span style="color:var(--text-dim)">no active session (localhost exemption)</span>`;

    return `
      <div class="body" style="font-size:12px">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
          <div>${avatarHtml}</div>
          <div style="flex:1;min-width:0">
            <div style="color:var(--text-bright);font-size:13px">${escapeHtml(displayName)}</div>
            ${nip05Html}
            <div style="font-size:10px;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.4px;margin-top:2px">
              Station owner · signed in via Amber
            </div>
          </div>
        </div>
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

  function render(rc, cfg, ident, session, profile, ngitAccount, aiList) {
    const whitelistHtml = rc.whitelist && rc.whitelist.length
      ? `<a href="#relay" style="color:var(--accent-bright)">${rc.whitelist.length} npub${rc.whitelist.length !== 1 ? 's' : ''} →</a>`
      : `<a href="#relay" style="color:var(--warn)">empty — add one →</a>`;

    const relayItems = (ident.readRelays || []).map(url => `
      <div class="item" data-url="${escapeHtml(url)}">
        <span class="url">${escapeHtml(url)}</span>
        <button class="danger rm">×</button>
      </div>`).join('');

    container.innerHTML = `
      <div class="config-section">
        <h3>Relay</h3>
        ${row('Name', rc.name || '—')}
        ${row('URL',  rc.url  || '—')}
        <div class="config-row">
          <div class="k">NIP-42 auth</div>
          <div class="v">
            <label class="toggle"><input type="checkbox" id="cfg-auth" ${rc.auth ? 'checked' : ''}><span class="slider"></span></label>
            <span style="margin-left:10px;font-size:11px;color:var(--text-dim)">Require signed AUTH to publish</span>
          </div>
        </div>
        <div class="config-row">
          <div class="k">DM auth</div>
          <div class="v">
            <label class="toggle"><input type="checkbox" id="cfg-dm-auth" ${rc.dmAuth ? 'checked' : ''}><span class="slider"></span></label>
            <span style="margin-left:10px;font-size:11px;color:var(--text-dim)">Require AUTH for kind 4/44/1059</span>
          </div>
        </div>
        <div class="config-row"><div class="k">Whitelist</div><div class="v">${whitelistHtml}</div></div>
        ${row('Data dir',    rc.dataDir || '—')}
        ${row('Config file', rc.configPath || '—')}
      </div>

      <div class="config-section">
        <h3>Read relays</h3>
        <div style="font-size:11px;color:var(--text-dim);margin-bottom:10px">
          Used to look up profile data (kind 0). <b>nostr-station never writes to these relays.</b>
        </div>
        <div class="relay-list" id="read-relays">
          ${relayItems || '<div style="color:var(--muted);font-size:11px">defaults will be used</div>'}
          <div class="add">
            <input id="read-relay-input" placeholder="wss://relay.example.com" autocomplete="off">
            <button id="read-relay-paste">paste</button>
            <button class="primary" id="read-relay-add">add</button>
          </div>
        </div>
      </div>

      <div class="config-section" id="cfg-ngit-section">
        <h3>NGIT</h3>
        <div style="font-size:11px;color:var(--text-dim);margin-bottom:10px">
          Default nostr relay for ngit. Used to pre-fill <code>ngit init</code>
          in the Projects panel. When set, the <b>ngit</b> service shows green
          in Service Health.
        </div>
        <div class="config-row">
          <div class="k">Default relay</div>
          <div class="v">
            <div class="keyrow">
              <div class="keyfield">
                <input id="cfg-ngit-relay-input" type="text" autocomplete="off" spellcheck="false" placeholder="wss://relay.damus.io" value="${escapeHtml(ident.ngitRelay || '')}">
              </div>
              <button class="primary" id="cfg-ngit-relay-save">save</button>
            </div>
            <div class="key-status-line ${ident.ngitRelay ? 'ok' : ''}" id="cfg-ngit-relay-status">
              ${ident.ngitRelay ? '✓ saved' : 'not set'}
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

      <div class="config-section">
        <h3>AI Providers</h3>
        <div style="font-size:11px;color:var(--text-dim);margin-bottom:10px">
          Terminal-native tools (Claude Code, OpenCode) launch in the terminal panel with cwd scoped to the selected project.
          API providers stream through the Chat pane via <code>/api/ai/chat</code>.
        </div>
        ${renderAiProviders(aiList)}
        <div class="config-row" style="margin-top:10px">
          <div class="k">Context</div>
          <div class="v ${cfg.hasContext ? 'on' : 'off'}">${cfg.hasContext ? 'NOSTR_STATION.md loaded' : 'not found'}</div>
        </div>
        <div class="callout">
          Per-provider keys live in the OS keychain as <code>ai:&lt;provider&gt;</code>.
          Config file: <code>~/.nostr-station/ai-config.json</code>.
        </div>
      </div>

      <div class="config-section">
        <h3>Identity (Amber / ngit)</h3>
        ${renderIdentityBody(ident, session, profile)}
        <div class="callout" style="margin-top:10px">
          Bunker URL is managed inside ngit. Configure via <code>nostr-station onboard</code>
          or <code>ngit init</code>. Test signing from your mobile signer (Amber) on first push.
        </div>
      </div>

      <div class="config-section" id="cfg-stacks-section">
        <h3>Stacks AI (Dork)</h3>
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

      <div class="config-section">
        <h3>System</h3>
        <div style="font-size:11px;color:var(--text-dim);margin-bottom:10px">
          Fetch newer versions of all components (relay, ngit, nak, Claude Code, Stacks). The
          wizard opens in a terminal tab with per-component diffs before applying.
        </div>
        <div class="keyrow">
          <button id="cfg-update-wizard">Update components</button>
          <span style="font-size:11px;color:var(--muted);align-self:center">
            runs <code>nostr-station update --wizard</code>
          </span>
        </div>
      </div>

    `;

    // Wire toggles
    $('cfg-auth').addEventListener('change', (e) => saveRelayFlag('auth', e.target.checked));
    $('cfg-dm-auth').addEventListener('change', (e) => saveRelayFlag('dmAuth', e.target.checked));

    // System → Update components — runs `nostr-station update --wizard` in a
    // terminal tab. Wizard is interactive (shows diff, prompts to apply)
    // which requires a real TTY, so it's terminal-only with a toast fallback.
    $('cfg-update-wizard')?.addEventListener('click', () => {
      if (window.NSTerminal?.isAvailable?.()) {
        window.NSTerminal.open('update-wizard');
      } else {
        toast('Terminal unavailable',
          window.NSTerminal?.getUnavailableReason?.() || 'Run update from your own shell: `nostr-station update --wizard`',
          'err');
      }
    });

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

    // Read-relays list
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

    // Multi-provider AI list — see renderAiProviders() for the markup.
    // Wire up all row actions + the "Add provider" dropdown in one place.
    // aiList is captured explicitly; wireAiProviders() lives at the panel
    // scope and can't reach render()'s param otherwise.
    wireAiProviders(aiList);

    // NGIT default relay — persists to identity.json via /api/identity/set.
    const ngitInput  = $('cfg-ngit-relay-input');
    const ngitSave   = $('cfg-ngit-relay-save');
    const ngitStatus = $('cfg-ngit-relay-status');
    async function saveNgitRelay() {
      const val = ngitInput.value.trim();
      if (val && !/^wss?:\/\//i.test(val)) {
        toast('Invalid relay URL', 'must start with wss:// or ws://', 'err');
        return;
      }
      ngitSave.disabled = true;
      try {
        const r = await api('/api/identity/set', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ngitRelay: val }),
        });
        if (!r.ok) throw new Error(r.error || 'save failed');
        ngitStatus.className = 'key-status-line ok';
        ngitStatus.textContent = val ? '✓ saved' : 'cleared';
        toast(val ? 'ngit relay saved' : 'ngit relay cleared', val, 'ok');
        // Sidebar dot + Status card may change color after this.
        refreshHealth();
      } catch (e) {
        toast('Save failed', e.message, 'err');
      }
      ngitSave.disabled = false;
    }
    ngitSave.addEventListener('click', saveNgitRelay);
    ngitInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveNgitRelay(); });

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
          const refetch = () => { load(); refreshHealth(); };
          [5_000, 15_000, 45_000, 120_000].forEach(ms => setTimeout(refetch, ms));
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
        }).then(() => { load(); refreshHealth(); });
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
        }).then(() => { load(); refreshHealth(); });
      });
    }

  }

  // ── AI providers list ───────────────────────────────────────────────
  //
  // Renders ai-config + registry state from /api/ai/providers. Callers
  // render the list HTML then call wireAiProviders() to attach actions.
  // Keep this in ConfigPanel so the close-over of load() + toast is free.

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
    const keyRow    = $('ai-add-keyrow');
    const keyInput  = $('ai-add-key');
    const keyEye    = $('ai-add-eye');
    const saveBtn   = $('ai-add-save');
    const cancelBtn = $('ai-add-cancel');

    sel.addEventListener('change', async () => {
      const id = sel.value;
      if (!id) { keyRow.style.display = 'none'; return; }
      // Find the chosen provider's type by matching against the current
      // aiList closure — cheap linear search is fine, <20 entries.
      const chosen = (aiList?.providers || []).find(x => x.id === id);
      if (!chosen) { keyRow.style.display = 'none'; return; }

      if (chosen.type === 'terminal-native') {
        // No key. Enable immediately.
        await enableTerminalProvider(id);
        sel.value = '';
      } else if (isBareKeyProvider(id)) {
        // Local daemons (ollama / lmstudio / maple) don't need a real
        // key — adding them just means creating an ai-config entry so
        // they appear in the Chat dropdown. Server fills in the bareKey
        // sentinel at request time.
        await addBareKeyProvider(id);
        sel.value = '';
      } else {
        // Show key input — user types, hits save.
        keyRow.style.display = '';
        keyInput.value = '';
        keyInput.type  = 'password';
        keyInput.focus();
      }
    });

    keyEye?.addEventListener('click', () => {
      keyInput.type = keyInput.type === 'password' ? 'text' : 'password';
    });

    saveBtn?.addEventListener('click', async () => {
      const id  = sel.value;
      const key = keyInput.value;
      if (!id || !key) return;
      saveBtn.disabled = true;
      try {
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
        // user adding a second key (or fixing a keyless entry from onboard
        // that already set defaults.chat) needs the dispatch here too.
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
      keyRow.style.display = 'none';
      sel.value = '';
      keyInput.value = '';
    });
  }

  // Local-daemon provider ids that accept a sentinel / empty key and don't
  // need a keychain entry. Mirrors the bareKey set in ai-providers.ts.
  function isBareKeyProvider(id) {
    return id === 'ollama' || id === 'lmstudio' || id === 'maple';
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
      // disappears from the list.
      await api(`/api/ai/providers/${encodeURIComponent(id)}/key`, { method: 'DELETE' })
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

  async function saveRelayFlag(key, value) {
    try {
      const body = key === 'auth' ? { auth: value } : { dmAuth: value };
      const r = await api('/api/relay-config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error((r.errors || []).join('; ') || 'save failed');
      toast(`${key === 'auth' ? 'NIP-42' : 'DM'} auth ${value ? 'enabled' : 'disabled'}`, 'Relay restarted', 'ok');
    } catch (e) { toast('Save failed', e.message, 'err'); load(); }
  }

  return {
    onEnter() { load(); },
    reload: load,
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
          Or run <code>nostr-station onboard</code> to configure everything
          (ngit, Amber, relays).
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
          <div class="avatar">${pixelAvatar(npub, 32)}</div>
          <div>
            <div class="role">Station owner</div>
            <div class="name">${escapeHtml(truncated)}</div>
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
      const { challenge } = await fetch('/api/auth/challenge', { method: 'POST' }).then(r => r.json());
      const template = {
        kind: 27235,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['u', window.location.origin],
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
      completeSignIn(data);
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
      completeSignIn(data);
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
          completeSignIn(data);
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
        completeSignIn(data);
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
  function completeSignIn(data) {
    if (!data?.token) { toast('Sign-in failed', 'no token', 'err'); return; }
    setSessionToken(data.token, data.expiresAt);
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
  const STAGES = ['welcome', 'identity', 'relay', 'ai', 'ngit', 'vpn', 'done'];
  let stageIdx = 0;
  const state = { npub: '', profile: null };

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
    else if (stage === 'identity') renderIdentity();
    else if (stage === 'relay')    renderRelay();
    else if (stage === 'ai')       renderAi();
    else if (stage === 'ngit')     renderNgit();
    else if (stage === 'vpn')      renderVpn();
    else if (stage === 'done')     renderDone();
    else                           renderStub(stage);
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
    let previewTimer = null;
    const runPreview = async () => {
      const val = input.value.trim();
      state.npub = val;
      saveBtn.disabled = !val;
      if (!val || !/^(npub1|[0-9a-f]{64})/i.test(val)) {
        state.profile = null;
        return render();
      }
      try {
        const p = await fetch(`/api/identity/profile/preview?npub=${encodeURIComponent(val)}`)
          .then(r => r.ok ? r.json() : null);
        if (p && !p.error) { state.profile = p; }
      } catch { /* leave profile as-is; partial render is fine */ }
      render();
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
    // (re-entering this stage via Back).
    if (state.npub && !state.profile) runPreview();
  }

  // ── Relay ────────────────────────────────────────────────────────────
  // This stage owns the full local-relay install: it writes the relay
  // config.toml, the watchdog script + keypair, and the systemd/launchd
  // unit files, then enables the service. The relay *binary* still has to
  // be installed ahead of time (compile or prebuilt download via
  // install.sh or `nostr-station onboard`) — that step isn't ported into
  // the browser because it can take 10+ minutes.
  //
  // Three paint states map to three status rows:
  //   ok    → relay is up, just move on.
  //   warn  → binary present; might need unit install and/or start.
  //           One idempotent "Install & start" button hits the setup
  //           endpoint, which writes the units, enables them, and starts
  //           the service. Also covers the "unit exists but stopped" case
  //           since enable --now is a no-op-plus-start when already enabled.
  //   error → binary missing. Point the user at `nostr-station onboard`
  //           and leave the stage walkable so they can skip past.
  async function renderRelay() {
    root.innerHTML = shell(
      'Local relay',
      'Your private Nostr relay running on ws://localhost:8080.',
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
      try {
        const status = await fetch('/api/status').then(r => r.ok ? r.json() : []);
        relay = Array.isArray(status) ? status.find(s => s.id === 'relay') : null;
      } catch {}

      if (!relay) {
        bodyEl.innerHTML = `<div class="setup-relay-row err">
          <span class="dot err"></span>
          <div>
            <div class="title">Status unavailable</div>
            <div class="muted">Couldn't reach the local API. Is the server still running?</div>
          </div>
        </div>`;
        nextBtn.disabled = false;
        return;
      }

      if (relay.state === 'ok') {
        bodyEl.innerHTML = `<div class="setup-relay-row ok">
          <span class="dot ok"></span>
          <div>
            <div class="title">Relay running · <code>ws://localhost:8080</code></div>
            <div class="muted">${escapeHtml(relay.value || '')}</div>
          </div>
        </div>`;
        nextBtn.disabled = false;
        return;
      }

      const installed = relay.state === 'warn';
      bodyEl.innerHTML = `
        <div class="setup-relay-row ${relay.state}">
          <span class="dot ${stateClass(relay.state)}"></span>
          <div>
            <div class="title">${installed ? 'Relay not yet running' : 'Relay not installed'}</div>
            <div class="muted">${escapeHtml(relay.value || '')}</div>
          </div>
        </div>
        ${installed ? `
          <div class="setup-actions" style="margin-top:12px;margin-bottom:0;justify-content:flex-start">
            <button class="primary" id="setup-relay-install">Install &amp; start relay</button>
          </div>
          <div id="setup-relay-steps" class="setup-relay-steps"></div>
        ` : `
          <div class="setup-hint muted" style="margin-top:12px">
            Finish <code>nostr-station onboard</code> first — that compiles the relay binary
            (10+ min on a cold machine), then revisit this page.
          </div>
        `}
      `;
      nextBtn.disabled = !installed;

      const installBtn = $('setup-relay-install');
      if (!installBtn) return;

      installBtn.addEventListener('click', async () => {
        installBtn.disabled = true;
        installBtn.innerHTML = '<span class="spinner"></span> Installing service…';
        const stepsEl = $('setup-relay-steps');
        stepsEl.innerHTML = '';
        try {
          const r = await fetch('/api/setup/relay/install', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({}),
          }).then(r => r.json().catch(() => ({ ok: false, error: 'server returned non-JSON' })));

          // Render each sub-step (dirs, keypair, config, units, enable) —
          // the bootstrap endpoint returns a structured list so a user
          // whose systemctl --user instance is unreachable (common on SSH
          // sessions without linger) can see *which* step warned.
          if (Array.isArray(r.steps)) {
            stepsEl.innerHTML = r.steps.map(s => `
              <div class="setup-step-row ${s.ok ? 'ok' : 'err'}">
                <span class="dot ${s.ok ? 'ok' : 'err'}"></span>
                <span class="label">${escapeHtml(s.name)}</span>
                ${s.detail ? `<span class="muted">${escapeHtml(s.detail)}</span>` : ''}
              </div>
            `).join('');
          }

          if (!r.ok) {
            installBtn.disabled = false;
            installBtn.textContent = 'Retry install';
            toast('Relay install had errors', r.error || 'see step details', 'warn');
            return;
          }

          toast('Relay installed', r.up ? 'service started' : 'enable succeeded', 'ok');
        } catch (e) {
          toast('Install failed', e.message || String(e), 'err');
          installBtn.disabled = false;
          installBtn.textContent = 'Retry install';
          return;
        }
        // Give systemd/launchd a beat to transition; re-check status.
        setTimeout(paint, 1200);
      });
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

      // bareKey providers are local daemons that don't need an API key —
      // matches the main dashboard's classification (see isBareKeyProvider).
      const BARE_KEY_IDS = ['ollama', 'lmstudio', 'maple'];

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
        if (BARE_KEY_IDS.includes(id)) {
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

  // ── ngit signing ─────────────────────────────────────────────────────
  // Two jobs: stash the default ngit relay (used when initialising new
  // repos) and hand off to the embedded terminal for `ngit account
  // login`. The terminal drawer renders the nostrconnect QR — the user
  // scans with Amber on their phone and the session completes in the
  // same browser tab, no shell hand-off required.
  async function renderNgit() {
    // Pre-fill the relay field from whatever identity.json already has.
    let existingRelay = '';
    try {
      const cfg = await fetch('/api/identity/config').then(r => r.ok ? r.json() : null);
      if (cfg?.ngitRelay) existingRelay = cfg.ngitRelay;
    } catch {}

    const termAvailable = !!window.NSTerminal?.isAvailable?.();

    root.innerHTML = shell(
      'ngit signing via Amber',
      'ngit publishes repo events to Nostr — signed by your phone.',
      `
        <div class="setup-field">
          <label>Default ngit relay</label>
          <div class="setup-row">
            <input id="setup-ngit-relay" type="text"
              placeholder="wss://relay.damus.io" value="${escapeHtml(existingRelay)}">
          </div>
          <div class="setup-hint muted">
            Used when initialising new repos. Change later in Config → ngit.
          </div>
        </div>

        <div class="setup-field">
          <label>Amber signing</label>
          ${termAvailable ? `
            <div class="setup-ngit-amber">
              <button class="primary" id="setup-ngit-amber-btn">Connect Amber →</button>
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
            <button class="primary setup-next" id="setup-ngit-next">Save &amp; continue →</button>
          </div>
        </div>
      `,
    );

    root.querySelector('.setup-back').addEventListener('click', back);
    root.querySelector('#setup-ngit-skip').addEventListener('click', next);

    const relayInput = $('setup-ngit-relay');
    const saveRelay = async () => {
      const val = relayInput.value.trim();
      if (!val) return true;
      // Basic shape check — server validates via isValidRelayUrl.
      if (!/^wss?:\/\//i.test(val)) {
        toast('Invalid relay URL', 'must start with wss:// or ws://', 'err');
        return false;
      }
      try {
        const r = await fetch('/api/identity/set', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ngitRelay: val }),
        }).then(r => r.json());
        if (!r.ok) throw new Error(r.error || 'save failed');
        return true;
      } catch (e) {
        toast('Save failed', e.message, 'err');
        return false;
      }
    };

    root.querySelector('#setup-ngit-next').addEventListener('click', async () => {
      if (await saveRelay()) next();
    });

    const amberBtn = $('setup-ngit-amber-btn');
    if (amberBtn) {
      amberBtn.addEventListener('click', async () => {
        if (!(await saveRelay())) return;
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
          server; skip it if you only develop locally. You can always add it
          later with <code>nostr-station doctor --fix</code>.
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

// ── Registry + boot ──────────────────────────────────────────────────────

const Panels = {
  status:   StatusPanel,
  chat:     ChatPanel,
  relay:    RelayPanel,
  projects: ProjectsPanel,
  logs:     LogsPanel,
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
