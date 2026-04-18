/**
 * nostr-station web dashboard server.
 *
 * Serves the control-center UI at /, and a small JSON+SSE API at /api/*:
 *   GET  /api/config         — AI provider + model + context presence
 *   POST /api/chat           — SSE streaming chat (proxies to provider)
 *   GET  /api/status         — gatherStatus() results (shared w/ `status --json`)
 *   GET  /api/relay-config   — relay name/url/auth/dm-auth/whitelist (npubs)
 *   POST /api/relay/:action  — start | stop | restart (launchctl/systemctl)
 *   GET  /api/logs/:service  — SSE live tail of relay or watchdog log
 *
 * Bound to 127.0.0.1 only. No auth — local user is the trust boundary.
 */

import http from 'http';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { spawn, execSync, execFile, execFileSync } from 'child_process';
import { nip19 } from 'nostr-tools';
import { getPublicKey } from 'nostr-tools/pure';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import { getKeychain } from './keychain.js';
import {
  loadPty, createSession as createTerminal, attachClient as attachTerminal,
  detachClient as detachTerminal, destroySession as destroyTerminal,
  writeInput as writeTerminalInput, resizeSession as resizeTerminal,
  listSessions as listTerminals, destroyAllSessions as destroyAllTerminals,
} from './terminal.js';
// AI provider registry. A legacy local `PROVIDERS` map in this file serves
// the old single-provider /api/config/set flow; importing the new one from
// ai-providers.ts with the same name would shadow it, so we pull named
// helpers instead. The old map goes away in a later step.
import {
  listProviders, getProvider, keychainAccountFor,
  type ApiProvider,
} from './ai-providers.js';
import {
  readAiConfig, writeAiConfig, migrateIfNeeded, setProviderEntry,
  type ProviderConfig as AiProviderConfig,
} from './ai-config.js';
import { buildAiContext } from './ai-context.js';
import { gatherStatus } from '../commands/Status.js';
import {
  readRelaySettings, defaultConfigPath, hexToNpub, npubToHex,
  addToWhitelist, removeFromWhitelist, setAuthFlag,
} from './relay-config.js';
import { detectPlatform, detectInstalled, probeOllama, probeLmStudio } from './detect.js';
import { bootstrapRelayServices } from './services.js';
import { installNostrVpn } from './install.js';
import {
  readIdentity, addReadRelay, removeReadRelay, setNpub as setIdentityNpub,
  setNgitRelay as setIdentityNgitRelay, setSetupComplete,
  isNpubOrHex, isNsec, isValidRelayUrl, DEFAULT_READ_RELAYS, type Identity,
} from './identity.js';
import {
  clearAllSessions, issueChallenge, consumeChallenge, createSession,
  getSession, deleteSession, extractBearer, verifyNip98, authStatus,
  isPublicApi, requireSession, expectedDashboardUrl, localhostExempt,
} from './auth.js';
import {
  startNostrConnect, getBunkerSession, consumeBunkerSession,
  signWithBunkerUrl, silentBunkerSign,
} from './auth-bunker.js';
import {
  readProjects, getProject, createProject, updateProject, deleteProject,
  detectPath, projectGitStatus, projectGitLog, resolveProjectContext,
  isStacksProject,
  type Project,
} from './projects.js';
import { checkCollision, scaffoldProject } from './project-scaffold.js';

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
  'Referrer-Policy': 'no-referrer',
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

// ── Provider config (unchanged from chat-server) ──────────────────────────────

interface ProviderConfig {
  isAnthropic: boolean;
  baseUrl:     string;
  model:       string;
  apiKey:      string;
  providerName: string;
}

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
  if (baseUrl.includes('openrouter'))  return 'OpenRouter';
  if (baseUrl.includes('routstr'))     return 'Routstr';
  if (baseUrl.includes('ppq.ai'))      return 'PayPerQ';
  if (baseUrl.includes('opencode.ai')) return 'OpenCode Zen';
  if (baseUrl.includes(':8081'))       return 'Maple';
  if (baseUrl.includes(':11434'))      return 'Ollama';
  if (baseUrl.includes(':1234'))       return 'LM Studio';
  return 'Custom';
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

  // Anthropic demands a real key; OpenAI-compat providers may accept "none"
  // (Ollama, LM Studio) so an empty key there still counts as configured.
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
  const contextPath = path.join(homeDir, 'projects', 'NOSTR_STATION.md');
  try { return fs.readFileSync(contextPath, 'utf8'); }
  catch { return 'You are a helpful assistant for Nostr protocol development.'; }
}

export function contextExists(): boolean {
  return fs.existsSync(path.join(os.homedir(), 'projects', 'NOSTR_STATION.md'));
}

// Active chat project — set via POST /api/chat/context, read by proxyChat()
// to pick the right system prompt. null means "use global NOSTR_STATION.md".
// Module-scoped, resets on server restart (same lifecycle as sessions).
let activeChatProjectId: string | null = null;

// ── Chat proxy (streaming SSE) ────────────────────────────────────────────────

async function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end',  () => resolve(body));
    req.on('error', reject);
  });
}

function completionsUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/$/, '');
  return base.endsWith('/v1') ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
}

type Msg = { role: string; content: string };

// ── Model-list adapters (used by GET /api/ai/providers/:id/models) ────────
//
// Anthropic + OpenAI-compat expose /v1/models; the Gemini-through-OpenAI
// shim does too. Results are keyed on the `id` field in the response's
// `data[]` array — that's what the /v1/chat/completions endpoint accepts.

async function fetchAnthropicModels(apiKey: string): Promise<string[]> {
  const res = await fetch('https://api.anthropic.com/v1/models', {
    headers: {
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`anthropic ${res.status}: ${body.slice(0, 160)}`);
  }
  const data = await res.json() as any;
  const list = Array.isArray(data?.data) ? data.data : [];
  const ids  = list.map((m: any) => m?.id).filter((s: any) => typeof s === 'string' && s);
  if (ids.length === 0) throw new Error('anthropic returned no models');
  return ids;
}

async function fetchOpenAICompatModels(
  apiKey: string, baseUrl: string, bareKey: boolean,
): Promise<string[]> {
  // Most OpenAI-compat endpoints expose /v1/models at the same base URL
  // as /v1/chat/completions. Some (Ollama, LM Studio) accept an empty
  // Authorization; only attach the header when we have a real key.
  const url = baseUrl.replace(/\/$/, '').endsWith('/v1')
    ? `${baseUrl.replace(/\/$/, '')}/models`
    : `${baseUrl.replace(/\/$/, '')}/v1/models`;
  const headers: Record<string, string> = { 'accept': 'application/json' };
  if (apiKey && !bareKey) headers['Authorization'] = `Bearer ${apiKey}`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${res.status}: ${body.slice(0, 160)}`);
  }
  const data = await res.json() as any;
  const list = Array.isArray(data?.data) ? data.data : [];
  const ids  = list.map((m: any) => m?.id).filter((s: any) => typeof s === 'string' && s);
  if (ids.length === 0) throw new Error('provider returned no models');
  // Alphabetical keeps the Chat dropdown scannable; providers often
  // return chronological which mixes gpt-3 / gpt-4 / etc. unpredictably.
  return ids.sort();
}

async function streamAnthropic(
  messages: Msg[], system: string, cfg: ProviderConfig, res: http.ServerResponse,
): Promise<void> {
  // Emit the requested model up front so the Chat pane can caption the
  // reply bubble before Anthropic's own message_start event arrives.
  // Anthropic's message_start carries the fully-qualified model id
  // (e.g. "claude-opus-4-6-20240229") — we forward that too when it
  // lands, and the client just overwrites its tag with the more
  // specific value. If upstream drops the event, the user still sees
  // the requested model, not a blank.
  res.write(`data: ${JSON.stringify({ model: cfg.model })}\n\n`);

  const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key':         cfg.apiKey,
      'anthropic-version': '2023-06-01',
      'content-type':      'application/json',
      'accept':            'text/event-stream',
    },
    body: JSON.stringify({
      model: cfg.model, max_tokens: 8192, system, messages, stream: true,
    }),
  });

  if (!apiRes.ok) {
    const text = await apiRes.text().catch(() => '');
    throw new Error(`Anthropic ${apiRes.status}: ${text.slice(0, 200)}`);
  }

  const reader  = apiRes.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n'); buf = lines.pop()!;
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (!data) continue;
      try {
        const parsed = JSON.parse(data);
        if (parsed.type === 'message_start' && parsed.message?.model) {
          res.write(`data: ${JSON.stringify({ model: parsed.message.model })}\n\n`);
        }
        if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta') {
          res.write(`data: ${JSON.stringify({ content: parsed.delta.text })}\n\n`);
        }
      } catch {}
    }
  }
}

async function streamOpenAICompat(
  messages: Msg[], system: string, cfg: ProviderConfig, res: http.ServerResponse,
): Promise<void> {
  const allMessages: Msg[] = [{ role: 'system', content: system }, ...messages];
  const url = completionsUrl(cfg.baseUrl);

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const bareKeys = new Set(['none', 'ollama', 'lm-studio', 'maple-desktop-auto']);
  if (cfg.apiKey && !bareKeys.has(cfg.apiKey)) {
    headers['Authorization'] = `Bearer ${cfg.apiKey}`;
  }

  // Same intent as streamAnthropic: caption the reply with the model
  // name immediately, then refine with whatever upstream actually routed
  // to (each OpenAI-compat chunk carries `model` at the top level).
  res.write(`data: ${JSON.stringify({ model: cfg.model })}\n\n`);

  const apiRes = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: cfg.model, messages: allMessages, stream: true }),
  });

  if (!apiRes.ok) {
    const text = await apiRes.text().catch(() => '');
    throw new Error(`${cfg.providerName} ${apiRes.status}: ${text.slice(0, 200)}`);
  }

  const reader  = apiRes.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let modelForwarded = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n'); buf = lines.pop()!;
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') return;
      try {
        const parsed  = JSON.parse(data);
        if (!modelForwarded && typeof parsed.model === 'string' && parsed.model) {
          res.write(`data: ${JSON.stringify({ model: parsed.model })}\n\n`);
          modelForwarded = true;
        }
        const content = parsed.choices?.[0]?.delta?.content;
        if (content) res.write(`data: ${JSON.stringify({ content })}\n\n`);
      } catch {}
    }
  }
}

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

  const activeProject = activeChatProjectId ? getProject(activeChatProjectId) : null;
  const system = activeChatProjectId
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

// ── Relay service controls ────────────────────────────────────────────────────

function serviceCmd(action: 'start' | 'stop'): string {
  const label = 'com.nostr-station.relay';
  return process.platform === 'darwin'
    ? `launchctl ${action} ${label}`
    : `systemctl --user ${action} nostr-relay.service`;
}

function isRelayUp(): boolean {
  try { execSync('nc -z localhost 8080', { stdio: 'pipe' }); return true; }
  catch { return false; }
}

async function relayAction(
  action: 'start' | 'stop' | 'restart',
  res: http.ServerResponse,
): Promise<void> {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  try {
    if (action === 'restart') {
      try { execSync(serviceCmd('stop'), { stdio: 'pipe' }); } catch {}
      await wait(500);
      execSync(serviceCmd('start'), { stdio: 'pipe' });
      await wait(1500);
    } else {
      execSync(serviceCmd(action), { stdio: 'pipe' });
      if (action === 'start') await wait(1500);
    }
    const up = isRelayUp();
    const expected = action !== 'stop';
    const ok = up === expected;
    res.end(JSON.stringify({ ok, up, action }));
  } catch (e: any) {
    const raw = String(e.message ?? e);
    const looksMissing = /not found|no such|could not find|input\/output error/i.test(raw);
    const hint = looksMissing ? 'relay service not installed — run: nostr-station onboard' : raw.slice(0, 160);
    res.end(JSON.stringify({ ok: false, error: hint }));
  }
}

function wait(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ── Relay config (read-only) ──────────────────────────────────────────────────

async function serveRelayConfig(res: http.ServerResponse): Promise<void> {
  const s = readRelaySettings();
  if (!s) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      name: '', url: '', auth: false, dmAuth: false,
      whitelist: [], knownRoles: {}, dataDir: '', configPath: defaultConfigPath(),
      error: `config not found at ${defaultConfigPath()} — run nostr-station onboard`,
    }));
    return;
  }
  // Prefer npub in the UI — hex is noise to humans. hexToNpub shells to `nak`
  // once per entry; whitelists are typically 1-10 entries so this is cheap.
  const whitelist = s.whitelist.map(h => hexToNpub(h));

  // Role labels for the UI — lets the whitelist render "You · station",
  // "Watchdog", "Seed" badges next to the nostr-station-managed entries
  // without the user having to memorize truncated npub prefixes. Any of
  // these may be undefined on a partial install (e.g. seed has never been
  // run yet, so seed-nsec isn't in keychain); the client just renders no
  // badge for missing roles.
  const ident = readIdentity();
  const [watchdogNpub, seedNpub] = await Promise.all([
    deriveKeychainNpub('watchdog-nsec'),
    deriveKeychainNpub('seed-nsec'),
  ]);
  const knownRoles: { station?: string; watchdog?: string; seed?: string } = {};
  if (ident.npub) knownRoles.station = ident.npub;
  if (watchdogNpub) knownRoles.watchdog = watchdogNpub;
  if (seedNpub)     knownRoles.seed = seedNpub;

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ...s, whitelist, knownRoles }));
}

// ── Logs (SSE live tail) ──────────────────────────────────────────────────────

type LogService = 'relay' | 'watchdog' | 'vpn';

interface ServiceHealth {
  service:    LogService;
  installed:  boolean;         // unit file / binary present
  running:    boolean;         // daemon actively loaded / running
  logPath:    string;
  logExists:  boolean;
  logMtimeMs: number | null;   // last write timestamp
  stale:      boolean;         // running but log hasn't been written recently
  watchdogNpub?: string;       // watchdog service only — so the user knows
                               // which identity to follow for relay-down DMs
}

// Per-service staleness threshold, in ms. Only set for services with a known
// write cadence; `undefined` means we never call the log stale based on mtime.
//
// - watchdog: fires every 5 min (launchd StartInterval=300) and always appends
//   a line, so >10 min of silence while the job is loaded is a real wedge.
// - relay / vpn: long-running daemons that are legitimately silent when idle
//   (a fresh relay with no connected clients writes nothing for hours). PID
//   presence via launchctl is the correct health signal for these; mtime-based
//   staleness on the log file fires as a false positive on quiet boxes.
const STALE_MS: Partial<Record<LogService, number>> = {
  watchdog: 600_000,
};

function cmdOk(c: string): boolean {
  try { execSync(c, { stdio: 'pipe', timeout: 1500, killSignal: 'SIGKILL' }); return true; }
  catch { return false; }
}

// launchctl list <label> exits 0 when the job is loaded; its output's PID
// field is an integer while the job is executing and absent otherwise.
//
// For continuous daemons (relay, vpn) "running" = live PID. For interval
// jobs (watchdog, StartInterval=300) there's no PID 99% of the time — it
// fires, exits, and waits. Loaded-and-scheduled IS the running state for
// those; gating on PID produced a permanent false-negative banner.
function launchctlState(
  label: string,
  mode: 'continuous' | 'interval',
): { installed: boolean; running: boolean } {
  try {
    const out = execSync(`launchctl list ${label}`, { stdio: 'pipe', timeout: 1500 }).toString();
    if (mode === 'interval') {
      // Just being loaded is enough — the next scheduled fire will run it.
      return { installed: true, running: true };
    }
    const pidLine = out.split('\n').find(l => l.includes('"PID"'));
    const running = !!(pidLine && /"PID"\s*=\s*\d+/.test(pidLine));
    return { installed: true, running };
  } catch {
    return { installed: false, running: false };
  }
}

// nvpn owns its own daemon lifecycle — it's launched via `nvpn start --daemon`
// (or `nvpn service install` on systems that want a platform-managed service),
// homebrew's post-install, or a user's own supervisor. That means launchd /
// systemd labels are unreliable predictors of install state: a perfectly fine
// homebrew install has no launchd agent, but the daemon is running and we
// should tail it. `nvpn status --json` is the authoritative signal — it
// reports `daemon.running` and the actual `log_file` path nvpn writes to,
// which is nvpn's Application Support dir, NOT our ~/logs convention.
function probeNvpn(): { installed: boolean; running: boolean; logPath: string } {
  const defaultLogPath = path.join(os.homedir(), 'logs', 'nvpn.log');
  const hasBinary = cmdOk('command -v nvpn');
  if (!hasBinary) return { installed: false, running: false, logPath: defaultLogPath };

  try {
    const out = execSync('nvpn status --json', { stdio: 'pipe', timeout: 2000 }).toString();
    const data: any = JSON.parse(out);
    const logFile = data?.daemon?.log_file;
    return {
      installed: true,
      running:   Boolean(data?.daemon?.running),
      logPath:   (typeof logFile === 'string' && logFile) ? logFile : defaultLogPath,
    };
  } catch {
    // Binary exists but status failed — daemon probably not running (nvpn
    // errors out when it can't reach its socket). Report installed + not
    // running; banner will tell the user how to start it.
    return { installed: true, running: false, logPath: defaultLogPath };
  }
}

function probeServiceHealth(service: LogService): ServiceHealth {
  let logPath = {
    relay:    path.join(os.homedir(), 'logs', 'nostr-rs-relay.log'),
    watchdog: path.join(os.homedir(), 'logs', 'watchdog.log'),
    vpn:      path.join(os.homedir(), 'logs', 'nvpn.log'),
  }[service];

  let installed = false;
  let running   = false;

  if (service === 'vpn') {
    const s = probeNvpn();
    installed = s.installed;
    running   = s.running;
    logPath   = s.logPath;  // nvpn's own log location, from its status JSON
  } else if (process.platform === 'darwin') {
    const label = service === 'relay' ? 'com.nostr-station.relay' : 'com.nostr-station.watchdog';
    const mode  = service === 'watchdog' ? 'interval' : 'continuous';
    ({ installed, running } = launchctlState(label, mode));
  } else if (process.platform === 'linux') {
    const unit = service === 'relay' ? 'nostr-relay.service' : 'nostr-watchdog.timer';
    installed = cmdOk(`systemctl --user cat ${unit}`) || cmdOk(`systemctl cat ${unit}`);
    running   = cmdOk(`systemctl --user is-active --quiet ${unit}`)
             || cmdOk(`systemctl is-active --quiet ${unit}`);
  }

  let logMtimeMs: number | null = null;
  let logExists = false;
  try {
    const st = fs.statSync(logPath);
    logExists = true;
    logMtimeMs = st.mtimeMs;
  } catch { /* missing file — logExists stays false */ }

  const threshold = STALE_MS[service];
  const stale = threshold !== undefined
    && running && logExists && logMtimeMs !== null
    && (Date.now() - logMtimeMs) > threshold;

  return { service, installed, running, logPath, logExists, logMtimeMs, stale };
}

async function deriveKeychainNpub(
  slot: 'watchdog-nsec' | 'seed-nsec',
): Promise<string | undefined> {
  try {
    const nsec = await getKeychain().retrieve(slot);
    if (!nsec || !nsec.startsWith('nsec')) return undefined;
    const d = nip19.decode(nsec);
    if (d.type !== 'nsec') return undefined;
    const pk = getPublicKey(d.data as Uint8Array);
    return nip19.npubEncode(pk);
  } catch { return undefined; }
}

const deriveWatchdogNpub = () => deriveKeychainNpub('watchdog-nsec');

async function streamLogs(
  service: LogService,
  res: http.ServerResponse,
  req: http.IncomingMessage,
): Promise<void> {
  res.writeHead(200, {
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
  });

  const health = probeServiceHealth(service);
  if (service === 'watchdog') {
    health.watchdogNpub = await deriveWatchdogNpub();
  }
  res.write(`data: ${JSON.stringify({ status: health })}\n\n`);

  if (!health.logExists) {
    // Keep the connection alive so the client can keep rendering its banner;
    // closing here made the EventSource fire onerror and log "[stream closed]",
    // which buried the status guidance under a false failure message.
    const hb = setInterval(() => {
      try { res.write(': heartbeat\n\n'); } catch { clearInterval(hb); }
    }, 15_000);
    const done = () => { clearInterval(hb); try { res.end(); } catch {} };
    req.on('close', done);
    req.on('error', done);
    return;
  }

  const tail = spawn('tail', ['-f', '-n', '200', health.logPath], { stdio: ['ignore', 'pipe', 'pipe'] });

  const sendLines = (chunk: Buffer) => {
    const lines = chunk.toString().split('\n').filter(Boolean);
    if (lines.length) res.write(`data: ${JSON.stringify({ lines })}\n\n`);
  };
  tail.stdout.on('data',  sendLines);
  tail.stderr.on('data',  c => res.write(`data: ${JSON.stringify({ error: c.toString() })}\n\n`));
  tail.on('close', () => { try { res.end(); } catch {} });

  const cleanup = () => { try { tail.kill(); } catch {} };
  req.on('close', cleanup);
  req.on('error', cleanup);
}

// ── Provider config writer ────────────────────────────────────────────────────
//
// When the dashboard switches AI provider, we rewrite ~/.claude_env (baseUrl
// + model) and, if an api key is supplied, update the single 'ai-api-key'
// keychain slot. The CLI keychain lib only has one slot — provider switching
// *overwrites* the key on purpose. A client that switches away from a hosted
// provider without providing a new key will hit the "not configured" state
// until a key is stored via `nostr-station keychain set ai-api-key`.

const PROVIDERS: Record<string, { baseUrl: string; defaultModel: string; bareKey?: string }> = {
  anthropic:    { baseUrl: '',                                defaultModel: 'claude-opus-4-6' },
  openrouter:   { baseUrl: 'https://openrouter.ai/api/v1',    defaultModel: 'anthropic/claude-sonnet-4' },
  'opencode-zen': { baseUrl: 'https://opencode.ai/zen/v1',     defaultModel: 'claude-opus-4-6' },
  routstr:      { baseUrl: 'https://api.routstr.com/v1',      defaultModel: 'claude-sonnet-4' },
  ppq:          { baseUrl: 'https://api.ppq.ai/v1',           defaultModel: 'claude-sonnet-4' },
  ollama:       { baseUrl: 'http://localhost:11434/v1',       defaultModel: 'llama3.2', bareKey: 'ollama' },
  lmstudio:     { baseUrl: 'http://localhost:1234/v1',        defaultModel: 'default',  bareKey: 'lm-studio' },
  maple:        { baseUrl: 'http://localhost:8081/v1',        defaultModel: 'claude-sonnet-4', bareKey: 'maple-desktop-auto' },
  custom:       { baseUrl: '',                                defaultModel: 'default' },
};

async function setProviderConfig(body: any): Promise<{ ok: boolean; error?: string }> {
  const provider = String(body.provider || '');
  const model    = String(body.model || '');
  const apiKey   = typeof body.apiKey === 'string' ? body.apiKey : undefined;
  const baseUrlOverride = typeof body.baseUrl === 'string' ? body.baseUrl : undefined;

  const spec = PROVIDERS[provider];
  if (!spec) return { ok: false, error: `unknown provider: ${provider}` };
  const baseUrl = spec.baseUrl || baseUrlOverride || '';

  // Rewrite ~/.claude_env — preserve unrelated lines if present.
  const envPath = path.join(os.homedir(), '.claude_env');
  let existing = '';
  try { existing = fs.readFileSync(envPath, 'utf8'); } catch {}

  const resolvedModel = model || spec.defaultModel;
  const lines = existing.split('\n').filter(l =>
    !l.startsWith('export ANTHROPIC_BASE_URL=') &&
    !l.startsWith('export CLAUDE_MODEL=') &&
    l.trim() !== '',
  );
  if (baseUrl) lines.push(`export ANTHROPIC_BASE_URL="${baseUrl}"`);
  lines.push(`export CLAUDE_MODEL="${resolvedModel}"`);

  try {
    fs.writeFileSync(envPath, lines.join('\n') + '\n', { mode: 0o600 });
  } catch (e: any) {
    return { ok: false, error: `failed to write ~/.claude_env: ${e.message}` };
  }

  // Update keychain: either a user-supplied key, or a bare sentinel for
  // local-auth providers (ollama/lm-studio/maple) so chat works out of the box.
  if (apiKey && apiKey.length > 0) {
    try { await getKeychain().store('ai-api-key', apiKey); }
    catch (e: any) { return { ok: false, error: `keychain write failed: ${e.message}` }; }
  } else if (spec.bareKey) {
    try { await getKeychain().store('ai-api-key', spec.bareKey); } catch {}
  }

  return { ok: true };
}

// ── Identity profile lookup ───────────────────────────────────────────────────
//
// Runs `nak req -k 0 -a <hex> <relays…>` with a short cap; nak streams until
// killed, so we collect events for a fixed window then pick the newest. The
// result is memoized for 5 minutes to keep drawer-opens snappy.

interface Profile {
  npub: string;
  hex:  string;
  name?: string;
  about?: string;
  picture?: string;
  nip05?: string;
  nip05Verified?: boolean;
  cachedAt: number;
}

const PROFILE_CACHE = new Map<string, Profile>();
const PROFILE_TTL_MS = 5 * 60 * 1000;

function npubToHexLocal(npub: string): string {
  if (/^[0-9a-f]{64}$/.test(npub)) return npub;
  try {
    const out = execFileSync('nak', ['decode', npub], { stdio: 'pipe' }).toString().trim();
    return /^[0-9a-f]{64}$/.test(out) ? out : '';
  } catch { return ''; }
}

function hexToNpubLocal(hex: string): string {
  if (/^npub1/.test(hex)) return hex;
  try {
    const out = execFileSync('nak', ['encode', 'npub', hex], { stdio: 'pipe' }).toString().trim();
    return out || hex;
  } catch { return hex; }
}

async function fetchNip05(name: string, domain: string, expectedHex: string): Promise<boolean> {
  try {
    const url = `https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(name)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return false;
    const data = await res.json() as { names?: Record<string, string> };
    const got = data.names?.[name];
    return typeof got === 'string' && got.toLowerCase() === expectedHex.toLowerCase();
  } catch { return false; }
}

// Fetch a kind-0 event from one relay via raw WebSocket.
// Resolves with the event (or null on timeout/error/EOSE-with-no-match).
function fetchKind0FromRelay(relayUrl: string, hex: string, timeoutMs: number): Promise<any | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ev: any | null) => {
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
    const subId = 'ns-profile-' + Math.random().toString(36).slice(2, 8);

    ws.addEventListener('open', () => {
      try {
        ws.send(JSON.stringify(['REQ', subId, { authors: [hex], kinds: [0], limit: 1 }]));
      } catch { finish(null); }
    });
    ws.addEventListener('message', (m: any) => {
      try {
        const msg = JSON.parse(typeof m.data === 'string' ? m.data : m.data.toString());
        if (Array.isArray(msg)) {
          if (msg[0] === 'EVENT' && msg[1] === subId && msg[2]?.kind === 0) finish(msg[2]);
          else if (msg[0] === 'EOSE' && msg[1] === subId) finish(null);
        }
      } catch {}
    });
    ws.addEventListener('error', () => finish(null));
    ws.addEventListener('close', () => finish(null));
  });
}

async function lookupProfile(npubOrHex: string, relays: string[]): Promise<Profile> {
  const hex = npubToHexLocal(npubOrHex);
  if (!hex) throw new Error('could not resolve npub/hex');
  const npub = hexToNpubLocal(hex);
  const cacheKey = hex;

  const cached = PROFILE_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < PROFILE_TTL_MS) return cached;

  const profile: Profile = { npub, hex, cachedAt: Date.now() };
  if (relays.length === 0) { PROFILE_CACHE.set(cacheKey, profile); return profile; }

  // Query all relays in parallel; take the newest kind-0 that answers.
  // Each relay gets a 5s budget. Promise.all means we wait for the slowest
  // relay (or its timeout), but since all run in parallel the total cap
  // is still ~5s.
  const results = await Promise.all(
    relays.map(r => fetchKind0FromRelay(r, hex, 5000)),
  );
  const events = results.filter(Boolean);

  const newest = events
    .filter((e: any) => e && e.kind === 0 && typeof e.content === 'string')
    .sort((a: any, b: any) => (b.created_at || 0) - (a.created_at || 0))[0];

  if (newest) {
    try {
      const meta = JSON.parse(newest.content);
      if (typeof meta.name    === 'string') profile.name    = meta.name;
      if (typeof meta.about   === 'string') profile.about   = meta.about;
      if (typeof meta.picture === 'string') profile.picture = meta.picture;
      if (typeof meta.nip05   === 'string') profile.nip05   = meta.nip05;
    } catch {}
  }

  if (profile.nip05) {
    const at = profile.nip05.indexOf('@');
    const name   = at >= 0 ? profile.nip05.slice(0, at) : '_';
    const domain = at >= 0 ? profile.nip05.slice(at + 1) : profile.nip05;
    profile.nip05Verified = await fetchNip05(name, domain, hex);
  }

  PROFILE_CACHE.set(cacheKey, profile);
  return profile;
}

function bustProfileCache(): void { PROFILE_CACHE.clear(); }

// ── Exec streaming (whitelisted commands over SSE) ────────────────────────────
//
// Commands are keyed by a short string; we never interpolate user input into
// the argv. Each command spawns via execFile-equivalent (spawn with a fixed
// argv array) and streams stdout+stderr as JSON-per-SSE-frame:
//   data: {"line":"<text>","stream":"stdout"|"stderr"}
//   data: {"done":true,"code":<int>}
//
// The dashboard opens a modal that renders these lines into a terminal view.

// Existing streaming-exec routes (publish, doctor, deploy…) pass CLI_BIN
// to `node` and assume it exists as dist/cli.js. That breaks when the
// dashboard is running in dev via `tsx src/cli.tsx chat` — cli.js never
// gets built in that workflow. For the terminal panel we prefer a resolver
// that picks whichever entrypoint actually exists and pairs it with the
// matching runner (node + cli.js, or tsx + cli.tsx). CLI_BIN stays for the
// legacy SSE call sites that already expect a Node+script pair; a dev who
// exercises them is expected to have run `npm run build` at least once.
const CLI_BIN = path.resolve(here, '..', 'cli.js');
const CLI_TSX = path.resolve(here, '..', '..', 'src', 'cli.tsx');
const TSX_BIN = path.resolve(here, '..', '..', 'node_modules', '.bin', 'tsx');
// Detect dev layout by checking where this module itself lives. When the
// web-server is being run from src/lib/ (tsx-hosted), prefer spawning our
// CLI subcommands from src/cli.tsx too — otherwise edits under src/ won't
// land until the user runs `npm run build`. In prod (dist/lib/), we always
// prefer the compiled cli.js + node pair.
const IS_DEV = here.includes(`${path.sep}src${path.sep}lib`);
const CLI_SPAWN = (!IS_DEV && fs.existsSync(CLI_BIN))
  ? { bin: process.execPath, prefix: [CLI_BIN] }
  : { bin: TSX_BIN,          prefix: [CLI_TSX] };

type CmdSpec = { bin: string; args: string[]; env?: Record<string, string> };
function cmdSpecFor(key: string, slug?: string): CmdSpec | null {
  // Whitelisted installs: these match src/lib/install.ts exports. We invoke
  // the CLI rather than the lib functions directly so the Ink install wizard
  // writes legible text lines (the wizard itself respects NO_COLOR + --plain
  // where applicable — see Doctor.tsx for the pattern).
  const INSTALL_TARGETS: Record<string, string[]> = {
    'nak':       ['doctor', '--fix'],   // Doctor --fix reinstalls missing bins
    'relay':     ['doctor', '--fix'],
    'claude':    ['doctor', '--fix'],
    'nsyte':     ['doctor', '--fix'],
    'stacks':    ['doctor', '--fix'],
    'gh':        ['doctor', '--fix'],
    'ngit':      ['doctor', '--fix'],
    'nvpn':      ['doctor', '--fix'],
  };

  switch (key) {
    case 'doctor': return { bin: process.execPath, args: [CLI_BIN, 'doctor', '--plain'], env: { NO_COLOR: '1', TERM: 'dumb' } };
    case 'publish': return { bin: process.execPath, args: [CLI_BIN, 'publish', '--yes'], env: { NO_COLOR: '1', TERM: 'dumb' } };
    case 'deploy': return { bin: process.execPath, args: [CLI_BIN, 'nsite', 'deploy', '--yes'], env: { NO_COLOR: '1', TERM: 'dumb' } };
    case 'git-pull': return { bin: 'git', args: ['pull', '--no-rebase', '--ff-only'] };
    case 'install': {
      const t = INSTALL_TARGETS[slug || ''];
      if (!t) return null;
      return { bin: process.execPath, args: [CLI_BIN, ...t], env: { NO_COLOR: '1', TERM: 'dumb' } };
    }
  }
  return null;
}

function streamExec(spec: CmdSpec, res: http.ServerResponse, req: http.IncomingMessage, cwd?: string, prelude?: object): void {
  res.writeHead(200, {
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
  });
  if (prelude) {
    try { res.write(`data: ${JSON.stringify(prelude)}\n\n`); } catch {}
  }
  const child = spawn(spec.bin, spec.args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...(spec.env || {}) },
    cwd: cwd || undefined,
  });

  const emit = (payload: object) => {
    try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch {}
  };
  const pushStream = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
    const lines = chunk.toString().split('\n');
    for (const line of lines) {
      if (line.length) emit({ line, stream });
    }
  };
  child.stdout.on('data', pushStream('stdout'));
  child.stderr.on('data', pushStream('stderr'));
  child.on('close', (code) => {
    emit({ done: true, code });
    try { res.end(); } catch {}
  });
  child.on('error', (e) => {
    emit({ line: String(e.message || e), stream: 'stderr' });
    emit({ done: true, code: -1 });
    try { res.end(); } catch {}
  });

  const cleanup = () => { try { child.kill(); } catch {} };
  req.on('close', cleanup);
  req.on('error', cleanup);
}

// Emits a single SSE stderr line + done frame so the exec modal renders a
// readable error exactly like a real command failure would. Used for
// preflight checks (e.g. missing git remote) where we want to skip the
// spawn entirely but keep the UX consistent with streamed command failures.
function streamExecError(res: http.ServerResponse, req: http.IncomingMessage, message: string): void {
  res.writeHead(200, {
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
  });
  const emit = (payload: object) => {
    try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch {}
  };
  emit({ line: message, stream: 'stderr' });
  emit({ done: true, code: 1 });
  try { res.end(); } catch {}
  const noop = () => {};
  req.on('close', noop);
  req.on('error', noop);
}

// ── Relay database management ─────────────────────────────────────────────────

function relayDbPaths(): string[] {
  const s = readRelaySettings();
  if (!s || !s.dataDir) return [];
  return [
    path.join(s.dataDir, 'nostr.db'),
    path.join(s.dataDir, 'nostr.db-wal'),
    path.join(s.dataDir, 'nostr.db-shm'),
  ];
}

function relayDbStats(): { sizeBytes: number; exists: boolean; path: string | null } {
  const paths = relayDbPaths();
  const main  = paths[0];
  if (!main || !fs.existsSync(main)) return { sizeBytes: 0, exists: false, path: null };
  let size = 0;
  for (const p of paths) {
    try { size += fs.statSync(p).size; } catch {}
  }
  return { sizeBytes: size, exists: true, path: main };
}

async function wipeRelayDatabase(): Promise<{ ok: boolean; error?: string }> {
  try { execSync(serviceCmd('stop'), { stdio: 'pipe' }); } catch {}
  await wait(600);
  const paths = relayDbPaths();
  for (const p of paths) {
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (e: any) {
      return { ok: false, error: `could not remove ${p}: ${e.message}` };
    }
  }
  try { execSync(serviceCmd('start'), { stdio: 'pipe' }); } catch (e: any) {
    return { ok: false, error: `restart failed: ${e.message}` };
  }
  await wait(1500);
  return { ok: true };
}

function exportRelayEvents(): Promise<{ ok: boolean; file?: string; error?: string }> {
  return new Promise((resolve) => {
    const dir = path.join(os.homedir(), 'nostr-exports');
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const file  = path.join(dir, `relay-events-${stamp}.jsonl`);
    const out   = fs.createWriteStream(file);
    const child = spawn('nak', ['req', '--stream', 'ws://localhost:8080'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let closed = false;
    const finish = (ok: boolean, err?: string) => {
      if (closed) return;
      closed = true;
      try { child.kill(); } catch {}
      try { out.end(); } catch {}
      resolve({ ok, file: ok ? file : undefined, error: err });
    };
    child.stdout.on('data', chunk => out.write(chunk));
    child.on('error', e => finish(false, String(e.message)));
    // nak --stream doesn't exit on its own; cap the export at 3 seconds —
    // local relays either have all events by then or we're exporting a
    // live feed which the user would cancel manually. A smarter cap
    // (EOSE detection) can come later.
    setTimeout(() => finish(true), 3000);
  });
}

// ── Server ────────────────────────────────────────────────────────────────────

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
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          provider:   meta.provider,
          model:      meta.model,
          baseUrl:    meta.baseUrl,
          configured: meta.configured,
          reason:     meta.reason,
          hasContext: contextExists(),
        }));
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

      if (url === '/api/relay-config' && method === 'GET') {
        await serveRelayConfig(res);
        return;
      }

      if (url === '/api/relay-config' && method === 'POST') {
        let parsed: any = {};
        try { parsed = JSON.parse(await readBody(req)); }
        catch { res.writeHead(400); res.end('bad json'); return; }
        const errors: string[] = [];
        if (typeof parsed.auth === 'boolean')   if (!setAuthFlag('nip42_auth', parsed.auth)) errors.push('could not write nip42_auth');
        if (typeof parsed.dmAuth === 'boolean') if (!setAuthFlag('nip42_dms',  parsed.dmAuth)) errors.push('could not write nip42_dms');
        if (errors.length === 0) {
          // Apply changes with a restart — same pattern as CLI.
          try {
            execSync(serviceCmd('stop'), { stdio: 'pipe' });
            await wait(400);
            execSync(serviceCmd('start'), { stdio: 'pipe' });
          } catch {}
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: errors.length === 0, errors }));
        return;
      }

      if (url === '/api/config/set' && method === 'POST') {
        let parsed: any = {};
        try { parsed = JSON.parse(await readBody(req)); }
        catch { res.writeHead(400); res.end('bad json'); return; }
        const result = await setProviderConfig(parsed);
        res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }

      const relayMatch = url.match(/^\/api\/relay\/(start|stop|restart)$/);
      if (relayMatch && method === 'POST') {
        await relayAction(relayMatch[1] as 'start' | 'stop' | 'restart', res);
        return;
      }

      if (url === '/api/relay/whitelist/add' && method === 'POST') {
        let parsed: any = {};
        try { parsed = JSON.parse(await readBody(req)); }
        catch { res.writeHead(400); res.end('bad json'); return; }
        const npub = String(parsed.npub || '').trim();
        // Guard: only accept npub or 64-hex. addToWhitelist accepts both, but
        // validating here gives a cleaner error to the caller.
        if (!/^npub1[a-z0-9]{58,}$/.test(npub) && !/^[0-9a-f]{64}$/.test(npub)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'invalid npub or hex key' }));
          return;
        }
        const r = addToWhitelist(npub);
        // Apply via restart so the new whitelist entry takes effect.
        if (r.ok && !r.already) { try { execSync(serviceCmd('stop'), { stdio: 'pipe' }); await wait(400); execSync(serviceCmd('start'), { stdio: 'pipe' }); } catch {} }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(r));
        return;
      }

      if (url === '/api/relay/whitelist/remove' && method === 'POST') {
        let parsed: any = {};
        try { parsed = JSON.parse(await readBody(req)); }
        catch { res.writeHead(400); res.end('bad json'); return; }
        const npub = String(parsed.npub || '').trim();
        if (!npub) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'missing npub' }));
          return;
        }
        const r = removeFromWhitelist(npub);
        if (r.ok) { try { execSync(serviceCmd('stop'), { stdio: 'pipe' }); await wait(400); execSync(serviceCmd('start'), { stdio: 'pipe' }); } catch {} }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(r));
        return;
      }

      if (url === '/api/relay/database/stats' && method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(relayDbStats()));
        return;
      }
      if (url === '/api/relay/database/wipe' && method === 'POST') {
        const r = await wipeRelayDatabase();
        res.writeHead(r.ok ? 200 : 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(r));
        return;
      }
      if (url === '/api/relay/database/export' && method === 'POST') {
        const r = await exportRelayEvents();
        res.writeHead(r.ok ? 200 : 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(r));
        return;
      }

      // ── Projects ───────────────────────────────────────────────────────
      if (url === '/api/projects' && method === 'GET') {
        // Annotate each project with two derived flags:
        //   - stacksProject — has stack.json (gates Dork/dev/deploy).
        //   - pathMissing   — path was recorded but the dir no longer
        //                     exists on disk (user deleted the folder
        //                     outside nostr-station, or scaffold
        //                     failed between mkdir and register). The
        //                     UI uses this to paint the card red and
        //                     guide the user toward Remove.
        // Both are cheap fs checks — list size is single-digit on any
        // install we've seen.
        const annotated = readProjects().map(p => ({
          ...p,
          stacksProject: isStacksProject(p),
          pathMissing:   !!p.path && !fs.existsSync(p.path),
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(annotated));
        return;
      }
      if (url === '/api/projects' && method === 'POST') {
        let parsed: any = {};
        try { parsed = JSON.parse(await readBody(req)); }
        catch { res.writeHead(400); res.end('bad json'); return; }
        const r = createProject(parsed);
        if (!r.ok) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: r.error }));
          return;
        }
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(r.project));
        return;
      }
      if (url === '/api/projects/detect' && method === 'POST') {
        let parsed: any = {};
        try { parsed = JSON.parse(await readBody(req)); }
        catch { res.writeHead(400); res.end('bad json'); return; }
        const p = String(parsed.path || '').trim();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(detectPath(p)));
        return;
      }

      // New-project scaffold flow — two endpoints. /check is a cheap
      // synchronous pre-flight the client uses to decide whether to open
      // the collision modal ("directory exists — adopt it instead?") or
      // proceed to the streaming scaffold. /new itself runs long (npm
      // install inside mkstack) so it emits SSE in the same frame shape
      // as /api/exec/install/* — openExecModal can render it directly.
      // Sanitized read of Stacks's config — exposes which providers
      // have a configured key (id only — never the key itself) so the
      // Config panel's Stacks AI section can show "configured" status
      // without the user needing to leave the dashboard. Stacks stores
      // its config at ~/Library/Preferences/stacks/config.json on macOS;
      // path differs on linux but stacks resolves it itself when the
      // user runs stacks configure.
      if (url === '/api/stacks/config' && method === 'GET') {
        const candidates = [
          path.join(os.homedir(), 'Library', 'Preferences', 'stacks', 'config.json'),
          path.join(os.homedir(), '.config', 'stacks', 'config.json'),
        ];
        let cfg: any = null;
        let foundAt: string | null = null;
        for (const p of candidates) {
          try {
            const raw = fs.readFileSync(p, 'utf8');
            cfg = JSON.parse(raw);
            foundAt = p;
            break;
          } catch { /* try next */ }
        }
        const providers = cfg && cfg.providers && typeof cfg.providers === 'object'
          ? Object.keys(cfg.providers)
          : [];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          configured: providers.length > 0,
          providers,                  // ids only — no keys, no baseURLs
          configPath: foundAt,
          recentModels: Array.isArray(cfg?.recentModels) ? cfg.recentModels : [],
        }));
        return;
      }

      if (url === '/api/projects/new/check' && method === 'POST') {
        let parsed: any = {};
        try { parsed = JSON.parse(await readBody(req)); }
        catch { res.writeHead(400); res.end('bad json'); return; }
        const report = checkCollision(String(parsed.name || ''));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(report));
        return;
      }
      if (url === '/api/projects/new' && method === 'POST') {
        let parsed: any = {};
        try { parsed = JSON.parse(await readBody(req)); }
        catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'bad json' }));
          return;
        }
        const name = String(parsed.name || '');

        // Two source types here: 'local-only' (plain git init) and
        // 'git-url' (git clone + freshen). ngit clones go through the
        // dedicated /api/ngit/clone path because they validate the
        // nostr:// / naddr1 URL format and use the existing Scan flow.
        // Default to local-only on unknown / missing source so we never
        // accidentally shell out to something unexpected.
        const src = parsed.source;
        let source: import('./project-scaffold.js').ScaffoldSource = { type: 'local-only' };
        if (src && typeof src === 'object') {
          if (src.type === 'git-url' && typeof src.url === 'string') {
            source = { type: 'git-url', url: src.url };
          } else if (src.type === 'local-only') {
            source = { type: 'local-only' };
          }
        }
        // Identity: station-default unless the client explicitly opts
        // the project into a project-specific npub + optional bunker.
        // scaffoldProject + projects.validateInput own the validation
        // (nsec rejection, bunker URL format); we just shape the object.
        let identity: import('./project-scaffold.js').ScaffoldIdentity = {
          useDefault: true, npub: null, bunkerUrl: null,
        };
        const rawIdent = parsed.identity;
        if (rawIdent && typeof rawIdent === 'object' && rawIdent.useDefault === false) {
          identity = {
            useDefault: false,
            npub:       typeof rawIdent.npub === 'string'      ? rawIdent.npub.trim()      : null,
            bunkerUrl:  typeof rawIdent.bunkerUrl === 'string' ? rawIdent.bunkerUrl.trim() : null,
          };
        }
        await scaffoldProject(name, source, res, identity);
        return;
      }

      const projMatch = url.match(/^\/api\/projects\/([a-f0-9-]{10,})(?:\/(.*))?$/);
      if (projMatch) {
        const id = projMatch[1];
        const tail = projMatch[2] || '';
        const project = getProject(id);
        if (!project) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'project not found' }));
          return;
        }

        if (tail === '' && method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ...project, stacksProject: isStacksProject(project) }));
          return;
        }
        if (tail === '' && method === 'PATCH') {
          let parsed: any = {};
          try { parsed = JSON.parse(await readBody(req)); }
          catch { res.writeHead(400); res.end('bad json'); return; }
          const r = updateProject(id, parsed);
          if (!r.ok) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: r.error }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(r.project));
          return;
        }
        if (tail === '' && method === 'DELETE') {
          const r = deleteProject(id);
          res.writeHead(r.ok ? 200 : 404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: r.ok }));
          return;
        }

        // Hard delete: rm -rf the project path, then unregister. POST
        // (not DELETE) because the operation is irreversible and the
        // UI path uses a type-to-confirm dialog. Safety guardrails:
        //   - path must be set (nsite-only projects have none; refuse)
        //   - path must be under the user's HOME (refuse system paths)
        //   - path must not BE the home directory itself
        //   - path must be a real directory that resolves without
        //     escaping via symlinks (realpath check + prefix match)
        // Failures surface as 4xx with a message; the rm itself is
        // best-effort — even if it partially fails, we unregister so
        // the user isn't stuck with a broken card pointing at a
        // now-partial path. Unusual but the path of least surprise.
        if (tail === 'purge' && method === 'POST') {
          const target = project.path || '';
          const home = process.env.HOME || os.homedir();
          if (!target) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'project has no local path to delete' }));
            return;
          }
          // Resolve both sides to absolute real paths. If realpath
          // fails (target missing), fall back to the raw path — the
          // under-HOME check still protects against nonsense input,
          // and rm -rf on a missing path is a no-op.
          let realTarget = target;
          let realHome   = home;
          try { realTarget = fs.realpathSync(target); } catch {}
          try { realHome   = fs.realpathSync(home);   } catch {}
          const normalizedTarget = path.resolve(realTarget);
          const normalizedHome   = path.resolve(realHome);
          if (normalizedTarget === normalizedHome
              || !normalizedTarget.startsWith(normalizedHome + path.sep)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              error: `refusing to delete ${normalizedTarget}: path must be under ${normalizedHome}`,
            }));
            return;
          }
          let rmError: string | null = null;
          try {
            fs.rmSync(normalizedTarget, { recursive: true, force: true });
          } catch (e: any) {
            rmError = e?.message || 'rm failed';
          }
          const r = deleteProject(id);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            ok:          r.ok,
            unregistered: r.ok,
            removedPath:  rmError ? null : normalizedTarget,
            rmError,
          }));
          return;
        }

        if (tail === 'git/status' && method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(projectGitStatus(project.path || '')));
          return;
        }
        if (tail === 'git/log' && method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(projectGitLog(project.path || '')));
          return;
        }
        if (tail === 'git/pull' && method === 'POST') {
          if (!project.path) { res.writeHead(400); res.end('project has no local path'); return; }
          streamExec({ bin: 'git', args: ['pull', '--no-rebase', '--ff-only'] }, res, req, project.path);
          return;
        }
        if (tail === 'git/push' && method === 'POST') {
          if (!project.path) { res.writeHead(400); res.end('project has no local path'); return; }
          // Route based on which capabilities are enabled.
          // git + ngit → nostr-station publish --yes (handles both remotes)
          // git only   → git push origin HEAD
          // ngit only  → ngit push
          let spec: CmdSpec;
          if (project.capabilities.git && project.capabilities.ngit) {
            spec = { bin: process.execPath, args: [CLI_BIN, 'publish', '--yes'], env: { NO_COLOR: '1', TERM: 'dumb' } };
          } else if (project.capabilities.git) {
            // Preflight: if the repo has no `origin` remote, git push would
            // fail with a cryptic "fatal: 'origin' does not appear…". Surface
            // a readable error through the existing SSE modal instead.
            try {
              execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: project.path, stdio: 'pipe' });
            } catch {
              streamExecError(res, req, "No git remote named 'origin' — add one in project Settings.");
              return;
            }
            spec = { bin: 'git', args: ['push', 'origin', 'HEAD'] };
          } else if (project.capabilities.ngit) {
            spec = { bin: 'ngit', args: ['push'] };
          } else {
            res.writeHead(400); res.end('no push-capable capability enabled'); return;
          }
          streamExec(spec, res, req, project.path);
          return;
        }

        if (tail === 'stacks/deploy' && method === 'POST') {
          if (!project.path) {
            streamExecError(res, req, 'project has no local path');
            return;
          }
          if (!isStacksProject(project)) {
            streamExecError(res, req, 'not a Stacks project (no stack.json found)');
            return;
          }
          // `npm run deploy` is mkstack's deploy script — bundles, uploads
          // to Blossom, publishes Nostr metadata, returns a NostrDeploy
          // URL. We stream the output as-is; URL parsing + persisting to
          // project.nsite.url is deferred to a follow-up once we've seen
          // the exact stdout format on a real deploy. For now, the user
          // sees the live URL in the exec modal output.
          streamExec(
            { bin: 'npm', args: ['run', 'deploy'] },
            res, req, project.path,
            { line: `$ npm run deploy  (cwd: ${project.path})`, stream: 'stdout' },
          );
          return;
        }

        if (tail === 'ngit/status' && method === 'GET') {
          // Mask bunker URL to domain-only for display.
          const bunker = project.identity.bunkerUrl;
          let bunkerDomain: string | null = null;
          if (bunker) {
            try { bunkerDomain = new URL(bunker.replace(/^bunker:/, 'https:')).host; }
            catch { bunkerDomain = 'bunker'; }
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            remote: project.remotes.ngit,
            bunkerDomain,
            useDefault: project.identity.useDefault,
          }));
          return;
        }
        if (tail === 'ngit/push' && method === 'POST') {
          if (!project.path) { res.writeHead(400); res.end('project has no local path'); return; }
          streamExec({ bin: 'ngit', args: ['push'] }, res, req, project.path);
          return;
        }

        if (tail === 'ngit/init' && method === 'POST') {
          if (!project.path) { res.writeHead(400); res.end('project has no local path'); return; }
          // Relay URL arrives in a JSON body and is validated strictly before
          // being handed to ngit as a fixed argv element. The validator
          // rejects whitespace and any non-ws(s):// scheme, so there's no
          // path for a user string to reach the shell.
          let parsed: any = {};
          try { parsed = JSON.parse(await readBody(req)); }
          catch { res.writeHead(400); res.end('bad json'); return; }
          const raw = String(parsed.relay || '').trim();
          if (!raw || !isValidRelayUrl(raw)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'relay must be a ws:// or wss:// URL' }));
            return;
          }
          streamExec(
            { bin: 'ngit', args: ['init', '--relay', raw], env: { NO_COLOR: '1', TERM: 'dumb' } },
            res, req, project.path,
          );
          return;
        }

        if (tail === 'exec' && method === 'POST') {
          // Whitelisted read-only commands scoped to the project's cwd.
          // Extend the switch below — NEVER interpolate body.cmd into argv.
          let parsed: any = {};
          try { parsed = JSON.parse(await readBody(req)); }
          catch { res.writeHead(400); res.end('bad json'); return; }
          const cmd = String(parsed.cmd || '');
          if (!project.path) { res.writeHead(400); res.end('project has no local path'); return; }
          let spec: CmdSpec | null = null;
          if (cmd === 'git-status') spec = { bin: 'git', args: ['status'] };
          if (!spec) { res.writeHead(400); res.end('unknown exec cmd'); return; }
          streamExec(spec, res, req, project.path);
          return;
        }

        if (tail === 'nsite/deploy' && method === 'POST') {
          const cwd = project.path || process.cwd();
          streamExec(
            { bin: process.execPath, args: [CLI_BIN, 'nsite', 'deploy', '--yes'], env: { NO_COLOR: '1', TERM: 'dumb' } },
            res, req, cwd,
          );
          return;
        }

        res.writeHead(404); res.end('unknown project endpoint');
        return;
      }

      // ── Chat project context ───────────────────────────────────────────
      if (url === '/api/chat/context' && method === 'POST') {
        let parsed: any = {};
        try { parsed = JSON.parse(await readBody(req)); }
        catch { res.writeHead(400); res.end('bad json'); return; }
        const projectId = parsed.projectId ? String(parsed.projectId) : null;
        const project   = projectId ? getProject(projectId) : null;
        if (projectId && !project) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'project not found' }));
          return;
        }
        activeChatProjectId = projectId;
        const { source } = resolveProjectContext(project);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          projectId,
          projectName: project?.name || null,
          source,
        }));
        return;
      }
      const chatCtxMatch = url.match(/^\/api\/chat\/context(?:\/([a-f0-9-]{10,}))?$/);
      if (chatCtxMatch && method === 'GET') {
        const pid = chatCtxMatch[1];
        const project = pid ? getProject(pid) : null;
        if (pid && !project) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'project not found' }));
          return;
        }
        const { content, source } = resolveProjectContext(project);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          projectId: pid || null,
          projectName: project?.name || null,
          content, source,
        }));
        return;
      }

      if (url === '/api/installed' && method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(detectInstalled()));
        return;
      }

      // ── Identity routes ─────────────────────────────────────────────────
      if (url === '/api/identity/config' && method === 'GET') {
        const ident = readIdentity();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          npub:       ident.npub,
          readRelays: ident.readRelays,
          ngitRelay:  ident.ngitRelay || '',
          hasProfile: !!ident.npub,
        }));
        return;
      }

      if (url === '/api/identity/set' && method === 'POST') {
        let parsed: any = {};
        try { parsed = JSON.parse(await readBody(req)); }
        catch { res.writeHead(400); res.end('bad json'); return; }
        // Fields accepted by this route:
        //   - npub          (bootstrap owner)
        //   - ngitRelay     (station-level default for ngit)
        //   - setupComplete (wizard progress marker — see localhostExempt)
        // All optional; handler updates whichever is present.
        const hasNpub     = typeof parsed.npub      === 'string';
        const hasNgitRly  = typeof parsed.ngitRelay === 'string';
        const hasSetup    = typeof parsed.setupComplete === 'boolean';
        if (!hasNpub && !hasNgitRly && !hasSetup) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'nothing to update' }));
          return;
        }
        let npubResult: { ok: boolean; error?: string; npub?: string } | null = null;
        let ngitResult: { ok: boolean; error?: string; ngitRelay?: string } | null = null;
        if (hasNpub) {
          npubResult = setIdentityNpub(String(parsed.npub || '').trim());
          if (npubResult.ok) bustProfileCache();
        }
        if (hasNgitRly) {
          ngitResult = setIdentityNgitRelay(String(parsed.ngitRelay || '').trim());
        }
        if (hasSetup) {
          setSetupComplete(parsed.setupComplete);
        }
        const ok = (!npubResult || npubResult.ok) && (!ngitResult || ngitResult.ok);
        const body: any = { ok };
        if (npubResult) { if (npubResult.npub) body.npub = npubResult.npub; if (npubResult.error) body.error = npubResult.error; }
        if (ngitResult) { if (ngitResult.ngitRelay !== undefined) body.ngitRelay = ngitResult.ngitRelay; if (ngitResult.error) body.error = ngitResult.error; }
        res.writeHead(ok ? 200 : 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
        return;
      }

      if (url === '/api/identity/relays/add' && method === 'POST') {
        let parsed: any = {};
        try { parsed = JSON.parse(await readBody(req)); }
        catch { res.writeHead(400); res.end('bad json'); return; }
        const r = addReadRelay(String(parsed.url || '').trim());
        res.writeHead(r.ok ? 200 : 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(r));
        if (r.ok) bustProfileCache();
        return;
      }

      if (url === '/api/identity/relays/remove' && method === 'POST') {
        let parsed: any = {};
        try { parsed = JSON.parse(await readBody(req)); }
        catch { res.writeHead(400); res.end('bad json'); return; }
        const r = removeReadRelay(String(parsed.url || '').trim());
        bustProfileCache();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(r));
        return;
      }

      // Public read-only profile lookup for the setup wizard. Takes an
      // npub in the query string and resolves it against the default
      // discovery relays. Intentionally does NOT use stored identity
      // state — the wizard runs before identity.json is written.
      if (url.startsWith('/api/identity/profile/preview') && method === 'GET') {
        const qpos = (req.url || '').indexOf('?');
        const qs = qpos >= 0 ? new URLSearchParams((req.url || '').slice(qpos + 1)) : new URLSearchParams();
        const raw = (qs.get('npub') || '').trim();
        if (!raw || !isNpubOrHex(raw) || isNsec(raw)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid npub' }));
          return;
        }
        try {
          const p = await lookupProfile(raw, DEFAULT_READ_RELAYS.slice());
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(p));
        } catch (e: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: String(e.message || e) }));
        }
        return;
      }

      if (url === '/api/identity/profile' && method === 'GET') {
        const ident = readIdentity();
        if (!ident.npub) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ empty: true }));
          return;
        }
        try {
          const p = await lookupProfile(ident.npub, ident.readRelays);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(p));
        } catch (e: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: String(e.message || e) }));
        }
        return;
      }

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
      // Setup wizard Relay stage — performs the full first-install bootstrap
      // for the local relay: dirs, watchdog keypair, relay config.toml,
      // watchdog script, systemd/launchd unit files, and enable --now.
      // Idempotent, so safe to re-run mid-wizard or as a repair path.
      //
      // Gated by localhostExempt during the wizard (setupComplete !== true)
      // and by a normal session afterwards, via the standard middleware —
      // no public-API carveout needed. Assumes the relay BINARY is already
      // installed; the wizard leaves compile/download to `nostr-station
      // onboard` because that step can run 10+ minutes and needs a TTY.
      if (url === '/api/setup/relay/install' && method === 'POST') {
        const ident = readIdentity();
        if (!ident.npub) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'identity.npub is not set — finish the Identity stage first' }));
          return;
        }
        // Optional body — caller can override relay name + fallback relays
        // + extra whitelisted npubs. Empty body is fine; the bootstrap
        // applies the same defaults as the TUI Config phase.
        let parsed: any = {};
        try { parsed = JSON.parse(await readBody(req) || '{}'); }
        catch { /* empty / malformed body — fall through with defaults */ }
        try {
          const platform = detectPlatform();
          const result = await bootstrapRelayServices(platform, {
            npub:           ident.npub,
            relayName:      typeof parsed.relayName      === 'string' ? parsed.relayName      : undefined,
            fallbackRelays: typeof parsed.fallbackRelays === 'string' ? parsed.fallbackRelays : undefined,
            whitelistExtra: typeof parsed.whitelistExtra === 'string' ? parsed.whitelistExtra : undefined,
          });
          // Probe the running relay so the client can short-circuit its own
          // status poll. `isRelayUp()` hits localhost:8080; safe to call even
          // when enable --now failed — just returns false.
          const up = isRelayUp();
          res.writeHead(result.ok ? 200 : 500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ...result, up }));
        } catch (e: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: String(e.message ?? e) }));
        }
        return;
      }

      // nvpn install — mirrors the TUI Services-phase nvpn step but
      // streams the per-step progress back to the browser as
      // newline-delimited JSON so the wizard can render each step live
      // (download → extract → locate → copy → verify → init → service).
      // Long-running (~30–60s with compile, more on slow links), so a
      // synchronous response would look like a freeze.
      //
      // Protocol:
      //   {"type":"progress","step":"<message>"}   — one per onProgress call
      //   {"type":"done","ok":bool,"detail":str}   — final event, then stream closes
      //
      // Gated by the same localhost-exempt wizard window as the rest of
      // /api/setup/*, no separate public-API entry needed. `sudo -n` inside
      // installNostrVpn will fail when the cred cache is cold; the error
      // surfaces in the final "done" event with the nvpn-install.log path so
      // the user can rerun `sudo <cargoBin>/nvpn service install` manually.
      if (url === '/api/setup/nvpn/install' && method === 'POST') {
        res.writeHead(200, {
          'Content-Type':      'application/x-ndjson',
          'Cache-Control':     'no-cache',
          'Connection':        'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        try {
          const platform = detectPlatform();
          const result = await installNostrVpn(platform, (step) => {
            // node's http response.write() is synchronous from our side but
            // the socket may apply backpressure — ignore it, we're emitting
            // <1 event per step so throttling isn't a concern.
            res.write(JSON.stringify({ type: 'progress', step }) + '\n');
          });
          res.write(JSON.stringify({ type: 'done', ok: result.ok, detail: result.detail ?? '' }) + '\n');
        } catch (e: any) {
          res.write(JSON.stringify({ type: 'done', ok: false, detail: String(e.message ?? e) }) + '\n');
        }
        res.end();
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

      if (url === '/api/identity/profile/sync' && method === 'POST') {
        const ident = readIdentity();
        bustProfileCache();
        if (!ident.npub) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ empty: true }));
          return;
        }
        try {
          const p = await lookupProfile(ident.npub, ident.readRelays);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(p));
        } catch (e: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: String(e.message || e) }));
        }
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

      // ── ngit discovery (kind 30617 repo announcements) ─────────────────
      //
      // Queries the station owner's read relays for kind 30617 (NIP-34 repo
      // announcement) events authored by the owner's npub. Results populate
      // the Projects → Discover modal so users can import existing ngit
      // repos as nostr-station Projects.
      //
      // Security: nak is invoked via spawn() with a fixed argv array (no
      // shell), and every arg is either a literal, a bech32-decoded hex
      // pubkey, or a relay URL already validated against `isValidRelayUrl`.
      if (url === '/api/ngit/discover' && method === 'GET') {
        const ident = readIdentity();
        if (!ident.npub) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'identity not configured' }));
          return;
        }
        // Decode via nostr-tools rather than shelling to `nak decode`, which
        // returns JSON (not raw hex) and would smuggle invalid argv into the
        // next step. nip19.decode is also faster and never spawns a process.
        let hex = '';
        if (/^[0-9a-f]{64}$/.test(ident.npub)) {
          hex = ident.npub;
        } else {
          try {
            const d = nip19.decode(ident.npub);
            if (d.type === 'npub' && typeof d.data === 'string') hex = d.data;
          } catch {}
        }
        if (!hex) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'could not decode npub to hex' }));
          return;
        }
        const DEFAULT_DISCOVERY_RELAYS = ['wss://relay.damus.io', 'wss://relay.nostr.band'];
        const relays = (ident.readRelays && ident.readRelays.length
          ? ident.readRelays
          : DEFAULT_DISCOVERY_RELAYS
        ).filter(isValidRelayUrl).slice(0, 8);
        if (relays.length === 0) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ repos: [], empty: true, queried: [] }));
          return;
        }

        const args = ['req', '-k', '30617', '-a', hex, ...relays, '--stream'];
        const child = spawn('nak', args, { stdio: ['ignore', 'pipe', 'pipe'] });

        const repos = new Map<string, any>();
        let buf = '';
        let settled = false;
        const finish = (status: number, body: any) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try { child.kill('SIGTERM'); } catch {}
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(body));
        };

        child.stdout.on('data', (chunk: Buffer) => {
          buf += chunk.toString();
          const lines = buf.split('\n');
          buf = lines.pop() || '';
          for (const line of lines) {
            const s = line.trim();
            if (!s) continue;
            let ev: any;
            try { ev = JSON.parse(s); } catch { continue; }
            if (!ev || ev.kind !== 30617 || !Array.isArray(ev.tags)) continue;
            const dTag = ev.tags.find((t: any[]) => Array.isArray(t) && t[0] === 'd')?.[1];
            if (!dTag) continue;
            const key = `${ev.pubkey}:${dTag}`;
            const prev = repos.get(key);
            if (prev && prev.published_at >= (ev.created_at || 0)) continue;
            const descTag = ev.tags.find((t: any[]) => t[0] === 'description')?.[1] || '';
            const cloneTags = ev.tags
              .filter((t: any[]) => t[0] === 'clone')
              .flatMap((t: any[]) => t.slice(1).filter((x: any) => typeof x === 'string' && x));
            const webTag = ev.tags.find((t: any[]) => t[0] === 'web')?.[1] || '';
            // Compute two nostr-native identifiers for this repo:
            //   - `cloneUrl` in the form git-remote-nostr expects
            //     (`nostr://<npub>/<d-tag>`, per `ngit --help`). This is
            //     what actually works with `git clone`.
            //   - `naddr` for reference / deep-linking; it's not a valid
            //     `git clone` argument on its own.
            // NIP-34 `clone` tags typically carry https/ssh/git URLs,
            // not nostr-native identifiers — we build these ourselves.
            let naddr = '';
            let cloneUrl = '';
            try {
              naddr = nip19.naddrEncode({
                kind: 30617,
                pubkey: ev.pubkey,
                identifier: String(dTag),
                relays: relays.slice(0, 3),
              });
            } catch {}
            try {
              const npub = nip19.npubEncode(ev.pubkey);
              cloneUrl = `nostr://${npub}/${String(dTag)}`;
            } catch {}
            repos.set(key, {
              pubkey: ev.pubkey,
              name: String(dTag),
              description: String(descTag),
              clone: cloneTags,
              web: String(webTag),
              naddr,
              cloneUrl,
              published_at: Number(ev.created_at || 0),
            });
          }
        });

        // --stream never exits on its own; cap at 10s and return whatever
        // we've collected. Enough for typical npub inventories; pagination
        // can come later if users start publishing hundreds of repos.
        const timer = setTimeout(() => {
          const list = Array.from(repos.values()).sort((a, b) => b.published_at - a.published_at);
          finish(200, { repos: list, empty: list.length === 0, queried: relays });
        }, 10000);

        child.on('error', (e) => {
          finish(500, { error: String(e.message || e), repos: [], empty: true, queried: relays });
        });
        child.on('close', () => {
          const list = Array.from(repos.values()).sort((a, b) => b.published_at - a.published_at);
          finish(200, { repos: list, empty: list.length === 0, queried: relays });
        });

        req.on('close', () => { try { child.kill('SIGTERM'); } catch {} });
        return;
      }

      // ── nsite discovery (kind 35128 site manifests) ────────────────────
      //
      // Tells the dashboard whether the station owner has published an
      // nsite (a static site served via nostr) to their read relays, and
      // where to reach it on the public nsite.lol gateway.
      //
      // Two URL forms are relevant (both served by nsite.lol):
      //   - npubUrl: `https://<npub>.nsite.lol` — always resolvable from
      //     just the pubkey; used as the "predicted" URL when no event is
      //     on the read relays yet.
      //   - d-tag URL: `https://<base36(pubkey)><d-tag>.nsite.lol` — the
      //     nicer canonical URL once a 35128 site manifest exists (e.g.
      //     `…6jaredlogan.nsite.lol` for d="jaredlogan"). The 50-char
      //     prefix is the pubkey as a big-endian integer converted to
      //     base36 and left-padded to 50 chars.
      //
      // Kind queried: **35128** — the modern nsite site-manifest
      // convention (one aggregate event per site, parameterized-
      // replaceable by a d-tag slug; `path` tags map file paths to
      // blossom blob hashes). This supersedes the older per-file kind
      // 34128 convention.
      //
      // Multiple sites: one pubkey can publish any number of 35128
      // manifests under different d-tags. We collect all of them
      // (keeping the freshest per d-tag) and return them as `sites[]`.
      // `relayEvent` / `url` mirror the most recent site for simple
      // consumers that want a single headline value.
      //
      // Security: mirrors /api/ngit/discover — nak is spawned via
      // spawn() with a fixed argv (stdio 'ignore' on stdin to prevent the
      // nak-stdin-hang pitfall documented in project memory), the pubkey
      // is bech32-decoded via nostr-tools (never shelled out to nak), and
      // every relay URL is validated against isValidRelayUrl.
      if (url === '/api/nsite/discover' && method === 'GET') {
        const ident = readIdentity();
        if (!ident.npub) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            npubUrl: null, relayEvent: null, url: null, deployed: false,
          }));
          return;
        }
        let hex = '';
        let npubBech32 = '';
        if (/^[0-9a-f]{64}$/.test(ident.npub)) {
          hex = ident.npub;
          try { npubBech32 = nip19.npubEncode(hex); } catch {}
        } else {
          try {
            const d = nip19.decode(ident.npub);
            if (d.type === 'npub' && typeof d.data === 'string') {
              hex = d.data;
              npubBech32 = ident.npub;
            }
          } catch {}
        }
        if (!hex || !npubBech32) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'could not decode npub to hex' }));
          return;
        }
        // Public gateway convention — matches the URLs printed by
        // `nostr-station nsite publish` (see commands/Nsite.tsx). Always
        // resolvable even if no kind 34128 events are on the user's read
        // relays, so we can still show *something* while the relay query
        // runs (or fails).
        const npubUrl = `https://${npubBech32}.nsite.lol`;

        const DEFAULT_DISCOVERY_RELAYS = ['wss://relay.damus.io', 'wss://relay.nostr.band'];
        const relays = (ident.readRelays && ident.readRelays.length
          ? ident.readRelays
          : DEFAULT_DISCOVERY_RELAYS
        ).filter(isValidRelayUrl).slice(0, 8);
        if (relays.length === 0) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            npubUrl, relayEvent: null, url: npubUrl, deployed: false,
          }));
          return;
        }

        // Collects every 35128 event by d-tag (35128 is parameterized-
        // replaceable, so the freshest event per d-tag wins). Returns
        // when the relay query settles or the timeout fires.
        const collectSites = (timeoutMs: number): Promise<Map<string, any>> =>
          new Promise((resolve) => {
            const args = ['req', '-k', '35128', '-a', hex, ...relays, '--stream'];
            const child = spawn('nak', args, { stdio: ['ignore', 'pipe', 'pipe'] });
            const byDTag = new Map<string, any>();
            let buf = '';
            let done = false;
            const finish = () => {
              if (done) return;
              done = true;
              clearTimeout(timer);
              try { child.kill('SIGTERM'); } catch {}
              resolve(byDTag);
            };
            child.stdout.on('data', (chunk: Buffer) => {
              buf += chunk.toString();
              const lines = buf.split('\n');
              buf = lines.pop() || '';
              for (const line of lines) {
                const s = line.trim();
                if (!s) continue;
                let ev: any;
                try { ev = JSON.parse(s); } catch { continue; }
                if (!ev || ev.kind !== 35128) continue;
                // Defense in depth — the `-a <hex>` arg should make nak
                // return only events by this author, but relays occasionally
                // return extras. Reject anything whose pubkey doesn't match
                // so we never display a stranger's nsite as the owner's.
                if (typeof ev.pubkey !== 'string' || ev.pubkey.toLowerCase() !== hex.toLowerCase()) continue;
                const dVal = Array.isArray(ev.tags)
                  ? ev.tags.find((t: any[]) => Array.isArray(t) && t[0] === 'd')?.[1]
                  : undefined;
                if (typeof dVal !== 'string' || !dVal) continue;
                const prev = byDTag.get(dVal);
                if (!prev || Number(ev.created_at || 0) > Number(prev.created_at || 0)) {
                  byDTag.set(dVal, ev);
                }
              }
            });
            const timer = setTimeout(finish, timeoutMs);
            child.on('error', finish);
            child.on('close', finish);
            req.on('close', () => { try { child.kill('SIGTERM'); } catch {} });
          });

        const byDTag = await collectSites(8000);

        // Build canonical nsite.lol URLs. Pubkey is a 256-bit big-endian
        // integer rendered in base36 (lowercase), left-padded to 50 chars
        // so the subdomain prefix is always a fixed width — verified
        // against live examples on the gateway.
        const base36 = BigInt('0x' + hex).toString(36).padStart(50, '0');
        const sites = Array.from(byDTag.values())
          // d-tags must be DNS-safe for the subdomain. Anything exotic is
          // dropped rather than producing a broken URL.
          .filter((ev) => {
            const d = ev.tags.find((t: any[]) => t[0] === 'd')?.[1];
            return typeof d === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(d);
          })
          .map((ev) => {
            const d     = ev.tags.find((t: any[]) => t[0] === 'd')?.[1] as string;
            const title = ev.tags.find((t: any[]) => t[0] === 'title')?.[1];
            return {
              d,
              title: typeof title === 'string' && title ? title : d,
              url:   `https://${base36}${d}.nsite.lol`,
              publishedAt: Number(ev.created_at || 0),
              event: ev,
            };
          })
          // Freshest first — also the order the UI renders them.
          .sort((a, b) => b.publishedAt - a.publishedAt);

        const primary = sites[0] || null;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          npubUrl,
          sites,
          deployed:   sites.length > 0,
          // Convenience mirrors of the primary (most recent) site so
          // simple consumers don't have to re-pick from `sites`.
          relayEvent: primary?.event || null,
          url:        primary?.url || npubUrl,
        }));
        return;
      }

      // ── ngit clone (streams `git clone <naddr> <path>`) ────────────────
      //
      // Pairs with /api/ngit/discover to give Projects → Discover a clean
      // clone step. ngit repos are cloned with the stock `git` binary —
      // ngit installs a protocol helper so `git clone <naddr>` resolves
      // via nostr; there is no `ngit clone` subcommand.
      //
      // Security:
      //   - url must be a nostr://… or naddr1… value (the only forms the
      //     git-remote-nostr helper accepts); anything else is rejected.
      //   - path must resolve under the user's home directory and must
      //     not already exist.
      //   - git is spawned via spawn() with a fixed argv — no shell.
      if (url === '/api/ngit/clone' && method === 'POST') {
        let parsed: any = {};
        try { parsed = JSON.parse(await readBody(req)); }
        catch { res.writeHead(400); res.end('bad json'); return; }
        const rawUrl      = String(parsed.url      || '').trim();
        const rawRepoName = String(parsed.repoName || '').trim();
        if (!rawUrl || !(rawUrl.startsWith('nostr://') || rawUrl.startsWith('naddr1'))) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'url must be a nostr:// URL or naddr1… value' }));
          return;
        }
        // Resolving a naddr to a git-cloneable URL happens in two stages:
        //
        //  (1) Decode the naddr (pubkey hex + d-tag + optional relay hints).
        //      A bare naddr can't be handed to `git clone` directly —
        //      git-remote-nostr only accepts `nostr://<npub>/<d-tag>`.
        //
        //  (2) Fetch the kind-30617 repo announcement from the naddr's
        //      embedded relay hints (plus the user's read relays as
        //      fallback). That announcement carries `clone` tags with
        //      real transport URLs — usually https://git.shakespeare.diy
        //      or https://relay.ngit.dev — which we prefer because
        //      git-remote-nostr can't always find the event via whatever
        //      relays ngit has configured globally.
        //
        // If step (2) finds clone URLs, we hand the https one to `git
        // clone`. If nothing comes back, we fall back to the reconstructed
        // `nostr://<npub>/<d-tag>` and let git-remote-nostr try its luck.
        // The client still records `remotes.ngit = <naddr or nostr://>`
        // so the ngit chip stays correct regardless of transport.
        let cloneUrl = rawUrl;
        if (rawUrl.startsWith('naddr1')) {
          let pubkeyHex = '';
          let dTag = '';
          let relayHints: string[] = [];
          try {
            const decoded = nip19.decode(rawUrl);
            if (decoded.type !== 'naddr' || decoded.data.kind !== 30617) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'naddr must reference a kind-30617 ngit repo announcement' }));
              return;
            }
            pubkeyHex = decoded.data.pubkey;
            dTag = decoded.data.identifier;
            relayHints = Array.isArray(decoded.data.relays) ? decoded.data.relays : [];
          } catch (e: any) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `could not decode naddr: ${e?.message ?? 'invalid encoding'}` }));
            return;
          }

          // Build the relay set. naddr hints go first (the publisher told
          // us where this event lives); user read relays as fallback so
          // we've got some breadth. Cap at 6 to keep nak's connection
          // fanout bounded — one slow relay shouldn't block the rest.
          const ident = readIdentity();
          const userReadRelays = (ident.readRelays || []).filter(isValidRelayUrl);
          const relays = [...relayHints, ...userReadRelays]
            .filter(isValidRelayUrl)
            .filter((r, i, a) => a.indexOf(r) === i) // dedupe preserving order
            .slice(0, 6);

          // Fetch the announcement. nak requires `stdin: 'ignore'` — its
          // req subcommand otherwise blocks on stdin EOF (see memory
          // project_nak_stdin_hang).
          const httpsCloneUrl = await new Promise<string>((resolve) => {
            if (relays.length === 0) { resolve(''); return; }
            const args = ['req', '-k', '30617', '-a', pubkeyHex, '-t', `d=${dTag}`, '-l', '1', ...relays];
            const child = spawn('nak', args, { stdio: ['ignore', 'pipe', 'pipe'] });
            let chunks = '';
            let resolved = false;
            const done = (url: string) => { if (resolved) return; resolved = true; clearTimeout(timer); try { child.kill('SIGTERM'); } catch {} resolve(url); };
            const timer = setTimeout(() => done(''), 10_000);
            child.stdout.on('data', (b: Buffer) => {
              chunks += b.toString();
              const lines = chunks.split('\n');
              chunks = lines.pop() || '';
              for (const line of lines) {
                const s = line.trim();
                if (!s) continue;
                let ev: any;
                try { ev = JSON.parse(s); } catch { continue; }
                if (!ev || ev.kind !== 30617 || !Array.isArray(ev.tags)) continue;
                const cloneTags = ev.tags
                  .filter((t: any[]) => t[0] === 'clone')
                  .flatMap((t: any[]) => t.slice(1).filter((x: any) => typeof x === 'string' && x));
                // Prefer HTTPS — most reliable transport and doesn't
                // require git-remote-nostr to find the event again.
                const https = cloneTags.find((u: string) => /^https:\/\//i.test(u));
                if (https) { done(https); return; }
                const anyGit = cloneTags.find((u: string) => /^(git|https?|ssh):\/\//i.test(u));
                if (anyGit) { done(anyGit); return; }
              }
            });
            child.on('error', () => done(''));
            child.on('close', () => done(''));
          });

          if (httpsCloneUrl) {
            cloneUrl = httpsCloneUrl;
          } else {
            // No announcement reachable (or no clone URLs in it).
            // Fall back to nostr:// and let git-remote-nostr try — if
            // the user's ngit relay config can find the event there's
            // still a chance.
            const npub = nip19.npubEncode(pubkeyHex);
            cloneUrl = `nostr://${npub}/${dTag}`;
          }
        }
        // repoName becomes the last segment of the clone target — reject
        // any path separators, dotfile patterns, or traversal attempts.
        // Allowed characters mirror what git itself accepts for repo dir
        // names in practice: letters, digits, dot, dash, underscore.
        if (!rawRepoName
            || !/^[A-Za-z0-9._-]{1,64}$/.test(rawRepoName)
            || rawRepoName === '.' || rawRepoName === '..'
            || rawRepoName.startsWith('.')) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'repoName must be a simple identifier (letters, digits, . - _)' }));
          return;
        }
        // Server owns the full path construction — never accept a user-
        // supplied path, never use a "~"-prefixed string. HOME is read
        // from the environment (falling back to os.homedir()) and the
        // clone target is ~/projects/<repoName>, always absolute.
        const home = process.env.HOME || os.homedir();
        const projectsDir = path.join(home, 'projects');
        const target      = path.join(projectsDir, rawRepoName);
        try { fs.mkdirSync(projectsDir, { recursive: true, mode: 0o755 }); } catch {}
        if (fs.existsSync(target)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `target path already exists: ${target}` }));
          return;
        }
        // Emit the fully-resolved target as an `info` frame so the client
        // can call /api/projects/detect and store the absolute path in
        // projects.json — detect does not expand "~".
        streamExec(
          { bin: 'git', args: ['clone', cloneUrl, target], env: { NO_COLOR: '1', TERM: 'dumb' } },
          res, req, undefined,
          { info: 'resolvedPath', value: target },
        );
        return;
      }

      // ── ngit account (signer) status + login/logout ────────────────────
      //
      // ngit stores the signer session in global git config under
      // `nostr.bunker-uri` + `nostr.bunker-app-key`. We read the first to
      // derive a "logged in?" state for the Config panel; the app-key is
      // an ephemeral keypair only meaningful to ngit itself.
      //
      // The bunker-uri format is:
      //   bunker://<remote-pubkey-hex>?relay=wss://...&relay=...&secret=<...>
      // We mask the `secret=` query param before returning — it's a live
      // session token that a UI/clipboard/screenshot shouldn't expose.
      if (url === '/api/ngit/account' && method === 'GET') {
        let bunkerUri = '';
        try {
          bunkerUri = execSync('git config --global --get nostr.bunker-uri', { stdio: ['ignore', 'pipe', 'pipe'] })
            .toString().trim();
        } catch {}
        const loggedIn = !!bunkerUri;
        const relays: string[] = [];
        let remotePubkey = '';
        if (loggedIn) {
          try {
            const u = new URL(bunkerUri.replace(/^bunker:/, 'https:'));
            remotePubkey = u.host; // hex pubkey sits in the host slot
            for (const r of u.searchParams.getAll('relay')) relays.push(r);
          } catch {}
        }
        // Masked URI: keep scheme + remote pubkey + relay params, replace
        // secret with asterisks. Safe to echo to the client.
        const maskedUri = loggedIn
          ? bunkerUri.replace(/([?&]secret=)[^&]*/i, '$1•••')
          : '';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          loggedIn,
          remotePubkey,
          relays,
          maskedUri,
        }));
        return;
      }

      if (url === '/api/ngit/account/login' && method === 'POST') {
        // `ngit account login` is interactive — without a TTY it'll
        // typically print a nostrconnect:// URL + wait for a remote
        // signer (Amber) to connect. We stream stdout/stderr so the
        // modal can surface the URL; the user scans it with Amber and
        // the command completes on its own. `-i` forces interactive
        // mode so ngit doesn't fall back to some non-interactive
        // default that would skip the QR path.
        streamExec(
          { bin: 'ngit', args: ['account', 'login', '-i'], env: { NO_COLOR: '1', TERM: 'dumb' } },
          res, req,
        );
        return;
      }

      if (url === '/api/ngit/account/logout' && method === 'POST') {
        streamExec(
          { bin: 'ngit', args: ['account', 'logout'], env: { NO_COLOR: '1', TERM: 'dumb' } },
          res, req,
        );
        return;
      }

      if (url === '/api/ollama/models' && method === 'GET') {
        const models = await probeOllama();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ models: models ?? [] }));
        return;
      }
      if (url === '/api/lmstudio/models' && method === 'GET') {
        const models = await probeLmStudio();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ models: models ?? [] }));
        return;
      }

      const execMatch = url.match(/^\/api\/exec\/([a-z-]+)(?:\/([a-z0-9-]+))?$/);
      if (execMatch && method === 'POST') {
        const spec = cmdSpecFor(execMatch[1], execMatch[2]);
        if (!spec) { res.writeHead(404); res.end('unknown exec target'); return; }
        streamExec(spec, res, req);
        return;
      }

      const logsMatch = url.match(/^\/api\/logs\/(relay|watchdog|vpn)$/);
      if (logsMatch && method === 'GET') {
        streamLogs(logsMatch[1] as 'relay' | 'watchdog' | 'vpn', res, req)
          .catch(e => { try { res.end(); } catch {} ; process.stderr.write(`streamLogs error: ${e}\n`); });
        return;
      }

      // ── AI provider system (Step 4) ───────────────────────────────────
      //
      // Endpoints here talk to ai-config.json + per-provider keychain slots
      // in the new multi-provider layout. The old /api/config/ /api/chat
      // routes continue to work against the single-provider config until
      // the Chat pane + Config panel UIs are switched over in later steps.

      if (url === '/api/ai/providers' && method === 'GET') {
        // Returns the full registry + per-provider configured state so the
        // Chat pane + Config panel can render list UIs without querying
        // the keychain per row. `configured` is a best-effort check against
        // ai-config.json — actual chat requests still fail loud if the
        // keychain slot is missing.
        const cfg = readAiConfig();
        const list = listProviders().map(p => {
          const entry = cfg.providers[p.id];
          // "Configured" = user has an entry in ai-config. Without an entry
          // even bareKey providers (ollama / lmstudio / maple) are "available
          // to add" — their local daemon existence alone shouldn't auto-add
          // them to the user's provider list without explicit opt-in.
          const hasKey   = !!(entry?.keyRef);
          const bareKey  = p.type === 'api' && !!((p as ApiProvider).bareKey);
          const enabled  = !!(entry?.enabled);
          const configured = !entry ? false
            : p.type === 'api'
              ? (hasKey || bareKey)
              : enabled;
          return {
            id: p.id,
            displayName: p.displayName,
            type: p.type,
            configured,
            // hasKey: a real API key is stored in the keychain. Distinct
            // from bareKey providers (Ollama / LM Studio / Maple) which
            // don't need one — the UI renders a "local" badge instead of
            // "key set" to avoid misleading users.
            hasKey,
            bareKey,
            // Expose the effective model + baseUrl so the Chat dropdown can
            // show what will actually be sent without re-implementing the
            // override-vs-registry resolution client-side.
            model:   p.type === 'api' ? (entry?.model   ?? (p as ApiProvider).defaultModel) : undefined,
            baseUrl: p.type === 'api' ? (entry?.baseUrl ?? (p as ApiProvider).baseUrl)      : undefined,
            isDefault: {
              terminal: cfg.defaults.terminal === p.id,
              chat:     cfg.defaults.chat === p.id,
            },
          };
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ providers: list, defaults: cfg.defaults }));
        return;
      }

      if (url === '/api/ai/config' && method === 'GET') {
        // Raw ai-config.json — already keyRef-only (never the raw keys),
        // so it's safe to expose as-is. Used by the CLI + debugging.
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(readAiConfig()));
        return;
      }

      if (url === '/api/ai/config' && method === 'POST') {
        // Partial ai-config update. Semantics:
        //   - providers: MERGE per-id entries. Set a provider-id to null
        //     to remove it entirely.
        //   - defaults: MERGE per-kind slots ('terminal' | 'chat'). Null
        //     removes the slot.
        // Keys are NEVER accepted here — the body is keyRef-safe config
        // only. Use POST /api/ai/providers/:id/key for the raw key path.
        let parsed: any = {};
        try { parsed = JSON.parse(await readBody(req)); }
        catch { res.writeHead(400); res.end('bad json'); return; }

        const cfg = readAiConfig();
        if (parsed.providers && typeof parsed.providers === 'object') {
          for (const [id, entry] of Object.entries(parsed.providers)) {
            if (!getProvider(id)) continue;  // reject unknown provider ids
            if (entry === null) {
              delete cfg.providers[id];
              // Cascade: a removed provider can't still be a default —
              // leaving it would point the Chat pane / "Open in AI" at
              // a non-existent entry. CLI's Ai.tsx remove does the same.
              if (cfg.defaults.terminal === id) delete cfg.defaults.terminal;
              if (cfg.defaults.chat     === id) delete cfg.defaults.chat;
              continue;
            }
            if (typeof entry !== 'object') continue;
            const existing = cfg.providers[id] ?? {};
            // Only accept known-safe fields — no keyRef acceptance here
            // (that goes through /api/ai/providers/:id/key). baseUrl
            // validated loosely since users with custom relays need it.
            const next: AiProviderConfig = { ...existing };
            const e = entry as any;
            if (typeof e.enabled === 'boolean') next.enabled = e.enabled;
            if (typeof e.model   === 'string')  next.model   = e.model.slice(0, 160);
            if (typeof e.baseUrl === 'string')  next.baseUrl = e.baseUrl.slice(0, 300);
            cfg.providers[id] = next;
          }
        }
        if (parsed.defaults && typeof parsed.defaults === 'object') {
          const d = parsed.defaults as any;
          if (d.terminal === null) delete cfg.defaults.terminal;
          else if (typeof d.terminal === 'string' && getProvider(d.terminal)) {
            cfg.defaults.terminal = d.terminal;
          }
          if (d.chat === null) delete cfg.defaults.chat;
          else if (typeof d.chat === 'string' && getProvider(d.chat)) {
            cfg.defaults.chat = d.chat;
          }
        }
        writeAiConfig(cfg);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, cfg }));
        return;
      }

      // POST /api/ai/providers/:id/key — stores an API key in the keychain
      // under `ai:<id>` AND sets the matching keyRef in ai-config.json.
      // This is the one place where raw keys enter the server process;
      // the key never gets echoed back in any response.
      //
      // Runs in the web-server process (which inherited Aqua from the
      // user's terminal), so macOS keychain writes succeed even though
      // they wouldn't from a PTY child — see terminal.ts for that note.
      const aiKeyMatch = url.match(/^\/api\/ai\/providers\/([a-z0-9-]+)\/key$/);
      if (aiKeyMatch && method === 'POST') {
        const id = aiKeyMatch[1];
        const provider = getProvider(id);
        if (!provider || provider.type !== 'api') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: `unknown API provider: ${id}` }));
          return;
        }
        let parsed: any = {};
        try { parsed = JSON.parse(await readBody(req)); }
        catch { res.writeHead(400); res.end('bad json'); return; }
        const key = typeof parsed.key === 'string' ? parsed.key : '';
        if (!key || key.length < 4) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'key is empty or too short' }));
          return;
        }
        // Defensive: reject obvious nsec paste — provider slots are for
        // AI keys only.
        if (isNsec(key)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'nsec detected — this slot is for AI keys only' }));
          return;
        }
        try {
          await getKeychain().store(keychainAccountFor(id), key);
          setProviderEntry(id, { keyRef: `keychain:${keychainAccountFor(id)}` });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: String(e.message || e).slice(0, 200) }));
        }
        return;
      }

      // GET /api/ai/providers/:id/models — live-fetch the provider's
      // model list via its own /v1/models endpoint and return the
      // normalized ids. Clients cache the result in ai-config.
      // knownModels so subsequent Chat panel renders skip the round-trip.
      const aiModelsMatch = url.match(/^\/api\/ai\/providers\/([a-z0-9-]+)\/models$/);
      if (aiModelsMatch && method === 'GET') {
        const id = aiModelsMatch[1];
        const provider = getProvider(id);
        if (!provider || provider.type !== 'api') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `unknown API provider: ${id}` }));
          return;
        }
        // Resolve key — bareKey providers skip the keychain read entirely.
        let apiKey = '';
        if (!provider.bareKey) {
          try {
            apiKey = (await getKeychain().retrieve(keychainAccountFor(id))) ?? '';
          } catch { apiKey = ''; }
          if (!apiKey) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'no API key stored — add one first' }));
            return;
          }
        }
        const cfg = readAiConfig();
        const baseUrl = cfg.providers[id]?.baseUrl ?? provider.baseUrl;
        try {
          const models = provider.flavor === 'anthropic'
            ? await fetchAnthropicModels(apiKey)
            : await fetchOpenAICompatModels(apiKey, baseUrl, !!provider.bareKey);
          // Persist immediately so the Chat pane + subsequent panel
          // renders see the fresh list without another round-trip.
          setProviderEntry(id, { knownModels: models });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ models }));
        } catch (e: any) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: String(e.message || e).slice(0, 240) }));
        }
        return;
      }

      if (aiKeyMatch && method === 'DELETE') {
        const id = aiKeyMatch[1];
        const provider = getProvider(id);
        if (!provider || provider.type !== 'api') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: `unknown API provider: ${id}` }));
          return;
        }
        try {
          await getKeychain().delete(keychainAccountFor(id));
        } catch {} // idempotent — already-missing is not an error
        // Don't nuke the whole entry (model / baseUrl overrides are still
        // valid without a key); just strip the keyRef pointer. The Chat
        // pane's "configured?" check flips to false on next render.
        const cfg = readAiConfig();
        if (cfg.providers[id]?.keyRef) {
          const { keyRef, ...rest } = cfg.providers[id];
          cfg.providers[id] = rest;
          writeAiConfig(cfg);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (url === '/api/ai/chat' && method === 'POST') {
        let parsed: any = {};
        try { parsed = JSON.parse(await readBody(req)); }
        catch { res.writeHead(400); res.end('bad json'); return; }
        const messages: Msg[] = Array.isArray(parsed.messages) ? parsed.messages : [];
        const explicit: string | null = typeof parsed.provider === 'string' ? parsed.provider : null;
        const explicitModel: string | null = typeof parsed.model === 'string'
          // Clamp defensively; registry models are <60 chars in practice.
          ? parsed.model.slice(0, 160)
          : null;
        const projectId: string | null = typeof parsed.projectId === 'string' ? parsed.projectId : null;

        // All failure modes emit SSE so the Chat pane's EventSource-like
        // reader gets a consistent shape — `data: {error: "..."}` + `[DONE]`.
        res.writeHead(200, {
          'Content-Type':  'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection':    'keep-alive',
        });
        const sseError = (msg: string) => {
          res.write(`data: ${JSON.stringify({ error: msg })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        };

        // Resolution order: explicit > project override > defaults.chat.
        // Project override is read from projects.json via getProject(); the
        // `aiDefaults` field is optional and only gets populated when a user
        // explicitly scopes a different provider per-project.
        const cfg = readAiConfig();
        let providerId: string | null = explicit;
        if (!providerId && projectId) {
          const p = getProject(projectId);
          const pd = (p as any)?.aiDefaults?.chat;
          if (typeof pd === 'string') providerId = pd;
        }
        if (!providerId) providerId = cfg.defaults.chat ?? null;

        if (!providerId) {
          return sseError('No chat provider configured — add one in Config');
        }
        const provider = getProvider(providerId);
        if (!provider || provider.type !== 'api') {
          return sseError(`Unknown or non-API provider: ${providerId}`);
        }

        // Resolve the key. bareKey providers (ollama / lm-studio / maple)
        // don't need a real key — we pass an empty string and skip the
        // Authorization header in streamOpenAICompat.
        let apiKey = '';
        if (provider.bareKey) {
          apiKey = ''; // streamOpenAICompat already special-cases bareKey sentinels
        } else {
          try {
            apiKey = (await getKeychain().retrieve(keychainAccountFor(providerId))) ?? '';
          } catch { apiKey = ''; }
          // Anthropic env-var fallback: onboard for aiProvider='anthropic'
          // intentionally does not store a key (the user owns ANTHROPIC_API_KEY
          // in their shell env via ~/.claude_env). Read it at request time so
          // a fresh install doesn't hit "No API key" on the first chat turn.
          // Mirrors the legacy /api/chat path in loadProviderConfig().
          if (!apiKey && providerId === 'anthropic') {
            apiKey = process.env.ANTHROPIC_API_KEY ?? '';
          }
          if (!apiKey) {
            return sseError(`No API key for ${provider.displayName} — set one in Config`);
          }
        }

        // Resolution order for model + baseUrl:
        //   explicit request field > ai-config override > registry default.
        // Explicit model lets the Chat dropdown's current value take
        // effect immediately — no race with the async persistModelChange
        // POST that also updates ai-config. Empty baseUrl only valid for
        // anthropic-native.
        const entry     = cfg.providers[providerId];
        const baseUrl   = entry?.baseUrl ?? provider.baseUrl;
        const model     = explicitModel ?? entry?.model ?? provider.defaultModel;
        const isAnth    = provider.flavor === 'anthropic';

        // Build the context block + merge with any caller-supplied system
        // prompt already in messages. We prepend rather than overwrite so
        // future per-prompt system messages still apply.
        const ctx = buildAiContext(projectId);
        const system = ctx.text;

        const runtimeCfg: ProviderConfig = {
          isAnthropic:  isAnth,
          baseUrl,
          model,
          apiKey,
          providerName: provider.displayName,
        };

        try {
          if (isAnth) await streamAnthropic(messages, system, runtimeCfg, res);
          else        await streamOpenAICompat(messages, system, runtimeCfg, res);
        } catch (e: any) {
          res.write(`data: ${JSON.stringify({ error: String(e.message ?? e) })}\n\n`);
        }
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      // ── Terminal panel (xterm.js + node-pty) ──────────────────────────
      //
      // Capability probe — tells the client whether the terminal bar can be
      // enabled. Lives at a stable URL so the client can render a degraded
      // "install python3 + build tools" hint without having to create a
      // session to find out.
      if (url === '/api/terminal/capability' && method === 'GET') {
        const pty = await loadPty();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          available: pty !== null,
          reason: pty === null
            ? 'node-pty not installed — run `nostr-station doctor --fix` or reinstall with build tools available'
            : undefined,
        }));
        return;
      }

      // List active sessions — supports the client reconnect path: on boot
      // it checks stored session ids against this list, only rejoining ones
      // the server still knows about.
      if (url === '/api/terminal' && method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ sessions: listTerminals() }));
        return;
      }

      // Create a new PTY session. Body shape: { key, cwd?, projectId? }.
      // `key` is one of the whitelisted strings in terminal.ts resolveCmd().
      // `projectId`, if given, is looked up server-side and its path used
      // as cwd — clients never pass raw paths here.
      if (url === '/api/terminal/create' && method === 'POST') {
        let parsed: any = {};
        try { parsed = JSON.parse(await readBody(req)); }
        catch { res.writeHead(400); res.end('bad json'); return; }
        const key = String(parsed.key || '');
        let cwd: string | undefined;
        const pid = parsed.projectId ? String(parsed.projectId) : '';
        if (pid) {
          const p = getProject(pid);
          if (!p) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'project not found' }));
            return;
          }
          if (p.path) cwd = p.path;
        }
        const r = await createTerminal({ key, cwd }, CLI_SPAWN);
        if (!r.ok) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: r.error }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: r.id, label: r.label }));
        return;
      }

      const termDelMatch = url.match(/^\/api\/terminal\/([a-f0-9]{16,})$/);
      if (termDelMatch && method === 'DELETE') {
        const ok = destroyTerminal(termDelMatch[1], 'client-close');
        res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok }));
        return;
      }

      // Static fallback — vendor libs first (fast path, strict whitelist),
      // then the regular src/web tree.
      if (method === 'GET' && serveVendorXterm(req, res)) return;
      if (method === 'GET' && serveStatic(req, res)) return;

      // SPA routes — served from index.html. The client router picks up
      // the path from location and renders the wizard/panel accordingly.
      // Listed explicitly (not a catch-all) so typos still 404.
      if (method === 'GET' && url === '/setup') {
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

    // ── Terminal WebSocket upgrade ────────────────────────────────────
    //
    // URL: /api/terminal/ws/:id?token=<bearer>
    // Auth: browser WebSockets can't set Authorization headers, so we accept
    // the session token as a query param. localhostExempt() still wins for
    // the identity.json requireAuth:false case, same as the REST surface.
    //
    // Client → server messages (JSON text frames):
    //   { type: 'input',  data: '<string>' }
    //   { type: 'resize', cols: 80, rows: 24 }
    // Server → client messages:
    //   - Raw PTY output as text frames (no wrapping; written straight to
    //     xterm.js via term.write()).
    //   - Control frames are prefixed with a NUL byte (\x00) followed by
    //     JSON. Clients split on the first byte to demux. We use NUL
    //     because no legitimate PTY stream contains it and xterm.js handles
    //     seeing one gracefully if we ever slip up.
    const wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (req, socket, head) => {
      const url = req.url || '';
      const match = url.match(/^\/api\/terminal\/ws\/([a-f0-9]{16,})(?:\?.*)?$/);
      if (!match) {
        socket.destroy();
        return;
      }
      const sessionId = match[1];

      // Mirror the HTTP Host + Origin checks at the WebSocket layer.
      // Browsers always send Origin on upgrade handshakes, so rejecting
      // missing/foreign Origin blocks cross-origin WS attempts (e.g. a
      // malicious page trying to attach to a live terminal session).
      const hostHeader = String(req.headers['host'] || '').toLowerCase();
      if (!allowedHosts.has(hostHeader)) {
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
        socket.destroy();
        return;
      }
      const wsOrigin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
      if (!isLoopbackUrl(wsOrigin)) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }

      // Auth check using the same primitives as the REST middleware.
      let authed = localhostExempt(req);
      if (!authed) {
        // Extract token from ?token= query string.
        const qIdx = url.indexOf('?');
        const qs   = qIdx >= 0 ? new URLSearchParams(url.slice(qIdx + 1)) : null;
        const tok  = qs?.get('token') || '';
        if (tok && getSession(tok)) authed = true;
      }
      if (!authed) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        const sess = attachTerminal(sessionId, ws);
        if (!sess) {
          // Session vanished between create and WS open. Emit a JSON control
          // frame so the client can show a clean "session expired" state,
          // then close. Useful after long sleeps where the grace timer fired.
          try { ws.send(`\x00${JSON.stringify({ type: 'closed', reason: 'unknown-session' })}`); } catch {}
          try { ws.close(4404, 'unknown session'); } catch {}
          return;
        }

        ws.on('message', (raw) => {
          // PTY input is high-rate; parse defensively and drop anything we
          // don't recognize. Max 64KiB per frame guards against a misbehaving
          // client streaming MBs of data into our event loop.
          if ((raw as Buffer).length > 64 * 1024) return;
          let parsed: any;
          try { parsed = JSON.parse(raw.toString()); } catch { return; }
          if (parsed?.type === 'input' && typeof parsed.data === 'string') {
            writeTerminalInput(sessionId, parsed.data);
          } else if (parsed?.type === 'resize') {
            resizeTerminal(sessionId, Number(parsed.cols), Number(parsed.rows));
          }
        });

        ws.on('close', () => detachTerminal(sessionId, ws));
        ws.on('error', () => detachTerminal(sessionId, ws));
      });
    });

    server.on('close', () => {
      destroyAllTerminals();
    });

    server.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'EADDRINUSE') {
        reject(new Error(`Port ${port} is already in use — check: lsof -i :${port}`));
      } else {
        reject(e);
      }
    });

    server.listen(port, '127.0.0.1', () => {
      // Kick off best-effort warm-ups now that the socket is bound. If any
      // of them hang (secret-tool unlock prompt, node-pty prebuilt probe,
      // ai-config migration) the dashboard is still up and serving.
      warmUp();
      resolve();
    });
  });
}
