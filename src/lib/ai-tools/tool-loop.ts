/**
 * Provider tool-loops — Anthropic + OpenAI-compat round-trip flows.
 *
 * Each loop:
 *   1. POSTs to the provider with the current messages + tools array.
 *   2. Streams the response, forwarding text deltas to the client
 *      and accumulating any tool_use blocks.
 *   3. After the model finishes a turn, dispatches each tool call —
 *      respecting permissions: 'always' tools auto-execute; 'gated'
 *      tools either auto-execute (auto-edit / yolo) or pause for
 *      approval via the approval-gate registry.
 *   4. Appends the assistant's tool_use message + tool_result
 *      messages to the thread and loops back to step 1.
 *   5. Stops when stop_reason ≠ 'tool_use' (Anthropic) or
 *      finish_reason === 'stop' (OpenAI), or when MAX_ROUNDS hit.
 *
 * Outbound SSE protocol additions (data: lines, type-tagged):
 *   { session:    sessionId }                       — first frame
 *   { model:      "..." }                            — model id (existing)
 *   { content:    "..." }                            — text delta (existing)
 *   { type: 'tool_call_start', id, name, args }     — tool call accepted
 *   { type: 'approval_request', id, approvalId, name, args, preview }
 *                                                    — gated; resolve via /approve
 *   { type: 'tool_result', id, ok, summary, error? }— after dispatch
 *   { error: "..." }                                 — fatal error
 *
 * Client signals approve/reject via POST /api/ai/chat/approve;
 * the route handler calls resolveApproval() which the loop awaits.
 *
 * Bounds:
 *   MAX_ROUNDS = 25         — runaway loop guard
 *   MAX_TOOL_RESULTS_BYTES  — cumulative cap on tool_result content
 *                              feeding back to the model so a chatty
 *                              tool can't blow the model's context
 */

import http from 'http';
import { readFileSync } from 'fs';
import { join as joinPath } from 'path';
import {
  runTool, requiresApproval, getTool,
  toolsForAnthropic, toolsForOpenAI,
  type ToolContext, type ToolResult,
} from './index.js';
import { awaitApproval, type ApprovalDecision } from './approval-gate.js';
import type { Msg, ProviderConfig } from '../routes/ai.js';

const MAX_ROUNDS = 25;
// Cumulative cap on tool_result content fed back to the model across
// the entire loop. Bumped 200 KB → 1 MB because the model now receives
// real tool payloads instead of one-line summaries; a session that
// reads a few moderately-sized files plus some grep/glob output can
// legitimately spend hundreds of KB before the loop is done. The
// per-call cap below stops any single call from monopolising it.
const MAX_TOOL_RESULTS_BYTES = 1024 * 1024;
// Per-call cap. Matches read_file's MAX_READ_BYTES so a single
// read_file call can deliver a complete file to the model without
// being truncated by the loop. Anything bigger gets replaced by a
// structured truncation marker so the model can choose to retry
// with a narrower scope rather than seeing garbled JSON.
const MAX_TOOL_RESULT_BYTES_PER_CALL = 256 * 1024;

// Serialize a tool's payload for the model. Keeps the JSON shape so
// the model gets structured signal (ok / error / nested fields), and
// degrades gracefully when over-budget instead of slicing mid-string
// and breaking JSON parsing on the model's side.
//
// Pre-fix the loop sent `out.summary` (a human-readable string like
// "18 entries" or "991 B") as the tool_result content, leaving the
// actual payload invisible to the model. The agent had no way to
// see file contents, list_dir entries, or run_command stdout — every
// call effectively returned a status string with no data. This
// helper is the structural fix: payload always reaches the model;
// summary stays in the SSE tool_result frame for the chat UI alone.
function stringifyForModel(payload: unknown): string {
  const json = JSON.stringify(payload);
  if (json.length <= MAX_TOOL_RESULT_BYTES_PER_CALL) return json;
  const ok = (payload as { ok?: unknown })?.ok ?? false;
  return JSON.stringify({
    ok,
    truncated:  true,
    fullBytes:  json.length,
    capBytes:   MAX_TOOL_RESULT_BYTES_PER_CALL,
    hint:       'tool result exceeded the per-call cap; retry with a ' +
                'narrower range (read_file), smaller depth (list_dir), ' +
                'or a more specific path/pattern (glob/grep).',
  });
}

function emit(res: http.ServerResponse, payload: any): void {
  try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch {}
}

function summarizeForPreview(toolName: string, args: any, ctx: ToolContext | null): any {
  // Strip large fields so the approval request stays human-readable.
  if (toolName === 'write_file') {
    const content = String(args?.content ?? '');
    return {
      path: args?.path,
      bytes: Buffer.byteLength(content, 'utf8'),
      preview: content.length > 400 ? content.slice(0, 400) + '\n… (truncated for preview)' : content,
    };
  }
  if (toolName === 'apply_patch') {
    return { path: args?.path, search: args?.search, replace: args?.replace };
  }
  if (toolName === 'run_command') {
    return { argv: args?.argv, cwd: args?.cwd, timeoutMs: args?.timeoutMs };
  }
  // build_project resolves the actual command from package.json at
  // approve-time so the user sees the script body that will run, not
  // just a generic "build?" prompt. Critical for catching the
  // edit-then-build escape: a hostile apply_patch to package.json
  // would show up as a payload in scripts.build here, distinct from
  // a benign "vite build" / "tsc -p ." that a real project ships.
  if (toolName === 'build_project' && ctx?.project?.path) {
    let scripts: { build?: string; compile?: string } = {};
    try {
      const pkgRaw = readFileSync(joinPath(ctx.project.path, 'package.json'), 'utf8');
      const pkg = JSON.parse(pkgRaw);
      if (pkg?.scripts?.build   && typeof pkg.scripts.build   === 'string') scripts.build   = pkg.scripts.build;
      if (pkg?.scripts?.compile && typeof pkg.scripts.compile === 'string') scripts.compile = pkg.scripts.compile;
    } catch { /* malformed / missing — handler will surface its own error */ }
    return {
      cwd:      ctx.project.path,
      command:  scripts.build ? 'npm run build' : (scripts.compile ? 'npm run compile' : '(none — handler will refuse)'),
      script:   scripts.build ?? scripts.compile ?? null,
      timeoutMs: args?.timeoutMs,
    };
  }
  return args;
}

// ── Anthropic tool-loop ──────────────────────────────────────────────────
//
// Anthropic message format:
//   user / assistant / user-with-tool_result, alternating.
//   Assistant content is an array of blocks — text, tool_use.
//   Tool result is a user message with content[i] = { type:
//   'tool_result', tool_use_id, content: string|object[] }.

interface AnthropicContentBlock {
  type:  'text' | 'tool_use' | 'tool_result';
  text?: string;
  id?:   string;
  name?: string;
  input?: any;
  tool_use_id?: string;
  content?: any;
}

interface AnthropicMsg {
  role:    'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

export async function streamAnthropicWithTools(
  initialMessages: Msg[],
  system: string,
  cfg: ProviderConfig,
  res: http.ServerResponse,
  toolCtx: ToolContext | null,
  sessionId: string,
): Promise<void> {
  // Initial messages are plain { role, content: string } from the
  // client. We accumulate richer messages here as the loop progresses.
  const messages: AnthropicMsg[] = initialMessages.map(m => ({
    role: (m.role === 'assistant' ? 'assistant' : 'user'),
    content: typeof m.content === 'string' ? m.content : '',
  }));

  let totalToolBytes = 0;
  let modelEmitted = false;

  emit(res, { session: sessionId });
  emit(res, { model: cfg.model });

  for (let round = 0; round < MAX_ROUNDS; round++) {
    // Build the request body. Tools array only included when we have
    // a project context (otherwise tools have nothing to operate on).
    const body: any = {
      model:      cfg.model,
      max_tokens: 8192,
      system,
      messages,
      stream:     true,
    };
    if (toolCtx) body.tools = toolsForAnthropic();

    const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key':         cfg.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
        'accept':            'text/event-stream',
      },
      body: JSON.stringify(body),
    });

    if (!apiRes.ok) {
      const text = await apiRes.text().catch(() => '');
      throw new Error(`Anthropic ${apiRes.status}: ${text.slice(0, 200)}`);
    }

    const reader  = apiRes.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    // Per-block accumulators. Anthropic streams blocks one at a time
    // by `index`; multiple text blocks may interleave with tool_use
    // blocks across a single turn.
    const blocks: Map<number, AnthropicContentBlock> = new Map();
    const toolJsonBuf: Map<number, string> = new Map();
    let stopReason: string | null = null;

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

          if (parsed.type === 'message_start' && parsed.message?.model && !modelEmitted) {
            emit(res, { model: parsed.message.model });
            modelEmitted = true;
          }

          if (parsed.type === 'content_block_start') {
            const idx = parsed.index ?? 0;
            const cb = parsed.content_block as AnthropicContentBlock;
            blocks.set(idx, { ...cb });
            if (cb.type === 'tool_use') toolJsonBuf.set(idx, '');
          }

          if (parsed.type === 'content_block_delta') {
            const idx = parsed.index ?? 0;
            const blk = blocks.get(idx);
            if (parsed.delta?.type === 'text_delta' && blk?.type === 'text') {
              const text = parsed.delta.text || '';
              blk.text = (blk.text ?? '') + text;
              emit(res, { content: text });
            }
            if (parsed.delta?.type === 'input_json_delta' && blk?.type === 'tool_use') {
              toolJsonBuf.set(idx, (toolJsonBuf.get(idx) ?? '') + (parsed.delta.partial_json ?? ''));
            }
          }

          if (parsed.type === 'content_block_stop') {
            const idx = parsed.index ?? 0;
            const blk = blocks.get(idx);
            if (blk?.type === 'tool_use') {
              const raw = toolJsonBuf.get(idx) ?? '';
              try { blk.input = raw ? JSON.parse(raw) : {}; }
              catch { blk.input = {}; }
            }
          }

          if (parsed.type === 'message_delta' && parsed.delta?.stop_reason) {
            stopReason = parsed.delta.stop_reason;
          }
        } catch { /* ignore non-JSON SSE control lines */ }
      }
    }

    // Compose the assistant turn's content array in index order.
    const assistantContent: AnthropicContentBlock[] = [...blocks.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, b]) => b);

    // Always append the assistant turn so the next round (if any)
    // sees the full conversation.
    messages.push({ role: 'assistant', content: assistantContent });

    // If we didn't see any tool_use blocks, the turn is done.
    const toolUses = assistantContent.filter(b => b.type === 'tool_use');
    if (toolUses.length === 0 || stopReason !== 'tool_use') break;

    // Dispatch each tool call. Append a single user message with all
    // tool_results in the same order. content (sent to the model) is
    // the JSON-stringified payload; summary stays in the SSE
    // tool_result frame for the chat UI alone — see stringifyForModel
    // above for the rationale.
    const toolResultBlocks: AnthropicContentBlock[] = [];
    for (const tu of toolUses) {
      const out = await dispatchOne(tu.name!, tu.input, toolCtx, sessionId, res, tu.id!);
      const modelContent = stringifyForModel(out.payload);
      toolResultBlocks.push({
        type:        'tool_result',
        tool_use_id: tu.id!,
        content:     modelContent,
      });
      totalToolBytes += modelContent.length;
      if (totalToolBytes > MAX_TOOL_RESULTS_BYTES) {
        emit(res, { error: 'tool result budget exceeded — stopping loop' });
        return;
      }
    }
    messages.push({ role: 'user', content: toolResultBlocks });
  }
}

// ── OpenAI-compat tool-loop ──────────────────────────────────────────────
//
// OpenAI message format:
//   { role: 'system'|'user'|'assistant'|'tool', content?, tool_calls?, tool_call_id? }
//   Assistant tool calls: { tool_calls: [{ id, type:'function',
//                                          function: { name, arguments } }] }
//   Tool result: { role: 'tool', tool_call_id, content }

interface OpenAIToolCall {
  id:       string;
  type:     'function';
  function: { name: string; arguments: string };
}
interface OpenAIMsg {
  role:        'system' | 'user' | 'assistant' | 'tool';
  content?:    string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  name?:       string;
}

function completionsUrlFor(baseUrl: string): string {
  const base = baseUrl.replace(/\/$/, '');
  return base.endsWith('/v1') ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
}

const BARE_KEYS = new Set(['none', 'ollama', 'lm-studio', 'maple-desktop-auto']);

export async function streamOpenAICompatWithTools(
  initialMessages: Msg[],
  system: string,
  cfg: ProviderConfig,
  res: http.ServerResponse,
  toolCtx: ToolContext | null,
  sessionId: string,
): Promise<void> {
  const messages: OpenAIMsg[] = [
    { role: 'system', content: system },
    ...initialMessages.map(m => ({
      role: (m.role === 'assistant' ? 'assistant' : 'user') as 'assistant' | 'user',
      content: typeof m.content === 'string' ? m.content : '',
    })),
  ];

  emit(res, { session: sessionId });
  emit(res, { model: cfg.model });

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cfg.apiKey && !BARE_KEYS.has(cfg.apiKey)) {
    headers['Authorization'] = `Bearer ${cfg.apiKey}`;
  }
  const url = completionsUrlFor(cfg.baseUrl);

  let totalToolBytes = 0;
  let modelEmitted = false;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const body: any = {
      model:    cfg.model,
      messages,
      stream:   true,
    };
    if (toolCtx) body.tools = toolsForOpenAI();

    const apiRes = await fetch(url, {
      method: 'POST',
      headers,
      body:   JSON.stringify(body),
    });
    if (!apiRes.ok) {
      const text = await apiRes.text().catch(() => '');
      throw new Error(`${cfg.providerName} ${apiRes.status}: ${text.slice(0, 200)}`);
    }

    const reader  = apiRes.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    let textOut = '';
    // Tool calls accumulate by index. Each chunk's delta.tool_calls[i]
    // appends to its arguments string.
    const tcs: Map<number, { id: string; name: string; args: string }> = new Map();
    let finishReason: string | null = null;

    outer: while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop()!;
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') break outer;
        if (!data) continue;
        try {
          const parsed = JSON.parse(data);
          if (!modelEmitted && typeof parsed.model === 'string' && parsed.model) {
            emit(res, { model: parsed.model });
            modelEmitted = true;
          }
          const choice = parsed.choices?.[0];
          if (!choice) continue;
          const delta = choice.delta || {};

          if (typeof delta.content === 'string' && delta.content) {
            textOut += delta.content;
            emit(res, { content: delta.content });
          }
          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              const cur = tcs.get(idx) ?? { id: '', name: '', args: '' };
              if (tc.id)               cur.id   = tc.id;
              if (tc.function?.name)   cur.name = tc.function.name;
              if (tc.function?.arguments) cur.args += tc.function.arguments;
              tcs.set(idx, cur);
            }
          }
          if (choice.finish_reason) finishReason = choice.finish_reason;
        } catch { /* tolerate malformed lines */ }
      }
    }

    // Build the assistant message that should appear in the thread.
    const toolCalls: OpenAIToolCall[] = [...tcs.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, tc]) => ({
        id:       tc.id,
        type:     'function' as const,
        function: { name: tc.name, arguments: tc.args },
      }));
    messages.push({
      role:       'assistant',
      content:    textOut || null,
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    });

    if (finishReason !== 'tool_calls' || toolCalls.length === 0) break;

    // Dispatch each tool call → append one role:'tool' message per.
    // content (sent to the model) is the JSON-stringified payload;
    // summary stays in the SSE tool_result frame for the chat UI
    // alone — see stringifyForModel above for the rationale.
    for (const tc of toolCalls) {
      let parsedArgs: any = {};
      try { parsedArgs = tc.function.arguments ? JSON.parse(tc.function.arguments) : {}; }
      catch { parsedArgs = {}; }
      const out = await dispatchOne(tc.function.name, parsedArgs, toolCtx, sessionId, res, tc.id);
      const modelContent = stringifyForModel(out.payload);
      messages.push({
        role:         'tool',
        tool_call_id: tc.id,
        content:      modelContent,
      });
      totalToolBytes += modelContent.length;
      if (totalToolBytes > MAX_TOOL_RESULTS_BYTES) {
        emit(res, { error: 'tool result budget exceeded — stopping loop' });
        return;
      }
    }
  }
}

// ── Shared dispatch step (permission gate + emit + run) ───────────────────

interface DispatchOutput {
  payload: any;
  summary: string;
}

async function dispatchOne(
  name:      string,
  args:      any,
  ctx:       ToolContext | null,
  sessionId: string,
  res:       http.ServerResponse,
  callId:    string,
): Promise<DispatchOutput> {
  // No project context means tools can't run — return an error envelope
  // back to the model so it can adapt rather than silently spinning.
  if (!ctx) {
    const payload = { ok: false, error: 'no project context — open a project before using tools' };
    emit(res, { type: 'tool_result', id: callId, ok: false, error: payload.error });
    return { payload, summary: payload.error };
  }

  const tool = getTool(name);
  if (!tool) {
    const payload = { ok: false, error: `unknown tool: ${name}` };
    emit(res, { type: 'tool_result', id: callId, ok: false, error: payload.error });
    return { payload, summary: payload.error };
  }

  emit(res, { type: 'tool_call_start', id: callId, name, args });

  // Approval gate.
  if (requiresApproval(name, ctx.permissions)) {
    const { approvalId, promise } = awaitApproval(sessionId);
    emit(res, {
      type:       'approval_request',
      id:         callId,
      approvalId,
      name,
      args,
      preview:    summarizeForPreview(name, args, ctx),
    });
    let decision: ApprovalDecision = 'reject';
    try { decision = await promise; }
    catch { decision = 'reject'; }
    if (decision === 'reject') {
      const payload = { ok: false, error: 'rejected by user' };
      emit(res, { type: 'tool_result', id: callId, ok: false, error: payload.error });
      return { payload, summary: payload.error };
    }
  }

  const result: ToolResult = await runTool(name, args, ctx);
  if (result.ok) {
    emit(res, { type: 'tool_result', id: callId, ok: true, summary: result.summary ?? '' });
    // Side channel: todo_read / todo_write surface the current list
    // separately so the chat UI can render the [N/M] tracker without
    // having to parse the per-call payload (the model still receives
    // the full payload via the tool_result content). Hardcoded here
    // because it's the only side-effect we surface today; if more
    // tools want side channels we'll add a `sideEffects?` field on
    // ToolResult instead of growing this branch.
    if ((name === 'todo_read' || name === 'todo_write')
        && result.content && typeof result.content === 'object'
        && Array.isArray((result.content as any).todos)) {
      emit(res, { type: 'todo_state', todos: (result.content as any).todos });
    }
    return { payload: { ok: true, content: result.content }, summary: result.summary ?? JSON.stringify(result.content).slice(0, 1000) };
  } else {
    emit(res, { type: 'tool_result', id: callId, ok: false, error: result.error });
    return { payload: { ok: false, error: result.error }, summary: result.error };
  }
}
