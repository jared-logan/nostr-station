/**
 * AI tools dispatcher — the bridge between provider tool-call APIs
 * (Anthropic + OpenAI-compat) and the project-scoped fs / git / exec
 * tool implementations.
 *
 * Single source of truth: every tool registers its name, description,
 * JSON-schema, permission class, and handler in this module's
 * `TOOLS` map. Provider integrations enumerate the map to build
 * provider-specific tool specs (Anthropic's `tools` array, OpenAI's
 * `tools: [{ type: 'function', function: { … } }]`), and dispatch
 * back through `runTool()` after the model emits a tool_use block.
 *
 * Permission classes:
 *
 *   'always'  — read-class tools (list_dir, read_file, git_status,
 *               git_log, git_diff). Auto-execute regardless of mode.
 *   'gated'   — write/exec tools (write_file, apply_patch,
 *               delete_file, run_command, git_commit). Only auto-
 *               execute under 'auto-edit' (writes only) or 'yolo'
 *               (everything). Otherwise the provider tool-loop must
 *               surface an approval prompt to the user.
 *
 * The dispatcher itself NEVER prompts — that's the provider tool-loop's
 * job. dispatchTool() returns ok-or-error envelopes and the caller
 * decides whether to call runTool() or surface an approval request.
 */

import type { Project } from '../projects.js';
import type { PermissionMode } from '../templates.js';
import { TOOLS as FS_TOOLS } from './fs.js';
import { TOOLS as GIT_TOOLS } from './git.js';
import { TOOLS as EXEC_TOOLS } from './exec.js';
import { TOOLS as TODO_TOOLS } from './todo.js';
import { TOOLS as BUILD_TOOLS } from './build.js';

// Re-export todo store helpers so test fixtures can reset between cases
// without reaching into the implementation file.
export { clearAllTodos } from './todo.js';

export type Permission = 'always' | 'gated';

export interface ToolContext {
  project:     Project;
  permissions: PermissionMode;
}

export type ToolResult =
  | { ok: true;  content: any; summary?: string }
  | { ok: false; error: string };

export interface Tool {
  name:        string;
  description: string;
  /** JSON Schema (canonical Anthropic-style). Provider adapters
   *  rewrap as needed. */
  inputSchema: {
    type:        'object';
    properties:  Record<string, unknown>;
    required?:   string[];
    additionalProperties?: false;
  };
  permission:  Permission;
  handler:     (args: any, ctx: ToolContext) => Promise<ToolResult>;
}

// ── Master registry ──────────────────────────────────────────────────────

const REGISTRY: Record<string, Tool> = {};

function register(tool: Tool): void {
  if (REGISTRY[tool.name]) {
    throw new Error(`tool already registered: ${tool.name}`);
  }
  REGISTRY[tool.name] = tool;
}

[...FS_TOOLS, ...GIT_TOOLS, ...EXEC_TOOLS, ...TODO_TOOLS, ...BUILD_TOOLS].forEach(register);

// ── Public API ───────────────────────────────────────────────────────────

export function listTools(): Tool[] {
  return Object.values(REGISTRY);
}

export function getTool(name: string): Tool | null {
  return REGISTRY[name] ?? null;
}

/**
 * Decide whether a tool needs a user-approval gate before execution.
 * Provider tool-loops call this BEFORE handing off to runTool().
 */
export function requiresApproval(toolName: string, mode: PermissionMode): boolean {
  const tool = REGISTRY[toolName];
  if (!tool) return true; // unknown tool → always gate (then handler will reject)
  if (tool.permission === 'always') return false;
  // 'gated' tools depend on the mode.
  if (mode === 'yolo')      return false;
  if (mode === 'auto-edit') {
    // auto-edit: file writes auto-approve; the two tools that can
    // execute arbitrary user-supplied process commands stay gated.
    //
    // build_project rides the same line as run_command because of
    // the edit-then-build escape: write tools are auto-approved in
    // this mode, so a hostile model (e.g. via prompt injection
    // through document content the agent reads) can use apply_patch
    // to overwrite package.json's scripts.build with an arbitrary
    // shell payload, then call build_project to execute it via
    // `npm run build`. The run_command DENYLIST never fires
    // because the spawned binary is hard-coded `npm`. Gating
    // build_project here closes the chain — the user sees a
    // preview of the resolved scripts.build string before any
    // build runs (see summarizeForPreview in tool-loop.ts).
    return tool.name === 'run_command' || tool.name === 'build_project';
  }
  // 'read-only' (default) — every gated tool needs approval.
  return true;
}

/**
 * Execute a tool by name with the given args + context. Caller is
 * responsible for permission gating (call requiresApproval first).
 *
 * Wraps handler errors so a thrown exception still returns an
 * { ok: false, error } envelope — providers shouldn't see raw
 * stack traces.
 */
export async function runTool(
  name: string,
  args: any,
  ctx:  ToolContext,
): Promise<ToolResult> {
  const tool = REGISTRY[name];
  if (!tool) return { ok: false, error: `unknown tool: ${name}` };
  try {
    return await tool.handler(args ?? {}, ctx);
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

// ── Provider-spec adapters ───────────────────────────────────────────────

/**
 * Build the Anthropic-shaped `tools` array for /v1/messages.
 *   { name, description, input_schema }
 */
export function toolsForAnthropic(): Array<{
  name: string; description: string; input_schema: any;
}> {
  return listTools().map(t => ({
    name:         t.name,
    description:  t.description,
    input_schema: t.inputSchema,
  }));
}

/**
 * Build the OpenAI-compat `tools` array for /v1/chat/completions.
 *   { type: 'function', function: { name, description, parameters } }
 */
export function toolsForOpenAI(): Array<{
  type: 'function';
  function: { name: string; description: string; parameters: any };
}> {
  return listTools().map(t => ({
    type: 'function' as const,
    function: {
      name:        t.name,
      description: t.description,
      parameters:  t.inputSchema,
    },
  }));
}
