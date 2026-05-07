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
    + 'binary files return a stub { kind: "binary", size }. To read a slice '
    + 'of a large file, pass `range: { start, end }` (byte offsets, both '
    + 'inclusive). When called on a directory, falls back to a list_dir '
    + 'payload (kind: "directory-fallback") rather than erroring. '
    + 'Returns two text fields for text files: '
    + '`text` is the verbatim file content (use this for apply_patch.search); '
    + '`display` is a numbered, <file>-wrapped variant with an end-of-file '
    + 'footer for citing line numbers without counting manually. Pick `text` '
    + 'for editing, `display` for navigating/quoting.',
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
      // Self-heal: return a list_dir result with a fallback marker
      // so the model gets useful data instead of just an error to
      // recover from. The agent in the original repro burned three
      // turns dead-ending on `read_file('.')` because the error
      // message told it "use list_dir instead" but didn't include
      // any of the data it would have gotten from list_dir. Now a
      // single tool call delivers the listing AND a hint.
      const projectAbs = fs.realpathSync(ctx.project.path!);
      const entries = listDirRecursive(safe.abs!, safe.abs!, DEFAULT_LIST_DEPTH, projectAbs);
      return {
        ok: true,
        content: {
          kind:    'directory-fallback',
          path:    args.path,
          depth:   DEFAULT_LIST_DEPTH,
          entries,
          hint:    'read_file was called on a directory — returning a list_dir payload instead. To read a specific file, call read_file with that file\'s path.',
        },
        summary: `${entries.length} entries (directory — read_file fell back to list_dir)`,
      };
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
    // Build a Shakespeare-style numbered display alongside the raw
    // text. The model gets BOTH fields:
    //   - text          — verbatim file content (for apply_patch.search)
    //   - display       — line-numbered, <file>-wrapped, with end-of-
    //                     file or "more available" footer (for the
    //                     model to cite line numbers without counting
    //                     manually).
    //
    // Two fields rather than one because apply_patch's search is a
    // literal string match — if the model copies a line out of the
    // numbered display, the "  42| " prefix would never match the
    // actual file. The tool description spells this out so models
    // pick the right field per task.
    const lines = text.split('\n');
    const lastLineNumber = start === 0 ? lines.length : -1; // -1 = unknown when reading a slice
    const totalLines = start === 0 && end === stat.size - 1 ? lines.length : null;
    const numberWidth = Math.max(4, String(start === 0 ? lines.length : 9999).length);
    const numbered = lines.map((line, idx) => {
      const n = (start === 0 ? idx + 1 : idx + 1).toString().padStart(numberWidth, ' ');
      return `${n}| ${line}`;
    }).join('\n');
    const footer = totalLines !== null
      ? `(End of file - total ${totalLines} line${totalLines === 1 ? '' : 's'})`
      : `(File has more bytes. Use range:{start,end} to read beyond byte ${end + 1})`;
    const display = `<file path="${args.path}">\n${numbered}\n</file>\n${footer}`;

    return {
      ok: true,
      content: {
        kind:   'text',
        path:   args.path,
        size:   stat.size,
        range:  { start, end },
        lines:  totalLines,
        text,
        display,
      },
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

// ── glob ──────────────────────────────────────────────────────────────────
//
// File-path search by glob pattern. Read-class — auto-executes
// regardless of permission mode. Replaces the gated `run_command find`
// the agent used to reach for, which forced an Approve/Reject prompt
// even in auto-edit mode (run_command stays gated by design).
// Mirrors shakespeare.diy's GlobTool — same intent, simpler matcher
// since we control the workload (agent-issued patterns, dozens to a
// few hundred file results, not arbitrary user input).
//
// Supported pattern syntax:
//   *      — matches anything except /
//   **     — matches anything including /
//   ?      — single non-/ char
//   plain  — literal match (regex specials escaped)
//   {a,b}  — brace expansion (recursive)
//
// Out of scope: character classes `[abc]`, negation `!(...)`. Agents
// can fall back to grep+filter for those rare cases.

function globToRegex(pattern: string): RegExp {
  // Brace expansion happens at compile time — we recursively expand
  // {a,b,c} into alternation `(?:a|b|c)`. Nested braces are flattened
  // by Node's regex engine, no special handling needed here.
  const expand = (s: string): string => {
    const open = s.indexOf('{');
    if (open < 0) return s;
    let depth = 1;
    let close = open + 1;
    while (close < s.length && depth > 0) {
      if (s[close] === '{') depth++;
      else if (s[close] === '}') depth--;
      if (depth === 0) break;
      close++;
    }
    if (close >= s.length) return s;
    const before = s.slice(0, open);
    const inner  = s.slice(open + 1, close);
    const after  = s.slice(close + 1);
    const parts  = inner.split(',');
    return `${before}(?:${parts.map(expand).join('|')})${expand(after)}`;
  };

  const expanded = expand(pattern);
  let re = '';
  let i = 0;
  while (i < expanded.length) {
    const c = expanded[i];
    if (c === '*') {
      if (expanded[i + 1] === '*') {
        // ** with optional trailing slash: match zero-or-more path
        // segments. The trailing-slash absorb means `**/*.ts` matches
        // both `foo.ts` (zero leading segments) and `a/b/foo.ts`.
        re += '.*';
        i += 2;
        if (expanded[i] === '/') i++;
        continue;
      }
      re += '[^/]*';
      i++;
      continue;
    }
    if (c === '?') { re += '[^/]'; i++; continue; }
    // Pass through `(?:`, `|`, `)` from brace expansion untouched;
    // escape every other regex meta.
    if (c === '(' && expanded.slice(i, i + 3) === '(?:') { re += '(?:'; i += 3; continue; }
    if (c === '|' || c === ')') { re += c; i++; continue; }
    if ('.+[]{}^$\\'.includes(c)) re += '\\' + c;
    else re += c;
    i++;
  }
  return new RegExp(`^${re}$`);
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'target', '.next']);

function walkAll(rootAbs: string, maxResults: number): string[] {
  const results: string[] = [];
  const stack: string[] = [rootAbs];
  while (stack.length > 0 && results.length < maxResults) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }
    for (const ent of entries) {
      if (results.length >= maxResults) break;
      if (SKIP_DIRS.has(ent.name)) continue;
      const abs = path.join(dir, ent.name);
      const rel = path.relative(rootAbs, abs);
      if (ent.isDirectory()) {
        stack.push(abs);
      } else if (ent.isFile() || ent.isSymbolicLink()) {
        results.push(rel);
      }
    }
  }
  return results;
}

const MAX_GLOB_RESULTS = 500;

const glob_tool: Tool = {
  name: 'glob',
  description:
    'Find files in the active project by glob pattern. Pattern syntax: '
    + '* (no /), ** (any path), ? (single char), {a,b,c} (alternation). '
    + 'Returns matching paths up to ' + MAX_GLOB_RESULTS + '. Skips heavy '
    + 'dirs by default (node_modules, .git, dist, build, target, .next). '
    + 'Read-class — runs without approval. Use this instead of '
    + 'run_command find — faster, ungated, deterministic.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern, e.g. "**/*.tsx" or "src/**/*.{ts,tsx}".' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  permission: 'always',
  handler: async (args, ctx): Promise<ToolResult> => {
    if (typeof args.pattern !== 'string' || !args.pattern) {
      return { ok: false, error: 'pattern is required' };
    }
    const projectAbs = fs.realpathSync(ctx.project.path!);
    let regex: RegExp;
    try { regex = globToRegex(args.pattern); }
    catch (e: any) { return { ok: false, error: `invalid pattern: ${e?.message ?? 'unknown'}` }; }

    const all = walkAll(projectAbs, 10_000);  // walk cap independent of result cap
    const matched = all.filter(p => regex.test(p)).slice(0, MAX_GLOB_RESULTS);
    return {
      ok: true,
      content: {
        pattern: args.pattern,
        count:   matched.length,
        truncated: matched.length === MAX_GLOB_RESULTS,
        paths:   matched,
      },
      summary: `${matched.length} match${matched.length === 1 ? '' : 'es'}`,
    };
  },
};

// ── grep ──────────────────────────────────────────────────────────────────
//
// File-content search by regex. Read-class — auto-executes regardless
// of permission mode. Replaces gated `run_command grep`. Mirrors
// shakespeare.diy's GrepTool.
//
// Behaviour notes:
//   - regex is JS RegExp (not POSIX/PCRE — "\\b" works, look-behind
//     works on modern Node, character classes work). Agents tend to
//     use simple substrings and basic regex; we trust them not to
//     write catastrophic-backtracking patterns within the per-file
//     time/byte caps.
//   - file selection: `glob` arg narrows which files to search;
//     defaults to all files under the project root.
//   - skips binary files (NUL byte detector) so the agent doesn't
//     get reams of garbage from the agent reading PNGs.
//   - cap: 200 matches total, 5 MB scanned, 50 KB per file. Past
//     these we stop and mark truncated:true so the agent can
//     narrow the glob and retry.

const MAX_GREP_MATCHES         = 200;
const MAX_GREP_TOTAL_BYTES     = 5  * 1024 * 1024;
const MAX_GREP_PER_FILE_BYTES  = 50 * 1024;

interface GrepMatch {
  path:       string;
  lineNumber: number;
  line:       string;
}

const grep_tool: Tool = {
  name: 'grep',
  description:
    'Search file contents in the active project for a regex pattern. '
    + 'Returns up to ' + MAX_GREP_MATCHES + ' matches as { path, lineNumber, line }. '
    + 'Use the optional `glob` arg to narrow the file set (e.g. "**/*.ts"). '
    + 'Skips binary files and heavy dirs (node_modules, .git, dist, build, '
    + 'target, .next). Read-class — runs without approval. Use this '
    + 'instead of run_command grep — faster, ungated, deterministic.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern:       { type: 'string',  description: 'JavaScript-flavored regex.' },
      glob:          { type: 'string',  description: 'Optional glob to narrow which files to search. Default: all files.' },
      caseSensitive: { type: 'boolean', description: 'Default true.' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  permission: 'always',
  handler: async (args, ctx): Promise<ToolResult> => {
    if (typeof args.pattern !== 'string' || !args.pattern) {
      return { ok: false, error: 'pattern is required' };
    }
    let regex: RegExp;
    try {
      const flags = args.caseSensitive === false ? 'i' : '';
      regex = new RegExp(args.pattern, flags);
    } catch (e: any) {
      return { ok: false, error: `invalid regex: ${e?.message ?? 'unknown'}` };
    }

    const projectAbs = fs.realpathSync(ctx.project.path!);
    const allFiles = walkAll(projectAbs, 10_000);
    let candidates = allFiles;
    if (typeof args.glob === 'string' && args.glob) {
      let globRegex: RegExp;
      try { globRegex = globToRegex(args.glob); }
      catch (e: any) { return { ok: false, error: `invalid glob: ${e?.message ?? 'unknown'}` }; }
      candidates = candidates.filter(p => globRegex.test(p));
    }

    const matches:    GrepMatch[] = [];
    let scannedBytes  = 0;
    let truncated     = false;
    let truncReason: string | null = null;

    for (const rel of candidates) {
      if (matches.length >= MAX_GREP_MATCHES) {
        truncated = true; truncReason = `match cap (${MAX_GREP_MATCHES})`; break;
      }
      if (scannedBytes >= MAX_GREP_TOTAL_BYTES) {
        truncated = true; truncReason = `total-bytes cap (${MAX_GREP_TOTAL_BYTES})`; break;
      }
      const abs = path.join(projectAbs, rel);
      let stat: fs.Stats;
      try { stat = fs.statSync(abs); }
      catch { continue; }
      if (!stat.isFile()) continue;

      const length = Math.min(stat.size, MAX_GREP_PER_FILE_BYTES,
        MAX_GREP_TOTAL_BYTES - scannedBytes);
      if (length <= 0) continue;
      let buf: Buffer;
      try {
        const fd = fs.openSync(abs, 'r');
        try {
          buf = Buffer.alloc(length);
          fs.readSync(fd, buf, 0, length, 0);
        } finally { fs.closeSync(fd); }
      } catch { continue; }
      scannedBytes += length;
      // Binary skip — same NUL-byte heuristic read_file uses.
      if (buf.indexOf(0) !== -1) continue;

      const text = buf.toString('utf8');
      const lines = text.split('\n');
      for (let i = 0; i < lines.length && matches.length < MAX_GREP_MATCHES; i++) {
        if (regex.test(lines[i])) {
          // Cap per-line content to keep payloads sane on tools that
          // dump 4 KB lines (minified js, generated files).
          const line = lines[i].length > 400
            ? lines[i].slice(0, 400) + '… (truncated)'
            : lines[i];
          matches.push({ path: rel, lineNumber: i + 1, line });
        }
      }
    }

    return {
      ok: true,
      content: {
        pattern: args.pattern,
        glob:    args.glob ?? null,
        caseSensitive: args.caseSensitive !== false,
        count:   matches.length,
        truncated,
        truncReason,
        matches,
      },
      summary: `${matches.length} match${matches.length === 1 ? '' : 'es'}${truncated ? ' (truncated)' : ''}`,
    };
  },
};

export const TOOLS: Tool[] = [list_dir, read_file, write_file, apply_patch, delete_file, glob_tool, grep_tool];
