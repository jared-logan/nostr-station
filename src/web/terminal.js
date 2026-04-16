// Dashboard terminal panel — xterm.js front end for the node-pty WebSocket
// backend. Loaded as a classic script (pre-app.js) so it can register its
// global before panels try to bind to it; the actual xterm.js bundle is
// fetched on demand so users who never open a terminal don't pay the ~300KB
// parse cost.
//
// Responsibilities:
//   - Capability probe (/api/terminal/capability) gates whether the bar renders.
//   - Session id persisted in localStorage; on boot we verify it against
//     /api/terminal (the server drops sessions after 5min idle) and rejoin
//     on match. Raw refresh therefore preserves a live Claude Code / ngit
//     session without the user re-launching anything.
//   - Expand / collapse via button or chevron. Drag-resize top edge between
//     a floor and the viewport's max-allowed terminal height.
//   - Single tab for MVP; tab machinery lives inside one label slot today
//     so the second-pass tab UI can grow into it.

(() => {
  'use strict';

  const LS_SESSION    = 'ns-term-session';
  const LS_EXPANDED   = 'ns-term-expanded';
  const LS_HEIGHT     = 'ns-term-height';

  // Floor keeps 8+ rows readable; ceiling keeps header + sidebar visible.
  const MIN_HEIGHT_PX = 180;
  const MAX_HEIGHT_VH = 70;

  let available   = null;   // null = not probed, true/false = probe result
  let term        = null;   // xterm Terminal instance (lazy)
  let fitAddon    = null;
  let ws          = null;
  let sessionId   = null;
  let sessionLabel = null;
  let xtermLoaded = false;
  let xtermLoading = null;  // Promise when loading in flight
  let resizeObserver = null;
  let pendingInput = [];    // Queued input before WS opens or during reconnect

  // ── DOM helpers ──────────────────────────────────────────────────────────

  const $ = (id) => document.getElementById(id);

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
      s.onload = () => resolve();
      s.onerror = () => reject(new Error(`failed to load ${src}`));
      document.head.appendChild(s);
    });
  }

  function loadCss(href) {
    return new Promise((resolve) => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = href;
      link.onload = () => resolve();
      // CSS load failure is non-fatal — xterm still functions, just unstyled.
      link.onerror = () => resolve();
      document.head.appendChild(link);
    });
  }

  async function ensureXterm() {
    if (xtermLoaded) return;
    if (xtermLoading) return xtermLoading;
    xtermLoading = (async () => {
      await loadCss('/vendor/xterm/xterm.css');
      await loadScript('/vendor/xterm/xterm.js');
      // Addons register themselves against the global xterm namespace; order
      // matters because addon-fit / addon-web-links both reference window.Terminal.
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
      else     { s.textContent = '';  s.hidden = true; }
    }
    // Close button only meaningful when a session is open.
    const close = $('term-bar-close');
    if (close) close.hidden = !sub;
  }

  function isExpanded() {
    return document.body.classList.contains('term-expanded');
  }

  function expand() {
    document.body.classList.add('term-expanded');
    const toggle = $('term-bar-toggle');
    if (toggle) toggle.setAttribute('aria-expanded', 'true');
    const panel = $('term-panel');
    if (panel) panel.hidden = false;
    localStorage.setItem(LS_EXPANDED, '1');
    // Defer the resize/fit until CSS transition has started taking effect —
    // fitting while height is still 0 produces cols=0,rows=0 and xterm refuses
    // to render.
    requestAnimationFrame(() => requestAnimationFrame(scheduleFit));
  }

  function collapse() {
    document.body.classList.remove('term-expanded');
    const toggle = $('term-bar-toggle');
    if (toggle) toggle.setAttribute('aria-expanded', 'false');
    localStorage.setItem(LS_EXPANDED, '0');
  }

  function toggle() { isExpanded() ? collapse() : expand(); }

  function applyStoredHeight() {
    const raw = localStorage.getItem(LS_HEIGHT);
    const px = raw ? parseInt(raw, 10) : NaN;
    if (!Number.isFinite(px)) return;
    const max = Math.floor(window.innerHeight * MAX_HEIGHT_VH / 100);
    const clamped = Math.min(Math.max(px, MIN_HEIGHT_PX), max);
    document.documentElement.style.setProperty('--term-h', `${clamped}px`);
  }

  // Drag-resize on the top edge of the expanded panel.
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

  // ── xterm instance management ────────────────────────────────────────────

  async function ensureTerm() {
    await ensureXterm();
    if (term) return term;
    const host = $('term-xterm');
    if (!host) throw new Error('term-xterm host missing');
    term = new window.Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, "SF Mono", Menlo, Monaco, Consolas, monospace',
      fontSize: 13,
      // xterm uses these colours across the full ANSI palette + background.
      // Match the dashboard's dark palette so the terminal doesn't look
      // bolted on — pulled straight from app.css --bg / --text tokens.
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
      ignoreBracketedPasteMode: true,
      allowProposedApi: true,
    });
    const FitCtor = window.FitAddon && window.FitAddon.FitAddon;
    const LinksCtor = window.WebLinksAddon && window.WebLinksAddon.WebLinksAddon;
    if (FitCtor) {
      fitAddon = new FitCtor();
      term.loadAddon(fitAddon);
    }
    if (LinksCtor) {
      term.loadAddon(new LinksCtor((_e, url) => {
        try { window.open(url, '_blank', 'noopener,noreferrer'); } catch {}
      }));
    }
    term.open(host);
    term.onData((data) => {
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'input', data }));
      } else {
        pendingInput.push(data);
      }
    });

    // Keep xterm's grid aligned to the host box on viewport / panel resize.
    // ResizeObserver fires on layout changes the window.resize handler misses
    // (e.g. sidebar drawer open).
    if (window.ResizeObserver) {
      resizeObserver = new ResizeObserver(scheduleFit);
      resizeObserver.observe(host);
    }
    window.addEventListener('resize', scheduleFit);
    return term;
  }

  let fitHandle = null;
  function scheduleFit() {
    if (fitHandle) cancelAnimationFrame(fitHandle);
    fitHandle = requestAnimationFrame(() => {
      fitHandle = null;
      if (!term || !fitAddon) return;
      try {
        fitAddon.fit();
        if (ws && ws.readyState === 1 && term.cols > 0 && term.rows > 0) {
          ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
        }
      } catch {}
    });
  }

  // ── WebSocket session ────────────────────────────────────────────────────

  function connectWs(id) {
    if (ws) { try { ws.close(); } catch {} ws = null; }
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const token = encodeURIComponent(getToken());
    const url = `${proto}://${location.host}/api/terminal/ws/${id}?token=${token}`;
    ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';

    ws.addEventListener('open', () => {
      // Flush anything the user typed before the WS was ready.
      while (pendingInput.length) {
        ws.send(JSON.stringify({ type: 'input', data: pendingInput.shift() }));
      }
      scheduleFit();
    });

    ws.addEventListener('message', (ev) => {
      let data = ev.data;
      if (data instanceof ArrayBuffer) data = new TextDecoder().decode(data);
      if (typeof data !== 'string') return;
      // Control frames are NUL-prefixed JSON. See terminal.ts — we use NUL
      // because it never appears in a real TTY stream.
      if (data.length && data.charCodeAt(0) === 0) {
        try {
          const ctrl = JSON.parse(data.slice(1));
          handleControl(ctrl);
        } catch {}
        return;
      }
      if (term) term.write(data);
    });

    ws.addEventListener('close', () => {
      // Grace window on the server kicks in automatically; we don't tear down
      // the term instance here so a reconnect can drop straight back in.
      ws = null;
    });

    ws.addEventListener('error', () => {
      // Surface via term so the user sees something happen.
      if (term) term.writeln('\r\n\x1b[31m[terminal] websocket error\x1b[0m');
    });
  }

  function handleControl(ctrl) {
    if (!term) return;
    if (ctrl.type === 'exit') {
      const code = ctrl.exitCode == null ? '?' : ctrl.exitCode;
      term.writeln(`\r\n\x1b[2m[process exited — code ${code}]\x1b[0m`);
      // Session will be destroyed server-side after a short lingering window.
      sessionLabel = null;
      setBarLabel('Terminal', '');
      localStorage.removeItem(LS_SESSION);
    } else if (ctrl.type === 'closed') {
      term.writeln(`\r\n\x1b[2m[session closed — ${ctrl.reason || 'unknown'}]\x1b[0m`);
      sessionId = null;
      sessionLabel = null;
      setBarLabel('Terminal', '');
      localStorage.removeItem(LS_SESSION);
    }
  }

  async function openKey(key, opts = {}) {
    if (!available) {
      window.toast?.('Terminal unavailable', 'Run `nostr-station doctor --fix` to install node-pty', 'err');
      return;
    }
    await ensureXterm();
    await ensureTerm();

    // If a session is already attached, close it first — MVP is single-tab.
    // Tab UI in the next pass will stash it instead of killing.
    if (sessionId) {
      try {
        await fetch(`/api/terminal/${sessionId}`, { method: 'DELETE', headers: authHeaders() });
      } catch {}
      sessionId = null;
    }

    const body = JSON.stringify({ key, ...opts });
    let r;
    try {
      const res = await fetch('/api/terminal/create', {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body,
      });
      r = await res.json();
      if (!res.ok) throw new Error(r.error || res.status);
    } catch (e) {
      window.toast?.('Terminal failed to start', String(e.message || e), 'err');
      return;
    }

    sessionId    = r.id;
    sessionLabel = r.label;
    localStorage.setItem(LS_SESSION, sessionId);
    setBarLabel('Terminal', sessionLabel);

    expand();
    connectWs(sessionId);
    term.focus();
  }

  async function closeSession() {
    if (!sessionId) return;
    try {
      await fetch(`/api/terminal/${sessionId}`, { method: 'DELETE', headers: authHeaders() });
    } catch {}
    if (ws) { try { ws.close(); } catch {} ws = null; }
    sessionId = null;
    sessionLabel = null;
    localStorage.removeItem(LS_SESSION);
    setBarLabel('Terminal', '');
    if (term) term.clear();
  }

  // On boot, see if a prior session is still alive and rejoin it.
  async function restoreSession() {
    const stored = localStorage.getItem(LS_SESSION);
    if (!stored) return;
    try {
      const res = await fetch('/api/terminal', { headers: authHeaders() });
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      const match = (data.sessions || []).find(s => s.id === stored && !s.exited);
      if (!match) {
        localStorage.removeItem(LS_SESSION);
        return;
      }
      sessionId = match.id;
      sessionLabel = match.label || 'shell';
      setBarLabel('Terminal', sessionLabel);
      await ensureXterm();
      await ensureTerm();
      if (localStorage.getItem(LS_EXPANDED) === '1') expand();
      connectWs(sessionId);
    } catch {
      localStorage.removeItem(LS_SESSION);
    }
  }

  // ── Wire-up ──────────────────────────────────────────────────────────────

  async function init() {
    applyStoredHeight();
    wireResize();

    // Capability probe. Gate the shell on a yes so we don't advertise a
    // broken feature (missing node-pty on an unusual arch, or install failed).
    try {
      const res = await fetch('/api/terminal/capability', { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        available = !!data.available;
        if (!available && data.reason) {
          // Keep the bar hidden but stash the reason for error surfaces to
          // show when a caller tries to open a terminal.
          window.__nsTerminalUnavailableReason = data.reason;
        }
      }
    } catch { available = false; }

    if (!available) return;
    showShell();

    $('term-bar-toggle')?.addEventListener('click', toggle);
    $('term-bar-close')?.addEventListener('click', (e) => {
      e.stopPropagation();
      closeSession();
    });
    $('term-empty-shell')?.addEventListener('click', () => openKey('shell'));

    await restoreSession();
  }

  window.NSTerminal = {
    init,
    open: openKey,
    close: closeSession,
    expand,
    collapse,
    isAvailable: () => !!available,
    getUnavailableReason: () => window.__nsTerminalUnavailableReason || null,
  };
})();
