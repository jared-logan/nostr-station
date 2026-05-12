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
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': [
    "default-src 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "connect-src 'self' ws://127.0.0.1:* ws://localhost:* wss:",
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    // Loopback only — used by the chat panel's live-preview iframe to embed
    // a project's local Vite dev server (default :5173). Cross-origin frames
    // are still rejected. frame-ancestors above keeps the dashboard itself
    // un-embeddable.
    "frame-src 'self' http://127.0.0.1:* http://localhost:*",
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
