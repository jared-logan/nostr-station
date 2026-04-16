/**
 * Project-scoped context builder for the Chat pane's system prompt.
 *
 * The spec calls for a fixed-format block injected server-side into every
 * /api/ai/chat request:
 *   - path
 *   - detected capabilities
 *   - last 10 git commits
 *   - README excerpt (first 500 chars)
 *
 * When no project is selected, the block falls back to a station-level
 * description — nostr-station's version + a hint that doctor/config/relay
 * questions are welcome. Enough so the assistant stays anchored instead
 * of replying with empty-slate generalities.
 *
 * Reads are fresh per chat turn (git log is the most volatile input, so
 * caching it would just stale). Costs are tiny (~one git invocation + a
 * 500-byte file read).
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
