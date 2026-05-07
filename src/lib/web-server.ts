/**
 * nostr-station web dashboard server.
 *
 * Serves the control-center UI at /, and a small JSON+SSE API at /api/*:
 *   GET  /api/config         — AI provider + model + context presence
 *   POST /api/chat           — SSE streaming chat (proxies to provider)
 *   GET  /api/status         — gatherStatus() results (shared w/ `status --json`)
 *
 * Bound to 127.0.0.1 only. No auth — local user is the trust boundary.
 */

import http from 'http';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { nip19 } from 'nostr-tools';
import { getPublicKey } from 'nostr-tools/pure';
import { fileURLToPath } from 'url';
import { getKeychain } from './keychain.js';
// Most terminal helpers moved alongside their HTTP routes + the WS
// upgrade handler — see routes/terminal.ts. We still need `loadPty`
// for the warm-up at server-listen time and `destroyAllSessions` to
// clean up on `server.close`.
import {
  loadPty, destroyAllSessions as destroyAllTerminals,
} from './terminal.js';
// AI provider registry / multi-provider config / context-builder all
// moved alongside their route handler — see routes/ai.ts. The legacy
// `/api/config/set` flow below still uses the in-file PROVIDERS map
// declared further down and the keychain slot `ai-api-key`; that
// surface goes away when the Chat pane fully switches to /api/ai/chat.
import { migrateIfNeeded } from './ai-config.js';
import { gatherStatus } from '../commands/Status.js';
import { DEFAULT_DB_PATH } from '../relay/store.js';
import type { Relay } from '../relay/index.js';
import { LogBuffer, type LogLine } from './log-buffer.js';
import { getTool, installTool, TOOLS } from './tools.js';
import { Watchdog } from './watchdog.js';
import { AutoSyncManager } from './auto-sync.js';
import { installNostrVpn } from './nvpn-installer.js';
import {
  probeNvpnStatus, probeNvpnServiceStatus, startNvpnLogTail, vpnBannerRunningFor,
} from './nvpn.js';
import { installNak } from './nak-installer.js';
import { installNgit } from './ngit-installer.js';
import { hexToNpub, npubToHex } from './identity.js';
import {
  readIdentity, setSetupComplete, isNsec,
} from './identity.js';
import {
  clearAllSessions, issueChallenge, consumeChallenge, createSession,
  deleteSession, extractBearer, verifyNip98, authStatus,
  isPublicApi, requireSession, expectedDashboardUrl,
} from './auth.js';
import {
  startNostrConnect, getBunkerSession, consumeBunkerSession,
  signWithBunkerUrl, silentBunkerSign,
  startSetupAmber, getSetupAmberSession, consumeSetupAmberSession,
  signEventWithSavedBunker,
} from './auth-bunker.js';
// `getProject` + `resolveProjectContext` are still needed here for the
// chat proxy's system-prompt resolution. Everything else moved to
// `routes/projects.ts` along with the Projects + Chat-context routes.
import {
  getProject, resolveProjectContext,
  type Project,
} from './projects.js';
import { writePidFile, removePidFile } from './pid-file.js';
import {
  readBody, streamExec, streamExecError,
  CLI_BIN, CLI_SPAWN,
  getActiveChatProjectId,
  setAutoSyncRef,
  type CmdSpec,
} from './routes/_shared.js';
import { buildAiContext, readStationContext, stationContextPath } from './ai-context.js';
import { seedStationContext, USER_REGION_BEGIN, USER_REGION_END } from './editor.js';
import { handleProjects } from './routes/projects.js';
import { handleIdentity } from './routes/identity.js';
import { handleDitto } from './routes/ditto.js';
import { handleNgit } from './routes/ngit.js';
import {
  handleAi,
  streamAnthropic, streamOpenAICompat,
  type Msg, type ProviderConfig,
} from './routes/ai.js';
import { handleTerminal, mountTerminalWebSocket } from './routes/terminal.js';
import { handleNvpn } from './routes/nvpn.js';
import { handleTemplates } from './routes/templates.js';

// ── Static assets ─────────────────────────────────────────────────────────────
//
// Resolved relative to this file at runtime — whether we're running from
// dist/lib/web-server.js (copy-web.mjs put the assets at dist/web) or from
// src via tsx (falls back to src/web so `npm run dev chat` still works).

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR_CANDIDATES = [
  path.resolve(here, '..', 'web'),          // dist/web next to dist/lib
  path.resolve(here, '..', '..', 'src', 'web'), // src/web when running via tsx
];
const WEB_DIR = WEB_DIR_CANDIDATES.find(p => fs.existsSync(p)) ?? WEB_DIR_CANDIDATES[0];

// ── Vendored frontend libs (xterm.js)
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

function serveVendorXterm(req: http.IncomingMessage, res: http.ServerResponse): boolean {
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
const HTML_SECURITY_HEADERS: Record<string, string> = {
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

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): boolean {
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

// ── Provider config (legacy single-provider /api/config + /api/chat path) ────
//
// `ProviderConfig` and the streaming helpers (`streamAnthropic`,
// `streamOpenAICompat`) moved to routes/ai.ts and are re-imported above.
// Everything below this line is the legacy bootstrap-from-claude_env
// flow that still backs `/api/config` and `/api/chat` until the Chat
// pane fully switches over to `/api/ai/chat`.

function parseClaudeEnv(homeDir: string): { baseUrl: string; model: string } {
  const envPath = path.join(homeDir, '.claude_env');
  try {
    const content    = fs.readFileSync(envPath, 'utf8');
    const baseMatch  = content.match(/^export ANTHROPIC_BASE_URL="([^"]+)"/m);
    const modelMatch = content.match(/^export CLAUDE_MODEL="([^"]+)"/m);
    return { baseUrl: baseMatch?.[1] ?? '', model: modelMatch?.[1] ?? '' };
  } catch {
    return { baseUrl: '', model: '' };
  }
}

function inferProviderName(baseUrl: string): string {
  // Display-name lookup for the legacy ~/.claude_env migration path.
  // Curated providers map to their registry display name; everything
  // else lands under "Custom Provider" — same as the Custom entry in
  // ai-providers.ts.
  if (baseUrl.includes('opencode.ai')) return 'OpenCode Zen';
  if (baseUrl.includes('routstr'))     return 'Routstr';
  if (baseUrl.includes('ppq.ai'))      return 'PayPerQ';
  return 'Custom Provider';
}

// Describes what we can show in the UI without an API key (provider name,
// model, context presence). `configured` is false when an API key is still
// missing — in that case the Chat panel shows an onboarding callout instead
// of proxying requests, but Status/Relay/Logs/Config panels are unaffected.
async function loadProviderConfig(): Promise<{ cfg: ProviderConfig | null; meta: { provider: string; model: string; baseUrl: string | null; configured: boolean; reason?: string } }> {
  const homeDir = os.homedir();
  const { baseUrl, model } = parseClaudeEnv(homeDir);
  const isAnthropic = !baseUrl;
  const providerName = isAnthropic ? 'Anthropic' : inferProviderName(baseUrl);
  const resolvedModel = model || (isAnthropic ? 'claude-opus-4-6' : 'default');
  const meta = { provider: providerName, model: resolvedModel, baseUrl: baseUrl || null, configured: false as boolean, reason: undefined as string | undefined };

  let apiKey = '';
  try {
    if (isAnthropic) {
      apiKey = process.env.ANTHROPIC_API_KEY
        || (await getKeychain().retrieve('ai-api-key'))
        || '';
    } else {
      apiKey = (await getKeychain().retrieve('ai-api-key')) ?? '';
    }
  } catch {}

  // Anthropic demands a real key; OpenAI-compat Custom Providers
  // pointing at local daemons (Ollama / LM Studio / etc.) may use a
  // sentinel — the values below skip the "configured?" check so an
  // empty key there still passes.
  const bareKeys = new Set(['none', 'ollama', 'lm-studio', 'maple-desktop-auto']);
  const isBare = bareKeys.has(apiKey);
  if (isAnthropic && !apiKey) {
    meta.reason = 'Anthropic API key not set — run: nostr-station keychain set ai-api-key';
    return { cfg: null, meta };
  }

  meta.configured = true;
  return {
    cfg: {
      isAnthropic,
      baseUrl,
      model: resolvedModel,
      apiKey: isBare ? '' : apiKey,
      providerName,
    },
    meta,
  };
}

function getContextContent(homeDir: string): string {
  const contextPath = path.join(homeDir, 'nostr-station', 'projects', 'NOSTR_STATION.md');
  try { return fs.readFileSync(contextPath, 'utf8'); }
  catch { return 'You are a helpful assistant for Nostr protocol development.'; }
}

// Whether the legacy on-disk seed file is present. The Chat CLI uses this
// to print a one-time hint; the dashboard panel reports the richer status
// from getContextStatus() below since the new /api/ai/chat path uses
// buildAiContext()'s in-memory station fallback regardless of this file.
export function contextExists(): boolean {
  return fs.existsSync(path.join(os.homedir(), 'nostr-station', 'projects', 'NOSTR_STATION.md'));
}

export interface ContextStatus {
  // True whenever a context block will be injected into /api/ai/chat. With
  // the station fallback in ai-context.ts this is effectively always true,
  // but we still compute it from buildAiContext() so any future change to
  // the resolver (e.g. an explicit "no context" mode) flows through.
  hasContext:   boolean;
  source:       'project' | 'station';
  projectName?: string;
  // Diagnostic: legacy seed file at ~/nostr-station/projects/NOSTR_STATION.md.
  // The panel uses this to distinguish "file-backed" from "built-in" station
  // context in its label.
  hasContextFile: boolean;
}

// `scope` chooses which context the caller wants to see:
//   'active' (default) — match what the next /api/ai/chat turn will use,
//                        i.e. the project opened in chat or station fallback.
//   'global'           — always describe the station-level context, ignoring
//                        whichever project is currently active in chat.
// The Config panel passes 'global' so its row reflects the station setup
// regardless of chat state; the chat header keeps the default so it labels
// the live chat context.
export function getContextStatus(scope: 'active' | 'global' = 'active'): ContextStatus {
  const projectId = scope === 'global' ? null : getActiveChatProjectId();
  const ctx = buildAiContext(projectId);
  return {
    hasContext:     ctx.text.length > 0,
    source:         ctx.source,
    projectName:    ctx.projectName,
    hasContextFile: contextExists(),
  };
}

// ── Chat proxy (streaming SSE) ────────────────────────────────────────────────
//
// `readBody`, `streamExec`, `streamExecError`, `CmdSpec`, `CLI_BIN`,
// `CLI_SPAWN`, and the active-chat-project-id state moved to
// `routes/_shared.ts`. The streaming helpers (`streamAnthropic`,
// `streamOpenAICompat`, `completionsUrl`, `Msg`, `ProviderConfig`) and
// the `/api/ai/*` route surface moved to `routes/ai.ts` — imported
// above for re-use by the legacy `/api/chat` proxy below.

async function proxyChat(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  cfg: ProviderConfig,
): Promise<void> {
  let messages: Msg[];
  try {
    const body = await readBody(req);
    ({ messages } = JSON.parse(body));
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid request body' }));
    return;
  }

  const activeProjectId = getActiveChatProjectId();
  const activeProject = activeProjectId ? getProject(activeProjectId) : null;
  const system = activeProjectId
    ? resolveProjectContext(activeProject).content
    : getContextContent(os.homedir());
  res.writeHead(200, {
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
  });

  try {
    if (cfg.isAnthropic) await streamAnthropic(messages, system, cfg, res);
    else                 await streamOpenAICompat(messages, system, cfg, res);
  } catch (e: any) {
    res.write(`data: ${JSON.stringify({ error: String(e.message ?? e) })}\n\n`);
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

// ── Relay-adjacent helpers ────────────────────────────────────────────────────

// Derive the npub for a keychain-stored nsec, best-effort. Used by
// /api/relay-config to label whitelist entries by role (the station
// owner's own npub comes straight from identity.json; watchdog and seed
// are recoverable only by reading + decoding the keychain entry). Returns
// null on any failure — the consumer treats null as "role not configured
// on this station", not "keychain backend broken".
async function deriveKeychainNpub(slot: 'watchdog-nsec' | 'seed-nsec'): Promise<string | null> {
  try {
    const nsec = await getKeychain().retrieve(slot);
    if (!nsec) return null;
    const decoded = nip19.decode(nsec);
    if (decoded.type !== 'nsec') return null;
    const pubHex = getPublicKey(decoded.data as Uint8Array);
    return nip19.npubEncode(pubHex);
  } catch { return null; }
}

// Format a LogLine for the Logs panel SSE wire. Pre-deletion the panel
// consumed plain `tail -f` strings, so the client just appends as text;
// we prefix with [LEVEL] iso-time to keep the warn/err classification
// (app.js:4727 'classify') working.
function formatLogLine(line: LogLine): string {
  const iso = new Date(line.ts).toISOString();
  const prefix = line.level === 'error' ? '[ERROR]'
              : line.level === 'warn'  ? '[WARN]'
              : '[INFO]';
  return `${iso} ${prefix} ${line.text}`;
}

// ── Server ────────────────────────────────────────────────────────────────────

// In-process Nostr relay handle. Started by maybeStartInprocRelay() unless
// the user explicitly opts out with STATION_INPROC_RELAY=0. Kept here so
// the dashboard's shutdown path can stop it cleanly + the Relay panel's
// control endpoints can mutate its state. `import type` keeps the relay
// module out of runtime load until maybeStartInprocRelay's dynamic import
// actually fires (preserving the STATION_INPROC_RELAY=0 fast path).
let inprocRelay: Relay | null = null;

// Per-channel log ring buffers for the Logs panel. The relay buffer is
// fed by Relay.onLog hooks (see maybeStartInprocRelay below). The
// watchdog buffer is fed by the in-Node Watchdog (Phase 2.1). The vpn
// buffer stays unfed for now; /api/logs/vpn returns a "pending" frame
// until Phase 2.2 lands the installer.
const logBuffers = {
  relay:    new LogBuffer(),
  watchdog: new LogBuffer(),
  vpn:      new LogBuffer(),
} as const;

// In-Node watchdog — heartbeats every 5 min through the local relay.
// Started after maybeStartInprocRelay (it depends on the Relay handle
// for whitelist registration + publishLocal). STATION_DISABLE_WATCHDOG=1
// opts out for tests / minimal deployments.
let watchdog: Watchdog | null = null;

// Auto-sync scheduler. Module-level singleton so the PATCH /api/projects/:id
// route handler can reach in and reconcile a single project after the
// user toggles the persisted autoSync flag — letting the change take
// effect inside the request/response cycle rather than waiting for the
// next interval tick. Lazy-init below so tests that don't boot the
// server never spin up the timer set.
let autoSync: AutoSyncManager | null = null;
export function getAutoSyncManager(): AutoSyncManager | null {
  return autoSync;
}

// nvpn daemon log tailer. Started best-effort once at server boot; pumps
// the daemon's own log file into logBuffers.vpn so /api/logs/vpn streams
// real lines instead of the static "tail it manually" hint that used to
// land in the Logs panel. Cleaned up on server.close so the polling
// timer doesn't keep the event loop alive across hot-restarts.
let nvpnLogTailer: { stop: () => void } | null = null;

function shouldStartInprocRelay(): boolean {
  return process.env.STATION_INPROC_RELAY !== '0';
}

// Live verification (Phase 4 of the user-journey spec). Asks the saved
// bunker client (Amber on the user's phone) to sign a kind-1 test event,
// publishes it to the running in-process relay over ws://, and reads it
// back via a REQ subscription. Each step is named so the client can
// render a checklist; failures stop at the first broken step.
//
// Why ws:// instead of calling the relay's store directly: the test is
// trying to prove "your apps will be able to talk to this relay." Going
// through the WebSocket layer exercises the same path the user's apps
// will use (NIP-01 over WS), which is what we want to verify.

interface VerifyStep { name: string; ok: boolean; detail?: string }
interface VerifyResult {
  ok:      boolean;
  steps:   VerifyStep[];
  eventId?: string;
  npub?:    string;
  error?:   string;
}

async function runSetupVerify(): Promise<VerifyResult> {
  const steps: VerifyStep[] = [];
  const ident = readIdentity();
  // Step 1 — sign via Amber. Generic event template; signEventWithSavedBunker
  // returns a fully-signed event whose pubkey is the user's main pubkey.
  const template = {
    kind:       1,
    created_at: Math.floor(Date.now() / 1000),
    tags:       [['client', 'nostr-station-setup-verify']],
    content:    'nostr-station: setup verification — you can ignore this event.',
  };
  let signed: any;
  try {
    const r = await signEventWithSavedBunker(template, 60_000);
    if (!r.ok || !r.signedEvent) {
      steps.push({ name: 'sign-via-amber', ok: false, detail: r.error || 'signing failed' });
      return { ok: false, steps, error: 'Amber did not sign the test event' };
    }
    signed = r.signedEvent;
    steps.push({ name: 'sign-via-amber', ok: true, detail: `signed by ${signed.pubkey.slice(0, 8)}…` });
  } catch (e: any) {
    steps.push({ name: 'sign-via-amber', ok: false, detail: String(e?.message ?? e) });
    return { ok: false, steps, error: 'sign step failed' };
  }

  // Resolve relay URL — same env vars maybeStartInprocRelay sets.
  const relayHost = process.env.RELAY_HOST || '127.0.0.1';
  const relayPort = process.env.RELAY_PORT || '7777';
  const relayUrl  = `ws://${relayHost}:${relayPort}`;

  // Steps 2 + 3 — publish + read back, both over a single WS connection.
  // Lazy-import ws so we don't pay the cost on cold-path requests.
  const { WebSocket } = await import('ws');
  const ws = new WebSocket(relayUrl);

  // Generic JSON-frame waiter so each step can wait for the message it
  // cares about without racing on the buffer's order.
  const waiters: Array<{ pred: (m: any[]) => boolean; resolve: (m: any[]) => void; reject: (e: Error) => void; timer?: NodeJS.Timeout }> = [];
  const buffer: any[][] = [];
  ws.on('message', d => {
    try {
      const msg = JSON.parse(d.toString());
      if (!Array.isArray(msg)) return;
      const idx = waiters.findIndex(w => w.pred(msg));
      if (idx >= 0) {
        const [w] = waiters.splice(idx, 1);
        if (w.timer) clearTimeout(w.timer);
        w.resolve(msg);
      } else {
        buffer.push(msg);
      }
    } catch { /* not JSON / not array — ignore */ }
  });
  const next = (pred: (m: any[]) => boolean, ms = 5_000): Promise<any[]> => {
    const idx = buffer.findIndex(pred);
    if (idx >= 0) return Promise.resolve(buffer.splice(idx, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = waiters.findIndex(w => w.pred === pred);
        if (i >= 0) waiters.splice(i, 1);
        reject(new Error(`timeout after ${ms}ms`));
      }, ms);
      waiters.push({ pred, resolve, reject, timer });
    });
  };

  try {
    await new Promise<void>((resolve, reject) => {
      ws.once('open',  () => resolve());
      ws.once('error', reject);
    });

    // Step 2 — publish.
    ws.send(JSON.stringify(['EVENT', signed]));
    const ok = await next(m => m[0] === 'OK' && m[1] === signed.id, 10_000);
    if (ok[2] !== true) {
      steps.push({ name: 'publish-to-relay', ok: false, detail: ok[3] || 'relay rejected event' });
      ws.close();
      return { ok: false, steps, error: 'relay rejected the test event' };
    }
    steps.push({ name: 'publish-to-relay', ok: true, detail: `accepted by ${relayUrl}` });

    // Step 3 — read back via REQ. The store is local and the round-trip
    // takes single-digit ms, so a 5s timeout is generous slack.
    const subId = 'setup-verify';
    ws.send(JSON.stringify(['REQ', subId, { ids: [signed.id] }]));
    await next(m => m[0] === 'EVENT' && m[1] === subId && m[2]?.id === signed.id, 5_000);
    await next(m => m[0] === 'EOSE'  && m[1] === subId, 5_000);
    ws.send(JSON.stringify(['CLOSE', subId]));
    steps.push({ name: 'read-back-from-relay', ok: true, detail: 'event found in store' });
  } catch (e: any) {
    steps.push({ name: 'read-back-from-relay', ok: false, detail: String(e?.message ?? e) });
    try { ws.close(); } catch {}
    return { ok: false, steps, error: 'relay round-trip failed' };
  }
  try { ws.close(); } catch {}

  return { ok: true, steps, eventId: signed.id, npub: ident.npub };
}

async function maybeStartInprocRelay(): Promise<void> {
  if (!shouldStartInprocRelay()) return;
  if (inprocRelay) return;
  // Lazy import — nothing in the rest of web-server.ts references the
  // relay module, so we keep it out of the load graph entirely when the
  // relay isn't started.
  const { Relay } = await import('../relay/index.js');
  const port = Number(process.env.STATION_INPROC_RELAY_PORT || '7777');
  // Owner-pubkey resolver for the relay's write-gating. Re-reads
  // identity.json on every EVENT publish so the user can rotate their
  // npub (e.g. via `/api/identity/set`) without restarting the relay.
  // Returns null when no owner is configured yet (fresh install / mid-
  // wizard) — the relay then accepts only whitelisted publishers, which
  // is the correct lock-down state.
  const r = new Relay({
    port, host: '127.0.0.1',
    getOwnerHex: () => {
      try {
        const ident = readIdentity();
        return ident.npub ? npubToHex(ident.npub).toLowerCase() : null;
      } catch { return null; }
    },
    // Pipe relay-emitted log lines into the channel buffer that backs
    // /api/logs/relay (1.8). Connection open/close, EVENT accept/reject/
    // duplicate, REQ subscriptions, and AUTH outcomes all land here.
    onLog: (level, text) => logBuffers.relay.push(level, text),
  });
  await r.start();
  inprocRelay = r;
  // Publish the relay address via env so gatherStatus probes the right
  // port, and any descendant tooling (e.g. nak commands) sees the same
  // source of truth.
  process.env.RELAY_HOST = '127.0.0.1';
  process.env.RELAY_PORT = String(port);
  process.stderr.write(`[relay] in-process relay listening on ws://127.0.0.1:${port}\n`);
  logBuffers.relay.info(`relay listening on ws://127.0.0.1:${port}`);
  await maybeStartWatchdog();
  if (process.env.STATION_DISABLE_AUTO_SYNC !== '1') {
    autoSync = new AutoSyncManager();
    autoSync.start();
    // Bridge the singleton through routes/_shared.ts so the project
    // PATCH route can call reconcile(id) without a cyclic import.
    setAutoSyncRef(autoSync);
  }
}

async function maybeStartWatchdog(): Promise<void> {
  if (process.env.STATION_DISABLE_WATCHDOG === '1') return;
  if (watchdog || !inprocRelay) return;
  const wd = new Watchdog({
    relay: inprocRelay,
    onLog: (level, text) => logBuffers.watchdog.push(level, text),
  });
  try {
    await wd.start();
    watchdog = wd;
  } catch (e: any) {
    logBuffers.watchdog.error(`watchdog start failed: ${e?.message || e}`);
  }
}

export async function startWebServer(port: number): Promise<void> {
  // Sessions are in-memory only and never survive a server restart — the
  // user re-authenticates after a nostr-station chat restart. Explicit here
  // for clarity in case the module is imported multiple times.
  clearAllSessions();

  // Deferred warm-up tasks. Everything here used to run BEFORE
  // `server.listen()` with `await` — a fresh Linux box with no seeded
  // GNOME keyring would hang on `secret-tool lookup` inside
  // loadProviderConfig (waits for an unlock prompt that never comes),
  // leaving the server unbound and `curl localhost:3000` refused.
  //
  // Run these AFTER the socket is bound so the dashboard starts no matter
  // what the keychain / node-pty / ai-config state is. Per-request handlers
  // already re-load loadProviderConfig(), so missing the warm-up costs at
  // most one cold-path lookup on the first chat request.
  const warmUp = () => {
    loadProviderConfig().catch(() => {});
    loadPty().catch(() => {});
    // Idempotent: writes the slim Nori-persona seed when missing,
    // leaves any existing file (and its user-region edits) alone.
    try { seedStationContext(); }
    catch (e: any) { process.stderr.write(`[context] seed skipped: ${e?.message || e}\n`); }
    migrateIfNeeded()
      .then(r => {
        if (r.migrated) {
          const bits: string[] = [];
          if (r.from) bits.push(`chat ← ${r.from.provider}`);
          if (r.terminalEnabled?.length) bits.push(`terminal ← ${r.terminalEnabled.join(',')}`);
          process.stderr.write(`[ai-config] migrated (${bits.join('; ') || 'empty'})\n`);
        }
      })
      .catch(e => process.stderr.write(`[ai-config] migration failed: ${e?.message || e}\n`));
  };

  // Loopback host:port variants we accept for Host / Origin / Referer.
  // Anything else in these headers is either a misconfigured proxy or an
  // active attack (DNS rebinding, cross-origin page trying to talk to us).
  const allowedHosts = new Set([
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    `[::1]:${port}`,
  ]);
  const isLoopbackUrl = (u: string | undefined | null): boolean => {
    if (!u) return false;
    try {
      const parsed = new URL(u);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'ws:') return false;
      if (parsed.port !== String(port)) return false;
      const h = parsed.hostname;
      return h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === '::1';
    } catch { return false; }
  };

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const url    = (req.url || '/').split('?')[0];
      const method = req.method || 'GET';

      // ── H1: Reject non-loopback Host headers ──────────────────────────
      // Without this check, a DNS-rebinding attacker (evil.com resolving to
      // 127.0.0.1:<port>) can reach the dispatcher and have NIP-98 events
      // signed against a forged `u` tag. Since the dashboard only ever
      // listens on loopback, any other Host value is either a
      // misconfiguration or an attack — either way, refuse.
      const hostHeader = String(req.headers['host'] || '').toLowerCase();
      if (!allowedHosts.has(hostHeader)) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('bad host');
        return;
      }

      // ── H2: CSRF — require loopback Origin/Referer on mutations ───────
      // `localhostExempt` (auth.ts) deliberately drops session checks for
      // localhost during the wizard and when the user sets requireAuth:false.
      // That window is exploitable from any tab open in the same browser
      // unless we also verify the request actually came from our own origin.
      // Applies to all state-changing methods; missing both headers is
      // treated as hostile (browsers always send at least Referer on a
      // form/fetch POST to a different origin; CLI clients can opt in by
      // passing -H "Origin: http://127.0.0.1:<port>").
      const isMutation = method === 'POST' || method === 'PATCH' || method === 'DELETE'
                       || method === 'PUT';
      if (isMutation) {
        const origin  = typeof req.headers.origin  === 'string' ? req.headers.origin  : '';
        const referer = typeof req.headers.referer === 'string' ? req.headers.referer : '';
        const ok = isLoopbackUrl(origin) || isLoopbackUrl(referer);
        if (!ok) {
          res.writeHead(403, { 'Content-Type': 'text/plain' });
          res.end('bad origin');
          return;
        }
      }

      // Token-fallback paths (EventSource, WebSocket upgrade handshake,
      // `<a download>`) carry the session token in the query string because
      // browsers can't set Authorization on those APIs. That's safe on
      // loopback, but only IF the request also originates from our origin —
      // otherwise a cross-origin EventSource to /api/logs?token=… would
      // happily stream subprocess output into an attacker page.
      if (method === 'GET' && /[?&]token=[a-f0-9]{64}(?:&|$)/.test(req.url || '')) {
        const origin  = typeof req.headers.origin  === 'string' ? req.headers.origin  : '';
        const referer = typeof req.headers.referer === 'string' ? req.headers.referer : '';
        const ok = isLoopbackUrl(origin) || isLoopbackUrl(referer);
        if (!ok) {
          res.writeHead(403, { 'Content-Type': 'text/plain' });
          res.end('bad origin');
          return;
        }
      }

      // ── Auth endpoints (public) ──────────────────────────────────────
      if (url === '/api/auth/status' && method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(authStatus(req)));
        return;
      }

      if (url === '/api/auth/challenge' && method === 'POST') {
        const c = issueChallenge();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(c));
        return;
      }

      if (url === '/api/auth/verify' && method === 'POST') {
        let parsed: any = {};
        try { parsed = JSON.parse(await readBody(req)); }
        catch { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'bad json' })); return; }
        const challenge = String(parsed.challenge || '');
        const event     = parsed.event;

        if (!consumeChallenge(challenge)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'challenge unknown or expired' }));
          return;
        }
        const r = verifyNip98({
          challenge, event,
          expectedUrl: expectedDashboardUrl(req, port),
        });
        if (!r.ok) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: r.error || 'verification failed' }));
          return;
        }
        const ua = String(req.headers['user-agent'] || '').slice(0, 200);
        const sess = createSession(r.npub!, ua);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          token: sess.token, expiresAt: sess.expiresAt, npub: sess.npub,
        }));
        return;
      }

      if (url === '/api/auth/bunker-connect' && method === 'POST') {
        // Tries silent re-auth first (saved bunker client from a previous
        // sign-in). If that succeeds, Amber gives the user a push-and-tap
        // approval flow and we return a session token directly — no QR,
        // no "delete old bunker" shuffle. If there's no saved client, or
        // the saved one is dead (user revoked, bunker offline, relays
        // changed), we fall through to the QR flow. silentBunkerSign()
        // clears stale saved state on its own, so a one-time failure
        // doesn't get stuck retrying.
        const { challenge } = issueChallenge();

        const silent = await silentBunkerSign(challenge, expectedDashboardUrl(req, port));
        if (silent.ok && silent.signedEvent) {
          const verify = verifyNip98({
            challenge, event: silent.signedEvent,
            expectedUrl: expectedDashboardUrl(req, port),
          });
          if (verify.ok) {
            const ua = String(req.headers['user-agent'] || '').slice(0, 200);
            const sess = createSession(verify.npub!, ua);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              mode: 'silent-ok',
              token: sess.token, expiresAt: sess.expiresAt, npub: sess.npub,
            }));
            return;
          }
          // Signed event failed verification — fall through to QR. This
          // is a near-impossible path (the bunker returned a validly
          // shaped event that still doesn't match our challenge / url),
          // but we'd rather give the user a working QR than a 401 dead end.
        }

        const start = await startNostrConnect(challenge, expectedDashboardUrl(req, port));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ mode: 'qr', ...start, challenge }));
        return;
      }

      const bunkerPollMatch = url.match(/^\/api\/auth\/bunker-session\/([0-9a-f]{64})$/);
      if (bunkerPollMatch && method === 'GET') {
        const eph = bunkerPollMatch[1];
        const s   = getBunkerSession(eph);
        if (!s) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'error', error: 'unknown session' }));
          return;
        }
        if (s.status === 'waiting') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'waiting', expiresAt: s.expiresAt }));
          return;
        }
        if (s.status !== 'ok' || !s.signedEvent || !s.challenge) {
          consumeBunkerSession(eph);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: s.status, error: s.error }));
          return;
        }
        // Success path — validate the signed event, then issue a session.
        const verify = verifyNip98({
          challenge:   s.challenge,
          event:       s.signedEvent,
          expectedUrl: expectedDashboardUrl(req, port),
        });
        consumeBunkerSession(eph);
        if (!verify.ok) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'error', error: verify.error || 'verification failed' }));
          return;
        }
        const ua = String(req.headers['user-agent'] || '').slice(0, 200);
        const sess = createSession(verify.npub!, ua);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'ok',
          token: sess.token, expiresAt: sess.expiresAt, npub: sess.npub,
        }));
        return;
      }

      if (url === '/api/auth/bunker-url' && method === 'POST') {
        let parsed: any = {};
        try { parsed = JSON.parse(await readBody(req)); }
        catch { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'bad json' })); return; }
        const bunkerUrl = String(parsed.bunkerUrl || '').trim();
        if (!/^bunker:\/\//i.test(bunkerUrl)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'bunker URL must start with bunker://' }));
          return;
        }
        const { challenge } = issueChallenge();
        const bunkerRes = await signWithBunkerUrl(bunkerUrl, challenge, expectedDashboardUrl(req, port));
        if (!bunkerRes.ok) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: bunkerRes.error || 'bunker sign failed' }));
          return;
        }
        const verify = verifyNip98({
          challenge, event: bunkerRes.signedEvent,
          expectedUrl: expectedDashboardUrl(req, port),
        });
        if (!verify.ok) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: verify.error || 'verification failed' }));
          return;
        }
        const ua = String(req.headers['user-agent'] || '').slice(0, 200);
        const sess = createSession(verify.npub!, ua);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          token: sess.token, expiresAt: sess.expiresAt, npub: sess.npub,
        }));
        return;
      }

      if (url === '/api/auth/logout' && method === 'POST') {
        const token = extractBearer(req);
        if (token) deleteSession(token);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (url === '/api/auth/session' && method === 'GET') {
        const sess = requireSession(req, res);
        if (!sess) return;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          npub: sess.npub, createdAt: sess.createdAt, expiresAt: sess.expiresAt,
        }));
        return;
      }

      // ── Gate everything else under /api/* ────────────────────────────
      // Public paths (auth endpoints above) are already handled via early
      // returns. Any other /api/* path requires a valid session token, or
      // the identity.json requireAuth:false localhost exemption.
      //
      // Bootstrap exemption: /api/identity/set is accepted without auth
      // only when no station owner is configured yet. This lets the auth
      // screen set up an npub before anyone can sign in. Once an owner
      // exists, all identity writes require a valid session.
      if (url.startsWith('/api/') && !isPublicApi(url)) {
        const bootstrap = url === '/api/identity/set'
          && method === 'POST'
          && !readIdentity().npub;
        if (!bootstrap && !requireSession(req, res)) return;
      }

      // API routes first — they take precedence over static.
      if (url === '/api/config' && method === 'GET') {
        const { meta } = await loadProviderConfig();
        const scope = /[?&]scope=global(?:&|$)/.test(req.url || '') ? 'global' : 'active';
        const ctx = getContextStatus(scope);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          provider:       meta.provider,
          model:          meta.model,
          baseUrl:        meta.baseUrl,
          configured:     meta.configured,
          reason:         meta.reason,
          hasContext:     ctx.hasContext,
          contextSource:  ctx.source,
          contextProject: ctx.projectName ?? null,
          hasContextFile: ctx.hasContextFile,
        }));
        return;
      }

      // ── Station context (user-editable always-on overlay) ──────────────
      // The Config panel reads this to render the editor textarea, and
      // writes back when the user saves. Content is the full file body
      // including the persona/seed text — `readStationContext()` (used
      // by the chat path) splices only the user-region into prompts.
      if (url === '/api/station-context' && method === 'GET') {
        const filePath = stationContextPath();
        let raw = '';
        let exists = false;
        try {
          raw = fs.readFileSync(filePath, 'utf8');
          exists = true;
        } catch { /* file may not be seeded yet; return empty */ }
        const hasMarkers = raw.includes(USER_REGION_BEGIN) && raw.includes(USER_REGION_END);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          path:           filePath,
          content:        raw,
          exists,
          hasMarkers,
          userRegionBegin: USER_REGION_BEGIN,
          userRegionEnd:   USER_REGION_END,
          // Effective overlay actually injected into prompts. null when
          // there are no user notes — the Config UI uses this to label
          // "no notes yet" vs "X bytes spliced in".
          effectiveOverlay: readStationContext(),
        }));
        return;
      }

      if (url === '/api/station-context' && method === 'PUT') {
        let parsed: any = {};
        try { parsed = JSON.parse(await readBody(req)); }
        catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'bad json' }));
          return;
        }
        const content = typeof parsed.content === 'string' ? parsed.content : null;
        if (content === null) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'content (string) required' }));
          return;
        }
        // 256 KB cap matches the read_file tool — large enough for any
        // realistic note set, small enough to refuse runaway pastes.
        if (content.length > 256 * 1024) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'content too large (>256KB)' }));
          return;
        }
        const filePath = stationContextPath();
        try {
          fs.mkdirSync(path.dirname(filePath), { recursive: true });
          fs.writeFileSync(filePath, content, { mode: 0o644 });
        } catch (e: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e?.message || 'write failed' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, path: filePath, bytes: Buffer.byteLength(content) }));
        return;
      }

      if (url === '/api/chat' && method === 'POST') {
        const { cfg, meta } = await loadProviderConfig();
        if (!cfg) {
          res.writeHead(200, {
            'Content-Type':  'text/event-stream',
            'Cache-Control': 'no-cache',
          });
          res.write(`data: ${JSON.stringify({ error: meta.reason || 'AI provider not configured' })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        await proxyChat(req, res, cfg);
        return;
      }

      if (url === '/api/status' && method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(gatherStatus()));
        return;
      }

      // ── Relay config (read-only stub) ─────────────────────────────────
      // The Config panel does a Promise.all over seven endpoints at boot
      // (app.js:4910). One 404 collapses the entire panel to "failed to
      // load", so this stub exists to unblock Config UI rendering even
      // before the real settings store / NIP-42 / whitelist enforcement
      // land. Fields:
      //   name/url/dataDir/configPath — describe the in-process relay
      //   auth/dmAuth — placeholder false; real toggles wire up in 1.7
      //   whitelist — empty array; populated by 1.6 once the store exists
      //   knownRoles — owner npub from identity.json, plus best-effort
      //     watchdog/seed npubs derived from keychain nsec slots so the
      //     whitelist editor can label entries by role.
      // ── Relay whitelist add/remove ────────────────────────────────────
      // Mutates the in-process relay's whitelist, persisted next to
      // relay.db. The Relay panel posts npub strings (app.js:1980, 2003);
      // we decode to hex for storage so the relay's handleEvent gating
      // path (1.6c) compares apples to apples — sigs verify against hex
      // pubkeys, not bech32. `already`/`absent` short-circuit responses
      // mirror the original endpoint shape so the panel's toast copy
      // ("npub already on whitelist") still works.
      if (url === '/api/relay/whitelist/add' && method === 'POST') {
        if (!inprocRelay) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'relay is not running' }));
          return;
        }
        let body: { npub?: string };
        try { body = JSON.parse(await readBody(req)); }
        catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'invalid JSON body' }));
          return;
        }
        const input = String(body?.npub || '').trim();
        let hex: string;
        try {
          hex = input.startsWith('npub') ? npubToHex(input) : input;
          if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error('not a valid pubkey');
        } catch (e: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: String(e?.message || 'invalid pubkey') }));
          return;
        }
        const added = inprocRelay.whitelist.add(hex);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, hex, already: !added }));
        return;
      }

      if (url === '/api/relay/whitelist/remove' && method === 'POST') {
        if (!inprocRelay) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'relay is not running' }));
          return;
        }
        let body: { npub?: string };
        try { body = JSON.parse(await readBody(req)); }
        catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'invalid JSON body' }));
          return;
        }
        const input = String(body?.npub || '').trim();
        let hex: string;
        try {
          hex = input.startsWith('npub') ? npubToHex(input) : input;
          if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error('not a valid pubkey');
        } catch (e: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: String(e?.message || 'invalid pubkey') }));
          return;
        }
        const removed = inprocRelay.whitelist.remove(hex);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, hex, absent: !removed }));
        return;
      }

      // ── Relay lifecycle ───────────────────────────────────────────────
      // start/stop/restart the in-process relay from the Relay panel
      // (app.js:1925). Pre-architectural-simplification this drove
      // launchctl/systemctl on a separate nostr-rs-relay daemon; now it
      // operates on the in-process Relay handle directly. STATION_INPROC_RELAY=0
      // is an opt-out: maybeStartInprocRelay no-ops in that case, so a
      // user who explicitly disabled the embedded relay sees a successful
      // {up:false} response rather than a confusing error.
      const relayActionMatch = url.match(/^\/api\/relay\/(start|stop|restart)$/);
      if (relayActionMatch && method === 'POST') {
        const action = relayActionMatch[1];
        try {
          if (action === 'stop' || action === 'restart') {
            if (inprocRelay) {
              await inprocRelay.stop();
              inprocRelay = null;
            }
          }
          if (action === 'start' || action === 'restart') {
            await maybeStartInprocRelay();
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, action, up: inprocRelay !== null }));
        } catch (e: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, action, error: String(e?.message || e) }));
        }
        return;
      }

      // ── Relay sqlite DB export ────────────────────────────────────────
      // Dumps every event in the store as one JSON object per line into
      // ~/nostr-exports/relay-events-<stamp>.jsonl. Drives Relay panel's
      // export button (app.js:2069). Streams via EventStore.iterAll() so
      // a large store doesn't blow up memory; sync write loop is fine
      // here because better-sqlite3 is sync anyway and the route blocks
      // until done. Pre-deletion this shelled to `nak req`; the new path
      // hits the store directly and removes the nak-on-PATH dependency.
      if (url === '/api/relay/database/export' && method === 'POST') {
        if (!inprocRelay) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'relay is not running' }));
          return;
        }
        try {
          const exportDir = path.join(os.homedir(), 'nostr-exports');
          fs.mkdirSync(exportDir, { recursive: true });
          const stamp = new Date().toISOString().replace(/[:.]/g, '-');
          const filePath = path.join(exportDir, `relay-events-${stamp}.jsonl`);
          const fd = fs.openSync(filePath, 'w');
          let count = 0;
          try {
            for (const ev of inprocRelay.store.iterAll()) {
              fs.writeSync(fd, JSON.stringify(ev) + '\n');
              count++;
            }
          } finally {
            fs.closeSync(fd);
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, file: filePath, count }));
        } catch (e: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
        }
        return;
      }

      // ── Relay sqlite DB wipe ──────────────────────────────────────────
      // Empties the relay's event store. Triggered by Relay panel's
      // danger-zone wipe button (app.js:2038). No service restart needed:
      // EventStore lives inside the dashboard process, the relay just
      // keeps serving once the table is empty. VACUUM (in EventStore.wipe)
      // shrinks the on-disk file so /api/relay/database/stats reports the
      // expected zero immediately.
      if (url === '/api/relay/database/wipe' && method === 'POST') {
        if (!inprocRelay) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'relay is not running' }));
          return;
        }
        try {
          inprocRelay.store.wipe();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
        }
        return;
      }

      // ── Relay sqlite DB stats ─────────────────────────────────────────
      // Used by the Relay panel's database section (app.js:1908). Sums the
      // sqlite main file plus its WAL/SHM sidecars so a relay under active
      // write load reports honestly. `exists:false` lets the UI show
      // "empty" instead of "0 B" when nothing's been stored yet.
      if (url === '/api/relay/database/stats' && method === 'GET') {
        const dbPath = DEFAULT_DB_PATH;
        let sizeBytes = 0;
        let exists = false;
        for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
          try {
            const st = fs.statSync(p);
            sizeBytes += st.size;
            if (p === dbPath) exists = true;
          } catch { /* missing sidecar — fine */ }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ sizeBytes, exists, path: dbPath }));
        return;
      }

      if (url === '/api/relay-config' && method === 'GET') {
        const ident = readIdentity();
        const host = process.env.RELAY_HOST || '127.0.0.1';
        const port = process.env.RELAY_PORT || '7777';
        const [watchdogNpub, seedNpub] = await Promise.all([
          deriveKeychainNpub('watchdog-nsec'),
          deriveKeychainNpub('seed-nsec'),
        ]);
        // Whitelist is presented as npubs because that's what the Relay
        // panel renders. Storage is hex (matches sig verification); we
        // bech32-encode on the way out only.
        const whitelist = inprocRelay
          ? inprocRelay.whitelist.list().map(hex => hexToNpub(hex))
          : [];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          name:       'nostr-station',
          url:        `ws://${host}:${port}`,
          // Write gating is always on in this build: only the station
          // owner and whitelisted pubkeys can publish. The Config panel's
          // auth/dmAuth toggles are kept here for back-compat with the
          // existing render code, but they reflect the real (immutable)
          // state — not user-mutable settings. dmAuth is reserved for a
          // future read-gating layer; today reads are open to all.
          auth:       true,
          dmAuth:     false,
          gating:     {
            policy:        'owner+whitelist',
            mutable:       false,
            reason:        'in-process relay: NIP-42 write gating is always on',
            ownerKnown:    !!ident.npub,
            whitelistSize: whitelist.length,
          },
          whitelist,
          dataDir:    path.join(os.homedir(), '.nostr-station', 'data'),
          configPath: 'in-process — no config file',
          knownRoles: {
            station:  ident.npub || null,
            watchdog: watchdogNpub,
            seed:     seedNpub,
          },
        }));
        return;
      }

      // Accept POSTs to /api/relay-config but treat the toggles as
      // immutable: write gating is always on (1.6c) and there's no
      // dmAuth implementation to enable yet. Returns the same shape as
      // GET so the Config panel's saveRelayFlag (app.js:5683) gets a
      // 200 response and re-renders against truth instead of erroring.
      if (url === '/api/relay-config' && method === 'POST') {
        // Drain body so the client doesn't see a stalled connection;
        // we deliberately ignore its contents.
        try { await readBody(req); } catch { /* fine */ }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok:      true,
          auth:    true,
          dmAuth:  false,
          mutable: false,
          message: 'write gating is always on — manage access via the whitelist',
        }));
        return;
      }


      // ── nvpn installer ────────────────────────────────────────────────
      // Wizard renderVpn (app.js:7141) drives this endpoint. NDJSON wire
      // format — one JSON line per progress event. The installer itself
      // is in src/lib/nvpn-installer.ts; this handler just streams its
      // progress callbacks back to the browser.
      if (url === '/api/setup/nvpn/install' && method === 'POST') {
        res.writeHead(200, {
          'Content-Type':      'application/x-ndjson',
          'Cache-Control':     'no-cache',
          'Connection':        'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        try {
          const result = await installNostrVpn((s) => {
            try { res.write(JSON.stringify({ type: 'progress', step: s }) + '\n'); } catch {}
          });
          res.write(JSON.stringify({
            type:   'done',
            ok:     result.ok,
            warn:   !!result.warn,
            detail: result.detail ?? '',
          }) + '\n');
        } catch (e: any) {
          res.write(JSON.stringify({
            type:   'done',
            ok:     false,
            detail: String(e?.message ?? e),
          }) + '\n');
        }
        res.end();
        return;
      }

      // ── Watchdog lifecycle + status ───────────────────────────────────
      // The in-Node watchdog publishes a kind-1 heartbeat to the local
      // relay on a recurring interval. Endpoints let the dashboard /
      // CLI start, stop, or inspect it explicitly — separate from the
      // relay's lifecycle (1.3) because some users may want the relay
      // up without the watchdog (or vice versa).
      if (url === '/api/watchdog/status' && method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(watchdog ? watchdog.status() : {
          running: false, lastHeartbeatAt: null, npub: null, intervalMs: 0,
        }));
        return;
      }
      if (url === '/api/watchdog/start' && method === 'POST') {
        try {
          await maybeStartWatchdog();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, status: watchdog?.status() ?? null }));
        } catch (e: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
        }
        return;
      }
      if (url === '/api/watchdog/stop' && method === 'POST') {
        if (watchdog) {
          watchdog.stop();
          watchdog = null;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // ── Status panel install button ───────────────────────────────────
      // POST /api/exec/install/<slug> — drives the Status row "Install"
      // CTA (app.js:1255). Most slugs flow through installTool() from
      // src/lib/tools.ts (npm-global / manual installers). `nak` and
      // `ngit` each have their own GitHub-release-binary installer
      // (src/lib/{nak,ngit}-installer.ts) — both used to be cargo
      // entries, but install.sh deliberately doesn't ship Rust, so the
      // prereq check rejected every fresh-install user. Bigger flows
      // (nvpn) keep their own dedicated setup endpoint
      // (/api/setup/nvpn/install above).
      const installMatch = url.match(/^\/api\/exec\/install\/([a-z][a-z0-9-]*)$/);
      if (installMatch && method === 'POST') {
        const slug = installMatch[1];
        res.writeHead(200, {
          'Content-Type':  'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection':    'keep-alive',
        });
        const emit = (p: object) => { try { res.write(`data: ${JSON.stringify(p)}\n\n`); } catch {} };

        // Custom installer slugs first.
        if (slug === 'nak') {
          try {
            const result = await installNak((line) => emit({ line, stream: 'stdout' }));
            if (!result.ok && result.detail) {
              emit({ line: result.detail, stream: result.warn ? 'stdout' : 'stderr' });
            }
            emit({ done: true, code: result.ok ? 0 : (result.warn ? 0 : 1) });
          } catch (e: any) {
            emit({ line: String(e?.message || e), stream: 'stderr' });
            emit({ done: true, code: -1 });
          }
          try { res.end(); } catch {}
          return;
        }

        if (slug === 'ngit') {
          try {
            const result = await installNgit((line) => emit({ line, stream: 'stdout' }));
            if (!result.ok && result.detail) {
              emit({ line: result.detail, stream: result.warn ? 'stdout' : 'stderr' });
            }
            emit({ done: true, code: result.ok ? 0 : (result.warn ? 0 : 1) });
          } catch (e: any) {
            emit({ line: String(e?.message || e), stream: 'stderr' });
            emit({ done: true, code: -1 });
          }
          try { res.end(); } catch {}
          return;
        }

        const tool = getTool(slug);
        if (!tool) {
          const supported = ['nak', 'ngit', ...Object.keys(TOOLS)].sort();
          emit({
            line:   `'${slug}' is not a known optional tool. Supported: ${supported.join(', ')}.`,
            stream: 'stderr',
          });
          emit({ done: true, code: 1 });
          try { res.end(); } catch {}
          return;
        }
        try {
          const result = await installTool(tool, (line) => emit({ line, stream: 'stdout' }));
          if (!result.ok && result.detail) {
            emit({ line: result.detail, stream: 'stderr' });
          }
          emit({ done: true, code: result.ok ? 0 : 1 });
        } catch (e: any) {
          emit({ line: String(e?.message || e), stream: 'stderr' });
          emit({ done: true, code: -1 });
        }
        try { res.end(); } catch {}
        return;
      }

      // ── Logs panel SSE ────────────────────────────────────────────────
      // Single endpoint for all three channels (relay/watchdog/vpn). The
      // panel opens an EventSource per active tab and reconnects on tab
      // change (app.js:4864). Output frames per the original wire shape:
      //   data: { status: ServiceHealth }   — emitted on connect
      //   data: { lines: [LogLine, ...] }   — replay of buffered history,
      //                                       then one frame per new line
      //   data: { error: <string> }         — replaced by graceful close
      // EventSource cannot set Authorization, so the auth gate accepts
      // ?token=<bearer> via the existing extractBearer path; the per-route
      // guard above has already vetted the token by the time we land here.
      const logsMatch = url.match(/^\/api\/logs\/(relay|watchdog|vpn)$/);
      if (logsMatch && method === 'GET') {
        const channel = logsMatch[1] as 'relay' | 'watchdog' | 'vpn';
        const buf = logBuffers[channel];

        res.writeHead(200, {
          'Content-Type':  'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          'Connection':    'keep-alive',
          'X-Accel-Buffering': 'no',
        });

        // Status frame matches the shape Logs panel's renderBanner /
        // renderMeta consume (app.js:4868). Per channel:
        //   relay     — running + log-buffer-backed
        //   watchdog  — running iff the in-Node watchdog is alive,
        //               carries watchdogNpub for the meta strip
        //   vpn       — pending until Phase 2.2 installer lands
        const status = await (async () => {
          if (channel === 'relay') {
            return {
              service:    'relay',
              installed:  true,
              running:    !!inprocRelay,
              logExists:  true,
              logPath:    '(in-memory ring buffer)',
              stale:      false,
              logMtimeMs: Date.now(),
            };
          }
          if (channel === 'watchdog') {
            const s = watchdog?.status();
            return {
              service:        'watchdog',
              installed:      true,
              running:        !!s?.running,
              logExists:      true,
              logPath:        '(in-memory ring buffer)',
              stale:          false,
              logMtimeMs:     s?.lastHeartbeatAt ?? Date.now(),
              watchdogNpub:   s?.npub ?? null,
            };
          }
          // vpn — probe the daemon directly so the banner reflects daemon
          // state, not just "is the tunnel up". Going through gatherStatus
          // collapsed everything below `state==='ok'` to running:false,
          // which flipped the banner to "stopped" whenever a healthy
          // daemon's status socket stalled briefly. probeNvpnStatus keeps
          // running and tunnelIp separate; vpnBannerRunningFor cross-checks
          // probeNvpnServiceStatus (systemd/launchd) when the direct probe
          // errored, so a slow socket on a healthy daemon doesn't lie
          // about whether the process is alive. The service probe is only
          // run on the failure path, so the happy case stays one shell-out.
          const direct = await probeNvpnStatus();
          const installed = direct.installed;
          const service = (installed && direct.error)
            ? await probeNvpnServiceStatus()
            : null;
          const running = vpnBannerRunningFor(direct, service);
          // The vpn LogBuffer is fed by startNvpnLogTail at boot — once
          // the daemon is up and writing to its log file, the panel
          // streams real lines. Until then a banner explains the gap.
          return {
            service:    channel,
            installed,
            running,
            logExists:  installed,
            logPath:    installed
              ? 'nvpn daemon log (auto-tailed)'
              : '(not installed)',
            stale:      false,
            logMtimeMs: Date.now(),
            note:       installed
              ? (running
                  ? (direct.tunnelIp ? `tunnel: ${direct.tunnelIp}` : 'running, no tunnel ip')
                  : 'not connected')
              : 'install via the setup wizard\'s vpn step',
            // Hint for the Logs panel renderMeta — shown as a copy-able
            // identity strip alongside the buffer. Mirrors the watchdog
            // tab's npub field.
            tunnelIp:   running ? direct.tunnelIp : null,
          };
        })();
        res.write(`data: ${JSON.stringify({ status })}\n\n`);

        // Replay the ring on connect so the user sees recent history
        // immediately, not just whatever happens after the panel opened.
        const initial = buf.drain();
        if (initial.length > 0) {
          res.write(`data: ${JSON.stringify({ lines: initial.map(formatLogLine) })}\n\n`);
        }

        // Live tail — push every new line as a single-line `lines` frame
        // so client code paths (history vs live) share one branch.
        const unsubscribe = buf.subscribe((line: LogLine) => {
          if (res.writableEnded) return;
          try {
            res.write(`data: ${JSON.stringify({ lines: [formatLogLine(line)] })}\n\n`);
          } catch { /* socket gone — close handler unsubs */ }
        });

        // 15s heartbeat keeps proxies / browsers from idling the
        // connection out when nothing's happening on the channel.
        const heartbeat = setInterval(() => {
          if (res.writableEnded) return;
          try { res.write(': heartbeat\n\n'); } catch {}
        }, 15_000);

        const cleanup = () => {
          clearInterval(heartbeat);
          unsubscribe();
        };
        req.on('close', cleanup);
        res.on('close', cleanup);
        return;
      }

      // ── Projects + Chat project context (extracted to routes/projects.ts) ──
      if (await handleProjects(req, res, url, method)) return;

      // ── Identity (extracted to routes/identity.ts) ─────────────────────
      // Covers /api/identity/config, /api/identity/set, /api/identity/relays/{add,remove},
      // /api/identity/profile/preview, /api/identity/profile, /api/identity/profile/sync.
      if (await handleIdentity(req, res, url, method)) return;

      // ── Ditto theme sync (routes/ditto.ts) ─────────────────────────────
      // GET /api/ditto/theme — fetch latest kind 16767 from owner's relays.
      if (await handleDitto(req, res, url, method)) return;

      // Setup wizard completion — called once from the Done stage. Flips
      // setupComplete=true (ending the localhost exemption on this box
      // when npub is set + requireAuth is on) and issues a fresh session
      // token for the stored npub so the dashboard unlocks without a
      // separate sign-in round trip.
      //
      // Safe to expose without a NIP-98 signature because:
      //   - setupComplete !== true means we're still inside the wizard's
      //     localhostExempt window, i.e. only something on 127.0.0.1 can
      //     reach this endpoint in the first place.
      //   - Once setupComplete flips true, this branch rejects further
      //     calls — a second-session upgrade requires real auth.
      // ── Amber QR pairing (first-run /setup) ──────────────────────────
      //
      // The hero step of the user-journey spec: a single full-screen QR
      // representing a NIP-46 nostrconnect:// URI. The user scans in
      // Amber, taps approve once, and the bunker handshake captures
      // their npub + saves a bunker client for future signing — all
      // without ever asking them to paste an npub.
      //
      // Two endpoints:
      //   POST /api/setup/amber/start
      //     Generates the URI + QR SVG, returns the session id for
      //     polling. Background task races the bunker connect against
      //     CONNECT_TIMEOUT_MS.
      //   GET  /api/setup/amber/session/:eph
      //     Polls session state. On status='ok' returns the captured
      //     npub; identity.json is already written by the time the
      //     wizard sees this response.
      if (url === '/api/setup/amber/start' && method === 'POST') {
        // Once setup is complete, this endpoint stops responding —
        // it's only meaningful during the first-run window. Subsequent
        // pairings (e.g. user wants to switch Amber accounts) go
        // through /api/auth/bunker-connect instead.
        const ident = readIdentity();
        if (ident.setupComplete === true) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'setup already complete' }));
          return;
        }
        const start = await startSetupAmber(expectedDashboardUrl(req, port));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ...start }));
        return;
      }

      const setupAmberPollMatch = url.match(/^\/api\/setup\/amber\/session\/([0-9a-f]{64})$/);
      if (setupAmberPollMatch && method === 'GET') {
        const eph = setupAmberPollMatch[1];
        const s   = getSetupAmberSession(eph);
        if (!s) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'error', error: 'unknown session' }));
          return;
        }
        if (s.status === 'waiting') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'waiting', expiresAt: s.expiresAt }));
          return;
        }
        // Terminal state — consume the session entry. The wizard
        // displays the result and moves to the next stage.
        consumeSetupAmberSession(eph);
        if (s.status !== 'ok') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: s.status, error: s.error }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', npub: s.userNpub }));
        return;
      }

      // ── Live verification (Phase 4 of the user journey) ──────────────
      //
      // Generates a kind-1 test event, asks Amber to sign it (second
      // and last phone tap during onboarding), publishes to the
      // in-process relay over the public ws:// URL, reads it back via
      // a REQ subscription, and returns a step-by-step result. This
      // is the trust-earning moment — the user sees the full pipeline
      // work end-to-end before being asked to do anything real.
      if (url === '/api/setup/verify' && method === 'POST') {
        const ident = readIdentity();
        if (!ident.npub) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'identity not paired — finish Amber pairing first' }));
          return;
        }
        if (ident.setupComplete === true) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'setup already complete' }));
          return;
        }
        try {
          const result = await runSetupVerify();
          res.writeHead(result.ok ? 200 : 500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (e: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: String(e?.message ?? e) }));
        }
        return;
      }

      if (url === '/api/setup/complete' && method === 'POST') {
        const ident = readIdentity();
        if (!ident.npub) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'identity not set' }));
          return;
        }
        if (ident.setupComplete === true) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'setup already complete — sign in normally' }));
          return;
        }
        setSetupComplete(true);
        const ua = String(req.headers['user-agent'] || '');
        const sess = createSession(ident.npub, ua);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          token:     sess.token,
          npub:      sess.npub,
          expiresAt: sess.expiresAt,
        }));
        return;
      }

      // Keychain set — AI API key.
      //
      // We use the keychain lib directly rather than shelling out to
      // `nostr-station keychain set ai-api-key` because the CLI command
      // runs in an interactive Ink prompt and can't accept a value via
      // stdin or argv. The underlying keychain backend already stores
      // values through execa with array args (no shell interpolation);
      // calling store() here is the same code path, minus the TUI.
      //
      // The key value never touches process.argv, env, or logs — it's
      // only passed to keychain.store() which forwards it as an argv
      // arg to `security` / `secret-tool`.
      if (url === '/api/keychain/set' && method === 'POST') {
        let parsed: any = {};
        try { parsed = JSON.parse(await readBody(req)); }
        catch { res.writeHead(400); res.end('bad json'); return; }
        const key = typeof parsed.key === 'string' ? parsed.key : '';
        if (!key || key.length < 4) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'key is empty or too short' }));
          return;
        }
        // Reject obvious nsec paste — the AI key slot is for provider keys.
        if (isNsec(key)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'nsec detected — this slot is for AI provider keys only' }));
          return;
        }
        try {
          await getKeychain().store('ai-api-key', key);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: String(e.message || e).slice(0, 200) }));
        }
        return;
      }

      // ── ngit / nsite / account (extracted to routes/ngit.ts) ──────────
      // Covers /api/ngit/discover, /api/nsite/discover, /api/ngit/clone,
      // /api/ngit/account[/login|/logout].
      if (await handleNgit(req, res, url, method)) return;

      // ── nvpn runtime control (extracted to routes/nvpn.ts) ────────────
      // Covers /api/nvpn/status, /api/nvpn/{start,stop,restart},
      // /api/nvpn/install-service. Drives the Status panel's start/stop
      // buttons and the Logs panel's nostr-vpn meta strip.
      if (await handleNvpn(req, res, url, method)) return;

      // ── AI provider system (extracted to routes/ai.ts)
      // Covers /api/ai/providers, /api/ai/config,
      // /api/ai/providers/:id/key (POST/DELETE),
      // /api/ai/providers/:id/models, and /api/ai/chat.
      if (await handleAi(req, res, url, method)) return;

      // ── Project templates registry (routes/templates.ts)
      // Covers /api/templates GET/POST and /api/templates/:id
      // GET/PATCH/DELETE + /api/templates/:id/reset.
      if (await handleTemplates(req, res, url, method)) return;

      // ── Terminal HTTP surface (extracted to routes/terminal.ts) ───────
      // Covers /api/terminal/capability, /api/terminal, /api/terminal/create,
      // and DELETE /api/terminal/:id. The matching WebSocket upgrade is
      // wired below via mountTerminalWebSocket() so it shares this
      // request handler's allowedHosts / isLoopbackUrl primitives.
      if (await handleTerminal(req, res, url, method)) return;

      // Static fallback — vendor libs first (fast path, strict whitelist),
      // then the regular src/web tree.
      if (method === 'GET' && serveVendorXterm(req, res)) return;
      if (method === 'GET' && serveStatic(req, res)) return;

      // SPA routes — served from index.html. The client router picks up
      // the path from location and renders the wizard/panel accordingly.
      // Listed explicitly (not a catch-all) so typos still 404.
      if (method === 'GET' && url === '/setup') {
        // Already paired — bounce to the dashboard. Without this guard a
        // refresh on /setup keeps the wizard SPA mounted, which both
        // confuses the user and offers no working path forward (the
        // /api/setup/* endpoints all 409 once setupComplete flips true).
        if (readIdentity().setupComplete === true) {
          res.writeHead(302, { Location: '/' });
          res.end();
          return;
        }
        const indexPath = path.join(WEB_DIR, 'index.html');
        if (fs.existsSync(indexPath)) {
          res.writeHead(200, {
            'Content-Type': 'text/html',
            'Cache-Control': 'no-cache',
            ...HTML_SECURITY_HEADERS,
          });
          fs.createReadStream(indexPath).pipe(res);
          return;
        }
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    });

    // ── Terminal WebSocket upgrade (extracted to routes/terminal.ts) ──
    // Mounted as a closure-receiving function so the WS layer reuses
    // this request handler's `allowedHosts` + `isLoopbackUrl` primitives
    // for H1 (DNS rebinding) and H2 (CSRF) checks. See the route module
    // for the full URL grammar + control-frame protocol.
    mountTerminalWebSocket(server, { allowedHosts, isLoopbackUrl });

    // PID file management (B3): write once we're bound, drop on graceful
    // exit. The file lets `nostr-station uninstall` refuse to nuke services
    // out from under a running dashboard — see src/lib/pid-file.ts for the
    // stale-PID handling story.
    let pidWritten = false;
    const dropPid = () => {
      if (!pidWritten) return;
      pidWritten = false;
      removePidFile();
    };

    server.on('close', () => {
      destroyAllTerminals();
      // Stop the watchdog before the relay it depends on.
      watchdog?.stop();
      watchdog = null;
      // Stop the in-process relay alongside the dashboard. Errors are
      // swallowed because a half-stopped relay during shutdown is no
      // worse than a dropped log line.
      void inprocRelay?.stop().catch(() => {});
      inprocRelay = null;
      // nvpn log tailer is independent of the daemon — it just polls a
      // file. Stop it so the polling timer doesn't keep Node alive.
      nvpnLogTailer?.stop();
      nvpnLogTailer = null;
      dropPid();
    });

    server.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'EADDRINUSE') {
        reject(new Error(`Port ${port} is already in use — check: lsof -i :${port}`));
      } else {
        reject(e);
      }
    });

    // Signal handlers — Ink's own SIGINT handler tears down the TUI but
    // doesn't fire `server.close`, so we mirror cleanup here. Use `once`
    // so a second Ctrl-C still terminates fast (default behavior); we
    // re-raise the signal after our cleanup so node uses its default
    // exit-on-signal semantics.
    const onSignal = (sig: NodeJS.Signals) => {
      dropPid();
      // Best-effort graceful close; don't await.
      try { server.close(); } catch {}
      // Re-raise so the parent process / Ink propagates exit-on-signal
      // semantics correctly. Without re-raising, a SIGTERM that arrived
      // mid-run-up could be silently absorbed.
      process.kill(process.pid, sig);
    };
    process.once('SIGINT',  onSignal);
    process.once('SIGTERM', onSignal);
    // `beforeExit` fires when the event loop drains naturally (rare for a
    // server but covers oddball test paths). Not registered as `exit`
    // because `exit` only allows synchronous work, and removePidFile is
    // already sync — but `beforeExit` is friendlier to debugging stacks.
    process.once('beforeExit', dropPid);

    server.listen(port, process.env.DEV_HOST || '127.0.0.1', () => {
      try {
        writePidFile();
        pidWritten = true;
      } catch (e) {
        // PID file is advisory — failure to write must not block the
        // dashboard from coming up. Surface to stderr for the post-mortem.
        process.stderr.write(`[pid-file] write failed: ${(e as Error).message}\n`);
      }
      // Kick off best-effort warm-ups now that the socket is bound. If any
      // of them hang (secret-tool unlock prompt, node-pty prebuilt probe,
      // ai-config migration) the dashboard is still up and serving.
      warmUp();
      // In-process relay (gated on STATION_INPROC_RELAY=1). Started after
      // the dashboard binds so a relay-port collision doesn't prevent
      // the dashboard from coming up — the relay will surface its own
      // EADDRINUSE in stderr if 7777 is taken.
      void maybeStartInprocRelay().catch(e => {
        process.stderr.write(`[relay] failed to start: ${(e as Error).message}\n`);
      });
      // nvpn daemon log tailer — best-effort. Sits idle until the daemon
      // log file appears, then pumps lines into logBuffers.vpn so the
      // Logs panel's nostr-vpn tab streams real output. Single instance
      // per server lifetime; the tailer's own poll loop is cheap and
      // cancels on `stop()` from the close handler below.
      if (process.env.STATION_DISABLE_NVPN_TAIL !== '1') {
        try { nvpnLogTailer = startNvpnLogTail(logBuffers.vpn); }
        catch (e: any) {
          process.stderr.write(`[nvpn] log tailer failed to start: ${e?.message || e}\n`);
        }
      }
      resolve();
    });
  });
}
