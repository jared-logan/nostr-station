// nostr-station signer shim — installed at the top of the Ditto iframe's
// <head> so it claims window.nostr before Ditto's main bundle runs.
//
// Behaviour:
//   - Reads localStorage['ns-ditto-signer']. Values:
//       'station'    → install our shim (route signEvent/getPublicKey
//                      through /api/sign/*, which talks to the station's
//                      saved NIP-46 bunker pairing).
//       'extension'  → bail; let whatever NIP-07 extension is installed
//                      (Alby, nos2x, …) own window.nostr like before.
//       (unset)      → bail. The "default ON" UX is delivered by the
//                      dashboard's boot path (app.js writes 'station'
//                      to this key on first sign-in when a bunker is
//                      paired) rather than by the shim guessing. That
//                      way users without a bunker paired don't get an
//                      installed shim that 400s on every sign — they
//                      stay on whatever NIP-07 extension Ditto picks up.
//
//   - When installing, we use Object.defineProperty with configurable +
//     writable = false. Extensions that re-claim window.nostr at
//     document_idle (some Alby builds do) would otherwise silently win
//     this race, and the user would see prompts again with no
//     diagnostic. With the lock in place a re-claim throws in strict
//     mode (or no-ops in sloppy mode) and Ditto keeps using us.
//
// The shim only implements `getPublicKey()` and `signEvent()` — the
// NIP-07 methods Ditto needs for posts, follows, reactions, profile
// edits, relay-list updates, etc. nip04 / nip44 (DMs) and getRelays()
// are intentionally absent in this PR; Ditto's DM features will use
// whatever fallback the page has (or break gracefully on `'nip04' in
// window.nostr` checks). A follow-up adds server-side nip04/nip44
// endpoints + their shim methods.

(function () {
  'use strict';

  // localStorage is shared with the parent dashboard (same origin), so
  // we can read both the toggle preference and the session token.
  // try/catch because some embedding modes (data: URLs, sandboxed
  // iframes without allow-same-origin) deny localStorage access — in
  // that case we just bail and Ditto behaves as today.
  var mode, token;
  try {
    mode  = localStorage.getItem('ns-ditto-signer');
    token = localStorage.getItem('ns-session-token');
  } catch (_) {
    return;
  }

  // Explicit opt-in only — see header. Anything other than 'station'
  // (including null / 'extension') means "stay out of the way".
  if (mode !== 'station') return;
  // Even with the explicit flag, bail without a token — our /api/sign/*
  // calls would 401 and Ditto would silently fail; leaving its
  // in-iframe NIP-07 extension in charge is the safer fallback.
  if (!token) return;

  function authHeaders(extra) {
    var h = { 'Accept': 'application/json' };
    if (extra) {
      for (var k in extra) { if (Object.prototype.hasOwnProperty.call(extra, k)) h[k] = extra[k]; }
    }
    var t;
    try { t = localStorage.getItem('ns-session-token'); } catch (_) {}
    if (t) h['Authorization'] = 'Bearer ' + t;
    return h;
  }

  // Cheap shared error-shape. The promise rejection's `.message` is what
  // Ditto surfaces to users on a failed sign — keep it short + actionable.
  function rpcFail(label, status, bodyText) {
    var msg = label + ' failed (' + status + ')';
    if (bodyText) {
      try {
        var j = JSON.parse(bodyText);
        if (j && j.error) msg += ': ' + j.error;
      } catch (_) {
        if (bodyText.length < 200) msg += ': ' + bodyText;
      }
    }
    return new Error(msg);
  }

  var signer = {
    // NIP-07 getPublicKey(): returns the owner's hex pubkey. Cached for
    // the page's lifetime — the pubkey doesn't change without a setup
    // re-pair, and Ditto calls this on every render of authored events.
    getPublicKey: (function () {
      var cached = null;
      return function () {
        if (cached) return Promise.resolve(cached);
        return fetch('/api/sign/pubkey', { headers: authHeaders() })
          .then(function (r) {
            if (!r.ok) return r.text().then(function (b) { throw rpcFail('getPublicKey', r.status, b); });
            return r.json();
          })
          .then(function (j) {
            cached = j.pubkey;
            return cached;
          });
      };
    })(),

    // NIP-07 signEvent(template): hands the unsigned template to the
    // station, which signs via the saved bunker pairing and returns the
    // signed event. The bunker round-trip can take a few seconds on
    // first call (Amber prompt) and ~100ms after — the server's 60s
    // timeout is the ceiling.
    //
    // Ditto passes templates with pubkey already filled (it stamps the
    // user's pubkey from getPublicKey above before calling signEvent).
    // The server-side handler ignores any pubkey in the input — the
    // bunker stamps its own — so we just forward and trust the result.
    signEvent: function (template) {
      return fetch('/api/sign/event', {
        method:  'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body:    JSON.stringify({ template: {
          kind:       template.kind,
          created_at: template.created_at,
          tags:       template.tags || [],
          content:    template.content || '',
        }}),
      })
        .then(function (r) {
          if (!r.ok) return r.text().then(function (b) { throw rpcFail('signEvent', r.status, b); });
          return r.json();
        })
        .then(function (j) {
          if (!j || !j.ok || !j.signedEvent) {
            throw new Error('signEvent: ' + (j && j.error ? j.error : 'no signed event in response'));
          }
          return j.signedEvent;
        });
    },
  };

  // Lock the shim into window.nostr. Extensions that try to overwrite
  // (Alby's content script runs at document_idle and re-checks) will
  // silently no-op in sloppy mode; either way, the iframe keeps using
  // the station signer. defineProperty with non-configurable also
  // protects against accidental shadowing from Ditto's own code in
  // case it ever tries `window.nostr = …` somewhere.
  try {
    Object.defineProperty(window, 'nostr', {
      value:        signer,
      writable:     false,
      configurable: false,
      enumerable:   true,
    });
  } catch (_) {
    // If the property already exists as non-configurable (extension got
    // here first and locked it), fall back to a plain assignment. May
    // get overwritten back, but at least the user sees something
    // working instead of a hard error.
    try { window.nostr = signer; } catch (__) {}
  }
})();
