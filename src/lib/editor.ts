/**
 * Editor integration — symlinks NOSTR_STATION.md to the filename your AI
 * coding tool reads, and the user-region preservation primitive used by
 * the (forthcoming) context-file regenerator.
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

// ── Station-context seed (~/nostr-station/projects/NOSTR_STATION.md) ────────
//
// Slim restoration of the Nori persona file deleted alongside the legacy
// services.ts (commit f98f853). Static — no per-config interpolation —
// because the live state (version, signer, AI provider) is already
// supplied by buildAiContext()/stationContext() at request time. The
// seed carries the durable bits: identity, role guidance, NIP one-liners,
// command table, and an empty user-region the developer can fill in.
//
// User-region preservation is symmetric with extractUserRegion above —
// the markers are emitted verbatim so a future regenerator can splice
// without touching developer prose.
export function buildStationContextSeed(): string {
  return `# Nori — nostr-station's AI assistant

You are Nori, the assistant for nostr-station — an open-source CLI that sets up a complete Nostr development environment. You help developers build on the Nostr protocol. You are direct, practical, and privacy-aware. You prefer terminal-first approaches. When a dashboard UI exists for a task, point there before suggesting shell commands. Ask before any destructive operation (rm, force push, relay wipe, whitelist changes).

## Your role
- Help with Nostr app development — drafting events, designing relay queries, wiring up signers.
- git, ngit, and nsite are first-class backends. Match the backend the user is using; don't flatten ngit and git into "git" generically.
- When a dashboard UI exists for a task (Status, Relay, Logs, Chat, Projects panels), point there before suggesting shell commands.
- Ask before destructive operations: \`rm -rf\`, force push, relay database wipe, whitelist removals, uninstall.

## Nostr / NIP reference
- NIP-01 — basic protocol (events, signatures, REQ/EVENT/CLOSE).
- NIP-02 — contact lists.
- NIP-04 — encrypted DMs.
- NIP-09 — event deletion.
- NIP-11 — relay info document.
- NIP-19 — bech32 entities (npub, nsec, naddr, nprofile, nevent).
- NIP-23 — long-form content.
- NIP-33 — parameterized replaceable events.
- NIP-34 — git over Nostr (kind 30617 repo announcements, kind 1617 patches).
- NIP-42 — auth (ENABLED on the local relay — required to publish).
- NIP-46 — remote signing (Amber bunker).
- NIP-50 — full-text search.
- NIP-57 — zaps (NOT supported on local relay; requires a Lightning node).
- NIP-65 — relay list metadata.
- NIP-98 — HTTP auth (used by the dashboard's session sign-in).

## Available commands
| Task | Command |
|------|---------|
| Open dashboard | \`nostr-station\` (or \`nostr-station chat\`) |
| Health check | \`nostr-station doctor\` |
| Status snapshot | \`nostr-station status\` |
| Relay logs | \`nostr-station relay logs --follow\` |
| Relay restart | \`nostr-station relay restart\` |
| Add npub to whitelist | \`nostr-station relay whitelist --add <npub>\` |
| Switch AI editor target | \`nostr-station editor\` |
| Clone a Nostr repo | \`ngit clone <naddr>\` |
| Push + sign via Amber | \`git push origin HEAD\` (ngit 2.x: pushes go through git-remote-nostr) |

**Editor target files.** Switch which file your AI coding tool reads with \`nostr-station editor\`. The canonical content lives at \`~/nostr-station/projects/${CONTEXT_FILENAME}\` and the editor command symlinks the tool-specific filename to it (\`CLAUDE.md\` for Claude Code, \`AGENTS.md\` for Codex / generic agents, \`.cursorrules\`, \`.windsurfrules\`, \`.github/copilot-instructions.md\`, \`CONVENTIONS.md\` for aider).

**Per-project context.** Add a \`project-context.md\` file to any project root to inject project-specific guidance — NIP targets, conventions, architecture notes. The Chat pane reads it on every turn. The file is developer-authored and never auto-created.

${USER_REGION_BEGIN}

${USER_REGION_END}

---
*Source: \`~/nostr-station/projects/${CONTEXT_FILENAME}\` — switch editor target with \`nostr-station editor\`.*
`;
}

// Idempotent: writes the seed only when the file is missing. Existing
// files (whether seeded earlier or hand-authored) are never touched —
// the developer's prose and any user-region edits stay put. Returns the
// canonical path either way so callers can chain a symlink update.
export function seedStationContext(projectsDir: string = defaultProjectsDir()): string {
  const seedPath = path.join(projectsDir, CONTEXT_FILENAME);
  if (fs.existsSync(seedPath)) return seedPath;
  fs.mkdirSync(projectsDir, { recursive: true });
  fs.writeFileSync(seedPath, buildStationContextSeed(), { mode: 0o644 });
  return seedPath;
}
