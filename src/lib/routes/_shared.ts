/**
 * Cross-route helpers — used by more than one route module.
 *
 * The orchestrator (`web-server.ts`) and the per-section route modules
 * import from here rather than from each other, so we don't grow a tangle
 * of cyclic imports as the route surface keeps splitting up.
 *
 * Things that live here:
 *   - `readBody` — JSON-body slurper. Every route that reads request bodies
 *     uses it; the implementation is identical and trivial.
 *   - `streamExec` / `streamExecError` — SSE wrappers around child processes.
 *     Used by Projects (publish, ngit init/push, stacks deploy, exec) and
 *     in a follow-up step by the AI-chat surface and the install slug
 *     dispatcher in web-server.ts.
 *   - `CmdSpec` — the small payload shape `streamExec` accepts.
 *   - `CLI_BIN` / `CLI_SPAWN` / `IS_DEV` — entrypoint resolution for spawning
 *     our own CLI. Kept here because both the orchestrator (`/api/exec/*`)
 *     and the route modules (e.g. nsite deploy) need them, and we don't
 *     want each module re-deriving the dev-vs-built layout independently.
 *   - `getActiveChatProjectId` / `setActiveChatProjectId` — encapsulated
 *     mutable state that bridges the Chat proxy (still in web-server.ts)
 *     and the `/api/chat/context` route (now in routes/projects.ts).
 *     Module-scoped, resets on server restart (same lifecycle as sessions).
 *
 * Everything here is intentionally framework-free — plain Node `http`
 * primitives in, plain Node `http` primitives out — so a route handler
 * can stay focused on its routing logic without learning a custom helper
 * library.
 */
import http from 'http';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

// ── Body reader ─────────────────────────────────────────────────────────────

export async function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end',  () => resolve(body));
    req.on('error', reject);
  });
}

// ── CLI entrypoint resolution ──────────────────────────────────────────────
//
// Two layouts to support:
//   - Built (npm install -g):  dist/lib/web-server.js → dist/cli.js (Node).
//   - Dev (`tsx src/cli.tsx chat`): src/lib/web-server.ts → src/cli.tsx (tsx).
//
// `here` is the directory of THIS file. From either layout, climbing one
// `..` lands us in `dist/` or `src/lib/`'s sibling dir, and CLI_BIN /
// CLI_TSX produce the right absolute path for the runner pair.
const here = path.dirname(fileURLToPath(import.meta.url));
export const CLI_BIN = path.resolve(here, '..', '..', 'cli.js');
const CLI_TSX = path.resolve(here, '..', '..', '..', 'src', 'cli.tsx');
const TSX_BIN = path.resolve(here, '..', '..', '..', 'node_modules', '.bin', 'tsx');
// Detect dev layout by checking where this module itself lives. When the
// route module is being run from src/lib/routes/ (tsx-hosted), prefer
// spawning our CLI subcommands from src/cli.tsx too — otherwise edits
// under src/ won't land until the user runs `npm run build`. In prod
// (dist/lib/routes/), we always prefer the compiled cli.js + node pair.
export const IS_DEV = here.includes(`${path.sep}src${path.sep}lib${path.sep}routes`);
export const CLI_SPAWN = (!IS_DEV && fs.existsSync(CLI_BIN))
  ? { bin: process.execPath, prefix: [CLI_BIN] }
  : { bin: TSX_BIN,          prefix: [CLI_TSX] };

// ── streamExec / streamExecError ───────────────────────────────────────────

// Default ceilings — subprocess timeout and consecutive-identical-line
// cap. Both are safety nets, not policy: streamExec consumers can
// override per-call via CmdSpec. Pre-fix neither existed, and a
// retry-looping `ngit init` was able to flood the SSE buffer with
// thousands of identical "failed to get nsec input from interactor"
// lines per second until the dashboard heap blew. See PR followup
// for the concrete repro.
export const STREAM_EXEC_DEFAULT_TIMEOUT_MS  = 60_000;
export const STREAM_EXEC_DEFAULT_MAX_REPEATS = 50;

export type CmdSpec = {
  bin:   string;
  args:  string[];
  env?:  Record<string, string>;
  // Per-spec overrides for the safety net. `timeoutMs:0` opts out
  // (used for installs whose total runtime can legitimately exceed
  // the default — those pass `STREAM_EXEC_DEFAULT_INSTALL_TIMEOUT_MS`
  // or 0). `maxRepeatedLines:0` likewise disables the consecutive-
  // line cap; we don't expect any caller to want this, but the
  // escape hatch is cheap.
  timeoutMs?:        number;
  maxRepeatedLines?: number;
};

export function streamExec(
  spec: CmdSpec,
  res: http.ServerResponse,
  req: http.IncomingMessage,
  cwd?: string,
  prelude?: object,
): void {
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

  // Safety net: kill the child + close the stream once any of the
  // bound conditions trip. Set the `bounded` flag so racing emits
  // (the kill is async; the child can still flush bytes between
  // SIGTERM and exit) don't keep flooding the response.
  const timeoutMs        = spec.timeoutMs        ?? STREAM_EXEC_DEFAULT_TIMEOUT_MS;
  const maxRepeatedLines = spec.maxRepeatedLines ?? STREAM_EXEC_DEFAULT_MAX_REPEATS;
  let bounded = false;
  const kill = (reason: string, code: number) => {
    if (bounded) return;
    bounded = true;
    emit({ line: reason, stream: 'stderr' });
    try { child.kill('SIGTERM'); } catch {}
    if (timeoutHandle) clearTimeout(timeoutHandle);
    emit({ done: true, code });
    try { res.end(); } catch {}
  };
  const timeoutHandle = timeoutMs > 0
    ? setTimeout(() => kill(`[killed: subprocess exceeded ${Math.round(timeoutMs / 1000)}s timeout]`, -2), timeoutMs)
    : null;

  // Per-stream consecutive-line tracker. Key = `${stream}:${line}`,
  // counted per identical neighbour (NOT total occurrences) so a
  // mixed-output run that intermittently repeats a normal line
  // doesn't hit the cap. The bug pattern is "same line N times in
  // a row, no other output" — exactly the retry-loop signature.
  let lastKey   = '';
  let runLength = 0;

  const pushLine = (line: string, stream: 'stdout' | 'stderr') => {
    if (bounded) return;
    if (maxRepeatedLines > 0) {
      const key = `${stream}\0${line}`;
      if (key === lastKey) {
        runLength++;
        if (runLength > maxRepeatedLines) {
          kill(
            `[bounded: ${maxRepeatedLines}+ identical lines suppressed; subprocess killed — likely a retry-loop bug upstream]`,
            -3,
          );
          return;
        }
      } else {
        lastKey   = key;
        runLength = 1;
      }
    }
    emit({ line, stream });
  };

  const pushStream = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
    const lines = chunk.toString().split('\n');
    for (const line of lines) {
      if (line.length) pushLine(line, stream);
    }
  };
  child.stdout.on('data', pushStream('stdout'));
  child.stderr.on('data', pushStream('stderr'));
  child.on('close', (code) => {
    if (bounded) return;
    if (timeoutHandle) clearTimeout(timeoutHandle);
    emit({ done: true, code });
    try { res.end(); } catch {}
  });
  child.on('error', (e) => {
    if (bounded) return;
    if (timeoutHandle) clearTimeout(timeoutHandle);
    emit({ line: String(e.message || e), stream: 'stderr' });
    emit({ done: true, code: -1 });
    try { res.end(); } catch {}
  });

  const cleanup = () => {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    try { child.kill(); } catch {}
  };
  req.on('close', cleanup);
  req.on('error', cleanup);
}

// Emits a single SSE stderr line + done frame so the exec modal renders a
// readable error exactly like a real command failure would. Used for
// preflight checks (e.g. missing git remote) where we want to skip the
// spawn entirely but keep the UX consistent with streamed command failures.
export function streamExecError(
  res: http.ServerResponse,
  req: http.IncomingMessage,
  message: string,
): void {
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

// ── Active chat project state ──────────────────────────────────────────────
//
// Set via POST /api/chat/context (routes/projects.ts), read by the chat
// proxy (web-server.ts) to pick the right system prompt. null means "use
// global NOSTR_STATION.md". Wrapped in a getter/setter pair so neither
// caller can drift from a single source of truth.
let activeChatProjectId: string | null = null;
export function getActiveChatProjectId(): string | null {
  return activeChatProjectId;
}
export function setActiveChatProjectId(id: string | null): void {
  activeChatProjectId = id;
}

// Auto-sync manager bridge. The orchestrator (`web-server.ts`) instantiates
// AutoSyncManager at startup and registers it here; the project PATCH
// route reads it back to call `reconcile(id)` after a toggle, so the
// flag takes effect inside the request/response cycle. Same shape as
// the chat-context bridge above — single source of truth, no cyclic
// imports between routes/* and web-server.ts.
//
// Typed loosely (`unknown`) to keep this module free of the heavier
// AutoSyncManager class import; consumers narrow at the call site.
let autoSyncRef: { reconcile: (id: string) => void } | null = null;
export function getAutoSyncRef(): { reconcile: (id: string) => void } | null {
  return autoSyncRef;
}
export function setAutoSyncRef(ref: { reconcile: (id: string) => void } | null): void {
  autoSyncRef = ref;
}
