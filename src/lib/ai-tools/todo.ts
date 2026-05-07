// Per-project todo list — gives the agent a planning surface so it
// can announce a multi-step task ("[1/4] Create NotePreview", etc.)
// and update progress as it works through it. Mirrors shakespeare.diy's
// TodoRead/TodoWrite + the [N/M] UI rendering you can see in the chat
// trace screenshots.
//
// Storage: in-memory, keyed by project id. Cleared on server restart
// (same lifecycle as approval-gate sessions). Project-scoped rather
// than session-scoped because the model often picks up a half-done
// list across multiple chat turns / page reloads — the context
// belongs to the project, not the conversation.

import type { Tool, ToolResult } from './index.js';

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface Todo {
  id:      string;
  content: string;
  status:  TodoStatus;
}

const STORE = new Map<string, Todo[]>();

// Project-id key; null/empty falls back to a 'global' bucket so
// global chat sessions still get a working list.
function keyFor(projectId: string | null | undefined): string {
  return projectId && projectId.trim() ? projectId : 'global';
}

export function getTodos(projectId: string | null | undefined): Todo[] {
  return STORE.get(keyFor(projectId))?.slice() ?? [];
}

export function setTodos(projectId: string | null | undefined, todos: Todo[]): Todo[] {
  STORE.set(keyFor(projectId), todos.slice());
  return todos.slice();
}

// Test/shutdown helper — wipe every project's list. Not exposed to
// the AI; only the test harness and the long-term-cleanup branch
// reach for this.
export function clearAllTodos(): void {
  STORE.clear();
}

// Summary helper — shared between the tools and the SSE frame
// emitted by the tool-loop after a TodoWrite. Compact "[N/M done]"
// style so a glance tells you progress without expanding.
export function summarize(todos: Todo[]): string {
  if (todos.length === 0) return 'no todos';
  const done = todos.filter(t => t.status === 'completed').length;
  const inflight = todos.filter(t => t.status === 'in_progress').length;
  const pending  = todos.filter(t => t.status === 'pending').length;
  const parts: string[] = [`${done}/${todos.length} done`];
  if (inflight > 0) parts.push(`${inflight} in progress`);
  if (pending > 0)  parts.push(`${pending} pending`);
  return parts.join(' · ');
}

const todo_read: Tool = {
  name: 'todo_read',
  description:
    'Read the current todo list for this project. Use to check progress '
    + 'between turns or to pick up an in-flight plan after a context switch. '
    + 'Returns { todos: [{ id, content, status }] }.',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  permission: 'always',
  handler: async (_args, ctx): Promise<ToolResult> => {
    const todos = getTodos(ctx.project.id);
    return {
      ok: true,
      // summary lives on the ToolResult envelope (above) and in the
      // SSE tool_result frame; the model sees a single source of
      // truth for it. Don't duplicate it inside content.
      content: { todos },
      summary: summarize(todos),
    };
  },
};

const todo_write: Tool = {
  name: 'todo_write',
  description:
    'Replace the project\'s todo list with the provided items. Use to '
    + 'plan a multi-step task before executing, then call this tool again '
    + 'to mark items in_progress / completed as you work through them. '
    + 'Each item: { id (string), content (string), status (pending | '
    + 'in_progress | completed) }. Pass an empty array to clear. The list '
    + 'is in-memory + per-project; it survives chat-turn boundaries but '
    + 'not server restart.',
  inputSchema: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id:      { type: 'string' },
            content: { type: 'string' },
            status:  { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
          },
          required: ['id', 'content', 'status'],
          additionalProperties: false,
        },
      },
    },
    required: ['todos'],
    additionalProperties: false,
  },
  permission: 'always',
  handler: async (args, ctx): Promise<ToolResult> => {
    if (!Array.isArray(args.todos)) {
      return { ok: false, error: 'todos must be an array' };
    }
    // Validate + coerce. Refuse rather than silently drop bad
    // entries so a malformed call surfaces clearly to the model.
    const next: Todo[] = [];
    for (const raw of args.todos) {
      if (!raw || typeof raw !== 'object') {
        return { ok: false, error: 'each todo must be an object' };
      }
      const id      = String((raw as Todo).id ?? '').trim();
      const content = String((raw as Todo).content ?? '').trim();
      const status  = (raw as Todo).status;
      if (!id)      return { ok: false, error: 'todo.id is required' };
      if (!content) return { ok: false, error: 'todo.content is required' };
      if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') {
        return { ok: false, error: `todo.status must be pending|in_progress|completed (got: ${String(status)})` };
      }
      next.push({ id, content, status });
    }
    const stored = setTodos(ctx.project.id, next);
    return {
      ok: true,
      content: { todos: stored },
      summary: summarize(stored),
    };
  },
};

export const TOOLS: Tool[] = [todo_read, todo_write];
