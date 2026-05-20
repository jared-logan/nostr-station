/**
 * Per-project AI configuration — split across two directories:
 *
 *   <project>/.nostr-station/              ← shareable, commits with the repo
 *     system-prompt.md       — override of the templated system prompt
 *     project-context.md     — developer-authored overlay (verbatim splice)
 *     template.json          — { templateId, scaffoldedAt, ... } provenance
 *
 *   ~/.config/nostr-station/projects/<id>/ ← private, never commits
 *     permissions.json       — { mode: 'read-only' | 'auto-edit' | 'yolo' }
 *     chat.json              — { provider, model } per-project AI override
 *     test-identities.json   — handled by test-identities.ts (mode 0600)
 *     cache/                 — handled by nostr-query.ts
 *
 * The split exists because the second group is per-user, per-machine state
 * that has no business in the repo. Keeping it out entirely — rather than
 * relying on an auto-managed `.nostr-station/.gitignore` — means the
 * working tree never goes dirty from station activity, no matter what
 * AI agents do with the project's own .gitignore, no matter whether a
 * pre-existing nested gitignore was already committed, and no matter
 * what `git add -A` sweeps catch.
 *
 * Migration: legacy files written to `<project>/.nostr-station/{permissions,
 * chat,test-identities}.json` are copied to the new location on first read.
 * Untracked legacy files get auto-deleted; tracked ones are left alone so
 * the user sees no surprise staged deletions, and the bundle surfaces a
 * `legacy` flag so the UI can nudge them to `git rm`.
 *
 * Back-compat: a pre-existing `<project>/project-context.md` (the legacy
 * location predating `.nostr-station/`) is still read when
 * `.nostr-station/project-context.md` is absent. We never auto-move it.
 *
 * Path safety: every read goes through `path.join(projectPath, ...)` and
 * we never accept an external path here. The `Project` value comes from
 * `getProject()`, whose `path` field is itself validated against the
 * home-dir guard in `projects.ts`. So this module assumes the path is
 * already trusted.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import type { Project } from './projects.js';
import type { Template, PermissionMode } from './templates.js';
import { atomicWriteText, atomicWriteJson } from './atomic-write.js';

export const CONFIG_DIRNAME = '.nostr-station';

export const SYSTEM_PROMPT_FILE   = 'system-prompt.md';
export const PROJECT_CONTEXT_FILE = 'project-context.md';
export const TEMPLATE_FILE        = 'template.json';
export const PERMISSIONS_FILE     = 'permissions.json';
export const CHAT_FILE            = 'chat.json';

export interface ProjectTemplateRecord {
  templateId:   string;
  templateName: string;
  sourceUrl:    string | null;
  scaffoldedAt: string; // ISO 8601
}

export interface ProjectChatOverride {
  provider?: string;
  model?:    string;
}

export interface ProjectPermissions {
  mode: PermissionMode;
}

// ── Path helpers ──────────────────────────────────────────────────────────

function configDir(projectPath: string): string {
  return path.join(projectPath, CONFIG_DIRNAME);
}

export function configDirFor(project: Project): string | null {
  return project.path ? configDir(project.path) : null;
}

/**
 * `~/.config/nostr-station/projects/<id>/`. The user-config root mirrors
 * the location of `projects.json` (in `projects.ts`) so all per-user
 * station state sits under one directory.
 */
export function userConfigDirFor(project: Project): string {
  return path.join(os.homedir(), '.config', 'nostr-station', 'projects', project.id);
}

function shareablePathFor(project: Project, file: string): string | null {
  if (!project.path) return null;
  return path.join(configDir(project.path), file);
}

function userPathFor(project: Project, file: string): string {
  return path.join(userConfigDirFor(project), file);
}

function legacyPathFor(project: Project, file: string): string | null {
  if (!project.path) return null;
  return path.join(configDir(project.path), file);
}

// ── Generic read helpers ──────────────────────────────────────────────────

function readTextFile(p: string): string | null {
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const trimmed = raw.replace(/\s+$/, '');
    return trimmed.length === 0 ? null : trimmed;
  } catch {
    return null;
  }
}

function readJsonFile<T>(p: string): T | null {
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed as T;
  } catch {
    return null;
  }
}

// ── Migration: legacy → user-config dir ───────────────────────────────────
//
// One-time-per-process scan that copies any legacy
// `<project>/.nostr-station/{permissions,chat,test-identities}.json` into
// the new user-config location, then deletes the legacy file if it's
// untracked in git. Tracked files are left alone so users never see a
// surprise staged deletion; the bundle reader records what remains so
// the UI can surface a nudge to `git rm` them deliberately.

const migrationInspected = new Set<string>();

/**
 * Files that moved out of `<project>/.nostr-station/`. Each entry is a
 * filename within that dir. `test-identities.json` is migrated by
 * test-identities.ts itself (different perms requirements, atomic
 * writer); listed here so the legacy banner can mention it even when
 * the user has never opened test-identities.
 */
const MIGRATED_FILES = [PERMISSIONS_FILE, CHAT_FILE, 'test-identities.json'] as const;

function fileIsTrackedInGit(projectPath: string, relPath: string): boolean {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', '--', relPath], {
      cwd: projectPath,
      stdio: ['ignore', 'ignore', 'ignore'],
      timeout: 2000,
    });
    return true;
  } catch {
    return false;
  }
}

function copyIfMissing(from: string, to: string, mode?: number): boolean {
  try {
    if (fs.existsSync(to)) return false;
    if (!fs.existsSync(from)) return false;
    fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
    const data = fs.readFileSync(from);
    fs.writeFileSync(to, data, mode !== undefined ? { mode } : undefined);
    return true;
  } catch {
    return false;
  }
}

/**
 * Idempotent per-process migration. Safe to call on every read; the
 * memo short-circuits after the first invocation per project.
 */
function migrateLegacyFiles(project: Project): void {
  if (!project.path) return;
  if (migrationInspected.has(project.id)) return;
  migrationInspected.add(project.id);

  for (const file of MIGRATED_FILES) {
    const legacy = path.join(project.path, CONFIG_DIRNAME, file);
    const dest   = path.join(userConfigDirFor(project), file);
    // test-identities.json carries nsecs; preserve 0600 on copy.
    const mode = file === 'test-identities.json' ? 0o600 : undefined;
    copyIfMissing(legacy, dest, mode);
    // Auto-delete the legacy file when it's safe (i.e. not tracked in
    // git). Tracked files are left alone — deleting them would create
    // an unexpected staged deletion in the user's working tree.
    try {
      if (fs.existsSync(legacy) && !fileIsTrackedInGit(project.path, `${CONFIG_DIRNAME}/${file}`)) {
        fs.unlinkSync(legacy);
      }
    } catch { /* best-effort */ }
  }

  // The old auto-managed `.gitignore` becomes dead weight after the
  // files it was ignoring are gone. Same rule — only remove when
  // untracked AND its contents match a retired-only signature (so we
  // never wipe a user-customized gitignore).
  try {
    const giPath = path.join(project.path, CONFIG_DIRNAME, '.gitignore');
    if (fs.existsSync(giPath) && isRetiredOnlyGitignore(giPath)
        && !fileIsTrackedInGit(project.path, `${CONFIG_DIRNAME}/.gitignore`)) {
      fs.unlinkSync(giPath);
    }
  } catch { /* best-effort */ }
}

// The set of lines we ever auto-wrote into `<project>/.nostr-station/.gitignore`
// across the lifetime of the pre-refactor code. Any gitignore whose
// non-blank lines are all drawn from this set is one we authored — safe
// to delete (when untracked) or flag as orphan (when tracked). Any
// other line means the user customized the file, so leave it alone.
const RETIRED_GITIGNORE_LINES = new Set<string>([
  PERMISSIONS_FILE,
  CHAT_FILE,
  'test-identities.json',
  'cache/',
]);

function isRetiredOnlyGitignore(giPath: string): boolean {
  try {
    const have = fs.readFileSync(giPath, 'utf8').trim();
    if (!have) return false;
    return have
      .split(/\r?\n/)
      .map(s => s.trim())
      .filter(Boolean)
      .every(line => RETIRED_GITIGNORE_LINES.has(line));
  } catch {
    return false;
  }
}

/**
 * Returns the list of legacy files still present in `.nostr-station/`
 * — i.e. files that survived the migration sweep because they're
 * tracked in git. The UI uses this to surface a "you can `git rm`
 * these" banner. Always returns an empty list for path-less projects.
 */
export function legacyLocalFiles(project: Project): string[] {
  if (!project.path) return [];
  const out: string[] = [];
  for (const file of MIGRATED_FILES) {
    const legacy = path.join(project.path, CONFIG_DIRNAME, file);
    if (fs.existsSync(legacy)) out.push(file);
  }
  return out;
}

/**
 * Whether `<project>/.nostr-station/.gitignore` exists and contains
 * only entries this codebase used to auto-write (and no user
 * customizations). True = dead weight in the repo, safe for the user
 * to `git rm`. False = file is absent OR user-customized (leave alone).
 */
export function isOrphanGitignore(project: Project): boolean {
  if (!project.path) return false;
  const giPath = path.join(project.path, CONFIG_DIRNAME, '.gitignore');
  if (!fs.existsSync(giPath)) return false;
  return isRetiredOnlyGitignore(giPath);
}

// ── Historical nsec leak detector ─────────────────────────────────────────
//
// In pre-refactor builds, the `.nostr-station/.gitignore` writer in
// `nostr-query.ts:setCached()` would clobber the project-config-managed
// gitignore (which listed `test-identities.json`) with just `cache/\n` —
// because the cache writer ran unconditionally on every cache write and
// did an exact-equality comparison. Net effect: the inner gitignore
// only ever protected `cache/`, not the private files it was supposed
// to. A casual `git add .` in any pre-refactor build would have staged
// test-identities.json, plaintext nsecs and all.
//
// This detector runs `git log --all --diff-filter=A` against that path
// to find any commit that ever introduced the file. The `--all` is
// load-bearing — it surfaces leaks on branches the user doesn't have
// checked out (including ngit-pushed feature branches). Result is
// memoized per process per project so the shell-out fires at most once.

const nsecHistoryMemo = new Map<string, string[] | null>();
const NSEC_HISTORY_TIMEOUT_MS = 2000;
const NSEC_HISTORY_MAX_COMMITS = 100;

/**
 * Returns commit SHAs (newest first) that added
 * `.nostr-station/test-identities.json` at any point in this repo's
 * history. Bounded scan — at most NSEC_HISTORY_MAX_COMMITS results,
 * 2 s timeout. Returns:
 *
 *   - `null`  — couldn't check (no path, no .git, no git binary,
 *               timeout, or other error). UI should treat as "unknown,
 *               don't alarm the user".
 *   - `[]`    — checked and clean. Show no banner.
 *   - `[...]` — found leaks. Show the red security banner.
 */
export function detectNsecsInHistory(project: Project): string[] | null {
  if (!project.path) return null;
  if (nsecHistoryMemo.has(project.id)) return nsecHistoryMemo.get(project.id)!;

  const result = scanNsecHistory(project.path);
  nsecHistoryMemo.set(project.id, result);
  return result;
}

function scanNsecHistory(projectPath: string): string[] | null {
  if (!fs.existsSync(path.join(projectPath, '.git'))) return null;
  try {
    const raw = execFileSync(
      'git',
      [
        'log', '--all', '--diff-filter=A',
        `--max-count=${NSEC_HISTORY_MAX_COMMITS}`,
        '--pretty=format:%H',
        '--', `${CONFIG_DIRNAME}/test-identities.json`,
      ],
      {
        cwd: projectPath,
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: NSEC_HISTORY_TIMEOUT_MS,
      },
    ).toString().trim();
    if (!raw) return [];
    return raw.split('\n').filter(Boolean);
  } catch {
    return null;
  }
}

// ── Public reads ──────────────────────────────────────────────────────────

/**
 * Read the per-project system-prompt override. Returns null when the
 * file is missing or empty (caller falls through to global → built-in).
 */
export function readSystemPromptOverride(project: Project): string | null {
  const p = shareablePathFor(project, SYSTEM_PROMPT_FILE);
  return p ? readTextFile(p) : null;
}

/**
 * Read the project-context overlay. Prefers the dot-dir version; falls
 * back to the legacy `<project>/project-context.md` location when the
 * new one is absent. Returns null on missing-or-empty in both spots.
 */
export function readProjectContextOverlay(project: Project): string | null {
  if (!project.path) return null;
  const dotDir = shareablePathFor(project, PROJECT_CONTEXT_FILE);
  const dotVal = dotDir ? readTextFile(dotDir) : null;
  if (dotVal !== null) return dotVal;
  // Back-compat: pre-2026-05 projects placed it at the project root.
  const legacy = path.join(project.path, PROJECT_CONTEXT_FILE);
  return readTextFile(legacy);
}

export function readProjectTemplate(project: Project): ProjectTemplateRecord | null {
  const p = shareablePathFor(project, TEMPLATE_FILE);
  if (!p) return null;
  const raw = readJsonFile<ProjectTemplateRecord>(p);
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.templateId !== 'string') return null;
  if (typeof raw.templateName !== 'string') return null;
  if (typeof raw.scaffoldedAt !== 'string') return null;
  return raw;
}

export function readProjectPermissions(project: Project): ProjectPermissions | null {
  migrateLegacyFiles(project);
  const p = userPathFor(project, PERMISSIONS_FILE);
  const raw = readJsonFile<ProjectPermissions>(p);
  if (!raw || typeof raw !== 'object') return null;
  if (raw.mode !== 'read-only' && raw.mode !== 'auto-edit' && raw.mode !== 'yolo') {
    return null;
  }
  return { mode: raw.mode };
}

export function readProjectChatOverride(project: Project): ProjectChatOverride | null {
  migrateLegacyFiles(project);
  const p = userPathFor(project, CHAT_FILE);
  const raw = readJsonFile<ProjectChatOverride>(p);
  if (!raw || typeof raw !== 'object') return null;
  const out: ProjectChatOverride = {};
  if (typeof raw.provider === 'string' && raw.provider) out.provider = raw.provider;
  if (typeof raw.model === 'string'    && raw.model)    out.model    = raw.model;
  return Object.keys(out).length === 0 ? null : out;
}

// ── Public writes ─────────────────────────────────────────────────────────

/**
 * Lazy-create the shareable `<project>/.nostr-station/` dir. Used for
 * system-prompt.md, project-context.md, and template.json — all of
 * which are intended to commit with the repo. Returns null when the
 * project has no path. Idempotent.
 */
export function ensureConfigDir(project: Project): string | null {
  if (!project.path) return null;
  const dir = configDir(project.path);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Lazy-create the user-config dir for this project. Mode 0o700 so
 * other users on a shared machine can't read private state (test
 * identity nsecs, model preferences). Idempotent.
 */
export function ensureUserConfigDir(project: Project): string {
  const dir = userConfigDirFor(project);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

// Project-tree files (mode 0o644). These live under .nostr-station/
// inside the project directory and are intended to commit with the
// repo, so they need world-readable mode — other tools (git, IDE
// previews) read them. atomic-write defaults to 0o600 so we pass
// mode explicitly.
export function writeSystemPromptOverride(project: Project, content: string): void {
  const dir = ensureConfigDir(project);
  if (!dir) throw new Error('project has no path');
  atomicWriteText(path.join(dir, SYSTEM_PROMPT_FILE), content, { mode: 0o644, dirMode: 0o755 });
}

export function writeProjectContextOverlay(project: Project, content: string): void {
  const dir = ensureConfigDir(project);
  if (!dir) throw new Error('project has no path');
  atomicWriteText(path.join(dir, PROJECT_CONTEXT_FILE), content, { mode: 0o644, dirMode: 0o755 });
}

export function writeProjectTemplate(project: Project, record: ProjectTemplateRecord): void {
  const dir = ensureConfigDir(project);
  if (!dir) throw new Error('project has no path');
  atomicWriteJson(path.join(dir, TEMPLATE_FILE), record, { mode: 0o644, dirMode: 0o755 });
}

// User-config files (mode 0o600). These live under ~/.config/
// nostr-station/projects/<id>/ — private, never committed.
export function writeProjectPermissions(project: Project, permissions: ProjectPermissions): void {
  const dir = ensureUserConfigDir(project);
  atomicWriteJson(path.join(dir, PERMISSIONS_FILE), permissions, { mode: 0o600 });
}

export function writeProjectChatOverride(project: Project, override: ProjectChatOverride): void {
  const dir = ensureUserConfigDir(project);
  atomicWriteJson(path.join(dir, CHAT_FILE), override, { mode: 0o600 });
}

// ── Public deletes (for "clear override" UI) ──────────────────────────────

export function deleteSystemPromptOverride(project: Project): void {
  const p = shareablePathFor(project, SYSTEM_PROMPT_FILE);
  if (p) try { fs.unlinkSync(p); } catch {}
}

export function deleteProjectContextOverlay(project: Project): void {
  const p = shareablePathFor(project, PROJECT_CONTEXT_FILE);
  if (p) try { fs.unlinkSync(p); } catch {}
}

export function deleteProjectPermissions(project: Project): void {
  try { fs.unlinkSync(userPathFor(project, PERMISSIONS_FILE)); } catch {}
  // Also clean up any legacy copy left behind by a tracked-in-git
  // migration — `null` in the bundle PUT means "reset to inherit" and
  // a leftover legacy file would silently keep the override alive.
  const legacy = legacyPathFor(project, PERMISSIONS_FILE);
  if (legacy) try { fs.unlinkSync(legacy); } catch {}
}

export function deleteProjectChatOverride(project: Project): void {
  try { fs.unlinkSync(userPathFor(project, CHAT_FILE)); } catch {}
  const legacy = legacyPathFor(project, CHAT_FILE);
  if (legacy) try { fs.unlinkSync(legacy); } catch {}
}

// ── Scaffold-time seeding ─────────────────────────────────────────────────

/**
 * Called once during `scaffoldProject` after the project record is
 * created in projects.json. Writes:
 *   - template.json             (if a template was used)
 *   - project-context.md        (if the template has a `defaults.projectContext`)
 *   - permissions.json          (if the template has a `defaults.permissions`)
 *
 * Never writes system-prompt.md or chat.json — those are user actions.
 *
 * Failures here don't fail the scaffold (the project files are already
 * on disk). Caller logs them.
 */
export function seedProjectConfig(
  project: Project,
  template: Template | null,
): void {
  const dir = ensureConfigDir(project);
  if (!dir) return;

  if (template) {
    const record: ProjectTemplateRecord = {
      templateId:   template.id,
      templateName: template.name,
      sourceUrl:    template.source.type === 'git-url' ? template.source.url : null,
      scaffoldedAt: new Date().toISOString(),
    };
    writeProjectTemplate(project, record);

    if (template.defaults?.projectContext) {
      // Only seed the overlay if the file isn't already present (a
      // template that ships its own `project-context.md` in the cloned
      // repo wins over our seed).
      const existing = path.join(dir, PROJECT_CONTEXT_FILE);
      const legacy   = path.join(project.path!, PROJECT_CONTEXT_FILE);
      if (!fs.existsSync(existing) && !fs.existsSync(legacy)) {
        writeProjectContextOverlay(project, template.defaults.projectContext);
      }
    }
    if (template.defaults?.permissions) {
      const existing = userPathFor(project, PERMISSIONS_FILE);
      if (!fs.existsSync(existing)) {
        writeProjectPermissions(project, { mode: template.defaults.permissions });
      }
    }
  }
}

// ── Bundle reader (used by /api/projects/:id/ai-config) ───────────────────

export interface ProjectAiConfigBundle {
  systemPrompt:    string | null;
  projectContext:  string | null;
  template:        ProjectTemplateRecord | null;
  permissions:     ProjectPermissions | null;
  chat:            ProjectChatOverride | null;
  // Whether the legacy root-level project-context.md exists. The UI
  // surfaces this so users can migrate by accepting the prompt to move
  // it under .nostr-station/.
  legacyContext:   boolean;
  // Names of files that used to live in `<project>/.nostr-station/`
  // and survived the auto-migration because they're tracked in git.
  // Empty list = clean. The UI shows a "you can git rm these" hint
  // when non-empty so the user can deliberately remove them from the
  // index.
  legacyLocalFiles: string[];
  // True when `<project>/.nostr-station/.gitignore` exists and only
  // lists retired station entries — dead weight in the repo. The UI
  // surfaces this in the same "you can git rm these" hint as
  // legacyLocalFiles. Distinct flag because the gitignore itself
  // doesn't appear in legacyLocalFiles (different category — it's
  // not a private file, it's a stale ignore rule).
  orphanGitignore: boolean;
  // Commit SHAs that ever added `<project>/.nostr-station/test-identities.json`
  // to git history. Pre-refactor builds had a gitignore race that left
  // this file unprotected — a stray `git add .` could and did stage
  // it. `null` = couldn't check; `[]` = clean; non-empty = SECURITY
  // INCIDENT, plaintext nsecs may be in history (and on any remote
  // they've been pushed to). UI surfaces this as a red banner with
  // audit guidance.
  nsecsInHistory: string[] | null;
}

export function readProjectAiConfig(project: Project): ProjectAiConfigBundle {
  const legacyContextPath = project.path
    ? path.join(project.path, PROJECT_CONTEXT_FILE)
    : null;
  return {
    systemPrompt:   readSystemPromptOverride(project),
    projectContext: readProjectContextOverlay(project),
    template:       readProjectTemplate(project),
    permissions:    readProjectPermissions(project),
    chat:           readProjectChatOverride(project),
    legacyContext:  !!(legacyContextPath && fs.existsSync(legacyContextPath)
                      && !fs.existsSync(path.join(configDir(project.path!), PROJECT_CONTEXT_FILE))),
    legacyLocalFiles: legacyLocalFiles(project),
    orphanGitignore:  isOrphanGitignore(project),
    nsecsInHistory:   detectNsecsInHistory(project),
  };
}
