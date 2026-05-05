/**
 * Editor integration — symlinks NOSTR_STATION.md to the filename your AI
 * coding tool reads, and the user-region preservation primitive used by
 * the (forthcoming) context-file regenerator.
 *
 * Replaces the editor portion of the deleted services.ts; no relay /
 * launchd / systemd / config-toml carry-over.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const EDITOR_START_COMMANDS: Record<string, string> = {
  'claude-code': 'claude',
  'cursor':      'cursor .',
  'windsurf':    'windsurf .',
  'copilot':     'code .',
  'aider':       'aider',
  'codex':       'codex',
  'other':       'your editor',
};

// Tool-specific filenames the symlink can target. The canonical
// content lives at NOSTR_STATION.md and the chosen editor's filename
// symlinks to it. Switch tools any time: `nostr-station editor`.
export const EDITOR_FILENAMES: Record<string, string> = {
  'claude-code': 'CLAUDE.md',
  'cursor':      '.cursorrules',
  'windsurf':    '.windsurfrules',
  'copilot':     '.github/copilot-instructions.md',
  'aider':       'CONVENTIONS.md',
  'codex':       'AGENTS.md',
  'other':       'AGENTS.md',
};

const CONTEXT_FILENAME = 'NOSTR_STATION.md';

// Default projects directory matches the user-journey spec: project
// directory set to ~/nostr-station/projects/ during setup.
function defaultProjectsDir(): string {
  return path.join(os.homedir(), 'nostr-station', 'projects');
}

// ── User-region preservation ────────────────────────────────────────────────
//
// Sentinel comments fenced around a region of NOSTR_STATION.md that
// belongs to the user. Anything between these markers survives every
// regeneration verbatim — never overwritten under any condition.
//
// HTML-style comment tokens so the markers don't render in rendered
// Markdown views. Markers are matched LITERALLY — substring equality,
// no regex flexibility — to keep the contract simple.
export const USER_REGION_BEGIN = '<!-- BEGIN USER EDITS — preserved across regeneration -->';
export const USER_REGION_END   = '<!-- END USER EDITS -->';

/**
 * Returns the content between the two user-region markers, with leading
 * / trailing whitespace stripped. Returns an empty string when:
 *   - either marker is missing
 *   - markers appear out of order
 *   - either marker appears more than once (ambiguous file — refuse to
 *     guess; the developer should re-run `nostr-station editor` against
 *     the canonical NOSTR_STATION.md to reset)
 *
 * Pure: input string in, output string out. Easy to unit-test.
 */
export function extractUserRegion(existing: string | null | undefined): string {
  if (typeof existing !== 'string' || !existing) return '';
  // Marker uniqueness guard — if a user (or a buggy editor) ever
  // duplicated a marker, refuse to splice rather than picking the wrong
  // region. The next regeneration will re-emit empty markers, which is
  // recoverable.
  const beginCount = existing.split(USER_REGION_BEGIN).length - 1;
  const endCount   = existing.split(USER_REGION_END).length - 1;
  if (beginCount !== 1 || endCount !== 1) return '';
  const beginIdx = existing.indexOf(USER_REGION_BEGIN);
  const endIdx   = existing.indexOf(USER_REGION_END);
  if (beginIdx < 0 || endIdx < 0 || endIdx <= beginIdx) return '';
  const inner = existing.slice(beginIdx + USER_REGION_BEGIN.length, endIdx);
  return inner.replace(/^\s*\n/, '').replace(/\n\s*$/, '');
}

// ── Symlink editor file → NOSTR_STATION.md ──────────────────────────────────
//
// Idempotent: removes any prior file or symlink at the target before
// creating a fresh relative symlink. The relative target keeps the
// link valid if the projects dir is moved.
export function symlinkEditorFile(editor: string, projectsDir: string = defaultProjectsDir()): string {
  const filename = EDITOR_FILENAMES[editor] ?? EDITOR_FILENAMES['other'];
  const linkPath = path.join(projectsDir, filename);

  // Handle subdirectory targets (e.g. .github/copilot-instructions.md)
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  try { fs.unlinkSync(linkPath); } catch { /* missing is fine */ }
  fs.symlinkSync(CONTEXT_FILENAME, linkPath);
  return linkPath;
}
