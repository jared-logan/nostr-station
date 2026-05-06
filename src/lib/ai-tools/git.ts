/**
 * Git tools — git_status, git_log, git_diff, git_commit. All run with
 * cwd scoped to the project path; no shell, only argv arrays.
 *
 * Status / log / diff are 'always' permission (read-only).
 * git_commit is 'gated' — it mutates the repo and may produce a
 * commit signed under the user's identity (depending on git config).
 */

import { execFileSync } from 'child_process';
import type { Tool, ToolResult } from './index.js';
import { resolveProjectPath } from './path-safety.js';

const GIT_TIMEOUT_MS = 10_000;

function runGit(cwd: string, args: string[]): { stdout: string; ok: boolean; err?: string } {
  try {
    const stdout = execFileSync('git', args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    return { ok: true, stdout };
  } catch (e: any) {
    // git emits "nothing to commit, working tree clean" to STDOUT
    // (not stderr) when commit is a no-op, so fall through both
    // streams when building the err message.
    const parts = [e?.stderr, e?.stdout, e?.message].filter(Boolean).map(String);
    return { ok: false, err: parts.join(' ') || 'git failed', stdout: '' };
  }
}

// ── git_status ───────────────────────────────────────────────────────────

const git_status: Tool = {
  name: 'git_status',
  description: 'Returns the current branch, HEAD short-hash, dirty file count, ahead/behind count.',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  permission: 'always',
  handler: async (_args, ctx): Promise<ToolResult> => {
    if (!ctx.project.path) return { ok: false, error: 'project has no path' };
    if (!ctx.project.capabilities.git) return { ok: false, error: 'project has no git capability' };

    const branch = runGit(ctx.project.path, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
    const hash   = runGit(ctx.project.path, ['rev-parse', '--short', 'HEAD']).stdout.trim();
    const status = runGit(ctx.project.path, ['status', '--porcelain']);
    const dirtyFiles = status.ok
      ? status.stdout.split('\n').filter(l => l.trim()).length
      : 0;
    return {
      ok: true,
      content: { branch, hash, dirtyFiles, dirty: dirtyFiles > 0 },
      summary: `${branch} @ ${hash}${dirtyFiles ? ` (${dirtyFiles} dirty)` : ''}`,
    };
  },
};

// ── git_log ──────────────────────────────────────────────────────────────

const git_log: Tool = {
  name: 'git_log',
  description: 'Returns the last N commits as { hash, message, author, date }. Default N=10, max 100.',
  inputSchema: {
    type: 'object',
    properties: {
      n: { type: 'number', description: 'Number of commits. Default 10, max 100.' },
    },
    additionalProperties: false,
  },
  permission: 'always',
  handler: async (args, ctx): Promise<ToolResult> => {
    if (!ctx.project.path) return { ok: false, error: 'project has no path' };
    if (!ctx.project.capabilities.git) return { ok: false, error: 'project has no git capability' };
    const n = Number.isInteger(args.n) ? Math.min(100, Math.max(1, args.n)) : 10;
    // Use a delimiter that is highly unlikely to appear in a commit
    // message; split on it server-side rather than parsing JSON from
    // git (--format=%(json) isn't portable across git versions).
    const SEP = '\x1e';
    const RECORD = '\x1f';
    const fmt = `%h${SEP}%an${SEP}%ad${SEP}%s${RECORD}`;
    const r = runGit(ctx.project.path, ['log', `--format=${fmt}`, '--date=short', `-n${n}`]);
    if (!r.ok) return { ok: false, error: r.err! };
    const commits = r.stdout.split(RECORD).map(s => s.trim()).filter(Boolean).map(line => {
      const [hash, author, date, message] = line.split(SEP);
      return { hash, author, date, message: (message ?? '').trim() };
    });
    return {
      ok: true,
      content: { commits },
      summary: `${commits.length} commits`,
    };
  },
};

// ── git_diff ─────────────────────────────────────────────────────────────

const git_diff: Tool = {
  name: 'git_diff',
  description:
    'Show the unified diff for the working tree (or a single path if '
    + 'provided). Pass `staged: true` to diff staged changes against HEAD '
    + 'instead. Output is capped at 256 KB.',
  inputSchema: {
    type: 'object',
    properties: {
      path:   { type: 'string', description: 'Optional project-relative path to scope the diff.' },
      staged: { type: 'boolean', description: 'Show staged-vs-HEAD instead of unstaged-vs-working.' },
    },
    additionalProperties: false,
  },
  permission: 'always',
  handler: async (args, ctx): Promise<ToolResult> => {
    if (!ctx.project.path) return { ok: false, error: 'project has no path' };
    if (!ctx.project.capabilities.git) return { ok: false, error: 'project has no git capability' };

    const argv = ['diff'];
    if (args.staged) argv.push('--cached');
    if (typeof args.path === 'string' && args.path) {
      const safe = resolveProjectPath(ctx.project, args.path);
      if (!safe.ok) return { ok: false, error: safe.error! };
      argv.push('--', args.path);
    }
    const r = runGit(ctx.project.path, argv);
    if (!r.ok) return { ok: false, error: r.err! };
    const MAX = 256 * 1024;
    const diff = r.stdout.length > MAX
      ? r.stdout.slice(0, MAX) + `\n... (truncated; ${r.stdout.length - MAX} bytes omitted)`
      : r.stdout;
    return {
      ok: true,
      content: { staged: !!args.staged, path: args.path ?? null, diff },
      summary: `${diff.split('\n').length} lines`,
    };
  },
};

// ── git_commit ───────────────────────────────────────────────────────────

const git_commit: Tool = {
  name: 'git_commit',
  description:
    'Create a commit with the given message. If `paths` is provided, '
    + '`git add` only those paths first; otherwise commits whatever is '
    + 'currently staged. Refuses if there is nothing to commit.',
  inputSchema: {
    type: 'object',
    properties: {
      message: { type: 'string' },
      paths:   {
        type: 'array',
        items: { type: 'string' },
        description: 'Project-relative paths to `git add` before committing. Optional.',
      },
    },
    required: ['message'],
    additionalProperties: false,
  },
  permission: 'gated',
  handler: async (args, ctx): Promise<ToolResult> => {
    if (!ctx.project.path) return { ok: false, error: 'project has no path' };
    if (!ctx.project.capabilities.git) return { ok: false, error: 'project has no git capability' };
    if (typeof args.message !== 'string' || !args.message.trim()) {
      return { ok: false, error: 'message is required' };
    }

    if (Array.isArray(args.paths) && args.paths.length > 0) {
      // Validate each path through resolveProjectPath to refuse
      // staging anything outside the root.
      for (const p of args.paths) {
        const safe = resolveProjectPath(ctx.project, p);
        if (!safe.ok) return { ok: false, error: `bad path "${p}": ${safe.error}` };
      }
      const addRes = runGit(ctx.project.path, ['add', '--', ...args.paths]);
      if (!addRes.ok) return { ok: false, error: addRes.err! };
    }

    const commitRes = runGit(ctx.project.path, ['commit', '-m', args.message]);
    if (!commitRes.ok) {
      // git emits "nothing to commit" on stderr, exit 1 — surface that
      // distinctly so the model can adapt instead of retrying.
      const err = commitRes.err!.toLowerCase();
      if (err.includes('nothing to commit')) {
        return { ok: false, error: 'nothing to commit' };
      }
      return { ok: false, error: commitRes.err! };
    }
    const hash = runGit(ctx.project.path, ['rev-parse', '--short', 'HEAD']).stdout.trim();
    return {
      ok: true,
      content: { hash, message: args.message },
      summary: `committed ${hash}`,
    };
  },
};

export const TOOLS: Tool[] = [git_status, git_log, git_diff, git_commit];
