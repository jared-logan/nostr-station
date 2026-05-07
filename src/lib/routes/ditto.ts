/**
 * Ditto theme route — fetches the station owner's published Ditto profile
 * theme (kind 16767, replaceable) from their read relays so the dashboard
 * can mirror the same accent color.
 *
 * The Ditto theme spec we read carries multiple `c` tags
 * (`["c", "<hex>", "<role>"]`) where role is `background`, `text`, or
 * `primary`, plus `bg` (cover image), `title`, `client`, `published_at`.
 *
 * Surface:
 *   GET /api/ditto/theme — returns parsed theme + raw event, or { found: false }
 *
 * The web client decides whether to apply it. We don't persist the choice
 * server-side — it's a per-browser preference that lives in localStorage
 * alongside the built-in accent picker.
 */
import http from 'http';
import { WebSocket } from 'ws';
import { readIdentity, npubToHex } from '../identity.js';
import { safeHttpUrl } from '../url-safety.js';

const DITTO_THEME_KIND = 16767;
const RELAY_TIMEOUT_MS = 5000;

// Fetch the latest kind-16767 from one relay via raw WebSocket.
// Resolves with the event (or null on timeout/error/EOSE-with-no-match).
// Mirrors the kind-0 fetcher in identity.ts — duplicated rather than
// generalized because the result shapes diverge downstream.
function fetchDittoThemeFromRelay(
  relayUrl: string, hex: string, timeoutMs: number,
): Promise<unknown | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ev: unknown | null) => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch {}
      clearTimeout(timer);
      resolve(ev);
    };
    let ws: WebSocket;
    try { ws = new WebSocket(relayUrl); }
    catch { resolve(null); return; }

    const timer = setTimeout(() => finish(null), timeoutMs);
    const subId = 'ns-ditto-' + Math.random().toString(36).slice(2, 8);

    ws.addEventListener('open', () => {
      try {
        ws.send(JSON.stringify(['REQ', subId, {
          authors: [hex], kinds: [DITTO_THEME_KIND], limit: 1,
        }]));
      } catch { finish(null); }
    });
    ws.addEventListener('message', (m: { data: unknown }) => {
      try {
        const raw = typeof m.data === 'string' ? m.data : (m.data as Buffer).toString();
        const msg = JSON.parse(raw);
        if (Array.isArray(msg)) {
          if (msg[0] === 'EVENT' && msg[1] === subId && msg[2]?.kind === DITTO_THEME_KIND) {
            finish(msg[2]);
          } else if (msg[0] === 'EOSE' && msg[1] === subId) {
            finish(null);
          }
        }
      } catch {}
    });
    ws.addEventListener('error', () => finish(null));
    ws.addEventListener('close', () => finish(null));
  });
}

interface ParsedTheme {
  title?: string;
  primary?: string;
  background?: string;
  text?: string;
  bgImage?: string;
  bgMode?: 'cover' | 'contain' | 'tile';
  publishedAt?: number;
}

// CSS hex literal — `#` followed by 3, 4, 6, or 8 hex digits.
// We accept 4 and 8 (alpha) so a Ditto theme that happens to include
// alpha doesn't get rejected; the renderer will use the same value
// inside color-mix so alpha just compounds.
const HEX_RE = /^#[0-9a-fA-F]{3,8}$/;

// `bg` tag elements are space-delimited "key value" pairs:
//   ["bg", "url https://…", "mode cover", "m image/jpeg", "dim 2560x1440"]
// Split on the first space; ignore anything we don't recognize.
function parseBgTag(tag: unknown[]): { url?: string; mode?: string } {
  const out: { url?: string; mode?: string } = {};
  for (let i = 1; i < tag.length; i++) {
    const part = tag[i];
    if (typeof part !== 'string') continue;
    const sp = part.indexOf(' ');
    if (sp < 0) continue;
    const key = part.slice(0, sp).trim().toLowerCase();
    const val = part.slice(sp + 1).trim();
    if (key === 'url')  out.url  = val;
    if (key === 'mode') out.mode = val.toLowerCase();
  }
  return out;
}

function parseDittoTheme(ev: { tags?: unknown[][] } | null): ParsedTheme | null {
  if (!ev || !Array.isArray(ev.tags)) return null;
  const out: ParsedTheme = {};
  for (const t of ev.tags) {
    if (!Array.isArray(t) || typeof t[0] !== 'string') continue;
    if (t[0] === 'c' && typeof t[1] === 'string' && typeof t[2] === 'string') {
      const value = t[1].trim();
      if (!HEX_RE.test(value)) continue;
      const role = t[2].trim().toLowerCase();
      if      (role === 'primary')    out.primary    = value;
      else if (role === 'background') out.background = value;
      else if (role === 'text')       out.text       = value;
    } else if (t[0] === 'bg') {
      const bg = parseBgTag(t);
      // Scheme-gate the URL — same defense as the kind-0 `picture` field.
      // Anything non-http(s) (data:, javascript:, file:, …) is dropped.
      const safe = safeHttpUrl(bg.url);
      if (safe) out.bgImage = safe;
      if (bg.mode === 'cover' || bg.mode === 'contain' || bg.mode === 'tile') {
        out.bgMode = bg.mode;
      }
    } else if (t[0] === 'title' && typeof t[1] === 'string') {
      out.title = t[1].slice(0, 80);
    } else if (t[0] === 'published_at' && typeof t[1] === 'string') {
      const n = parseInt(t[1], 10);
      if (Number.isFinite(n)) out.publishedAt = n;
    }
  }
  if (!out.primary && !out.background && !out.text && !out.bgImage) return null;
  return out;
}

export async function handleDitto(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  url: string,
  method: string,
): Promise<boolean> {
  if (url === '/api/ditto/theme' && method === 'GET') {
    const ident = readIdentity();
    if (!ident.npub) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ found: false, reason: 'no-npub' }));
      return true;
    }
    const hex = npubToHex(ident.npub);
    if (!hex) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ found: false, reason: 'bad-npub' }));
      return true;
    }
    const relays = (ident.readRelays || []).filter(Boolean);
    if (relays.length === 0) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ found: false, reason: 'no-relays' }));
      return true;
    }

    try {
      const results = await Promise.all(
        relays.map(r => fetchDittoThemeFromRelay(r, hex, RELAY_TIMEOUT_MS)),
      );
      const events = results.filter(Boolean) as { kind?: number; created_at?: number }[];
      const newest = events
        .filter(e => e.kind === DITTO_THEME_KIND)
        .sort((a, b) => (b.created_at || 0) - (a.created_at || 0))[0];

      if (!newest) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ found: false, reason: 'no-event' }));
        return true;
      }

      const parsed = parseDittoTheme(newest as { tags?: unknown[][] });
      if (!parsed) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ found: false, reason: 'no-colors' }));
        return true;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        found: true,
        title:      parsed.title,
        primary:    parsed.primary,
        background: parsed.background,
        text:       parsed.text,
        bgImage:    parsed.bgImage,
        bgMode:     parsed.bgMode,
        publishedAt: parsed.publishedAt,
      }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String((e as Error).message || e) }));
    }
    return true;
  }
  return false;
}
