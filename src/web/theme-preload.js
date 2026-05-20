// Apply persisted accent theme before paint to avoid a flash of purple
// when the user has picked a different color in the Config panel.
// Ditto themes carry user-published colors + an optional background
// image so they're injected via a dynamic <style> block — kept inline
// here so everything lands before first paint just like the static
// presets. Mirrors applyDittoStyleBlock() in app.js.
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
      return;
    }
    if (t !== 'ditto') return;
    var raw = localStorage.getItem('nostr-station:ditto-theme');
    if (!raw) return;
    var d = JSON.parse(raw);
    if (!d) return;
    var hexRe = /^#[0-9a-fA-F]{3,8}$/;
    var primary    = hexRe.test(d.primary || '')    ? d.primary    : '';
    var background = hexRe.test(d.background || '') ? d.background : '';
    var bgImage = '';
    try {
      if (d.bgImage) {
        var u = new URL(d.bgImage);
        if (u.protocol === 'http:' || u.protocol === 'https:') bgImage = d.bgImage;
      }
    } catch (_) {}
    var bgMode = (d.bgMode === 'contain' || d.bgMode === 'tile') ? d.bgMode : 'cover';
    if (!primary && !background && !bgImage) return;

    var rootDecls = [];
    // Neutral-grey text ramp for Ditto modes (matches Ditto's own
    // foreground/muted-foreground scheme). See applyDittoStyleBlock
    // in app.js for the rationale.
    rootDecls.push('--text-bright: #ffffff');
    rootDecls.push('--text:        #e8e8e8');
    rootDecls.push('--text-dim:    #b3b3b3');
    rootDecls.push('--muted:       #7a7a7a');
    if (primary) {
      rootDecls.push('--accent: ' + primary);
      rootDecls.push('--accent-bright: color-mix(in srgb, ' + primary + ' 65%, #ffffff)');
      rootDecls.push('--accent-dim:    color-mix(in srgb, ' + primary + ' 65%, #000000)');
      rootDecls.push('--info:          color-mix(in srgb, ' + primary + ' 70%, #ffffff)');
    }

    var css;
    if (bgImage) {
      var size   = bgMode === 'tile' ? 'auto' : bgMode;
      var repeat = bgMode === 'tile' ? 'repeat' : 'no-repeat';
      var fallback = background || '#0a0a0a';
      rootDecls.push('--bg: ' + fallback);
      rootDecls.push('--bg-elev:       rgba(0, 0, 0, 0.85)');
      rootDecls.push('--bg-card:       rgba(0, 0, 0, 0.78)');
      rootDecls.push('--bg-hover:      rgba(255, 255, 255, 0.08)');
      rootDecls.push('--border:        rgba(255, 255, 255, 0.16)');
      rootDecls.push('--border-strong: rgba(255, 255, 255, 0.28)');
      // CSP img-src 'self' data: blocks raw https:// backgrounds, so
      // route the URL through /api/img-proxy. Inlined here (small)
      // because theme-preload runs before app.js / markdown.js can
      // import proxyImageUrl. Keep in sync with markdown.js
      // proxyImageUrl.
      var proxiedBg = bgImage;
      try {
        var pu = new URL(bgImage, location.href);
        var ph = pu.hostname;
        var isLocal = pu.origin === location.origin
                   || ph === '127.0.0.1' || ph === 'localhost'
                   || ph === '::1' || /\.localhost$/.test(ph);
        if (!isLocal && pu.protocol === 'https:') {
          proxiedBg = '/api/img-proxy?u=' + encodeURIComponent(pu.toString());
        }
      } catch (_) {}
      var safeUrl = proxiedBg.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      var bodyCss = ':root[data-theme="ditto"] body {' +
        ' background-image: linear-gradient(rgba(0,0,0,0.72), rgba(0,0,0,0.72)), url("' + safeUrl + '");' +
        ' background-color: ' + fallback + ';' +
        ' background-size: 100% 100%, ' + size + ';' +
        ' background-position: center center, center center;' +
        ' background-repeat: no-repeat, ' + repeat + ';' +
        ' background-attachment: fixed, fixed;' +
        ' }';
      var headerCss = ':root[data-theme="ditto"] .header {' +
        ' background: linear-gradient(180deg, rgba(0,0,0,0.7) 0%, rgba(0,0,0,0.45) 100%);' +
        ' }';
      css = ':root[data-theme="ditto"] { ' + rootDecls.join('; ') + '; } ' + bodyCss + ' ' + headerCss;
    } else if (background) {
      rootDecls.push('--bg: ' + background);
      rootDecls.push('--bg-elev:       color-mix(in srgb, ' + background + ' 95%, #ffffff)');
      rootDecls.push('--bg-card:       color-mix(in srgb, ' + background + ' 92%, #ffffff)');
      rootDecls.push('--bg-hover:      color-mix(in srgb, ' + background + ' 88%, #ffffff)');
      rootDecls.push('--border:        color-mix(in srgb, ' + background + ' 88%, #ffffff)');
      rootDecls.push('--border-strong: color-mix(in srgb, ' + background + ' 80%, #ffffff)');
      css = ':root[data-theme="ditto"] { ' + rootDecls.join('; ') + '; }';
    } else {
      css = ':root[data-theme="ditto"] { ' + rootDecls.join('; ') + '; }';
    }
    var style = document.createElement('style');
    style.id = 'ditto-theme-style';
    style.textContent = css;
    document.head.appendChild(style);
    document.documentElement.setAttribute('data-theme', 'ditto');
  } catch (_) { /* localStorage may be blocked; default purple is fine */ }
})();
