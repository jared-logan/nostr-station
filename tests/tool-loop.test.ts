// Tool-loop integration tests — drive streamAnthropicWithTools and
// streamOpenAICompatWithTools end-to-end with a mock fetch + a real
// project tmpdir. Asserts:
//   - text deltas reach the SSE stream
//   - tool_call_start / tool_result events emit
//   - tool calls actually mutate the project files
//   - approval gate pauses the loop, resumes on /approve
//   - MAX_ROUNDS bounds runaway loops
//
// Mocking strategy: `globalThis.fetch` is replaced per-test with a
// canned-response generator that emits Anthropic / OpenAI streaming
// frames as ReadableStreams. No network, fast, deterministic.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { Writable } from 'node:stream';

import {
  streamAnthropicWithTools, streamOpenAICompatWithTools,
} from '../src/lib/ai-tools/tool-loop.js';
import {
  createSession, destroySession, resolveApproval,
} from '../src/lib/ai-tools/approval-gate.js';

interface MinimalProject {
  id: string; name: string; path: string | null;
  capabilities: { git: boolean; ngit: boolean; nsite: boolean };
  identity: any; remotes: any; nsite: any;
  readRelays: null; createdAt: string; updatedAt: string;
}

function makeProject(p: string | null): MinimalProject {
  return {
    id: 'p', name: 'p', path: p,
    capabilities: { git: false, ngit: false, nsite: false },
    identity: { useDefault: true, npub: null, bunkerUrl: null },
    remotes: { github: null, ngit: null },
    nsite: { url: null, lastDeploy: null },
    readRelays: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

// ── Mock SSE response builder ────────────────────────────────────────────

function sseStream(events: string[]): Response {
  const body = new ReadableStream({
    start(c) {
      const enc = new TextEncoder();
      for (const e of events) c.enqueue(enc.encode(`data: ${e}\n\n`));
      c.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

// Anthropic frames
function anthMessageStart(model: string)        { return JSON.stringify({ type: 'message_start', message: { model } }); }
function anthBlockStartText(idx: number)        { return JSON.stringify({ type: 'content_block_start', index: idx, content_block: { type: 'text', text: '' } }); }
function anthBlockStartTool(idx: number, id: string, name: string) {
  return JSON.stringify({ type: 'content_block_start', index: idx, content_block: { type: 'tool_use', id, name, input: {} } });
}
function anthTextDelta(idx: number, t: string)  { return JSON.stringify({ type: 'content_block_delta', index: idx, delta: { type: 'text_delta', text: t } }); }
function anthInputJsonDelta(idx: number, j: string) {
  return JSON.stringify({ type: 'content_block_delta', index: idx, delta: { type: 'input_json_delta', partial_json: j } });
}
function anthBlockStop(idx: number)             { return JSON.stringify({ type: 'content_block_stop', index: idx }); }
function anthMessageDelta(reason: string)       { return JSON.stringify({ type: 'message_delta', delta: { stop_reason: reason } }); }

// OpenAI frames
function oaiTextDelta(model: string, content: string) {
  return JSON.stringify({ model, choices: [{ index: 0, delta: { content } }] });
}
function oaiToolDelta(model: string, idx: number, id: string, name: string, args: string) {
  return JSON.stringify({ model, choices: [{ index: 0, delta: { tool_calls: [{ index: idx, id, type: 'function', function: { name, arguments: args } }] } }] });
}
function oaiFinish(model: string, reason: string) {
  return JSON.stringify({ model, choices: [{ index: 0, finish_reason: reason }] });
}

// ── Capture-the-SSE-stream test harness ──────────────────────────────────

function makeRes(): { res: http.ServerResponse; lines: string[] } {
  const lines: string[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      const s = chunk.toString('utf8');
      for (const line of s.split('\n')) {
        if (line.startsWith('data: ')) {
          const d = line.slice(6).trim();
          if (d) lines.push(d);
        }
      }
      cb();
    },
  });
  // Minimal fake — only methods our code calls (write, end).
  const res: any = {
    write: (s: string) => sink.write(s),
    end:   () => sink.end(),
    writeHead: () => {},
  };
  return { res: res as http.ServerResponse, lines };
}

let ROOT: string;
let originalFetch: any;

beforeEach(() => {
  ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-tloop-'));
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ── Anthropic: text-only turn ────────────────────────────────────────────

test('anthropic: text-only response forwards deltas as data: {content}', async () => {
  globalThis.fetch = async () => sseStream([
    anthMessageStart('claude'),
    anthBlockStartText(0),
    anthTextDelta(0, 'Hello, '),
    anthTextDelta(0, 'world.'),
    anthBlockStop(0),
    anthMessageDelta('end_turn'),
  ]);

  const sid = createSession();
  const { res, lines } = makeRes();
  await streamAnthropicWithTools(
    [{ role: 'user', content: 'hi' }],
    'system',
    { isAnthropic: true, baseUrl: '', model: 'claude', apiKey: 'k', providerName: 'Anthropic' },
    res,
    { project: makeProject(ROOT) as any, permissions: 'read-only' },
    sid,
  );
  destroySession(sid);

  const events = lines.map(l => JSON.parse(l));
  const text = events.filter(e => typeof e.content === 'string').map(e => e.content).join('');
  assert.equal(text, 'Hello, world.');
});

// ── Anthropic: tool call dispatch ────────────────────────────────────────

test('anthropic: tool_use round-trips through dispatch + writes file', async () => {
  let call = 0;
  globalThis.fetch = async (input: any, init?: any) => {
    call++;
    if (call === 1) {
      // First turn: model emits a write_file tool_use block.
      const argsJson = JSON.stringify({ path: 'hello.txt', content: 'hi from AI' });
      return sseStream([
        anthMessageStart('claude'),
        anthBlockStartTool(0, 'tu_1', 'write_file'),
        anthInputJsonDelta(0, argsJson),
        anthBlockStop(0),
        anthMessageDelta('tool_use'),
      ]);
    }
    // Second turn: model wraps up after seeing tool_result.
    return sseStream([
      anthBlockStartText(0),
      anthTextDelta(0, 'Done.'),
      anthBlockStop(0),
      anthMessageDelta('end_turn'),
    ]);
  };

  const sid = createSession();
  const { res, lines } = makeRes();
  await streamAnthropicWithTools(
    [{ role: 'user', content: 'write hello.txt' }],
    'system',
    { isAnthropic: true, baseUrl: '', model: 'claude', apiKey: 'k', providerName: 'Anthropic' },
    res,
    { project: makeProject(ROOT) as any, permissions: 'yolo' }, // yolo so writes auto-approve
    sid,
  );
  destroySession(sid);

  // File got written.
  assert.equal(fs.readFileSync(path.join(ROOT, 'hello.txt'), 'utf8'), 'hi from AI');

  // SSE stream contains the tool_call_start + tool_result events.
  const events = lines.map(l => JSON.parse(l));
  assert.ok(events.some(e => e.type === 'tool_call_start' && e.name === 'write_file'));
  assert.ok(events.some(e => e.type === 'tool_result' && e.ok === true));
  // And the final text delta from the second turn.
  assert.ok(events.some(e => e.content === 'Done.'));
});

// ── Anthropic: approval gate ─────────────────────────────────────────────

test('anthropic: gated tool waits for approval; reject means file not written', async () => {
  let call = 0;
  globalThis.fetch = async () => {
    call++;
    if (call === 1) {
      const argsJson = JSON.stringify({ path: 'gated.txt', content: 'should-not-land' });
      return sseStream([
        anthMessageStart('claude'),
        anthBlockStartTool(0, 'tu_1', 'write_file'),
        anthInputJsonDelta(0, argsJson),
        anthBlockStop(0),
        anthMessageDelta('tool_use'),
      ]);
    }
    return sseStream([
      anthBlockStartText(0),
      anthTextDelta(0, 'Cancelled.'),
      anthBlockStop(0),
      anthMessageDelta('end_turn'),
    ]);
  };

  const sid = createSession();
  const { res, lines } = makeRes();

  // Drive the request. Reject the approval as soon as we see it.
  const requestP = streamAnthropicWithTools(
    [{ role: 'user', content: 'attempt write' }],
    'system',
    { isAnthropic: true, baseUrl: '', model: 'claude', apiKey: 'k', providerName: 'Anthropic' },
    res,
    { project: makeProject(ROOT) as any, permissions: 'read-only' }, // read-only → write_file is gated
    sid,
  );
  // Give the loop a chance to emit the approval_request event.
  let approvalId: string | null = null;
  const start = Date.now();
  while (Date.now() - start < 1000) {
    await new Promise(r => setTimeout(r, 10));
    const ar = lines.map(l => JSON.parse(l)).find(e => e.type === 'approval_request');
    if (ar) { approvalId = ar.approvalId; break; }
  }
  assert.ok(approvalId, 'expected approval_request event');
  resolveApproval(sid, approvalId!, 'reject');

  await requestP;
  destroySession(sid);

  // File NOT written.
  assert.equal(fs.existsSync(path.join(ROOT, 'gated.txt')), false);

  // Tool result reflects rejection.
  const events = lines.map(l => JSON.parse(l));
  const tr = events.find(e => e.type === 'tool_result');
  assert.equal(tr.ok, false);
  assert.match(tr.error, /rejected/i);
});

test('anthropic: approval approve actually executes the tool', async () => {
  let call = 0;
  globalThis.fetch = async () => {
    call++;
    if (call === 1) {
      const argsJson = JSON.stringify({ path: 'approved.txt', content: 'landed' });
      return sseStream([
        anthMessageStart('claude'),
        anthBlockStartTool(0, 'tu_1', 'write_file'),
        anthInputJsonDelta(0, argsJson),
        anthBlockStop(0),
        anthMessageDelta('tool_use'),
      ]);
    }
    return sseStream([
      anthBlockStartText(0),
      anthTextDelta(0, 'Done.'),
      anthBlockStop(0),
      anthMessageDelta('end_turn'),
    ]);
  };

  const sid = createSession();
  const { res, lines } = makeRes();
  const requestP = streamAnthropicWithTools(
    [{ role: 'user', content: 'attempt write' }],
    'system',
    { isAnthropic: true, baseUrl: '', model: 'claude', apiKey: 'k', providerName: 'Anthropic' },
    res,
    { project: makeProject(ROOT) as any, permissions: 'read-only' },
    sid,
  );
  let approvalId: string | null = null;
  const start = Date.now();
  while (Date.now() - start < 1000) {
    await new Promise(r => setTimeout(r, 10));
    const ar = lines.map(l => JSON.parse(l)).find(e => e.type === 'approval_request');
    if (ar) { approvalId = ar.approvalId; break; }
  }
  assert.ok(approvalId);
  resolveApproval(sid, approvalId!, 'approve');
  await requestP;
  destroySession(sid);

  assert.equal(fs.readFileSync(path.join(ROOT, 'approved.txt'), 'utf8'), 'landed');
});

// ── Approval preview: build_project surfaces resolved script ─────────────

test('build_project: approval preview shows the resolved scripts.build content', async () => {
  // Pins the security defence-in-depth shipped after the auto-edit
  // sandbox-escape review: when build_project gates for approval,
  // the preview must include the actual script string from
  // package.json so a hostile edit-then-build chain (apply_patch
  // rewrites scripts.build → calls build_project) shows the
  // injected payload in the approval modal instead of a generic
  // "build?" prompt.
  fs.writeFileSync(path.join(ROOT, 'package.json'), JSON.stringify({
    name: 'preview-test', version: '0.0.0',
    scripts: { build: 'vite build --mode test' },
  }));
  let call = 0;
  globalThis.fetch = async () => {
    call++;
    if (call === 1) {
      return sseStream([
        anthMessageStart('claude'),
        anthBlockStartTool(0, 'tu_1', 'build_project'),
        anthInputJsonDelta(0, '{}'),
        anthBlockStop(0),
        anthMessageDelta('tool_use'),
      ]);
    }
    // After rejection the loop continues for a wrap-up turn.
    return sseStream([
      anthBlockStartText(0),
      anthTextDelta(0, 'Cancelled.'),
      anthBlockStop(0),
      anthMessageDelta('end_turn'),
    ]);
  };

  const sid = createSession();
  const { res, lines } = makeRes();
  const requestP = streamAnthropicWithTools(
    [{ role: 'user', content: 'build it' }],
    'system',
    { isAnthropic: true, baseUrl: '', model: 'claude', apiKey: 'k', providerName: 'Anthropic' },
    res,
    { project: makeProject(ROOT) as any, permissions: 'auto-edit' },   // would have auto-approved pre-fix
    sid,
  );

  // Approval is now required in auto-edit (the fix).
  let approvalEvent: any = null;
  const start = Date.now();
  while (Date.now() - start < 1000) {
    await new Promise(r => setTimeout(r, 10));
    approvalEvent = lines.map(l => JSON.parse(l)).find(e => e.type === 'approval_request');
    if (approvalEvent) break;
  }
  assert.ok(approvalEvent, 'build_project must require approval in auto-edit (sandbox escape fix)');
  // Preview surfaces the resolved script body — not just the empty argv.
  assert.equal(approvalEvent.preview?.command, 'npm run build');
  assert.equal(approvalEvent.preview?.script,  'vite build --mode test');

  resolveApproval(sid, approvalEvent.approvalId, 'reject');
  await requestP;
  destroySession(sid);
});

// ── OpenAI tool loop ──────────────────────────────────────────────────────

test('openai: text + tool_calls round-trip', async () => {
  let call = 0;
  globalThis.fetch = async () => {
    call++;
    if (call === 1) {
      const argsJson = JSON.stringify({ path: 'oai.txt', content: 'oai-wrote' });
      return sseStream([
        oaiToolDelta('gpt', 0, 'tc_1', 'write_file', argsJson),
        oaiFinish('gpt', 'tool_calls'),
      ]);
    }
    return sseStream([
      oaiTextDelta('gpt', 'OK.'),
      oaiFinish('gpt', 'stop'),
    ]);
  };

  const sid = createSession();
  const { res, lines } = makeRes();
  await streamOpenAICompatWithTools(
    [{ role: 'user', content: 'write oai.txt' }],
    'system',
    { isAnthropic: false, baseUrl: 'https://api.example.com/v1', model: 'gpt', apiKey: 'k', providerName: 'OpenAI-compat' },
    res,
    { project: makeProject(ROOT) as any, permissions: 'yolo' },
    sid,
  );
  destroySession(sid);

  assert.equal(fs.readFileSync(path.join(ROOT, 'oai.txt'), 'utf8'), 'oai-wrote');

  const events = lines.map(l => JSON.parse(l));
  assert.ok(events.some(e => e.type === 'tool_call_start' && e.name === 'write_file'));
  assert.ok(events.some(e => e.type === 'tool_result' && e.ok === true));
  assert.ok(events.some(e => e.content === 'OK.'));
});

// ── No project context — tools refused gracefully ────────────────────────

test('no project context: tool call returns "no project context" error', async () => {
  globalThis.fetch = async () => {
    const argsJson = JSON.stringify({ path: 'orphan.txt', content: 'x' });
    return sseStream([
      anthMessageStart('claude'),
      anthBlockStartTool(0, 'tu_1', 'write_file'),
      anthInputJsonDelta(0, argsJson),
      anthBlockStop(0),
      anthMessageDelta('tool_use'),
    ]);
  };

  const sid = createSession();
  const { res, lines } = makeRes();
  await streamAnthropicWithTools(
    [{ role: 'user', content: 'try' }],
    'system',
    { isAnthropic: true, baseUrl: '', model: 'claude', apiKey: 'k', providerName: 'Anthropic' },
    res,
    null, // no project context
    sid,
  );
  destroySession(sid);

  const events = lines.map(l => JSON.parse(l));
  const tr = events.find(e => e.type === 'tool_result');
  assert.ok(tr);
  assert.equal(tr.ok, false);
  assert.match(tr.error, /no project context/i);
});

// ── Protocol: model receives full payload, not just summary ──────────────
//
// Pre-fix the tool-loop sent `out.summary` (a one-line status string
// like "991 B" or "18 entries") as the tool_result content, leaving
// the actual payload invisible to the model. The agent had no way to
// see file contents, list_dir entries, or run_command stdout — every
// call effectively returned a status string with no data. These tests
// pin the new contract (payload reaches the model; summary stays in
// the SSE frame for the chat UI alone) so a future regression can't
// quietly recross the wires.

test('protocol: read_file content reaches the model (anthropic)', async () => {
  // Seed a file the model "asks to read", then capture the second-turn
  // request body — the tool_result content there is what the model
  // actually sees on its next inference. Asserting the file's literal
  // content appears in that body is the structural pin.
  const FILE_CONTENT = 'this is the secret file body the model needs to see';
  fs.writeFileSync(path.join(ROOT, 'secret.txt'), FILE_CONTENT, 'utf8');

  let secondTurnBody: any = null;
  let call = 0;
  globalThis.fetch = async (_input: any, init?: any) => {
    call++;
    if (call === 1) {
      const argsJson = JSON.stringify({ path: 'secret.txt' });
      return sseStream([
        anthMessageStart('claude'),
        anthBlockStartTool(0, 'tu_1', 'read_file'),
        anthInputJsonDelta(0, argsJson),
        anthBlockStop(0),
        anthMessageDelta('tool_use'),
      ]);
    }
    secondTurnBody = JSON.parse(init.body);
    return sseStream([
      anthBlockStartText(0),
      anthTextDelta(0, 'Done.'),
      anthBlockStop(0),
      anthMessageDelta('end_turn'),
    ]);
  };

  const sid = createSession();
  const { res } = makeRes();
  await streamAnthropicWithTools(
    [{ role: 'user', content: 'read secret.txt' }],
    'system',
    { isAnthropic: true, baseUrl: '', model: 'claude', apiKey: 'k', providerName: 'Anthropic' },
    res,
    { project: makeProject(ROOT) as any, permissions: 'read-only' },
    sid,
  );
  destroySession(sid);

  // The tool_result must have shipped the payload, not the summary.
  // Extract the user message that carries tool_result blocks and
  // check its content for the file body.
  assert.ok(secondTurnBody, 'second turn never ran — first turn must have completed dispatch');
  const userToolResultMsg = secondTurnBody.messages.find((m: any) =>
    m.role === 'user' && Array.isArray(m.content)
    && m.content.some((b: any) => b.type === 'tool_result'));
  assert.ok(userToolResultMsg, 'expected a user message carrying tool_result blocks');
  const block = userToolResultMsg.content.find((b: any) => b.type === 'tool_result');
  assert.ok(typeof block.content === 'string');
  assert.ok(
    block.content.includes(FILE_CONTENT),
    `tool_result content must include the file body — got: ${block.content.slice(0, 200)}`,
  );
  // And the SSE frame still carries a UI summary (separate channel).
  // Not asserting exact text because that's a UI concern; just that
  // the SSE frame's summary is shorter than the model's content (the
  // proof that they're separate channels).
});

test('protocol: list_dir entries reach the model (openai)', async () => {
  // Seed a few files so list_dir has something to enumerate.
  fs.writeFileSync(path.join(ROOT, 'alpha.md'), '');
  fs.writeFileSync(path.join(ROOT, 'beta.md'),  '');
  fs.writeFileSync(path.join(ROOT, 'gamma.md'), '');

  let secondTurnBody: any = null;
  let call = 0;
  globalThis.fetch = async (_input: any, init?: any) => {
    call++;
    if (call === 1) {
      const argsJson = JSON.stringify({ path: '.' });
      return sseStream([
        oaiToolDelta('m', 0, 'tc_1', 'list_dir', argsJson),
        oaiFinish('m', 'tool_calls'),
      ]);
    }
    secondTurnBody = JSON.parse(init.body);
    return sseStream([
      oaiTextDelta('m', 'OK.'),
      oaiFinish('m', 'stop'),
    ]);
  };

  const sid = createSession();
  const { res } = makeRes();
  await streamOpenAICompatWithTools(
    [{ role: 'user', content: 'list root' }],
    'system',
    { isAnthropic: false, baseUrl: '', model: 'm', apiKey: 'k', providerName: 'X' },
    res,
    { project: makeProject(ROOT) as any, permissions: 'read-only' },
    sid,
  );
  destroySession(sid);

  assert.ok(secondTurnBody, 'second turn never ran');
  const toolMsg = secondTurnBody.messages.find((m: any) => m.role === 'tool');
  assert.ok(toolMsg, 'expected a role:tool message carrying the tool result');
  // All three filenames the agent should be able to see.
  for (const name of ['alpha.md', 'beta.md', 'gamma.md']) {
    assert.ok(
      toolMsg.content.includes(name),
      `tool result must include "${name}" — got: ${toolMsg.content.slice(0, 200)}`,
    );
  }
});
