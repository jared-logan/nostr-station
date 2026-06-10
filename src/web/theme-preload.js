// Apply persisted accent theme before paint to avoid a flash of purple
// when the user has picked a different color in the Config panel.
//
// Loaded as a synchronous <script src=…> in index.html so it's render-
// blocking the same way the prior inline <script> was. Externalizing
// is what lets the CSP drop 'unsafe-inline' from script-src.
(function () {
  try {
    var t = localStorage.getItem('nostr-station:theme');
    if (!t || t === 'purple') return;
    if (/^(green|red|blue|white)$/.test(t)) {
      document.documentElement.setAttribute('data-theme', t);
    }
    // Any other stored value (e.g. a legacy "ditto" theme from before the
    // embedded client was removed) is not a valid preset — leave the
    // default purple in place.
  } catch (_) { /* localStorage may be blocked; default purple is fine */ }
})();
