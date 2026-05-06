/**
 * Project-scoped context builder for the Chat pane's system prompt.
 *
 * The block injected server-side into every /api/ai/chat request:
 *   - path
 *   - detected capabilities
 *   - last 10 git commits
 *   - README excerpt (first 500 chars)
 *   - project-context.md overlay (developer-authored, no truncation)
 *
 * When no project is selected, the block falls back to a station-level
 * description — nostr-station's version + a hint that doctor/config/relay
 * questions are welcome. Enough so the assistant stays anchored instead
 * of replying with empty-slate generalities.
 *
 * Reads are fresh per chat turn (git log is the most volatile input, so
 * caching it would just stale). Costs are tiny (~one git invocation + a
 * 500-byte file read + a single project-context.md slurp).
 *
 * ── Developer note: project-context.md conventions ─────────────────────
 *
 * `project-context.md` is a developer-authored overlay — placed at the
 * project root, read on every chat turn, never auto-created or auto-
 * truncated. Stable conventions for anything we read out of it (when
 * future code wants more than the raw passthrough we do today):
 *
 *   ## Wiki namespaces
 *   - nostr-protocol
 *   - nostr-apps
 *
 * Developers can add a `## Wiki namespaces` section to signal which
 * llm-wiki namespaces Nori should query for that project specifically.
 * Today we just splice the whole file; a future pass can parse this
 * section and feed it into the wiki-lookup hint at request time.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { getProject, projectGitLog, type Project } from './projects.js';

export interface AiContext {
  text:         string;
  source:       'project' | 'station';
  projectId?:   string;
  projectName?: string;
}

const README_CHARS_MAX = 500;

function formatCapabilities(p: Project): string {
  const active: string[] = [];
  if (p.capabilities.git)   active.push('git');
  if (p.capabilities.ngit)  active.push('ngit');
  if (p.capabilities.nsite) active.push('nsite');
  return active.length ? active.join(', ') : '(none detected)';
}

/**
 * Reads the developer-authored `project-context.md` from the project
 * root. Returns null when the file is missing, empty, or unreadable —
 * the caller silently omits the overlay block in that case (the file
 * is intentional; we never auto-create one).
 *
 * No truncation. The README excerpt is capped because READMEs are
 * often book-length and most projects have one whether or not it's
 * meant for AI consumption. `project-context.md` is the opposite —
 * a developer wrote it specifically as AI-facing context and the
 * length they chose is the length they meant. Splicing it verbatim
 * keeps the contract simple and predictable.
 *
 * Exported for testability — returns the raw file contents (sans
 * trailing whitespace) so tests can assert end-to-end without
 * driving a full Project + buildAiContext round-trip.
 */
export function readProjectContext(projectPath: string): string | null {
  const filePath = path.join(projectPath, 'project-context.md');
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  const trimmed = raw.trimEnd();
  if (!trimmed) return null;
  return trimmed;
}

function readReadmeExcerpt(projectPath: string): string | null {
  // README casing varies wildly (README.md, readme.md, Readme.md, …). Walk
  // the dir for a case-insensitive match rather than probing every casing.
  let entries: string[] = [];
  try { entries = fs.readdirSync(projectPath); } catch { return null; }
  const hit = entries.find(e => /^readme(\.\w+)?$/i.test(e));
  if (!hit) return null;
  try {
    const raw = fs.readFileSync(path.join(projectPath, hit), 'utf8');
    const trimmed = raw.trim();
    if (!trimmed) return null;
    // Truncate at char budget; add ellipsis marker when clipped so the
    // assistant knows it's looking at a partial.
    if (trimmed.length > README_CHARS_MAX) {
      return trimmed.slice(0, README_CHARS_MAX).trimEnd() + '\n\n… (truncated)';
    }
    return trimmed;
  } catch {
    return null;
  }
}

function stationContext(): AiContext {
  // Prefer the seeded file at ~/nostr-station/projects/NOSTR_STATION.md
  // when present. The seed (slim Nori persona — identity, role, NIP
  // reference, command table, user-region) is written once on first
  // server start and is the same file that terminal-native AI tools
  // read via the CLAUDE.md / AGENTS.md / etc. symlink, so the
  // dashboard Chat pane and `claude` in a terminal share one source
  // of truth the developer can edit.
  const seedPath = path.join(os.homedir(), 'nostr-station', 'projects', 'NOSTR_STATION.md');
  try {
    const raw = fs.readFileSync(seedPath, 'utf8').trimEnd();
    if (raw) return { text: raw, source: 'station' };
  } catch { /* file missing — fall through to generated block */ }

  // Lazy-require so a broken package.json doesn't crash the whole module.
  let version = '?';
  try {
    const pkg = JSON.parse(fs.readFileSync(
      path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'package.json'),
      'utf8',
    ));
    version = String(pkg.version || '?');
  } catch {}

  const lines = [
    '# Context: nostr-station',
    `Version: ${version}`,
    `Host: ${os.platform()} ${os.arch()}`,
    '',
    'No project is selected. Questions about nostr-station itself —',
    'doctor output, relay configuration, AI provider setup, ngit / Amber —',
    'are appropriate here. If the user asks code questions, remind them',
    'to open the relevant project first so the context switches to that',
    'codebase.',
  ];
  return { text: lines.join('\n'), source: 'station' };
}

function projectContext(p: Project): AiContext {
  const lines: string[] = [];
  lines.push(`# Active project: ${p.name}`);
  if (p.path) lines.push(`Path: ${p.path}`);
  lines.push(`Capabilities: ${formatCapabilities(p)}`);

  if (p.path && p.capabilities.git) {
    const log = projectGitLog(p.path, 10);
    if (log.length) {
      lines.push('');
      lines.push('## Recent commits (last 10)');
      for (const c of log) {
        // Short hash + first-line message. Authors and timestamps bloat
        // the block without carrying much signal for the assistant.
        lines.push(`- ${c.hash} — ${c.message}`);
      }
    }
  }

  if (p.path) {
    const readme = readReadmeExcerpt(p.path);
    if (readme) {
      lines.push('');
      lines.push('## README excerpt');
      lines.push(readme);
    }
  }

  // Per-project overlay — developer-authored guidance file at the
  // project root. Spliced verbatim AFTER the README so the most
  // intentional guidance lands closest to the prompt boundary
  // (system prompts get truncated by the model from the top in
  // pathological-length cases; tail content has the best survival
  // odds). Silently omitted when the file is missing.
  if (p.path) {
    const overlay = readProjectContext(p.path);
    if (overlay) {
      lines.push('');
      lines.push('## Project context overlay');
      lines.push('*(from `project-context.md` at the project root)*');
      lines.push('');
      lines.push(overlay);
    }
  }

  return {
    text: lines.join('\n'),
    source: 'project',
    projectId: p.id,
    projectName: p.name,
  };
}

/**
 * Build the context block for a given projectId (or null/missing → station
 * scope). Never throws — missing files / git errors just trim the block.
 */
export function buildAiContext(projectId?: string | null): AiContext {
  if (!projectId) return stationContext();
  const p = getProject(projectId);
  if (!p) return stationContext();
  return projectContext(p);
}
