/**
 * AI provider routes — split out of `web-server.ts` as part of the route-
 * group refactor. Pure dispatch by URL + method; the orchestrator handles
 * auth, CSRF, and DNS-rebinding checks before any of these handlers see
 * the request.
 *
 * Surface:
 *   GET    /api/ai/providers                 — registry + per-provider state
 *   GET    /api/ai/config                    — raw ai-config.json
 *   POST   /api/ai/config                    — partial merge (no keys)
 *   POST   /api/ai/providers/:id/key         — store a key in the keychain
 *   DELETE /api/ai/providers/:id/key         — clear a key
 *   GET    /api/ai/providers/:id/models      — live /v1/models fetch + cache
 *   POST   /api/ai/chat                      — SSE streaming chat
 *
 * Streaming helpers (streamAnthropic, streamOpenAICompat, completionsUrl)
 * and the shared `Msg` / `ProviderConfig` types are exported so the
 * legacy `/api/chat` path in web-server.ts can keep using them without
 * duplicating the SSE-decode loop. Pre-refactor those helpers lived in
 * web-server.ts; this is the cleanest place for them now that the new
 * AI surface is the primary consumer.
 *
 * Returns `true` when matched and a response was written; `false` lets
 * the orchestrator continue trying its remaining route groups.
 */
import http from 'http';
import {
  listProviders, getProvider, keychainAccountFor,
  type ApiProvider,
} from '../ai-providers.js';
import {
  readAiConfig, writeAiConfig, setProviderEntry,
  type ProviderConfig as AiProviderConfig,
} from '../ai-config.js';
import { buildAiContext } from '../ai-context.js';
import { isNsec } from '../identity.js';
import {
  streamAnthropicWithTools, streamOpenAICompatWithTools,
} from '../ai-tools/tool-loop.js';
import {
  createSession, destroySession, resolveApproval,
  type ApprovalDecision,
} from '../ai-tools/approval-gate.js';
import type { ToolContext } from '../ai-tools/index.js';
import { readProjectPermissions } from '../project-config.js';
import { getKeychain } from '../keychain.js';
import { getProject } from '../projects.js';
import { readBody } from './_shared.js';

// ── Public types ───────────────────────────────────────────────────────────

export interface ProviderConfig {
  isAnthropic: boolean;
  baseUrl:     string;
  model:       string;
  apiKey:      string;
  providerName: string;
}

export type Msg = { role: string; content: string };

export function completionsUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/$/, '');
  return base.endsWith('/v1') ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
}

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

// ── Streaming chat ────────────────────────────────────────────────────────

export async function streamAnthropic(
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

export async function streamOpenAICompat(
  messages: Msg[], system: string, cfg: ProviderConfig, res: http.ServerResponse,
): Promise<void> {
  const allMessages: Msg[] = [{ role: 'system', content: system }, ...messages];
  const url = completionsUrl(cfg.baseUrl);

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  // Bare-key sentinels skip the Authorization header — useful when a
  // Custom Provider points at a local daemon (Ollama / LM Studio / etc.)
  // that rejects bearer tokens. Curated providers all need real keys;
  // 'none' is the generic skip token, the others remain for users
  // migrating Custom configs from the previous registry.
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

// ── Route handler ──────────────────────────────────────────────────────────

export async function handleAi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: string,
  method: string,
): Promise<boolean> {
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
    return true;
  }

  if (url === '/api/ai/config' && method === 'GET') {
    // Raw ai-config.json — already keyRef-only (never the raw keys),
    // so it's safe to expose as-is. Used by the CLI + debugging.
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(readAiConfig()));
    return true;
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
    catch { res.writeHead(400); res.end('bad json'); return true; }

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
    return true;
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
      return true;
    }
    let parsed: any = {};
    try { parsed = JSON.parse(await readBody(req)); }
    catch { res.writeHead(400); res.end('bad json'); return true; }
    const key = typeof parsed.key === 'string' ? parsed.key : '';
    if (!key || key.length < 4) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'key is empty or too short' }));
      return true;
    }
    // Defensive: reject obvious nsec paste — provider slots are for
    // AI keys only.
    if (isNsec(key)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'nsec detected — this slot is for AI keys only' }));
      return true;
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
    return true;
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
      return true;
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
        return true;
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
    return true;
  }

  if (aiKeyMatch && method === 'DELETE') {
    const id = aiKeyMatch[1];
    const provider = getProvider(id);
    if (!provider || provider.type !== 'api') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: `unknown API provider: ${id}` }));
      return true;
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
    return true;
  }

  if (url === '/api/ai/chat' && method === 'POST') {
    let parsed: any = {};
    try { parsed = JSON.parse(await readBody(req)); }
    catch { res.writeHead(400); res.end('bad json'); return true; }
    const messages: Msg[] = Array.isArray(parsed.messages) ? parsed.messages : [];
    const explicit: string | null = typeof parsed.provider === 'string' ? parsed.provider : null;
    const explicitModel: string | null = typeof parsed.model === 'string'
      // Clamp defensively; registry models are <60 chars in practice.
      ? parsed.model.slice(0, 160)
      : null;
    const projectId: string | null = typeof parsed.projectId === 'string' ? parsed.projectId : null;
    const project = projectId ? getProject(projectId) : null;

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
      sseError('No chat provider configured — add one in Config');
      return true;
    }
    const provider = getProvider(providerId);
    if (!provider || provider.type !== 'api') {
      sseError(`Unknown or non-API provider: ${providerId}`);
      return true;
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
      // Anthropic env-var fallback: when aiProvider='anthropic' is
      // configured without a stored key, we let the user own
      // ANTHROPIC_API_KEY in their shell env (via ~/.claude_env or
      // similar). Read it at request time so a fresh install doesn't
      // hit "No API key" on the first chat turn. Mirrors the legacy
      // /api/chat path in loadProviderConfig().
      if (!apiKey && providerId === 'anthropic') {
        apiKey = process.env.ANTHROPIC_API_KEY ?? '';
      }
      if (!apiKey) {
        sseError(`No API key for ${provider.displayName} — set one in Config`);
        return true;
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
    const ctx = buildAiContext(projectId, { provider: providerId, fullId: model });
    const system = ctx.text;

    const runtimeCfg: ProviderConfig = {
      isAnthropic:  isAnth,
      baseUrl,
      model,
      apiKey,
      providerName: provider.displayName,
    };

    // Tool context: only enabled when an active project is selected
    // AND the project has a path. Without a path, tools have nothing
    // to operate on (and runTool would error per-call). Permissions
    // resolve project-override → station default 'read-only'.
    let toolCtx: ToolContext | null = null;
    if (project && project.path) {
      const permLocal = readProjectPermissions(project);
      toolCtx = {
        project,
        permissions: permLocal?.mode ?? 'read-only',
      };
    }

    // Approval session for the duration of this chat turn. The first
    // SSE frame the loop emits is { session: sessionId } so the
    // client knows the id to use for /api/ai/chat/approve.
    //
    // If the client disconnects mid-stream (browser closes, tab
    // refreshes) we destroySession() on the close event — that
    // resolves any pending awaitApproval() Promises with 'reject'
    // so the tool-loop can unwind instead of hanging forever on a
    // dangling Promise. Without this, an abandoned approval would
    // leak both an in-memory session entry AND keep the upstream
    // provider request alive indefinitely.
    const sessionId = createSession();
    let disconnected = false;
    const onClose = () => {
      disconnected = true;
      destroySession(sessionId);
    };
    req.on('close', onClose);
    try {
      if (isAnth) await streamAnthropicWithTools(messages, system, runtimeCfg, res, toolCtx, sessionId);
      else        await streamOpenAICompatWithTools(messages, system, runtimeCfg, res, toolCtx, sessionId);
    } catch (e: any) {
      if (!disconnected) {
        try { res.write(`data: ${JSON.stringify({ error: String(e.message ?? e) })}\n\n`); } catch {}
      }
    } finally {
      req.off('close', onClose);
      destroySession(sessionId);
    }
    res.write('data: [DONE]\n\n');
    res.end();
    return true;
  }

  // ── Approval response — resolves a pending tool-call gate ─────────
  if (url === '/api/ai/chat/approve' && method === 'POST') {
    let parsed: any = {};
    try { parsed = JSON.parse(await readBody(req)); }
    catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid JSON body' }));
      return true;
    }
    const sessionId  = String(parsed.sessionId ?? '');
    const approvalId = String(parsed.approvalId ?? '');
    const decision   = parsed.decision === 'approve' ? 'approve'
                     : parsed.decision === 'reject'  ? 'reject'
                     : null;
    if (!sessionId || !approvalId || !decision) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'sessionId, approvalId, and decision (approve|reject) are required' }));
      return true;
    }
    const ok = resolveApproval(sessionId, approvalId, decision as ApprovalDecision);
    if (!ok) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'approval not found (already resolved or session expired)' }));
      return true;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }

  return false;
}
