/**
 * Filesystem tools — list_dir, read_file, write_file, apply_patch,
 * delete_file. Every path goes through resolveProjectPath() so the
 * model can never escape the project root, even via symlinks.
 *
 * Read-class tools (list_dir, read_file) auto-execute in any
 * permission mode. Write-class tools (write_file, apply_patch,
 * delete_file) are gated — see ai-tools/index.ts requiresApproval().
 *
 * Caps:
 *   - read_file    — 256 KB max per call; binary files return a
 *                    `{ kind: 'binary', size }` stub.
 *   - list_dir     — depth 2 by default, capped at 5.
 *   - write_file   — content cap 1 MB to keep tool outputs sane.
 *   - apply_patch  — search/replace block style. Search must occur
 *                    exactly once in the file; ambiguous matches
 *                    error out and the model must disambiguate.
 *
 * The .nostr-station/ dir is intentionally readable + writable by
 * the AI — it's part of the project, and the AI editing
 * project-context.md or system-prompt.md is a feature.
 */

import fs from 'fs';
import path from 'path';
import type { Tool, ToolResult } from './index.js';
import { resolveProjectPath } from './path-safety.js';

const MAX_READ_BYTES  = 256 * 1024;
const MAX_WRITE_BYTES = 1024 * 1024;
const MAX_LIST_DEPTH  = 5;
const DEFAULT_LIST_DEPTH = 2;

// ── list_dir ─────────────────────────────────────────────────────────────

interface DirEntry {
  name:  string;
  path:  string;            // project-relative
  kind:  'file' | 'dir' | 'symlink' | 'other';
  size?: number;            // files only
  children?: DirEntry[];    // dirs only, when depth allows
}

function listDirRecursive(rootAbs: string, abs: string, depth: number, projectAbs: string): DirEntry[] {
  let names: string[];
  try { names = fs.readdirSync(abs); } catch { return []; }
  // Skip noisy / huge dirs by default. Users wanting them can
  // read_file directly. Mirrors what most editor file-pickers do.
  const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'target', '.next']);
  names = names.filter(n => !SKIP.has(n));
  names.sort();
  return names.map(name => {
    const childAbs = path.join(abs, name);
    let stat: fs.Stats | null = null;
    try { stat = fs.lstatSync(childAbs); } catch {}
    const kind: DirEntry['kind'] =
      !stat ? 'other'
      : stat.isSymbolicLink() ? 'symlink'
      : stat.isDirectory()    ? 'dir'
      : stat.isFile()         ? 'file'
      : 'other';
    const entry: DirEntry = {
      name,
      path: path.relative(projectAbs, childAbs),
      kind,
    };
    if (kind === 'file' && stat) entry.size = stat.size;
    if (kind === 'dir' && depth > 1) {
      entry.children = listDirRecursive(rootAbs, childAbs, depth - 1, projectAbs);
    }
    return entry;
  });
}

const list_dir: Tool = {
  name: 'list_dir',
  description:
    'List entries in a directory under the active project. Returns a tree '
    + 'up to `depth` levels deep (default 2, max 5). Skips heavy dirs by '
    + 'default: node_modules, .git, dist, build, target, .next.',
  inputSchema: {
    type: 'object',
    properties: {
      path:  { type: 'string', description: 'Project-relative path. Defaults to "." (project root).' },
      depth: { type: 'number', description: 'How many levels deep to recurse. Default 2, max 5.' },
    },
    additionalProperties: false,
  },
  permission: 'always',
  handler: async (args, ctx): Promise<ToolResult> => {
    const safe = resolveProjectPath(ctx.project, args.path ?? '.');
    if (!safe.ok) return { ok: false, error: safe.error! };
    let stat: fs.Stats;
    try { stat = fs.statSync(safe.abs!); }
    catch (e: any) { return { ok: false, error: `path does not exist: ${args.path}` }; }
    if (!stat.isDirectory()) {
      return { ok: false, error: `not a directory: ${args.path}` };
    }
    const depthRaw = Number.isInteger(args.depth) ? Math.min(MAX_LIST_DEPTH, Math.max(1, args.depth)) : DEFAULT_LIST_DEPTH;
    const projectAbs = fs.realpathSync(ctx.project.path!);
    const entries = listDirRecursive(safe.abs!, safe.abs!, depthRaw, projectAbs);
    return {
      ok: true,
      content: { path: args.path ?? '.', depth: depthRaw, entries },
      summary: `${entries.length} entries`,
    };
  },
};

// ── read_file ────────────────────────────────────────────────────────────

const read_file: Tool = {
  name: 'read_file',
  description:
    'Read a UTF-8 text file under the active project. Capped at 256 KB; '
    + 'binary files return a stub { kind: "binary", size } so the model '
    + 'doesn\'t try to interpret them as text. To read a slice of a large '
    + 'file, pass `range: { start, end }` (byte offsets, both inclusive).',
  inputSchema: {
    type: 'object',
    properties: {
      path:  { type: 'string' },
      range: {
        type: 'object',
        properties: {
          start: { type: 'number' },
          end:   { type: 'number' },
        },
      },
    },
    required: ['path'],
    additionalProperties: false,
  },
  permission: 'always',
  handler: async (args, ctx): Promise<ToolResult> => {
    const safe = resolveProjectPath(ctx.project, args.path);
    if (!safe.ok) return { ok: false, error: safe.error! };
    let stat: fs.Stats;
    try { stat = fs.statSync(safe.abs!); }
    catch { return { ok: false, error: `path does not exist: ${args.path}` }; }
    if (stat.isDirectory()) {
      return { ok: false, error: `path is a directory: ${args.path} — use list_dir instead` };
    }

    const start = Number.isInteger(args.range?.start) ? Math.max(0, args.range.start) : 0;
    const endRaw = Number.isInteger(args.range?.end) ? args.range.end : start + MAX_READ_BYTES - 1;
    const end   = Math.min(stat.size - 1, endRaw, start + MAX_READ_BYTES - 1);
    const length = Math.max(0, end - start + 1);

    let buf: Buffer;
    try {
      const fd = fs.openSync(safe.abs!, 'r');
      try {
        buf = Buffer.alloc(length);
        if (length > 0) fs.readSync(fd, buf, 0, length, start);
      } finally { fs.closeSync(fd); }
    } catch (e: any) {
      return { ok: false, error: `read failed: ${e?.message ?? 'unknown'}` };
    }

    // Detect binary by NUL byte — same heuristic as `git diff` and most
    // text-vs-binary detectors. Fast and good enough for source trees.
    if (buf.indexOf(0) !== -1) {
      return {
        ok: true,
        content: { kind: 'binary', size: stat.size, path: args.path },
        summary: `${stat.size} B (binary)`,
      };
    }
    const text = buf.toString('utf8');
    return {
      ok: true,
      content: { kind: 'text', path: args.path, size: stat.size, range: { start, end }, text },
      summary: `${length} B${length < stat.size ? ` of ${stat.size}` : ''}`,
    };
  },
};

// ── write_file ───────────────────────────────────────────────────────────

const write_file: Tool = {
  name: 'write_file',
  description:
    'Create or overwrite a UTF-8 text file under the active project. '
    + 'Creates parent directories as needed. Content is capped at 1 MB; '
    + 'split into multiple write_file calls for larger payloads (or use '
    + 'apply_patch for surgical edits).',
  inputSchema: {
    type: 'object',
    properties: {
      path:    { type: 'string' },
      content: { type: 'string' },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },
  permission: 'gated',
  handler: async (args, ctx): Promise<ToolResult> => {
    if (typeof args.content !== 'string') {
      return { ok: false, error: 'content must be a string' };
    }
    if (Buffer.byteLength(args.content, 'utf8') > MAX_WRITE_BYTES) {
      return { ok: false, error: `content exceeds ${MAX_WRITE_BYTES} byte cap` };
    }
    const safe = resolveProjectPath(ctx.project, args.path);
    if (!safe.ok) return { ok: false, error: safe.error! };
    try {
      fs.mkdirSync(path.dirname(safe.abs!), { recursive: true });
      fs.writeFileSync(safe.abs!, args.content, 'utf8');
    } catch (e: any) {
      return { ok: false, error: `write failed: ${e?.message ?? 'unknown'}` };
    }
    return {
      ok: true,
      content: { path: args.path, bytes: Buffer.byteLength(args.content, 'utf8') },
      summary: `wrote ${Buffer.byteLength(args.content, 'utf8')} B`,
    };
  },
};

// ── apply_patch ──────────────────────────────────────────────────────────

const apply_patch: Tool = {
  name: 'apply_patch',
  description:
    'Replace `search` with `replace` in the file at `path`. The `search` '
    + 'string must occur exactly once in the file — ambiguous matches '
    + 'are an error so the model must disambiguate by including more '
    + 'context. Useful for surgical edits without round-tripping the '
    + 'whole file through write_file.',
  inputSchema: {
    type: 'object',
    properties: {
      path:    { type: 'string' },
      search:  { type: 'string', description: 'Exact string to find. Whitespace-significant.' },
      replace: { type: 'string', description: 'Replacement text.' },
    },
    required: ['path', 'search', 'replace'],
    additionalProperties: false,
  },
  permission: 'gated',
  handler: async (args, ctx): Promise<ToolResult> => {
    if (typeof args.search !== 'string' || typeof args.replace !== 'string') {
      return { ok: false, error: 'search and replace must be strings' };
    }
    if (!args.search) return { ok: false, error: 'search is empty' };
    const safe = resolveProjectPath(ctx.project, args.path);
    if (!safe.ok) return { ok: false, error: safe.error! };

    let original: string;
    try { original = fs.readFileSync(safe.abs!, 'utf8'); }
    catch (e: any) { return { ok: false, error: `read failed: ${e?.message ?? 'unknown'}` }; }

    const occurrences = countOccurrences(original, args.search);
    if (occurrences === 0) {
      return { ok: false, error: `search string not found in ${args.path}` };
    }
    if (occurrences > 1) {
      return { ok: false, error: `search string is not unique in ${args.path} (${occurrences} matches) — include more context to disambiguate` };
    }
    const updated = original.replace(args.search, args.replace);
    try { fs.writeFileSync(safe.abs!, updated, 'utf8'); }
    catch (e: any) { return { ok: false, error: `write failed: ${e?.message ?? 'unknown'}` }; }

    const delta = Buffer.byteLength(updated, 'utf8') - Buffer.byteLength(original, 'utf8');
    return {
      ok: true,
      content: { path: args.path, bytesBefore: Buffer.byteLength(original, 'utf8'), bytesAfter: Buffer.byteLength(updated, 'utf8') },
      summary: `patched (${delta >= 0 ? '+' : ''}${delta} B)`,
    };
  },
};

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let i = 0;
  while (true) {
    const idx = haystack.indexOf(needle, i);
    if (idx === -1) break;
    count++;
    i = idx + needle.length;
  }
  return count;
}

// ── delete_file ──────────────────────────────────────────────────────────

const delete_file: Tool = {
  name: 'delete_file',
  description:
    'Delete a single file under the active project. Refuses directories '
    + '(no recursive delete). Approval is required unless the user is in '
    + 'YOLO permissions mode.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
    },
    required: ['path'],
    additionalProperties: false,
  },
  permission: 'gated',
  handler: async (args, ctx): Promise<ToolResult> => {
    const safe = resolveProjectPath(ctx.project, args.path);
    if (!safe.ok) return { ok: false, error: safe.error! };
    let stat: fs.Stats;
    try { stat = fs.lstatSync(safe.abs!); }
    catch { return { ok: false, error: `path does not exist: ${args.path}` }; }
    if (stat.isDirectory()) {
      return { ok: false, error: `path is a directory: ${args.path} — recursive delete is not supported` };
    }
    try { fs.unlinkSync(safe.abs!); }
    catch (e: any) { return { ok: false, error: `delete failed: ${e?.message ?? 'unknown'}` }; }
    return { ok: true, content: { path: args.path }, summary: 'deleted' };
  },
};

export const TOOLS: Tool[] = [list_dir, read_file, write_file, apply_patch, delete_file];
