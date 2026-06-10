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

  const LS_TABS        = 'ns-term-tabs';        // JSON [{ id, label }, …]
  const LS_ACTIVE      = 'ns-term-active';      // id of the active tab
  const LS_EXPANDED    = 'ns-term-expanded';    // '1' | '0'
  const LS_HEIGHT      = 'ns-term-height';      // pixel height of expanded panel
  const LS_KEYS_HIDDEN = 'ns-term-keys-hidden'; // '1' | '0' — mobile extra-keys row

  // Floor keeps 8+ rows readable; ceiling keeps header + sidebar visible.
  const MIN_HEIGHT_PX = 180;
  const MAX_HEIGHT_VH = 70;

  // Auto-reconnect backoff for dropped WebSockets. The server keeps the PTY
  // alive for its grace window, so a transient drop should silently rejoin.
  // Schedule: 0.5s, 1s, 2s, 4s, 8s, 15s, 15s, 15s — ~60s of retries before we
  // give up and ask the user to refresh (which re-runs restoreTabs and
  // rejoins). We never kill the session from the client on exhaustion.
  const RECONNECT_BASE_MS     = 500;
  const RECONNECT_MAX_ATTEMPTS = 8;

  // Activity-state heuristics (see noteOutput). A tab is "working" while
  // the PTY produces a sustained output burst — WORKING_MIN_MS filters
  // out keystroke echo and prompt redraws, which are single sub-50ms
  // chunks. ACTIVITY_QUIET_MS of silence ends the burst: a foreground
  // tab just returns to idle (the user watched it finish), a background
  // one flips to "attention" so the strip + bar show that the long task
  // (Claude Code turn, build, test run) is now waiting on the user.
  const ACTIVITY_QUIET_MS = 1200;
  const WORKING_MIN_MS    = 400;

  // True on phones — a coarse pointer at a narrow width. Gates the full-screen
  // terminal sheet's companion JS: the keyboard-input bridge and the
  // render-robustness kicks below. Desktop (any width, mouse) never matches, so
  // none of the mobile-only paths can touch the desktop experience. Matches the
  // CSS max-width:640px sheet breakpoint, plus pointer:coarse so a narrow
  // *desktop* window keeps xterm's normal (working) input path.
  const MOBILE_MQ = window.matchMedia('(max-width: 640px) and (pointer: coarse)');
  const isMobile = () => MOBILE_MQ.matches;

  let available    = null;   // null = not probed; true/false after probe
  let xtermLoaded  = false;
  let xtermLoading = null;   // Promise when the library fetch is in flight

  // Opt-in TX tracing. When on, every byte that leaves xterm toward the PTY
  // (real keystrokes, pastes, AND xterm's automatic replies to device/focus
  // queries) is logged to the console with the originating tab. This is the
  // ground-truth tool for diagnosing phantom input — e.g. a stray `/clear`
  // appearing in a Claude session after a collapse/restore. Flip it from the
  // DevTools console with `NSTerminal.setDebug(true)`, reproduce, and read
  // the `[ns-term tx]` lines to see exactly what (if anything) the browser
  // transmits. Persisted so it survives a refresh during a repro session.
  let debugTx = localStorage.getItem('ns-term-debug') === '1';

  /** @type {Array<Tab>} */
  const tabs = [];
  let activeIdx = -1;

  // Sticky-Ctrl modifier for the mobile extra-keys row: when armed, the next
  // single letter (from the keys row OR the soft keyboard) is sent as its
  // control code. Module-scoped so it's shared across the keys row and the
  // per-tab input bridge.
  let ctrlSticky = false;

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
    // same key contract it uses (see getSessionToken in app.js). Reads from
    // localStorage — app.js moved the token there so it survives tab close
    // and browser relaunch. Missing the migration here caused the terminal
    // capability probe to fire without a Bearer header, 401 out, and leave
    // `available` null — every terminal-backed button ("Seed Events",
    // "Open in Claude Code", etc.) would then show "Terminal unavailable".
    return localStorage.getItem('ns-session-token') || '';
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
    // The per-tab × in the strip is the sole close control now — the
    // bar-level × was redundant and visually competed with the expand
    // chevron, so it's been removed. Kept this block as a no-op stub in
    // case the button returns in a different spot later.
  }

  function refreshBarLabel() {
    const active = tabs[activeIdx];
    let sub = active ? active.label : '';
    if (active && active.connState === 'reconnecting') sub += ' · reconnecting…';
    if (active && active.connState === 'offline')      sub += ' · offline';
    setBarLabel('Terminal', sub);
  }

  // Reflect a tab's connection state (open / reconnecting / offline) in the
  // strip + bar label. Backoff used to run silently — a dropped session was
  // indistinguishable from a hung shell until retries exhausted.
  function setConnState(tab, state) {
    if (tab.connState === state) return;
    tab.connState = state;
    renderStrip();
    refreshBarLabel();
  }

  // ── Per-tab activity state ─────────────────────────────────────────────
  // 'idle' | 'working' | 'attention' — dot in the tab strip plus an
  // aggregate dot on the collapsed bar, so "the agent finished and is
  // waiting for me" is visible without expanding the drawer.

  const isForeground = (tab) =>
    isExpanded() && tabs[activeIdx] === tab && !document.hidden;

  function setActivity(tab, state) {
    if (tab.activity === state) return;
    tab.activity = state;
    renderStrip();
    updateBarActivity();
  }

  function updateBarActivity() {
    const dot = $('term-bar-dot');
    if (!dot) return;
    const agg = tabs.some(t => t.activity === 'attention') ? 'attention'
              : tabs.some(t => t.activity === 'working')   ? 'working'
              : '';
    dot.hidden = !agg;
    dot.className = 'term-bar-dot' + (agg ? ` ${agg}` : '');
    dot.title = agg === 'attention' ? 'A terminal is waiting for input'
              : agg === 'working'   ? 'A terminal is working'
              : '';
  }

  function clearAttention(tab) {
    if (tab && tab.activity === 'attention') setActivity(tab, 'idle');
  }

  // Classify a PTY output chunk. Called from the WS message handler for
  // every data frame; cheap on purpose.
  function noteOutput(tab, data) {
    // Scrollback replay after (re)connect is history, not fresh work —
    // same suppression window the TX side uses, plus a grace period of
    // our own: the replay burst can outlast suppressTx's 300ms on big
    // buffers, and without this every restored background tab would
    // flash working → attention on page load.
    const now = Date.now();
    if (tab.suppressTx || now - (tab.connectedAt || 0) < 1000) return;
    // BEL is an explicit attention request (Claude Code rings it when a
    // turn ends or an approval is pending). Honor it immediately unless
    // the user is already looking at this tab.
    if (data.includes('\x07') && !isForeground(tab)) {
      setActivity(tab, 'attention');
    }
    // New burst if the previous output is older than the quiet window.
    if (now - tab.lastOutputAt > ACTIVITY_QUIET_MS) tab.workStartAt = now;
    tab.lastOutputAt = now;
    if (tab.activity !== 'attention' && now - tab.workStartAt >= WORKING_MIN_MS) {
      setActivity(tab, 'working');
    }
    if (!tab.quietTimer) armQuietTimer(tab, ACTIVITY_QUIET_MS);
  }

  // One live timer per burst instead of clear+set per WS frame — a
  // high-rate stream (cat of a big file) delivers hundreds of frames a
  // second and the per-chunk timer churn adds up. At fire time, if
  // output kept flowing, re-arm for whatever remains of the quiet
  // window measured from the last chunk.
  function armQuietTimer(tab, delay) {
    tab.quietTimer = setTimeout(() => {
      tab.quietTimer = null;
      const remaining = ACTIVITY_QUIET_MS - (Date.now() - tab.lastOutputAt);
      if (remaining > 25) { armQuietTimer(tab, remaining); return; }
      if (tab.activity !== 'working') return;
      setActivity(tab, isForeground(tab) ? 'idle' : 'attention');
    }, delay);
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
    // Defer fit until the CSS height transition is underway — fitting while
    // the host is still clipped to ~0 height produces cols=rows=0 and xterm
    // refuses to render. Once the drawer is open, refocus the active tab so
    // collapsing mid-chat and reopening drops the user straight back into the
    // session they left, ready to type — without clicking into the panel.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      scheduleFit();
      const active = tabs[activeIdx];
      if (active) {
        clearAttention(active);
        try { active.term.focus(); } catch {}
      }
      // On phones the sheet snaps to full-screen and the keyboard animates in
      // over a few hundred ms; the host's final height (and the visible rows
      // above the keyboard) only settle after that. Re-fit on a couple of
      // delays so the prompt paints into the correct grid rather than a blank
      // or clipped one. No-op churn on desktop is avoided by the gate.
      if (isMobile()) {
        setTimeout(scheduleFit, 160);
        setTimeout(scheduleFit, 420);
      }
    }));
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

  // Single funnel for bytes headed to the PTY, shared by xterm's onData (desktop)
  // and the mobile input bridge. While the server is replaying historical output
  // on (re)connect, drop xterm's automatic answers to any device/cursor queries
  // embedded in that scrollback — replaying old query bytes makes xterm reply
  // *now*, and those stale answers would land in the live prompt as junk input.
  // Real keystrokes are extremely unlikely in that sub-second window; pre-connect
  // input is preserved separately via pendingInput.
  function sendInputBytes(tab, data) {
    if (!data) return;
    if (tab.suppressTx) return;
    // Typing is the strongest "I've seen it" signal — drop the
    // needs-input dot for this tab.
    clearAttention(tab);
    if (tab.ws && tab.ws.readyState === 1) {
      tab.ws.send(JSON.stringify({ type: 'input', data }));
    } else {
      tab.pendingInput.push(data);
      // Typing into an offline tab (backoff exhausted) restarts the
      // reconnect loop — the keystroke is queued in pendingInput and
      // flushes on open, so the input isn't lost, it's the wake-up call.
      if (tab.connState === 'offline' && !tab.closing && !tab.exited) {
        tab.reconnectAttempts = 0;
        scheduleReconnect(tab);
      }
    }
  }

  // ── Mobile extra-keys row ───────────────────────────────────────────────────
  // Terminal byte sequences for the on-screen accessory keys (#term-keys).
  const KEY_SEQ = {
    esc:      '\x1b',
    tab:      '\t',
    'ctrl-c': '\x03',
    up:       '\x1b[A',
    down:     '\x1b[B',
    left:     '\x1b[D',
    right:    '\x1b[C',
  };

  function updateCtrlVisual() {
    for (const b of document.querySelectorAll('.term-key-ctrl')) {
      b.setAttribute('aria-pressed', ctrlSticky ? 'true' : 'false');
    }
  }

  // Send user text to the PTY, applying a pending sticky-Ctrl to a single
  // letter (a–z → control code). Anything else passes through untouched; a
  // sticky-Ctrl followed by a non-letter is simply cleared. Used by both the
  // soft-keyboard bridge and the extra-keys row.
  function emitText(tab, text) {
    if (ctrlSticky && text && text.length === 1) {
      const code = text.toLowerCase().charCodeAt(0);
      ctrlSticky = false;
      updateCtrlVisual();
      if (code >= 97 && code <= 122) { sendInputBytes(tab, String.fromCharCode(code - 96)); return; }
    }
    sendInputBytes(tab, text);
  }

  function handleExtraKey(seq) {
    if (seq === 'ctrl') { ctrlSticky = !ctrlSticky; updateCtrlVisual(); return; }
    const bytes = KEY_SEQ[seq];
    if (bytes == null) return;
    const tab = tabs[activeIdx];
    if (!tab) return;
    sendInputBytes(tab, bytes);
    if (ctrlSticky) { ctrlSticky = false; updateCtrlVisual(); }
  }

  function wireExtraKeys() {
    const row = $('term-keys');
    if (row) {
      for (const btn of row.querySelectorAll('.term-key')) {
        const seq = btn.getAttribute('data-seq');
        // Act on press, NOT click: preventDefault on touchstart/mousedown keeps
        // focus on the hidden textarea, so tapping a key never blurs the
        // keyboard (when up) or re-opens it (when the user minimized it) — and
        // it makes the key feel instant. On touch, the touchstart preventDefault
        // also suppresses the emulated mousedown/click, so we fire exactly once.
        const fire = (e) => { e.preventDefault(); handleExtraKey(seq); };
        btn.addEventListener('touchstart', fire, { passive: false });
        btn.addEventListener('mousedown', fire);
        btn.addEventListener('click', (e) => e.preventDefault());
      }
    }
    const toggle = $('term-keys-toggle');
    if (toggle) {
      if (localStorage.getItem(LS_KEYS_HIDDEN) === '1') {
        document.body.classList.add('term-keys-hidden');
      }
      toggle.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();   // don't also trigger the bar's expand/collapse
        const hidden = !document.body.classList.contains('term-keys-hidden');
        document.body.classList.toggle('term-keys-hidden', hidden);
        try { localStorage.setItem(LS_KEYS_HIDDEN, hidden ? '1' : '0'); } catch {}
        scheduleFit();   // row appearing/disappearing changes xterm's height
      });
    }
  }

  // ── Mobile keyboard bridge ─────────────────────────────────────────────────
  // xterm's built-in keyboard handling drops most soft-keyboard input: Android
  // (Gboard) and iOS compose predictive text inside the hidden textarea and
  // commit it via composition/beforeinput events that xterm's path mishandles,
  // so onData never fires and nothing reaches the shell — the exact "keyboard
  // looks alive but nothing types" symptom. We attach our own capture-phase
  // listeners on that textarea, translate the events to terminal bytes, forward
  // them via sendInputBytes, and stop them before xterm sees them (no
  // double-send). Phone-only; desktop keeps xterm's native path untouched.
  function attachMobileInput(tab) {
    const ta = tab.host.querySelector('.xterm-helper-textarea');
    if (!ta) return;
    // Nudge the keyboard toward discrete character inserts instead of a
    // composed/predicted word, which the beforeinput path handles cleanly.
    ta.setAttribute('autocomplete', 'off');
    ta.setAttribute('autocorrect', 'off');
    ta.setAttribute('autocapitalize', 'off');
    ta.setAttribute('spellcheck', 'false');
    ta.setAttribute('enterkeyhint', 'send');

    let composing = false;
    // Route through emitText so a sticky-Ctrl armed from the extra-keys row
    // applies to the next letter typed on the soft keyboard, too.
    const send = (d) => emitText(tab, d);

    // Own composition end-to-end so xterm's CompositionHelper can't also fire.
    ta.addEventListener('compositionstart', (e) => { composing = true; e.stopPropagation(); }, true);
    ta.addEventListener('compositionupdate', (e) => { e.stopPropagation(); }, true);
    ta.addEventListener('compositionend', (e) => {
      composing = false;
      e.stopPropagation();
      send(e.data != null ? e.data : ta.value);
      ta.value = '';
    }, true);

    // Printable text, paste, and Gboard-style backspace arrive as beforeinput.
    // preventDefault keeps the textarea empty so xterm's own input never fires.
    ta.addEventListener('beforeinput', (e) => {
      if (composing || e.inputType === 'insertCompositionText') return;
      switch (e.inputType) {
        case 'insertText':
        case 'insertReplacementText':
        case 'insertFromPaste':
          send(e.data); e.preventDefault(); break;
        case 'insertLineBreak':
        case 'insertParagraph':
          send('\r'); e.preventDefault(); break;
        case 'deleteContentBackward':
          send('\x7f'); e.preventDefault(); break;
        case 'deleteWordBackward':
          send('\x17'); e.preventDefault(); break;
        default: break;
      }
    }, true);

    // Control keys (Enter, Backspace, arrows, Tab, Ctrl-combos) that hardware
    // and some soft keyboards send as keydown. preventDefault here suppresses
    // the matching beforeinput, so a key is never sent twice.
    ta.addEventListener('keydown', (e) => {
      if (composing || e.isComposing) return;
      const k = e.key;
      let seq = null;
      if (e.ctrlKey && !e.altKey && !e.metaKey && k.length === 1) {
        const c = k.toLowerCase().charCodeAt(0);
        if (c >= 97 && c <= 122) seq = String.fromCharCode(c - 96); // Ctrl-A..Z
      } else if (!e.ctrlKey && !e.metaKey && !e.altKey && k.length === 1) {
        // A real printable key (hardware keyboard, or a soft keyboard not in a
        // composition). Own it here and preventDefault so neither xterm's
        // keydown nor the beforeinput path also emits it — that double-send is
        // the only way a phone with a physical keyboard could echo each char
        // twice. Composing soft keyboards report key='Unidentified' (keyCode
        // 229) instead, fall through, and go via beforeinput/compositionend.
        seq = k;
      } else {
        switch (k) {
          case 'Enter':      seq = '\r';     break;
          case 'Backspace':  seq = '\x7f';   break;
          case 'Tab':        seq = '\t';     break;
          case 'Escape':     seq = '\x1b';   break;
          case 'ArrowUp':    seq = '\x1b[A'; break;
          case 'ArrowDown':  seq = '\x1b[B'; break;
          case 'ArrowRight': seq = '\x1b[C'; break;
          case 'ArrowLeft':  seq = '\x1b[D'; break;
          case 'Home':       seq = '\x1b[H'; break;
          case 'End':        seq = '\x1b[F'; break;
          default: break;
        }
      }
      if (seq != null) { send(seq); e.preventDefault(); e.stopPropagation(); }
    }, true);
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
      // Reconnect bookkeeping (see connectWs / scheduleReconnect).
      closing: false,          // true once the user/server is tearing this tab down
      reconnectAttempts: 0,    // resets to 0 on a successful open
      reconnectTimer: null,    // pending backoff timer, if any
      connState: 'open',       // 'open' | 'reconnecting' | 'offline' — strip/bar UI
      reconnectNotified: false, // one "connection lost" line per drop, not per retry
      // Activity tracking (see noteOutput): output-burst bookkeeping
      // behind the working / needs-input dot in the strip + bar.
      activity: 'idle',        // 'idle' | 'working' | 'attention'
      lastOutputAt: 0,
      workStartAt: 0,
      quietTimer: null,
      connectedAt: 0,          // set on WS open; gates the replay grace period
      // True for a brief window right after (re)connect while the server
      // replays scrollback — see the open handler in connectWs.
      suppressTx: false,
    };

    term.onData((data) => {
      if (debugTx) {
        // JSON.stringify renders control bytes as  etc. so escape
        // sequences are legible and a literal "/clear" stands out plainly.
        try { console.debug('[ns-term tx]', tab.label, tab.suppressTx ? '(suppressed)' : '', JSON.stringify(data)); } catch {}
      }
      sendInputBytes(tab, data);
    });

    // On phones, drive input through our own bridge (attachMobileInput) which
    // bypasses xterm's keyboard path — that path drops Android/iOS soft-keyboard
    // input (predictive text composes in the hidden textarea and never reaches
    // onData). The bridge feeds the PTY via sendInputBytes directly, so xterm's
    // onData stays effectively the desktop path and there's no double-send.
    if (isMobile()) attachMobileInput(tab);

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
    // Mark deliberate teardown BEFORE closing the socket so the ws 'close'
    // handler doesn't mistake this for a transient drop and try to reconnect.
    tab.closing = true;
    if (tab.reconnectTimer) { clearTimeout(tab.reconnectTimer); tab.reconnectTimer = null; }
    if (tab.quietTimer)     { clearTimeout(tab.quietTimer);     tab.quietTimer = null; }
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
    updateBarActivity();
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
      if (isForeground(active)) clearAttention(active);
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
    const parts = tabs.map((t, i) => {
      const connSuffix = t.connState === 'reconnecting' ? ' (reconnecting…)'
                       : t.connState === 'offline'      ? ' (offline)' : '';
      const actSuffix  = t.activity === 'working'   ? ' (working)'
                       : t.activity === 'attention' ? ' (waiting for input)' : '';
      const dot = t.activity !== 'idle'
        ? `<span class="term-tab-dot ${t.activity}" aria-hidden="true"></span>` : '';
      return `
      <button class="term-tab ${i === activeIdx ? 'active' : ''}${t.connState === 'reconnecting' ? ' reconnecting' : ''}${t.connState === 'offline' ? ' offline' : ''}"
              role="tab"
              data-idx="${i}"
              title="${escapeHtml(t.label)}${connSuffix}${actSuffix}">
        ${dot}<span class="term-tab-label">${escapeHtml(t.label)}</span>
        <span class="term-tab-close" data-close="${i}" aria-label="Close tab">×</span>
      </button>
    `;
    }).join('');
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
      // Never refit while the drawer is collapsed. When collapsed the panel
      // is clipped to the bar height (see body:not(.term-expanded) in
      // app.css), so the active xterm host measures ~0px tall. fitAddon.fit()
      // would then compute a degenerate 1-row geometry and resize the live
      // PTY down to it — firing a SIGWINCH at the attached full-screen TUI
      // (Claude Code, ngit prompts) on every collapse, and again on expand.
      // That resize churn is what made a mid-chat collapse/restore disrupt
      // the running session. Hold the last good size until the drawer is
      // genuinely open and laid out; the cols>0 check below only ever
      // guarded the *send*, not the fit() itself.
      if (!isExpanded()) return;
      const tab = tabs[activeIdx];
      if (!tab || !tab.fitAddon) return;
      // Mid-expand the height transition may not have handed the host any
      // usable rows yet; skip until it has real height — a later
      // ResizeObserver tick fires once the transition lands the final size.
      if (tab.host.clientHeight < 1) return;
      try {
        tab.fitAddon.fit();
        if (tab.ws && tab.ws.readyState === 1 && tab.term.cols > 0 && tab.term.rows > 0) {
          tab.ws.send(JSON.stringify({ type: 'resize', cols: tab.term.cols, rows: tab.term.rows }));
        }
        if (isMobile()) {
          // The full-screen sheet mounts xterm while its host is still 0-height
          // (collapsed), so the first prompt can render into a stale grid and
          // look blank. Repaint and pin to the latest line once we have a real
          // fit, so the shell prompt is actually visible after the sheet opens.
          try { tab.term.refresh(0, tab.term.rows - 1); } catch {}
          try { tab.term.scrollToBottom(); } catch {}
        }
      } catch {}
    });
  }
  window.addEventListener('resize', scheduleFit);

  // ── Mobile keyboard tracking ───────────────────────────────────────────────
  // On phones the expanded terminal is a full-screen sheet (see the
  // max-width:640px block in app.css) whose bottom edge is lifted by the
  // --kb-inset CSS var so the prompt clears the on-screen keyboard. The layout
  // viewport (innerHeight) stays full-height when the keyboard opens; only the
  // VisualViewport shrinks, so the gap between them is the keyboard's height.
  // Writing that to --kb-inset floats the sheet up, and a refit reflows xterm
  // to the now-shorter host. On desktop the inset stays 0 (no keyboard), so the
  // var is a harmless no-op there and the CSS only consumes it on phones.
  const vv = window.visualViewport;
  function updateKeyboardInset() {
    if (!vv) return;
    const inset = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
    document.documentElement.style.setProperty('--kb-inset', `${inset}px`);
    if (isExpanded()) scheduleFit();
  }
  if (vv) {
    vv.addEventListener('resize', updateKeyboardInset);
    vv.addEventListener('scroll', updateKeyboardInset);
    updateKeyboardInset();
  }

  // Re-attach any tab whose socket dropped the moment we plausibly have
  // connectivity again — the laptop woke, the tab regained focus, or the
  // network came back. Backoff retries can exhaust during a long sleep (timers
  // don't fire reliably while suspended), so these events are the safety net
  // that makes "close the lid, come back tomorrow" land you straight back in
  // the still-running session without a manual refresh.
  function reconnectDroppedTabs() {
    for (const tab of tabs) {
      if (tab.closing || tab.exited) continue;
      // Skip tabs that are connecting (0) or already open (1).
      if (tab.ws && (tab.ws.readyState === 0 || tab.ws.readyState === 1)) continue;
      tab.reconnectAttempts = 0;
      if (tab.reconnectTimer) { clearTimeout(tab.reconnectTimer); tab.reconnectTimer = null; }
      scheduleReconnect(tab);
    }
  }
  window.addEventListener('online', reconnectDroppedTabs);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      reconnectDroppedTabs();
      // Coming back to a visible drawer counts as seeing the active tab.
      const active = tabs[activeIdx];
      if (active && isForeground(active)) clearAttention(active);
    }
  });

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
      // A clean open means any prior drop is resolved — reset the backoff so
      // the next genuine drop starts its retry schedule fresh.
      tab.reconnectAttempts = 0;
      tab.reconnectNotified = false;
      tab.connectedAt = Date.now();
      setConnState(tab, 'open');
      // Open the replay-suppression window: the server replays scrollback as
      // the first frame(s) after attach, and xterm will auto-reply to any
      // device/cursor queries inside it. Drop those replies (see onData) for a
      // brief window so they can't dirty the live prompt. Pre-open keystrokes
      // are flushed below via ws.send directly, so they're unaffected.
      tab.suppressTx = true;
      setTimeout(() => { tab.suppressTx = false; }, 300);
      // Flush keystrokes typed before the WS was ready.
      while (tab.pendingInput.length) {
        ws.send(JSON.stringify({ type: 'input', data: tab.pendingInput.shift() }));
      }
      if (tabs[activeIdx] === tab) scheduleFit();
    });

    // Coalesce incoming chunks into a per-frame flush. xterm.js parses each
    // write() synchronously; high-rate streams (e.g. an ngit-login QR redraw,
    // or a `cat` of a large file) used to land one xterm.write per WS message
    // and starve the main thread, freezing the rest of the dashboard. Buffering
    // by frame keeps xterm's parser pipeline full without paying per-message
    // overhead, and each frame still draws the latest state.
    let pending = '';
    let pendingHandle = 0;
    const flushPending = () => {
      pendingHandle = 0;
      if (!pending || tab.exited) { pending = ''; return; }
      const out = pending;
      pending = '';
      try { tab.term.write(out); } catch {}
    };
    ws.addEventListener('message', (ev) => {
      let data = ev.data;
      if (data instanceof ArrayBuffer) data = new TextDecoder().decode(data);
      if (typeof data !== 'string') return;
      // Control frames are NUL-prefixed JSON. See terminal.ts — we use NUL
      // because it never appears in a real TTY stream.
      if (data.length && data.charCodeAt(0) === 0) {
        // Flush buffered output before the control side-effect so any
        // "process exited" line lands after the prior chunk.
        if (pending) flushPending();
        try { handleControl(tab, JSON.parse(data.slice(1))); } catch {}
        return;
      }
      if (tab.exited) return;
      noteOutput(tab, data);
      pending += data;
      if (!pendingHandle) pendingHandle = requestAnimationFrame(flushPending);
    });

    ws.addEventListener('close', () => {
      // Ignore closes for a socket we've already replaced (a deliberate
      // reconnect or teardown swapped tab.ws to a new socket / null). Only the
      // currently-live socket dropping should drive reconnect logic.
      if (tab.ws !== ws) return;
      tab.ws = null;
      // The server's grace window keeps the PTY alive across a WS drop; don't
      // dispose the xterm here so a reconnect drops straight back in. If the
      // session was actually destroyed (process exit / explicit close), the
      // server sent a 'closed'/'exit' control frame first and handleControl()
      // already flipped tab.exited — so we skip reconnect in that case.
      if (tab.exited || tab.closing) return;
      scheduleReconnect(tab);
    });

    ws.addEventListener('error', () => {
      // An 'error' is almost always immediately followed by 'close', which
      // drives the reconnect path — so don't spam the terminal with a red
      // line on every transient blip. Surface only when TX tracing is on.
      if (debugTx) { try { console.debug('[ns-term] ws error', tab.label); } catch {} }
    });
  }

  // Reconnect a tab whose WebSocket dropped unexpectedly. The PTY survives on
  // the server for the grace window, so a transient blip (laptop sleep, wifi
  // flap, a server restart mid-session) should silently rejoin rather than
  // freeze the tab until a manual refresh.
  function scheduleReconnect(tab) {
    if (tab.closing || tab.exited) return;
    if (tab.reconnectTimer) return;                 // already scheduled
    if (tab.ws && tab.ws.readyState === 1) return;  // already back
    const attempt = tab.reconnectAttempts || 0;
    if (attempt >= RECONNECT_MAX_ATTEMPTS) {
      setConnState(tab, 'offline');
      tab.term.writeln('\r\n\x1b[33m[terminal] disconnected — press any key to retry\x1b[0m');
      return;
    }
    setConnState(tab, 'reconnecting');
    if (!tab.reconnectNotified) {
      tab.reconnectNotified = true;
      tab.term.writeln('\r\n\x1b[2m[terminal] connection lost — reconnecting…\x1b[0m');
    }
    const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, attempt), 15000);
    tab.reconnectAttempts = attempt + 1;
    tab.reconnectTimer = setTimeout(async () => {
      tab.reconnectTimer = null;
      if (tab.closing || tab.exited) return;
      if (tab.ws && tab.ws.readyState === 1) return;
      // Confirm the session still exists before reattaching, so we can tell a
      // transient network drop (keep retrying) apart from a session the server
      // actually retired (stop and clean up). null = couldn't reach the server.
      let listed = null;
      try {
        const res = await fetch('/api/terminal', { headers: authHeaders() });
        if (res.ok) {
          const data = await res.json();
          listed = (data.sessions || []).some(s => s.id === tab.id && !s.exited);
        }
      } catch { /* server unreachable — treat as indeterminate, keep backing off */ }
      if (tab.closing || tab.exited) return;
      if (listed === true) { connectWs(tab); return; }
      if (listed === false) {
        // Server is reachable and the session is gone — retire the tab cleanly
        // instead of looping against an id that will never come back.
        tab.exited = true;
        tab.term.writeln('\r\n\x1b[2m[session ended]\x1b[0m');
        const idx = tabs.indexOf(tab);
        if (idx >= 0) destroyTab(idx, true);
        return;
      }
      // Indeterminate (server unreachable): keep the backoff going.
      scheduleReconnect(tab);
    }, delay);
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
    wireExtraKeys();

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
    $('term-empty-shell')?.addEventListener('click', () => openKey('shell'));

    // Warm the xterm bundle in the background so the first interactive
    // open doesn't pay the ~300KB parse cost in the click handler. This
    // is fire-and-forget; openKey() still awaits ensureXterm() and will
    // dedupe against the in-flight load via xtermLoading.
    ensureXterm().catch(() => {});

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
    // Toggle TX tracing (see debugTx above). `NSTerminal.setDebug(true)` in
    // the console, reproduce the phantom input, then read the `[ns-term tx]`
    // lines to see exactly what the browser sends to the PTY.
    setDebug: (on) => {
      debugTx = !!on;
      try { localStorage.setItem('ns-term-debug', debugTx ? '1' : '0'); } catch {}
      return debugTx;
    },
    // Number of live tabs — used by the sidebar Terminal nav to decide
    // whether clicking should spawn a shell or just expand an existing one.
    tabCount: () => tabs.length,
  };
})();
