/**
 * Legacy single-provider chat surface — extracted from web-server.ts as
 * part of the D13 split.
 *
 * Backs the older `/api/config` + `/api/chat` routes that pre-date the
 * multi-provider /api/ai/* surface in routes/ai.ts. The dashboard Chat
 * pane still uses these until it fully switches over, so we keep the
 * code path live but isolated.
 *
 * Surface (all re-exported from web-server.ts to preserve any external
 * import paths, e.g. Chat.tsx's `contextExists` import):
 *   - loadProviderConfig — ai-config.json → keychain → legacy .claude_env
 *                          fallback. Returns { cfg, meta }.
 *   - proxyChat          — SSE streaming wrapper around
 *                          streamAnthropic / streamOpenAICompat.
 *   - getContextStatus   — what context the next /api/ai/chat turn will
 *                          actually use (project vs station fallback).
 *   - contextExists      — whether the legacy NOSTR_STATION.md seed file
 *                          exists on disk. Diagnostic only.
 *
 * The private helpers (parseClaudeEnv, inferProviderName, getContextContent)
 * stay local to the module — they have no other consumers.
 */
import http from 'http';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { getKeychain } from './keychain.js';
import { readAiConfig } from './ai-config.js';
import {
  getProvider, keychainAccountFor, type ApiProvider,
} from './ai-providers.js';
import { buildAiContext } from './ai-context.js';
import {
  streamAnthropic, streamOpenAICompat,
  type Msg, type ProviderConfig,
} from './routes/ai.js';
import { readBody, getActiveChatProjectId } from './routes/_shared.js';
import { getProject, resolveProjectContext } from './projects.js';

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
//
// Resolution order matches /api/ai/chat (routes/ai.ts):
//   1. ai-config.json `defaults.chat` provider — the modern multi-provider
//      layout the setup wizard, Config panel, and Chat dropdown all write
//      to. Key resolved from keychain slot `ai:<id>`, with an
//      ANTHROPIC_API_KEY env-var + legacy `ai-api-key` slot fallback for
//      anthropic so users mid-migration still see "configured".
//   2. Legacy ~/.claude_env + `ai-api-key` slot — the v0.x single-provider
//      layout. Only consulted when ai-config.json has no chat default,
//      which means migrateIfNeeded() decided not to migrate (no key found
//      at boot) and the user hasn't touched Config / wizard since.
export async function loadProviderConfig(): Promise<{ cfg: ProviderConfig | null; meta: { provider: string; model: string; baseUrl: string | null; configured: boolean; reason?: string } }> {
  const bareKeys = new Set(['none', 'ollama', 'lm-studio', 'maple-desktop-auto']);

  // ── Phase-2 path: ai-config.json + per-provider keychain ─────────────
  const aiCfg  = readAiConfig();
  const chatId = aiCfg.defaults.chat;
  if (chatId) {
    const provider = getProvider(chatId);
    if (provider && provider.type === 'api') {
      const apiP    = provider as ApiProvider;
      const entry   = aiCfg.providers[chatId];
      const baseUrl = entry?.baseUrl ?? apiP.baseUrl;
      const model   = entry?.model   ?? apiP.defaultModel;
      const isAnthropic = apiP.flavor === 'anthropic';

      let apiKey = '';
      if (apiP.bareKey) {
        apiKey = apiP.bareKey;
      } else {
        try {
          apiKey = (await getKeychain().retrieve(keychainAccountFor(chatId))) ?? '';
        } catch { apiKey = ''; }
        // Anthropic env-var + legacy-slot fallback. Mirrors the chat
        // path so the header reports "configured" for users who set
        // ANTHROPIC_API_KEY in their shell env or who haven't yet
        // re-saved their key under the new `ai:anthropic` slot.
        if (!apiKey && chatId === 'anthropic') {
          apiKey = process.env.ANTHROPIC_API_KEY ?? '';
          if (!apiKey) {
            try { apiKey = (await getKeychain().retrieve('ai-api-key')) ?? ''; }
            catch { apiKey = ''; }
          }
        }
      }

      const meta = {
        provider:   provider.displayName,
        model,
        baseUrl:    isAnthropic ? null : baseUrl,
        configured: false as boolean,
        reason:     undefined as string | undefined,
      };
      const isBare = bareKeys.has(apiKey);
      if (!apiKey && !apiP.bareKey) {
        meta.reason = `${provider.displayName} API key not set — add one in Config`;
        return { cfg: null, meta };
      }
      meta.configured = true;
      return {
        cfg: {
          isAnthropic,
          baseUrl,
          model,
          apiKey: isBare ? '' : apiKey,
          providerName: provider.displayName,
        },
        meta,
      };
    }
  }

  // ── Legacy v0.x fallback (~/.claude_env + `ai-api-key` slot) ─────────
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

  const isBare = bareKeys.has(apiKey);
  if (isAnthropic && !apiKey) {
    meta.reason = 'Anthropic API key not set — add one in Config';
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

export async function proxyChat(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  cfg: ProviderConfig,
): Promise<void> {
  let messages: Msg[];
  let bodyProjectId: string | null = null;
  try {
    const body = await readBody(req);
    const parsed = JSON.parse(body);
    messages = parsed.messages;
    if (typeof parsed.projectId === 'string' && parsed.projectId) {
      bodyProjectId = parsed.projectId;
    }
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid request body' }));
    return;
  }

  // Per-request projectId wins. Singleton fallback keeps older clients
  // (which set context via POST /api/chat/context) working until they
  // migrate to passing projectId in the body — same shape as /api/ai/chat.
  const activeProjectId = bodyProjectId ?? getActiveChatProjectId();
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
