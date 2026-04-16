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
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import { getKeychain } from './keychain.js';
import {
  loadPty, createSession as createTerminal, attachClient as attachTerminal,
  detachClient as detachTerminal, destroySession as destroyTerminal,
  writeInput as writeTerminalInput, resizeSession as resizeTerminal,
  listSessions as listTerminals, destroyAllSessions as destroyAllTerminals,
} from './terminal.js';
import { gatherStatus } from '../commands/Status.js';
import {
  readRelaySettings, defaultConfigPath, hexToNpub, npubToHex,
  addToWhitelist, removeFromWhitelist, setAuthFlag,
} from './relay-config.js';
import { detectInstalled, probeOllama, probeLmStudio } from './detect.js';
import {
  readIdentity, addReadRelay, removeReadRelay, setNpub as setIdentityNpub,
  setNgitRelay as setIdentityNgitRelay,
  isNpubOrHex, isNsec, isValidRelayUrl, type Identity,
} from './identity.js';
import {
  clearAllSessions, issueChallenge, consumeChallenge, createSession,
  getSession, deleteSession, extractBearer, verifyNip98, authStatus,
  isPublicApi, requireSession, expectedDashboardUrl, localhostExempt,
} from './auth.js';
import {
  startNostrConnect, getBunkerSession, consumeBunkerSession,
  signWithBunkerUrl,
} from './auth-bunker.js';
import {
  readProjects, getProject, createProject, updateProject, deleteProject,
  detectPath, projectGitStatus, projectGitLog, resolveProjectContext,
  type Project,
} from './projects.js';

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

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const urlPath = (req.url || '/').split('?')[0];
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  // Block traversal — we never serve outside WEB_DIR.
  const resolved = path.resolve(WEB_DIR, '.' + rel);
  if (!resolved.startsWith(WEB_DIR)) return false;
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return false;

  const ext  = path.extname(resolved).toLowerCase();
  const mime = MIME[ext] ?? 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
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

async function streamAnthropic(
  messages: Msg[], system: string, cfg: ProviderConfig, res: http.ServerResponse,
): Promise<void> {
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

function serveRelayConfig(res: http.ServerResponse): void {
  const s = readRelaySettings();
  if (!s) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      name: '', url: '', auth: false, dmAuth: false,
      whitelist: [], dataDir: '', configPath: defaultConfigPath(),
      error: `config not found at ${defaultConfigPath()} — run nostr-station onboard`,
    }));
    return;
  }
  // Prefer npub in the UI — hex is noise to humans. hexToNpub shells to `nak`
  // once per entry; whitelists are typically 1-10 entries so this is cheap.
  const whitelist = s.whitelist.map(h => hexToNpub(h));
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ...s, whitelist }));
}

// ── Logs (SSE live tail) ──────────────────────────────────────────────────────

function streamLogs(
  service: 'relay' | 'watchdog' | 'vpn',
  res: http.ServerResponse,
  req: http.IncomingMessage,
): void {
  const LOGS: Record<typeof service, string> = {
    relay:    path.join(os.homedir(), 'logs', 'nostr-rs-relay.log'),
    watchdog: path.join(os.homedir(), 'logs', 'watchdog.log'),
    vpn:      path.join(os.homedir(), 'logs', 'nvpn.log'),
  };
  const file = LOGS[service];

  res.writeHead(200, {
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
  });

  if (!fs.existsSync(file)) {
    res.write(`data: ${JSON.stringify({ error: `log not found: ${file} — service may not be running yet` })}\n\n`);
    res.end();
    return;
  }

  const tail = spawn('tail', ['-f', '-n', '200', file], { stdio: ['ignore', 'pipe', 'pipe'] });

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

const CLI_BIN = path.resolve(here, '..', 'cli.js');

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
  // Best-effort load at startup — we reload per-request so the Chat panel
  // picks up a newly-stored key (e.g. user ran `keychain set ai-api-key`
  // in another terminal) without needing a server restart.
  await loadProviderConfig();

  // Sessions are in-memory only and never survive a server restart — the
  // user re-authenticates after a nostr-station chat restart. Explicit here
  // for clarity in case the module is imported multiple times.
  clearAllSessions();

  // Probe node-pty at startup — not for correctness (terminal.ts does the
  // same lazy check on first use) but to trigger ensureSpawnHelperExecutable()
  // before the first user click. The chmod self-heal for npm-stripped perms
  // can't wait for the authenticated capability probe, because that round
  // trip has observable latency the first time a browser hits the dashboard.
  // Fire-and-forget; a failure here means the terminal panel is disabled,
  // which the client surfaces via the capability endpoint anyway.
  loadPty().catch(() => {});

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const url    = (req.url || '/').split('?')[0];
      const method = req.method || 'GET';

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
          expectedUrl: expectedDashboardUrl(req),
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
        // Starts a nostrconnect:// (QR) flow. Returns the URI + QR SVG +
        // ephemeral pubkey immediately; the actual relay subscription runs
        // in the background until the remote signer answers or we time out.
        const { challenge } = issueChallenge();
        const start = await startNostrConnect(challenge, expectedDashboardUrl(req));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ...start, challenge }));
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
          expectedUrl: expectedDashboardUrl(req),
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
        const bunkerRes = await signWithBunkerUrl(bunkerUrl, challenge, expectedDashboardUrl(req));
        if (!bunkerRes.ok) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: bunkerRes.error || 'bunker sign failed' }));
          return;
        }
        const verify = verifyNip98({
          challenge, event: bunkerRes.signedEvent,
          expectedUrl: expectedDashboardUrl(req),
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
        serveRelayConfig(res);
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
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(readProjects()));
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
          res.end(JSON.stringify(project));
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
        // Two fields may be set by this route — npub (bootstrap owner) and
        // ngitRelay (station-level default for ngit). Both are optional; the
        // handler updates whichever is present.
        const hasNpub     = typeof parsed.npub      === 'string';
        const hasNgitRly  = typeof parsed.ngitRelay === 'string';
        if (!hasNpub && !hasNgitRly) {
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
          { bin: 'git', args: ['clone', rawUrl, target], env: { NO_COLOR: '1', TERM: 'dumb' } },
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
        streamLogs(logsMatch[1] as 'relay' | 'watchdog' | 'vpn', res, req);
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
        const r = await createTerminal({ key, cwd }, CLI_BIN);
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

    server.listen(port, '127.0.0.1', () => resolve());
  });
}
