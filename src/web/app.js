// nostr-station dashboard — single-file client.
// No framework, no build step. Organized as per-panel modules + shared
// utilities (toast, modal, copy-button) at the bottom.

const $  = (id) => document.getElementById(id);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const PANELS = ['status', 'chat', 'relay', 'git', 'logs', 'config'];

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

// Drop-in fetch wrapper that surfaces non-2xx + network errors as toasts.
// Returns parsed JSON on success, throws on failure (caller can add context).
async function api(path, init) {
  let res;
  try { res = await fetch(path, init); }
  catch (e) { toast('Network error', path, 'err'); throw e; }
  if (!res.ok) {
    let body = '';
    try { body = (await res.text()).slice(0, 180); } catch {}
    toast(`${path} → ${res.status}`, body, 'err');
    throw new Error(`${path} ${res.status}`);
  }
  const ct = res.headers.get('content-type') || '';
  return ct.includes('json') ? res.json() : res.text();
}

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

// Reusable terminal-output modal for streaming SSE from /api/exec/:cmd.
// `pathKey` is the exec slug (e.g. 'doctor', 'push', 'install/nak').
// Resolves when the stream emits `done`. Close button is enabled on done.
function openExecModal({ title, subtitle, endpoint }) {
  const body = document.createElement('div');
  body.innerHTML = `
    <div class="note">Streaming from <code>${escapeHtml(endpoint)}</code></div>
    <div class="term" id="exec-term"><span class="line sys">starting…</span><span class="cursor"></span></div>
  `;
  const statusPill = document.createElement('span');
  statusPill.className = 'status-pill running';
  statusPill.textContent = 'running';

  const foot = document.createElement('div');
  foot.style.display = 'flex'; foot.style.alignItems = 'center'; foot.style.width = '100%';
  const statusWrap = document.createElement('div'); statusWrap.style.flex = '1';
  statusWrap.appendChild(statusPill);
  const closeBtn = document.createElement('button'); closeBtn.textContent = 'close'; closeBtn.disabled = true;
  foot.appendChild(statusWrap); foot.appendChild(closeBtn);

  const modal = openModal({ title, subtitle, body, footer: foot });
  const term = body.querySelector('#exec-term');
  const cursor = term.querySelector('.cursor');

  const addLine = (text, cls = '') => {
    const span = document.createElement('span');
    span.className = 'line ' + cls;
    span.textContent = text + '\n';
    term.insertBefore(span, cursor);
    term.scrollTop = term.scrollHeight;
  };

  closeBtn.addEventListener('click', () => modal.close());

  return new Promise((resolve) => {
    fetch(endpoint, { method: 'POST' }).then(async (res) => {
      if (!res.ok) {
        addLine(`HTTP ${res.status} — ${await res.text().catch(() => '')}`, 'err');
        statusPill.className = 'status-pill error'; statusPill.textContent = 'error';
        closeBtn.disabled = false;
        resolve({ ok: false, code: -1 });
        return;
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let doneCode = null;
      outer: while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n'); buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (!raw) continue;
          try {
            const msg = JSON.parse(raw);
            if (msg.done) { doneCode = msg.code ?? 0; break outer; }
            const cls = msg.stream === 'stderr' ? 'err' : '';
            // Strip ANSI escapes
            const clean = (msg.line || '').replace(/\x1b\[[0-9;]*m/g, '');
            addLine(clean, cls);
          } catch {}
        }
      }
      cursor.remove();
      if (doneCode === 0) {
        addLine('— done —', 'ok');
        statusPill.className = 'status-pill done'; statusPill.textContent = 'done';
      } else {
        addLine(`— exit ${doneCode} —`, 'err');
        statusPill.className = 'status-pill error'; statusPill.textContent = `exit ${doneCode}`;
      }
      closeBtn.disabled = false;
      resolve({ ok: doneCode === 0, code: doneCode });
    }).catch((e) => {
      addLine(String(e.message || e), 'err');
      statusPill.className = 'status-pill error'; statusPill.textContent = 'error';
      closeBtn.disabled = false;
      resolve({ ok: false, code: -1 });
    });
  });
}

// ── Router ───────────────────────────────────────────────────────────────

function currentPanel() {
  const hash = (location.hash || '#status').slice(1);
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

const PROVIDER_LIST = [
  { value: 'anthropic',    label: 'Anthropic',    models: ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5'] },
  { value: 'openrouter',   label: 'OpenRouter',   models: ['anthropic/claude-sonnet-4', 'openai/gpt-4o', 'google/gemini-2.5-pro', 'deepseek/deepseek-chat'] },
  { value: 'opencode-zen', label: 'OpenCode Zen', models: ['claude-opus-4-6', 'claude-sonnet-4-6', 'gpt-4o', 'gemini-2.5-pro'] },
  { value: 'routstr',      label: 'Routstr ⚡',    models: ['claude-sonnet-4', 'gpt-4o', 'llama-3.3-70b'] },
  { value: 'ppq',          label: 'PayPerQ ⚡',    models: ['claude-sonnet-4', 'gpt-4o', 'llama-3.3-70b'] },
  { value: 'ollama',       label: 'Ollama (local)', models: [], dynamic: true },
  { value: 'lmstudio',     label: 'LM Studio',    models: ['default'] },
  { value: 'maple',        label: 'Maple 🔒',      models: ['claude-sonnet-4', 'claude-opus-4-6'] },
  { value: 'custom',       label: 'Custom',       models: ['default'] },
];

async function modelsFor(provider) {
  const p = PROVIDER_LIST.find(x => x.value === provider);
  if (!p) return [];
  if (!p.dynamic) return p.models;
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
    return;
  }
  chip.classList.remove('missing');

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
      __identity = null; __profile = null;
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

  $('identity-chip').addEventListener('click', open);

  return { open, close, render };
})();

async function refreshHealth() {
  try {
    const status = await api('/api/status');
    const relay = status.find(s => s.id === 'relay');
    $('hdr-relay-dot').className = 'dot ' + stateClass(relay?.state || 'err');
    $('hdr-relay').textContent   = relay?.state === 'ok' ? 'relay up' : relay?.state === 'warn' ? 'relay down' : 'not installed';

    const health = $('health');
    health.innerHTML = '';
    for (const s of status) {
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `<span class="dot ${stateClass(s.state)}" title="${escapeHtml(s.value)}"></span>
                       <span class="name">${escapeHtml(s.label)}</span>`;
      health.appendChild(row);
    }

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
  'relay':     { installSlug: 'relay',  configHint: 'nostr-station relay start' },
  'vpn':       { installSlug: 'nvpn',   configHint: 'sudo nvpn service install' },
  'ngit':      { installSlug: 'ngit',   configHint: null /* inline-form handled below */ },
  'claude':    { installSlug: 'claude', configHint: null },
  'nak':       { installSlug: 'nak',    configHint: null },
  'relay-bin': { installSlug: 'relay',  configHint: 'nostr-station relay start' },
};

const StatusPanel = {
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
    cards.innerHTML = '';
    for (const s of status) {
      const cta = SERVICE_CTAS[s.id] || {};
      const card = document.createElement('div');
      card.className = `card ${stateClass(s.state)}`;
      card.innerHTML = `
        <div class="label">${escapeHtml(s.label)}</div>
        <div class="value">${escapeHtml(s.value)}</div>
      `;
      const ctaRow = document.createElement('div');
      ctaRow.className = 'cta';
      if (s.state === 'err' && cta.installSlug) {
        const btn = document.createElement('button');
        btn.className = 'primary';
        btn.textContent = 'Install';
        btn.addEventListener('click', () => {
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
      }
      if (ctaRow.childElementCount > 0) card.appendChild(ctaRow);
      cards.appendChild(card);
    }
  },
};

$('status-refresh').addEventListener('click', () => refreshHealth());
$('status-doctor').addEventListener('click', () => {
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
  const history = [];
  let busy = false;

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
    history.length = 0;
    feed.innerHTML = `
      <div class="msg asst">
        <div class="lbl">assistant</div>
        <div class="body">Cleared. Start a new conversation — NOSTR_STATION.md still loaded as context.</div>
      </div>`;
  }

  async function populateProvider() {
    provSel.innerHTML = PROVIDER_LIST.map(p => `<option value="${p.value}">${escapeHtml(p.label)}</option>`).join('');
    const cfg = await api('/api/config').catch(() => null);
    // Server gives us the provider NAME (e.g. "Anthropic") — map back to slug.
    const byName = {
      'Anthropic': 'anthropic', 'OpenRouter': 'openrouter', 'OpenCode Zen': 'opencode-zen',
      'Routstr': 'routstr', 'PayPerQ': 'ppq', 'Ollama': 'ollama',
      'LM Studio': 'lmstudio', 'Maple': 'maple', 'Custom': 'custom',
    };
    const slug = byName[cfg?.provider] || 'anthropic';
    provSel.value = slug;
    await populateModels(slug, cfg?.model);
    updateKeyWarning(cfg);
  }

  async function populateModels(slug, preferred) {
    const models = await modelsFor(slug);
    modelSel.innerHTML = models.map(m => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join('');
    if (preferred && models.includes(preferred)) modelSel.value = preferred;
  }

  function updateKeyWarning(cfg) {
    if (!cfg || cfg.configured) {
      warnEl.style.display = 'none';
      return;
    }
    warnEl.style.display = '';
    warnEl.innerHTML = '';
    warnEl.appendChild(document.createTextNode(`No API key — run: `));
    const cmd = 'nostr-station keychain set ai-api-key';
    const code = document.createElement('span');
    code.className = 'cmd-inline'; code.textContent = cmd;
    warnEl.appendChild(code);
    warnEl.appendChild(copyBtn(cmd));
  }

  async function persistSelection() {
    try {
      const result = await api('/api/config/set', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: provSel.value, model: modelSel.value }),
      });
      if (!result.ok) throw new Error(result.error || 'save failed');
      toast('Provider saved', `${provSel.value} · ${modelSel.value}`, 'ok');
      await refreshHeader();
      updateKeyWarning(window.__lastConfig);
    } catch (e) {
      // api() already toasted; no-op
    }
  }

  provSel.addEventListener('change', async () => {
    await populateModels(provSel.value);
    await persistSelection();
  });
  modelSel.addEventListener('change', persistSelection);
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
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    input.style.height = 'auto';
    busy = true; send.disabled = true;

    history.push({ role: 'user', content: text });
    addMsg('user', text);
    const bodyEl = addMsg('asst', '');
    const cur = document.createElement('span');
    cur.className = 'cursor';
    bodyEl.appendChild(cur);
    let full = '';

    try {
      const res = await fetch('/api/chat', {
        method:  'POST',
        headers: { 'content-type': 'application/json' },
        body:    JSON.stringify({ messages: history }),
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
    busy = false; send.disabled = false;
    input.focus();
  }

  // Config panel emits this after a successful API-key save or provider
  // switch — we re-poll /api/config and refresh the warning chip in place
  // without requiring the user to leave/re-enter the Chat panel.
  document.addEventListener('api-config-changed', async () => {
    try {
      const cfg = await api('/api/config');
      window.__lastConfig = cfg;
      updateKeyWarning(cfg);
    } catch {}
  });

  let initialized = false;
  return {
    onEnter() {
      if (!initialized) { initialized = true; populateProvider(); }
      input.focus();
    },
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
      for (const npub of rc.whitelist) {
        const row = document.createElement('div');
        row.className = 'item-row';
        row.innerHTML = `<div class="npub">${escapeHtml(npub)}</div>`;
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

const GitPanel = (() => {
  const body = $('git-body');
  let loaded = false;

  function fmtTime(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    const mins = Math.round((Date.now() - ms) / 60000);
    if (mins < 1)  return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24)  return `${hrs}h ago`;
    return d.toLocaleDateString();
  }

  async function load() {
    body.innerHTML = `<div style="color:var(--muted)">loading…</div>`;
    try {
      const [status, log] = await Promise.all([api('/api/git/status'), api('/api/git/log')]);
      if (!status.inRepo) {
        body.innerHTML = `<div class="empty-state">Not a git repository.<div class="hint">Run <code>git init</code> in a project directory and restart the dashboard from there.</div></div>`;
        return;
      }
      const remoteHtml = (status.remotes || []).map(r =>
        `<div class="remote-row"><span class="k">${escapeHtml(r.type)} (${escapeHtml(r.name)})</span><span class="v">${escapeHtml(r.url)}</span></div>`
      ).join('');
      body.innerHTML = `
        <div class="git-header">
          <span class="git-chip"><span class="k">branch</span><span class="v">${escapeHtml(status.branch)}</span></span>
          <span class="git-chip"><span class="k">HEAD</span><span class="v">${escapeHtml(status.hash)}</span></span>
          <span class="git-chip ${status.dirty ? 'dirty' : ''}"><span class="k">uncommitted</span><span class="v">${status.dirty} file${status.dirty !== 1 ? 's' : ''}</span></span>
          <span class="git-chip"><span class="k">last commit</span><span class="v">${escapeHtml(fmtTime(status.timestamp))} · ${escapeHtml(status.author)}</span></span>
        </div>

        <div class="config-section" style="margin-bottom:18px">
          <h3>Latest</h3>
          <div style="font-size:12px;color:var(--text-bright);margin-bottom:4px">${escapeHtml(status.message || '—')}</div>
          <div style="font-size:11px;color:var(--muted)">${escapeHtml(status.hash)} · ${escapeHtml(status.author)} · ${escapeHtml(fmtTime(status.timestamp))}</div>
        </div>

        ${remoteHtml ? `<div class="remote-section"><h4>Remotes</h4>${remoteHtml}</div>` : '<div style="color:var(--text-dim);font-size:11px;margin-bottom:12px">No remotes configured.</div>'}

        <div class="config-section">
          <h3>Recent commits</h3>
          <div class="commits">
            ${(log || []).map(c => `
              <div class="commit">
                <span class="hash">${escapeHtml(c.hash)}</span>
                <span class="msg">${escapeHtml(c.message)}</span>
                <span class="author">${escapeHtml(c.author)}</span>
                <span class="when">${escapeHtml(fmtTime(c.timestamp))}</span>
              </div>
            `).join('')}
          </div>
        </div>
      `;
    } catch (e) {
      body.innerHTML = `<div class="empty-state" style="color:var(--error)">failed to load git status: ${escapeHtml(e.message)}</div>`;
    }
  }

  $('git-push').addEventListener('click', async () => {
    const confirmed = await confirmDestructive({
      title: 'nostr-station push',
      description: 'Pushes current branch to all configured remotes (GitHub + ngit where present). Amber will sign ngit pushes.',
      confirmLabel: 'Push',
    });
    if (!confirmed) return;
    openExecModal({
      title: 'Pushing…',
      subtitle: 'Streams `nostr-station push --yes`',
      endpoint: '/api/exec/push',
    }).then(r => {
      if (r.ok) toast('Push complete', '', 'ok');
      else      toast('Push finished with errors', `exit ${r.code}`, 'err');
      load();
    });
  });

  $('git-pull').addEventListener('click', () => {
    openExecModal({
      title: 'git pull --ff-only',
      subtitle: 'Fast-forward only — refuses on divergent history',
      endpoint: '/api/exec/git-pull',
    }).then(r => {
      if (r.ok) toast('Pulled', '', 'ok');
      else      toast('Pull failed', `exit ${r.code}`, 'err');
      load();
    });
  });

  return {
    onEnter() { if (!loaded) { loaded = true; } load(); },
  };
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
  const view = $('log-view');
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
  function disconnect() { if (es) { es.close(); es = null; } }
  function connect(svc) {
    disconnect();
    view.innerHTML = '';
    append([`connecting to ${svc}…`]);
    es = new EventSource(`/api/logs/${svc}`);
    es.addEventListener('message', (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.lines) append(data.lines);
        if (data.error) append(['[error] ' + data.error]);
      } catch {}
    });
    es.addEventListener('error', () => append(['[stream closed]']));
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
      const [rc, cfg, git, ident] = await Promise.all([
        api('/api/relay-config'),
        api('/api/config'),
        api('/api/git/status'),
        api('/api/identity/config'),
      ]);
      render(rc, cfg, git, ident);
    } catch (e) {
      container.innerHTML = `<div class="config-section"><div style="color:var(--error)">failed to load: ${escapeHtml(e.message)}</div></div>`;
    }
  }

  function row(k, v, cls = '') {
    return `<div class="config-row"><div class="k">${escapeHtml(k)}</div><div class="v ${cls}">${escapeHtml(v)}</div></div>`;
  }

  function render(rc, cfg, git, ident) {
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

      <div class="config-section">
        <h3>AI Provider</h3>
        <div class="config-row">
          <div class="k">Provider</div>
          <div class="v"><select id="cfg-provider" style="min-width:180px"></select></div>
        </div>
        <div class="config-row">
          <div class="k">Model</div>
          <div class="v"><select id="cfg-model" style="min-width:180px"></select></div>
        </div>
        ${row('Base URL', cfg.baseUrl || '(provider default)')}
        <div class="config-row">
          <div class="k">API key</div>
          <div class="v">
            <div class="keyrow">
              <div class="keyfield">
                <input id="cfg-key-input" type="password" autocomplete="off" placeholder="paste provider key (sk-…)">
                <button class="eye" id="cfg-key-eye" aria-label="toggle visibility">
                  <svg viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>
                </button>
              </div>
              <button class="primary" id="cfg-key-save">save</button>
            </div>
            <div class="key-status-line ${cfg.configured ? 'ok' : 'err'}" id="cfg-key-status">
              ${cfg.configured ? '✓ stored in keychain' : '✗ not stored'}
            </div>
          </div>
        </div>
        <div class="config-row">
          <div class="k">Context</div>
          <div class="v ${cfg.hasContext ? 'on' : 'off'}">${cfg.hasContext ? 'NOSTR_STATION.md loaded' : 'not found'}</div>
        </div>
        <div class="callout">
          Prefer CLI? <code>nostr-station keychain set ai-api-key</code>
        </div>
      </div>

      <div class="config-section">
        <h3>Identity (Amber / ngit)</h3>
        <div class="body" style="font-size:12px">
          ${ident.npub
            ? `<div>npub: <span style="font-family:var(--font-mono);color:var(--text-bright)">${escapeHtml(truncNpub(ident.npub))}</span> — manage via identity drawer (header →)</div>`
            : `<div style="color:var(--warn)">No npub configured — click the identity chip in the header to set up.</div>`}
        </div>
        <div class="callout" style="margin-top:10px">
          Bunker URL is managed inside ngit. Configure via <code>nostr-station onboard</code>
          or <code>ngit init</code>. Test signing from your mobile signer (Amber) on first push.
        </div>
      </div>

      <div class="config-section">
        <h3>Git</h3>
        ${git && git.inRepo ? `
          ${row('Branch', git.branch)}
          ${row('HEAD',   git.hash + (git.dirty ? ` · ${git.dirty} uncommitted` : ''))}
          ${(git.remotes || []).map(r => row(`remote (${r.type})`, r.url)).join('')}
        ` : '<div style="color:var(--text-dim);font-size:11px">Not a git repository.</div>'}
      </div>
    `;

    // Wire toggles
    $('cfg-auth').addEventListener('change', (e) => saveRelayFlag('auth', e.target.checked));
    $('cfg-dm-auth').addEventListener('change', (e) => saveRelayFlag('dmAuth', e.target.checked));

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

    // API-key input — masked by default, reveal toggle, save button.
    // Server never returns the stored key, and we never log it here.
    const keyInput = $('cfg-key-input');
    const keyEye   = $('cfg-key-eye');
    const keySave  = $('cfg-key-save');
    const keyStat  = $('cfg-key-status');
    keyEye.addEventListener('click', () => {
      keyInput.type = keyInput.type === 'password' ? 'text' : 'password';
    });
    keySave.addEventListener('click', async () => {
      const key = keyInput.value;
      if (!key) { toast('Enter a key first', '', 'warn'); return; }
      keySave.disabled = true;
      try {
        const r = await api('/api/keychain/set', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ key }),
        });
        if (!r.ok) throw new Error(r.error || 'save failed');
        keyInput.value = '';
        keyStat.className = 'key-status-line ok';
        keyStat.textContent = '✓ stored in keychain';
        toast('API key stored', 'keychain write succeeded', 'ok');
        // Let Chat panel and header warning bar refresh from /api/config.
        document.dispatchEvent(new CustomEvent('api-config-changed'));
        refreshHeader();
      } catch (e) {
        toast('Save failed', e.message, 'err');
      }
      keySave.disabled = false;
    });

    // Provider/model selects
    const provSel  = $('cfg-provider');
    const modelSel = $('cfg-model');
    provSel.innerHTML = PROVIDER_LIST.map(p => `<option value="${p.value}">${escapeHtml(p.label)}</option>`).join('');
    const byName = {
      'Anthropic': 'anthropic', 'OpenRouter': 'openrouter', 'OpenCode Zen': 'opencode-zen',
      'Routstr': 'routstr', 'PayPerQ': 'ppq', 'Ollama': 'ollama',
      'LM Studio': 'lmstudio', 'Maple': 'maple', 'Custom': 'custom',
    };
    const slug = byName[cfg.provider] || 'anthropic';
    provSel.value = slug;
    modelsFor(slug).then(models => {
      modelSel.innerHTML = models.map(m => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join('');
      if (cfg.model && models.includes(cfg.model)) modelSel.value = cfg.model;
    });
    provSel.addEventListener('change', async () => {
      const models = await modelsFor(provSel.value);
      modelSel.innerHTML = models.map(m => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join('');
      saveProvider();
    });
    modelSel.addEventListener('change', saveProvider);

    async function saveProvider() {
      try {
        const r = await api('/api/config/set', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ provider: provSel.value, model: modelSel.value }),
        });
        if (!r.ok) throw new Error(r.error || 'save failed');
        toast('Provider saved', `${provSel.value} · ${modelSel.value}`, 'ok');
        document.dispatchEvent(new CustomEvent('api-config-changed'));
        refreshHeader();
      } catch {}
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

// ── Registry + boot ──────────────────────────────────────────────────────

const Panels = {
  status: StatusPanel,
  chat:   ChatPanel,
  relay:  RelayPanel,
  git:    GitPanel,
  logs:   LogsPanel,
  config: ConfigPanel,
};

refreshHeader();
refreshHealth();
activatePanel(currentPanel());
