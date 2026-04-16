// Dashboard terminal panel — xterm.js front end for the node-pty WebSocket
// backend. Loaded as a classic script (pre-app.js) so it can register its
// global before panels try to bind to it; the xterm.js bundle itself is
// fetched on demand so users who never open a terminal don't pay the ~300KB
// parse cost.
//
// Scope (pass 2):
//   - Multi-tab: each tab owns its own xterm instance + WebSocket and
//     persists its session id across refreshes. Tab strip at the top of
//     the expanded panel; a trailing "+" button spawns a shell.
//   - Capability probe (/api/terminal/capability) still gates whether the
//     bar renders at all — a missing node-pty disables the feature cleanly.
//   - Session ids are persisted in localStorage and verified against
//     /api/terminal on boot. Live sessions rejoin; dead ids get dropped.
//     The server holds PTYs alive for 5 minutes after the last detach, so
//     a refresh inside that window restores the full terminal state.
//
// xterm instances are stacked in one parent div; switching tabs flips a CSS
// class on their hosts (visibility: hidden, not display:none). This keeps
// xterm's internal measurements stable so switching back doesn't trigger a
// full re-layout / scrollback reflow.

(() => {
  'use strict';

  const LS_TABS     = 'ns-term-tabs';     // JSON [{ id, label }, …]
  const LS_ACTIVE   = 'ns-term-active';   // id of the active tab
  const LS_EXPANDED = 'ns-term-expanded'; // '1' | '0'
  const LS_HEIGHT   = 'ns-term-height';   // pixel height of expanded panel

  // Floor keeps 8+ rows readable; ceiling keeps header + sidebar visible.
  const MIN_HEIGHT_PX = 180;
  const MAX_HEIGHT_VH = 70;

  let available    = null;   // null = not probed; true/false after probe
  let xtermLoaded  = false;
  let xtermLoading = null;   // Promise when the library fetch is in flight

  /** @type {Array<Tab>} */
  const tabs = [];
  let activeIdx = -1;

  // Shape of a Tab (documented here so IDE autocomplete in the block below
  // gives useful hints, even without TS types):
  //   id: string           — server session id (same as /api/terminal)
  //   label: string        — label shown on the tab
  //   host: HTMLElement    — per-tab div that xterm mounts into
  //   term: Terminal       — xterm.js Terminal instance
  //   fitAddon: FitAddon
  //   ws: WebSocket|null
  //   pendingInput: string[] — typed-but-unsent keystrokes (while WS opens)
  //   ro: ResizeObserver|null
  //   exited: boolean

  // ── DOM helpers ──────────────────────────────────────────────────────────

  const $ = (id) => document.getElementById(id);

  function escapeHtml(s) {
    return String(s ?? '')
      .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
  }

  function getToken() {
    // app.js owns session storage and is loaded after us; reach through the
    // same key contract it uses (see getSessionToken in app.js).
    return sessionStorage.getItem('ns-session-token') || '';
  }

  function authHeaders(extra) {
    const h = new Headers(extra || {});
    const t = getToken();
    if (t) h.set('Authorization', `Bearer ${t}`);
    return h;
  }

  // ── xterm lazy loader ────────────────────────────────────────────────────

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = false;
      s.onload  = () => resolve();
      s.onerror = () => reject(new Error(`failed to load ${src}`));
      document.head.appendChild(s);
    });
  }

  function loadCss(href) {
    return new Promise((resolve) => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = href;
      link.onload  = () => resolve();
      // CSS failure is non-fatal; terminal still functions, just unstyled.
      link.onerror = () => resolve();
      document.head.appendChild(link);
    });
  }

  async function ensureXterm() {
    if (xtermLoaded)  return;
    if (xtermLoading) return xtermLoading;
    xtermLoading = (async () => {
      await loadCss('/vendor/xterm/xterm.css');
      await loadScript('/vendor/xterm/xterm.js');
      // Addons register against the global xterm namespace; load order
      // matters because they reference window.Terminal.
      await loadScript('/vendor/xterm/addon-fit.js');
      await loadScript('/vendor/xterm/addon-web-links.js');
      if (!window.Terminal) throw new Error('xterm failed to register global Terminal');
      xtermLoaded = true;
    })();
    return xtermLoading;
  }

  // ── Bar / panel UI ───────────────────────────────────────────────────────

  function showShell() {
    const s = $('term-shell');
    if (s) s.hidden = false;
  }

  function setBarLabel(main, sub) {
    const m = $('term-bar-label');
    const s = $('term-bar-sub');
    if (m) m.textContent = main || 'Terminal';
    if (s) {
      if (sub) { s.textContent = sub; s.hidden = false; }
      else     { s.textContent = '';  s.hidden = true;  }
    }
    // Bar's × button closes the active tab; only meaningful when any tab
    // is open. (The per-tab × button in the strip is always visible.)
    const close = $('term-bar-close');
    if (close) close.hidden = !sub;
  }

  function refreshBarLabel() {
    const active = tabs[activeIdx];
    setBarLabel('Terminal', active ? active.label : '');
  }

  function isExpanded() {
    return document.body.classList.contains('term-expanded');
  }

  function expand() {
    document.body.classList.add('term-expanded');
    $('term-bar-toggle')?.setAttribute('aria-expanded', 'true');
    const panel = $('term-panel');
    if (panel) panel.hidden = false;
    localStorage.setItem(LS_EXPANDED, '1');
    // Defer fit until CSS transition is underway — fitting while the host
    // has zero height produces cols=rows=0 and xterm refuses to render.
    requestAnimationFrame(() => requestAnimationFrame(scheduleFit));
  }

  function collapse() {
    document.body.classList.remove('term-expanded');
    $('term-bar-toggle')?.setAttribute('aria-expanded', 'false');
    localStorage.setItem(LS_EXPANDED, '0');
  }

  function toggleExpand() { isExpanded() ? collapse() : expand(); }

  function applyStoredHeight() {
    const raw = localStorage.getItem(LS_HEIGHT);
    const px = raw ? parseInt(raw, 10) : NaN;
    if (!Number.isFinite(px)) return;
    const max = Math.floor(window.innerHeight * MAX_HEIGHT_VH / 100);
    const clamped = Math.min(Math.max(px, MIN_HEIGHT_PX), max);
    document.documentElement.style.setProperty('--term-h', `${clamped}px`);
  }

  function wireResize() {
    const handle = $('term-resize');
    if (!handle) return;
    let dragging = false;
    let startY = 0;
    let startH = 0;

    handle.addEventListener('mousedown', (e) => {
      if (!isExpanded()) return;
      dragging = true;
      startY = e.clientY;
      const shell = $('term-shell');
      startH = shell ? shell.getBoundingClientRect().height : 320;
      document.body.classList.add('term-dragging');
      e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const delta = startY - e.clientY; // drag up grows panel
      const max = Math.floor(window.innerHeight * MAX_HEIGHT_VH / 100);
      const target = Math.min(Math.max(startH + delta, MIN_HEIGHT_PX), max);
      document.documentElement.style.setProperty('--term-h', `${target}px`);
      scheduleFit();
    });

    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove('term-dragging');
      const shell = $('term-shell');
      if (shell) localStorage.setItem(LS_HEIGHT, String(Math.round(shell.getBoundingClientRect().height)));
    });
  }

  // ── Tab construction ─────────────────────────────────────────────────────

  function buildXterm() {
    const term = new window.Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, "SF Mono", Menlo, Monaco, Consolas, monospace',
      fontSize: 13,
      // Match the dashboard's dark palette so the terminal doesn't look
      // bolted on — values pulled from app.css --bg / --text tokens.
      theme: {
        background: '#0a0a0a',
        foreground: '#c8c8d0',
        cursor: '#9B8FFF',
        cursorAccent: '#0a0a0a',
        selectionBackground: '#7B68EE40',
        black: '#1f1f25', brightBlack: '#5a5a6a',
        red: '#FF5A5A', brightRed: '#FF8080',
        green: '#3DDC84', brightGreen: '#7BF5B2',
        yellow: '#FFB020', brightYellow: '#FFD060',
        blue: '#7B68EE', brightBlue: '#A89FFF',
        magenta: '#A89FFF', brightMagenta: '#C8B8FF',
        cyan: '#7BF5F5', brightCyan: '#B0FFFF',
        white: '#c8c8d0', brightWhite: '#ececf0',
      },
      scrollback: 5000,
      // Bracketed paste would wrap pasted strings in ESC[200~…ESC[201~
      // markers that ngit's rust-dialoguer prompt reads literally rather
      // than as a paste — regressed the bunker-URL login flow. xterm
      // exposes this option in 5.x.
      ignoreBracketedPasteMode: true,
      allowProposedApi: true,
    });
    const FitCtor   = window.FitAddon     && window.FitAddon.FitAddon;
    const LinksCtor = window.WebLinksAddon && window.WebLinksAddon.WebLinksAddon;
    let fitAddon = null;
    if (FitCtor) {
      fitAddon = new FitCtor();
      term.loadAddon(fitAddon);
    }
    if (LinksCtor) {
      term.loadAddon(new LinksCtor((_e, url) => {
        try { window.open(url, '_blank', 'noopener,noreferrer'); } catch {}
      }));
    }
    return { term, fitAddon };
  }

  function createTab({ id, label }) {
    const bodies = $('term-bodies');
    if (!bodies) throw new Error('term-bodies host missing');

    const host = document.createElement('div');
    host.className = 'term-host';
    host.dataset.sessionId = id;
    bodies.appendChild(host);

    const { term, fitAddon } = buildXterm();
    term.open(host);

    const tab = {
      id, label, host, term, fitAddon,
      ws: null, pendingInput: [], ro: null, exited: false,
    };

    term.onData((data) => {
      if (tab.ws && tab.ws.readyState === 1) {
        tab.ws.send(JSON.stringify({ type: 'input', data }));
      } else {
        tab.pendingInput.push(data);
      }
    });

    // Keep xterm's grid aligned to its host on resize — but ONLY when this
    // tab is active. Hidden tabs report their last-active dimensions, so
    // re-fitting them produces wrong cols/rows.
    if (window.ResizeObserver) {
      tab.ro = new ResizeObserver(() => {
        if (tabs[activeIdx] === tab) scheduleFit();
      });
      tab.ro.observe(host);
    }

    tabs.push(tab);
    return tab;
  }

  function destroyTab(idx, fromServerClose = false) {
    const tab = tabs[idx];
    if (!tab) return;
    if (!fromServerClose) {
      // Fire-and-forget the DELETE — the server's destroySession also
      // fires a 'closed' control frame that would otherwise race our WS
      // close handler. We don't wait because tab destruction is a UI
      // action and should feel instant.
      fetch(`/api/terminal/${tab.id}`, { method: 'DELETE', headers: authHeaders() }).catch(() => {});
    }
    try { tab.ws?.close(); } catch {}
    try { tab.ro?.disconnect(); } catch {}
    try { tab.term.dispose(); } catch {}
    try { tab.host.remove(); } catch {}
    tabs.splice(idx, 1);
    // Adjust activeIdx for the splice: if we removed an earlier tab,
    // the active index shifts left; if we removed the active one, pick
    // the right neighbor (or left, if we just removed the last).
    if (tabs.length === 0) {
      activeIdx = -1;
    } else if (idx < activeIdx) {
      activeIdx -= 1;
    } else if (idx === activeIdx) {
      activeIdx = Math.min(idx, tabs.length - 1);
    }
    persistTabs();
    renderStrip();
    refreshActive();
  }

  function refreshActive() {
    // Flip the .active class on host divs; empty-state shows when no tabs.
    for (let i = 0; i < tabs.length; i++) {
      tabs[i].host.classList.toggle('active', i === activeIdx);
    }
    const empty = $('term-empty');
    if (empty) empty.classList.toggle('hidden', tabs.length > 0);
    refreshBarLabel();

    const active = tabs[activeIdx];
    if (active) {
      // Give xterm a tick to notice its host is now visible before fitting.
      requestAnimationFrame(() => {
        scheduleFit();
        try { active.term.focus(); } catch {}
      });
    }
  }

  function setActive(idx) {
    if (idx < 0 || idx >= tabs.length) return;
    activeIdx = idx;
    persistTabs();
    renderStrip();
    refreshActive();
  }

  function persistTabs() {
    const rows = tabs.map(t => ({ id: t.id, label: t.label }));
    localStorage.setItem(LS_TABS, JSON.stringify(rows));
    const active = tabs[activeIdx];
    if (active) localStorage.setItem(LS_ACTIVE, active.id);
    else        localStorage.removeItem(LS_ACTIVE);
  }

  function renderStrip() {
    const strip = $('term-tabs');
    if (!strip) return;
    const parts = tabs.map((t, i) => `
      <button class="term-tab ${i === activeIdx ? 'active' : ''}"
              role="tab"
              data-idx="${i}"
              title="${escapeHtml(t.label)}">
        <span class="term-tab-label">${escapeHtml(t.label)}</span>
        <span class="term-tab-close" data-close="${i}" aria-label="Close tab">×</span>
      </button>
    `).join('');
    strip.innerHTML = parts +
      `<button class="term-tab-new" id="term-tab-new" title="New shell" aria-label="New shell">+</button>`;
  }

  // Event delegation for the strip — the strip is re-rendered on every
  // tab change, so wiring listeners once at init() on the parent keeps
  // us out of a click-handler leak.
  function wireStrip() {
    const strip = $('term-tabs');
    if (!strip) return;
    strip.addEventListener('click', (e) => {
      const t = e.target;
      if (!(t instanceof HTMLElement)) return;
      if (t.id === 'term-tab-new' || t.closest('#term-tab-new')) {
        openKey('shell');
        return;
      }
      const closeIdx = t.dataset.close;
      if (closeIdx !== undefined) {
        e.stopPropagation();
        destroyTab(parseInt(closeIdx, 10));
        return;
      }
      const btn = t.closest('.term-tab');
      const idx = btn instanceof HTMLElement ? btn.dataset.idx : null;
      if (idx !== null && idx !== undefined) setActive(parseInt(idx, 10));
    });
  }

  // ── Fit handling ─────────────────────────────────────────────────────────

  let fitHandle = null;
  function scheduleFit() {
    if (fitHandle) cancelAnimationFrame(fitHandle);
    fitHandle = requestAnimationFrame(() => {
      fitHandle = null;
      const tab = tabs[activeIdx];
      if (!tab || !tab.fitAddon) return;
      try {
        tab.fitAddon.fit();
        if (tab.ws && tab.ws.readyState === 1 && tab.term.cols > 0 && tab.term.rows > 0) {
          tab.ws.send(JSON.stringify({ type: 'resize', cols: tab.term.cols, rows: tab.term.rows }));
        }
      } catch {}
    });
  }
  window.addEventListener('resize', scheduleFit);

  // ── WebSocket wiring ─────────────────────────────────────────────────────

  function connectWs(tab) {
    if (tab.ws) { try { tab.ws.close(); } catch {} tab.ws = null; }
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const token = encodeURIComponent(getToken());
    const url = `${proto}://${location.host}/api/terminal/ws/${tab.id}?token=${token}`;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    tab.ws = ws;

    ws.addEventListener('open', () => {
      // Flush keystrokes typed before the WS was ready.
      while (tab.pendingInput.length) {
        ws.send(JSON.stringify({ type: 'input', data: tab.pendingInput.shift() }));
      }
      if (tabs[activeIdx] === tab) scheduleFit();
    });

    ws.addEventListener('message', (ev) => {
      let data = ev.data;
      if (data instanceof ArrayBuffer) data = new TextDecoder().decode(data);
      if (typeof data !== 'string') return;
      // Control frames are NUL-prefixed JSON. See terminal.ts — we use NUL
      // because it never appears in a real TTY stream.
      if (data.length && data.charCodeAt(0) === 0) {
        try { handleControl(tab, JSON.parse(data.slice(1))); } catch {}
        return;
      }
      tab.term.write(data);
    });

    ws.addEventListener('close', () => {
      // The server's 5-min grace window keeps the PTY alive; don't dispose
      // the xterm here so a reconnect drops straight back in. If the
      // session was actually destroyed (e.g. process exit), the server
      // sent a control frame first and handleControl() takes care of it.
      if (tab.ws === ws) tab.ws = null;
    });

    ws.addEventListener('error', () => {
      tab.term.writeln('\r\n\x1b[31m[terminal] websocket error\x1b[0m');
    });
  }

  function handleControl(tab, ctrl) {
    if (ctrl.type === 'exit') {
      const code = ctrl.exitCode == null ? '?' : ctrl.exitCode;
      tab.term.writeln(`\r\n\x1b[2m[process exited — code ${code}]\x1b[0m`);
      tab.exited = true;
    } else if (ctrl.type === 'closed') {
      tab.term.writeln(`\r\n\x1b[2m[session closed — ${ctrl.reason || 'unknown'}]\x1b[0m`);
      tab.exited = true;
      // Remove the tab from state — the server has already destroyed
      // it. Skip the DELETE call via fromServerClose so we don't get a
      // 404 back into the console.
      const idx = tabs.indexOf(tab);
      if (idx >= 0) destroyTab(idx, true);
    }
  }

  // ── Public surface: openKey / closeActive / restoreTabs ──────────────────

  async function openKey(key, opts = {}) {
    if (!available) {
      const reason = window.__nsTerminalUnavailableReason
        || 'Run `nostr-station doctor --fix` to install node-pty';
      window.toast?.('Terminal unavailable', reason, 'err');
      return;
    }
    await ensureXterm();

    let r;
    try {
      const res = await fetch('/api/terminal/create', {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ key, ...opts }),
      });
      r = await res.json();
      if (!res.ok) throw new Error(r.error || String(res.status));
    } catch (e) {
      window.toast?.('Terminal failed to start', String(e.message || e), 'err');
      return;
    }

    const tab = createTab({ id: r.id, label: r.label || key });
    activeIdx = tabs.length - 1;
    persistTabs();
    renderStrip();
    expand();
    refreshActive();
    connectWs(tab);
  }

  function closeActive() {
    if (activeIdx < 0) return;
    destroyTab(activeIdx);
  }

  // On boot, see which stored tabs are still alive on the server.
  async function restoreTabs() {
    const raw = localStorage.getItem(LS_TABS);
    if (!raw) return;
    let stored;
    try { stored = JSON.parse(raw); } catch { localStorage.removeItem(LS_TABS); return; }
    if (!Array.isArray(stored) || stored.length === 0) return;

    let live;
    try {
      const res = await fetch('/api/terminal', { headers: authHeaders() });
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      live = new Map((data.sessions || []).filter(s => !s.exited).map(s => [s.id, s]));
    } catch {
      // Server unreachable or auth lapsed — drop stored state; the panel
      // stays collapsed and the user can open a fresh tab.
      return;
    }
    // Recreate tabs in stored order, skipping any the server no longer knows.
    await ensureXterm();
    const activeId = localStorage.getItem(LS_ACTIVE);
    for (const entry of stored) {
      const id    = entry && typeof entry.id === 'string' ? entry.id : null;
      const label = entry && typeof entry.label === 'string' ? entry.label : '';
      if (!id || !live.has(id)) continue;
      const tab = createTab({ id, label: label || live.get(id).label || 'shell' });
      connectWs(tab);
    }
    if (tabs.length === 0) {
      // All stored sessions are gone — clean up and leave the panel collapsed.
      localStorage.removeItem(LS_TABS);
      localStorage.removeItem(LS_ACTIVE);
      return;
    }
    // Pick the previously-active tab, or fall back to the first.
    activeIdx = Math.max(0, tabs.findIndex(t => t.id === activeId));
    persistTabs();
    renderStrip();
    if (localStorage.getItem(LS_EXPANDED) === '1') expand();
    refreshActive();
  }

  // ── Boot ─────────────────────────────────────────────────────────────────

  async function init() {
    applyStoredHeight();
    wireResize();
    wireStrip();

    // Capability probe — gates the bar so we don't advertise a broken
    // feature (missing node-pty on an unusual arch, or install failure).
    try {
      const res = await fetch('/api/terminal/capability', { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        available = !!data.available;
        if (!available && data.reason) {
          window.__nsTerminalUnavailableReason = data.reason;
        }
      }
    } catch { available = false; }

    if (!available) return;
    showShell();

    $('term-bar-toggle')?.addEventListener('click', toggleExpand);
    $('term-bar-close')?.addEventListener('click', (e) => {
      e.stopPropagation();
      closeActive();
    });
    $('term-empty-shell')?.addEventListener('click', () => openKey('shell'));

    await restoreTabs();
  }

  window.NSTerminal = {
    init,
    open: openKey,
    close: closeActive,
    expand,
    collapse,
    isAvailable: () => !!available,
    getUnavailableReason: () => window.__nsTerminalUnavailableReason || null,
    // Number of live tabs — used by the sidebar Terminal nav to decide
    // whether clicking should spawn a shell or just expand an existing one.
    tabCount: () => tabs.length,
  };
})();
