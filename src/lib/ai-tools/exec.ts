/**
 * run_command — argv-only command execution scoped to the active
 * project. Always 'gated' (writes-or-worse). Even under YOLO mode
 * the user sees the call rendered in the chat UI before execution
 * proceeds — the gate is bypassed but the visibility is not.
 *
 * Hard rules:
 *   - argv ARRAY only. No string command, no shell flag. This
 *     matches NOSTR_STATION.md rule #2 ("All shell calls use argv
 *     arrays. No string concatenation into /bin/sh -c.").
 *   - cwd is the project path (or a project-relative subdir if the
 *     model passes one — validated through resolveProjectPath).
 *   - Output capped at 256 KB total (stdout + stderr combined).
 *   - Default 60-second timeout, max 600 seconds. Long-running
 *     processes (dev servers, watch loops) belong in the terminal
 *     panel, not this tool.
 *   - A small denylist of obviously destructive argv prefixes is
 *     rejected outright regardless of permissions mode. The
 *     intent isn't to catch every bad command (impossible) — it's
 *     to refuse the easy-to-typo footguns so the user can't
 *     accidentally one-click rm -rf their home dir.
 */

import { spawn } from 'child_process';
import type { Tool, ToolResult } from './index.js';
import { resolveProjectPath } from './path-safety.js';

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS     = 600_000;
const MAX_OUTPUT_BYTES   = 256 * 1024;

// Argv prefixes we refuse outright. Order matters — the matcher
// requires every element of the prefix to be present at the head
// of the argv (so `git push` is fine, only `git push --force` is
// blocked). Curated to obvious footguns; not a complete sandbox.
const DENYLIST: string[][] = [
  ['rm',  '-rf', '/'],
  ['rm',  '-rf', '~'],
  ['rm',  '-rf'],   // Bare rm -rf — even if the path is legal we'd rather force the user to use the dashboard.
  ['rm',  '-fr'],
  ['git', 'push', '--force'],
  ['git', 'push', '-f'],
  ['git', 'reset', '--hard'],
  ['npm', 'publish'],
  ['npm', 'unpublish'],
  ['curl'],         // Leak vectors — if the user wants a fetch they can ask for it explicitly via an HTTP tool.
  ['wget'],
  ['sudo'],
  [':'],            // Block fork-bomb-shaped argv ":(){:|:&};:" pieces if they ever land here despite argv-only.
];

function argvIsDenied(argv: string[]): boolean {
  return DENYLIST.some(prefix => {
    if (prefix.length > argv.length) return false;
    for (let i = 0; i < prefix.length; i++) {
      if (argv[i] !== prefix[i]) return false;
    }
    return true;
  });
}

const run_command: Tool = {
  name: 'run_command',
  description:
    'Run a command in the active project directory. argv is an array of '
    + 'strings — the binary name comes first, then arguments. NO shell — '
    + 'pipes, redirections, and command substitution do not work; pass '
    + 'them as literal strings to the binary itself, or run multiple '
    + 'tools in sequence. Output is capped at 256 KB and the process is '
    + 'killed after `timeoutMs` (default 60s, max 600s). Refused for '
    + 'destructive prefixes (rm -rf, git push --force, npm publish, '
    + 'curl, wget, sudo).',
  inputSchema: {
    type: 'object',
    properties: {
      argv: {
        type: 'array',
        items: { type: 'string' },
        description: 'Argv array. argv[0] is the binary; remaining items are arguments.',
      },
      cwd: {
        type: 'string',
        description: 'Project-relative subdirectory to run in. Defaults to the project root.',
      },
      timeoutMs: {
        type: 'number',
        description: 'Hard timeout in milliseconds. Default 60000, max 600000.',
      },
    },
    required: ['argv'],
    additionalProperties: false,
  },
  permission: 'gated',
  handler: async (args, ctx): Promise<ToolResult> => {
    if (!Array.isArray(args.argv) || args.argv.length === 0) {
      return { ok: false, error: 'argv must be a non-empty array of strings' };
    }
    for (const a of args.argv) {
      if (typeof a !== 'string') {
        return { ok: false, error: 'every argv element must be a string' };
      }
      if (a.indexOf('\0') !== -1) {
        return { ok: false, error: 'argv contains a null byte' };
      }
    }
    if (argvIsDenied(args.argv)) {
      return { ok: false, error: `refused destructive argv prefix: ${args.argv.slice(0, 3).join(' ')}` };
    }

    const safe = resolveProjectPath(ctx.project, args.cwd ?? '.');
    if (!safe.ok) return { ok: false, error: safe.error! };

    const timeoutMs = Number.isInteger(args.timeoutMs)
      ? Math.min(MAX_TIMEOUT_MS, Math.max(100, args.timeoutMs))
      : DEFAULT_TIMEOUT_MS;

    return await new Promise<ToolResult>((resolve) => {
      let stdout = '';
      let stderr = '';
      let bytes = 0;
      let killed = false;
      const child = spawn(args.argv[0], args.argv.slice(1), {
        cwd: safe.abs!,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const collect = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
        bytes += chunk.length;
        const text = chunk.toString('utf8');
        if (stream === 'stdout') stdout += text;
        else                     stderr += text;
        if (bytes > MAX_OUTPUT_BYTES) {
          killed = true;
          try { child.kill('SIGTERM'); } catch {}
        }
      };
      child.stdout.on('data', collect('stdout'));
      child.stderr.on('data', collect('stderr'));
      const timer = setTimeout(() => {
        killed = true;
        try { child.kill('SIGTERM'); } catch {}
      }, timeoutMs);
      child.on('error', (e) => {
        clearTimeout(timer);
        resolve({ ok: false, error: `spawn failed: ${e.message}` });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        // Truncate output to the cap (we may have collected a bit more
        // before the kill landed).
        const trim = (s: string) => s.length > MAX_OUTPUT_BYTES
          ? s.slice(0, MAX_OUTPUT_BYTES) + `\n… (truncated)`
          : s;
        resolve({
          ok: true,
          content: {
            argv: args.argv,
            cwd: args.cwd ?? '.',
            exitCode: code,
            timedOut: killed && bytes <= MAX_OUTPUT_BYTES,
            stdoutTruncated: bytes > MAX_OUTPUT_BYTES,
            stdout: trim(stdout),
            stderr: trim(stderr),
          },
          summary: `exit ${code}${killed ? ' (killed)' : ''}`,
        });
      });
    });
  },
};

export const TOOLS: Tool[] = [run_command];
