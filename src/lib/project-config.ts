/**
 * Per-project AI configuration directory — `<project>/.nostr-station/`.
 *
 * Every project gets a small dot-dir at its root that holds editable AI
 * config: a system-prompt override, a project-context overlay, the
 * template that scaffolded it, the permissions mode, and a per-project
 * provider/model override. Resolution falls through global defaults
 * (~/.config/nostr-station/) and ultimately the built-in seed in
 * `editor.ts`, so empty / absent files mean "inherit the next layer."
 *
 *   <project>/.nostr-station/
 *     system-prompt.md       — override of the templated system prompt
 *     project-context.md     — developer-authored overlay (verbatim splice)
 *     template.json          — { templateId, scaffoldedAt, ... }
 *     permissions.json       — { mode: 'read-only' | 'auto-edit' | 'yolo' }
 *     chat.json              — { provider, model } per-project AI override
 *     .gitignore             — keeps machine-local files out of git
 *
 * Back-compat: a pre-existing `<project>/project-context.md` (the legacy
 * location) is still read when `.nostr-station/project-context.md` is
 * absent. We never auto-move the legacy file — the developer migrates
 * deliberately when they want.
 *
 * Path safety: every read goes through `path.join(projectPath, ...)` and
 * we never accept an external path here. The `Project` value comes from
 * `getProject()`, whose `path` field is itself validated against the
 * home-dir guard in `projects.ts`. So this module assumes the path is
 * already trusted.
 */

import fs from 'fs';
import path from 'path';
import type { Project } from './projects.js';
import type { Template, PermissionMode } from './templates.js';

export const CONFIG_DIRNAME = '.nostr-station';

export const SYSTEM_PROMPT_FILE   = 'system-prompt.md';
export const PROJECT_CONTEXT_FILE = 'project-context.md';
export const TEMPLATE_FILE        = 'template.json';
export const PERMISSIONS_FILE     = 'permissions.json';
export const CHAT_FILE            = 'chat.json';
export const GITIGNORE_FILE       = '.gitignore';

// Files that are machine-local and should not be committed to git. Keep
// `system-prompt.md`, `project-context.md`, and `template.json` out of
// the gitignore so they DO travel with the repo — they're shareable
// per-project guidance and provenance.
const GITIGNORE_CONTENTS = `${PERMISSIONS_FILE}\n${CHAT_FILE}\n`;

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

function pathFor(project: Project, file: string): string | null {
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

// ── Public reads ──────────────────────────────────────────────────────────

/**
 * Read the per-project system-prompt override. Returns null when the
 * file is missing or empty (caller falls through to global → built-in).
 */
export function readSystemPromptOverride(project: Project): string | null {
  const p = pathFor(project, SYSTEM_PROMPT_FILE);
  return p ? readTextFile(p) : null;
}

/**
 * Read the project-context overlay. Prefers the dot-dir version; falls
 * back to the legacy `<project>/project-context.md` location when the
 * new one is absent. Returns null on missing-or-empty in both spots.
 */
export function readProjectContextOverlay(project: Project): string | null {
  if (!project.path) return null;
  const dotDir = pathFor(project, PROJECT_CONTEXT_FILE);
  const dotVal = dotDir ? readTextFile(dotDir) : null;
  if (dotVal !== null) return dotVal;
  // Back-compat: pre-2026-05 projects placed it at the project root.
  const legacy = path.join(project.path, PROJECT_CONTEXT_FILE);
  return readTextFile(legacy);
}

export function readProjectTemplate(project: Project): ProjectTemplateRecord | null {
  const p = pathFor(project, TEMPLATE_FILE);
  if (!p) return null;
  const raw = readJsonFile<ProjectTemplateRecord>(p);
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.templateId !== 'string') return null;
  if (typeof raw.templateName !== 'string') return null;
  if (typeof raw.scaffoldedAt !== 'string') return null;
  return raw;
}

export function readProjectPermissions(project: Project): ProjectPermissions | null {
  const p = pathFor(project, PERMISSIONS_FILE);
  if (!p) return null;
  const raw = readJsonFile<ProjectPermissions>(p);
  if (!raw || typeof raw !== 'object') return null;
  if (raw.mode !== 'read-only' && raw.mode !== 'auto-edit' && raw.mode !== 'yolo') {
    return null;
  }
  return { mode: raw.mode };
}

export function readProjectChatOverride(project: Project): ProjectChatOverride | null {
  const p = pathFor(project, CHAT_FILE);
  if (!p) return null;
  const raw = readJsonFile<ProjectChatOverride>(p);
  if (!raw || typeof raw !== 'object') return null;
  const out: ProjectChatOverride = {};
  if (typeof raw.provider === 'string' && raw.provider) out.provider = raw.provider;
  if (typeof raw.model === 'string'    && raw.model)    out.model    = raw.model;
  return Object.keys(out).length === 0 ? null : out;
}

// ── Public writes ─────────────────────────────────────────────────────────

/**
 * Lazy-create the dot-dir if it doesn't exist. Caller is responsible for
 * project.path being a writable directory. Idempotent.
 */
export function ensureConfigDir(project: Project): string | null {
  if (!project.path) return null;
  const dir = configDir(project.path);
  fs.mkdirSync(dir, { recursive: true });
  // .gitignore is harmless to write every time; small file, never
  // touched by the user, machine-local enough that overwriting is fine.
  const giPath = path.join(dir, GITIGNORE_FILE);
  if (!fs.existsSync(giPath)) {
    fs.writeFileSync(giPath, GITIGNORE_CONTENTS);
  }
  return dir;
}

export function writeSystemPromptOverride(project: Project, content: string): void {
  const dir = ensureConfigDir(project);
  if (!dir) throw new Error('project has no path');
  fs.writeFileSync(path.join(dir, SYSTEM_PROMPT_FILE), content);
}

export function writeProjectContextOverlay(project: Project, content: string): void {
  const dir = ensureConfigDir(project);
  if (!dir) throw new Error('project has no path');
  fs.writeFileSync(path.join(dir, PROJECT_CONTEXT_FILE), content);
}

export function writeProjectTemplate(project: Project, record: ProjectTemplateRecord): void {
  const dir = ensureConfigDir(project);
  if (!dir) throw new Error('project has no path');
  fs.writeFileSync(path.join(dir, TEMPLATE_FILE), JSON.stringify(record, null, 2));
}

export function writeProjectPermissions(project: Project, permissions: ProjectPermissions): void {
  const dir = ensureConfigDir(project);
  if (!dir) throw new Error('project has no path');
  fs.writeFileSync(path.join(dir, PERMISSIONS_FILE), JSON.stringify(permissions, null, 2));
}

export function writeProjectChatOverride(project: Project, override: ProjectChatOverride): void {
  const dir = ensureConfigDir(project);
  if (!dir) throw new Error('project has no path');
  fs.writeFileSync(path.join(dir, CHAT_FILE), JSON.stringify(override, null, 2));
}

// ── Scaffold-time seeding ─────────────────────────────────────────────────

/**
 * Called once during `scaffoldProject` after the project record is
 * created in projects.json. Writes:
 *   - .gitignore                (always)
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
      const existing = path.join(dir, PERMISSIONS_FILE);
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
  };
}
