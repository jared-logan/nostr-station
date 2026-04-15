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
import { spawn, execSync, execFile } from 'child_process';
import { fileURLToPath } from 'url';
import { getKeychain } from './keychain.js';
import { gatherStatus } from '../commands/Status.js';
import {
  readRelaySettings, defaultConfigPath, hexToNpub, npubToHex,
  addToWhitelist, removeFromWhitelist, setAuthFlag,
} from './relay-config.js';
import { detectInstalled, probeOllama, probeLmStudio } from './detect.js';
import { getCurrentBranch, getRemotes, isGitRepo } from './git.js';
import {
  readIdentity, addReadRelay, removeReadRelay, setNpub as setIdentityNpub,
  isNpubOrHex, isNsec, type Identity,
} from './identity.js';

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

  const system = getContextContent(os.homedir());
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

// ── Git status helpers (missing pieces not in lib/git.ts) ─────────────────────

function runGit(args: string[]): string | null {
  try {
    return execSync(`git ${args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ')} 2>/dev/null`)
      .toString().trim();
  } catch { return null; }
}

// Scrub tokens out of git remote URLs before sending to the client.
// Users routinely embed PATs in https://<user>:<token>@github.com/... — we
// don't want those showing up on screen or in screenshots of the dashboard.
function scrubRemoteUrl(url: string): string {
  return url.replace(/^(https?:\/\/)([^@\/]+)@/, '$1•••@');
}

function gitStatus(): any {
  if (!isGitRepo()) return { inRepo: false };
  const branch  = getCurrentBranch();
  const hash    = runGit(['rev-parse', '--short', 'HEAD']) ?? '';
  const msg     = runGit(['log', '-1', '--pretty=%s']) ?? '';
  const ts      = Number(runGit(['log', '-1', '--pretty=%ct']) ?? '0') * 1000;
  const author  = runGit(['log', '-1', '--pretty=%an']) ?? '';
  const dirtyRaw = runGit(['status', '--short']) ?? '';
  const dirty   = dirtyRaw.split('\n').filter(Boolean).length;
  const remotes = getRemotes().map(r => ({ ...r, url: scrubRemoteUrl(r.url) }));
  return {
    inRepo: true,
    branch, hash, message: msg, timestamp: ts, author,
    dirty, remotes,
  };
}

function gitLog(): any[] {
  if (!isGitRepo()) return [];
  const raw = runGit(['log', '-10', '--pretty=%h|%s|%an|%ct']);
  if (!raw) return [];
  return raw.split('\n').filter(Boolean).map(line => {
    const [hash, message, author, ctSec] = line.split('|');
    return {
      hash: hash || '',
      message: message || '',
      author: author || '',
      timestamp: (Number(ctSec) || 0) * 1000,
    };
  });
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
    const out = execSync(`nak decode ${npub}`, { stdio: 'pipe' }).toString().trim();
    return /^[0-9a-f]{64}$/.test(out) ? out : '';
  } catch { return ''; }
}

function hexToNpubLocal(hex: string): string {
  if (/^npub1/.test(hex)) return hex;
  try {
    const out = execSync(`nak encode npub ${hex}`, { stdio: 'pipe' }).toString().trim();
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
    case 'push':   return { bin: process.execPath, args: [CLI_BIN, 'push', '--yes'], env: { NO_COLOR: '1', TERM: 'dumb' } };
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

function streamExec(spec: CmdSpec, res: http.ServerResponse, req: http.IncomingMessage): void {
  res.writeHead(200, {
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
  });
  const child = spawn(spec.bin, spec.args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...(spec.env || {}) },
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

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const url    = (req.url || '/').split('?')[0];
      const method = req.method || 'GET';

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

      if (url === '/api/git/status' && method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(gitStatus()));
        return;
      }
      if (url === '/api/git/log' && method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(gitLog()));
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
          hasProfile: !!ident.npub,
        }));
        return;
      }

      if (url === '/api/identity/set' && method === 'POST') {
        let parsed: any = {};
        try { parsed = JSON.parse(await readBody(req)); }
        catch { res.writeHead(400); res.end('bad json'); return; }
        const input = String(parsed.npub || '').trim();
        const r = setIdentityNpub(input);
        // Setting a new npub invalidates any cached profile under the old id.
        if (r.ok) bustProfileCache();
        res.writeHead(r.ok ? 200 : 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(r));
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

      // Static fallback.
      if (method === 'GET' && serveStatic(req, res)) return;

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
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
