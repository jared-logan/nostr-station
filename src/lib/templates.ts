/**
 * Project-template registry — what the New Project flow shows the user
 * (and what the AI sees in its system prompt's "available templates"
 * block) at project-creation time.
 *
 * Design: data lives in ~/.config/nostr-station/templates.json so the
 * user can edit, add, or remove entries from the dashboard's Config
 * panel without touching code. Built-in entries (currently MKStack) are
 * seeded on first read into a missing or template-less file. They can
 * be edited in place — the next read silently reseeds anything the
 * user deleted (matching ai-config.ts's "self-healing" pattern), but a
 * user-edited builtin keeps its edits.
 *
 * Shape mirrors Shakespeare's `config.templates` so the AI prompt can
 * render the same kind of "## Project Templates" section. Source types
 * piggyback on `ScaffoldSource` from project-scaffold.ts so creating a
 * project from a template is a one-line `templates.get(id).source` →
 * `scaffoldProject({ source, ... })`.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import type { ScaffoldSource } from './project-scaffold.js';

export type PermissionMode = 'read-only' | 'auto-edit' | 'yolo';

export interface TemplateDefaults {
  /**
   * Seeded as `<project>/.nostr-station/project-context.md` at scaffold
   * time when present. Lets a template ship sensible per-project AI
   * guidance (wiki namespaces, framework conventions) without the user
   * having to copy-paste it themselves.
   */
  projectContext?: string;
  /**
   * Seeded as `<project>/.nostr-station/permissions.json` at scaffold
   * time when present. Most templates should not set this — the user's
   * global default in ai-settings.json wins by default.
   */
  permissions?: PermissionMode;
}

export interface Template {
  id:           string;
  name:         string;
  description:  string;
  source:       ScaffoldSource;
  defaults?:    TemplateDefaults;
  /**
   * `true` for entries seeded by `BUILTINS` below. Builtins can be
   * edited or "Reset to default" but not deleted — the registry is
   * self-healing and a deleted builtin reappears on next read.
   */
  builtin?:     boolean;
}

interface RegistryFile {
  version:   1;
  templates: Template[];
}

// ── Built-in seed ──────────────────────────────────────────────────────────
//
// MKStack is the canonical "build a Nostr client with React" template.
// The description is intentionally close to Shakespeare's wording — the
// AI's system prompt enumerates this list and we want the AI to reach
// for MKStack the same way Shakespeare's does, since the upstream
// template is the same git repo.

export const BUILTINS: Template[] = [
  {
    id:          'mkstack',
    name:        'MKStack',
    description:
      'Build Nostr clients with React. The default template — ships ' +
      'with complete Nostr integration out of the box, enabling ' +
      'social, blogging, AI-powered, and other client apps. If you ' +
      'are not sure which template to choose, choose this one.',
    source: {
      type: 'git-url',
      url:  'https://gitlab.com/soapbox-pub/mkstack.git',
    },
    defaults: {
      projectContext:
        '## Wiki namespaces\n' +
        '- nostr-protocol\n' +
        '- nostr-apps\n',
    },
    builtin: true,
  },
];

// ── Storage ────────────────────────────────────────────────────────────────

function configDir(): string {
  return path.join(os.homedir(), '.config', 'nostr-station');
}

export function templatesPath(): string {
  return path.join(configDir(), 'templates.json');
}

function readRaw(): RegistryFile | null {
  try {
    const raw = fs.readFileSync(templatesPath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.version !== 1) return null;
    if (!Array.isArray(parsed.templates)) return null;
    return parsed as RegistryFile;
  } catch {
    return null;
  }
}

function writeRaw(file: RegistryFile): void {
  fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(templatesPath(), JSON.stringify(file, null, 2), { mode: 0o600 });
}

/**
 * Self-healing read. Missing file → seed with builtins. File present
 * but missing some builtin ids → splice them back in (a user can never
 * lose MKStack by deleting it from the JSON; the registry's job is to
 * guarantee the curated set is always present). User-edited fields on
 * existing builtins are preserved — only absent builtins get seeded.
 */
export function readTemplates(): Template[] {
  const file = readRaw();

  if (!file) {
    // Fresh install or corrupted file — seed clean.
    const seeded: RegistryFile = { version: 1, templates: [...BUILTINS] };
    writeRaw(seeded);
    return seeded.templates;
  }

  const haveIds = new Set(file.templates.map(t => t.id));
  const missing = BUILTINS.filter(b => !haveIds.has(b.id));
  if (missing.length === 0) return file.templates;

  const merged: RegistryFile = {
    version:   1,
    templates: [...file.templates, ...missing],
  };
  writeRaw(merged);
  return merged.templates;
}

export function getTemplate(id: string): Template | null {
  return readTemplates().find(t => t.id === id) ?? null;
}

// ── Validation ─────────────────────────────────────────────────────────────

export interface ValidationResult {
  ok:    boolean;
  error?: string;
}

export function validateTemplate(t: Partial<Template>): ValidationResult {
  if (!t.id || typeof t.id !== 'string') return { ok: false, error: 'id is required' };
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(t.id)) {
    return { ok: false, error: 'id must be lowercase alphanumeric + dashes, ≤41 chars' };
  }
  if (!t.name || typeof t.name !== 'string' || !t.name.trim()) {
    return { ok: false, error: 'name is required' };
  }
  if (!t.description || typeof t.description !== 'string' || !t.description.trim()) {
    return { ok: false, error: 'description is required' };
  }
  if (!t.source || typeof t.source !== 'object') {
    return { ok: false, error: 'source is required' };
  }
  if (t.source.type === 'git-url') {
    if (!t.source.url || typeof t.source.url !== 'string') {
      return { ok: false, error: 'source.url is required for git-url templates' };
    }
    // Match the same shape isStandardGitUrl checks client-side.
    const u = t.source.url.trim();
    const looksLikeGit =
         /^https?:\/\//i.test(u)
      || /^git@[\w.-]+:[\w./-]+$/i.test(u)
      || /^ssh:\/\//i.test(u)
      || /^git:\/\//i.test(u);
    if (!looksLikeGit) return { ok: false, error: 'source.url is not a recognized git URL' };
  } else if (t.source.type === 'local-only') {
    // No additional fields.
  } else {
    return { ok: false, error: `source.type must be "git-url" or "local-only"` };
  }
  return { ok: true };
}

// ── Mutations ──────────────────────────────────────────────────────────────

/**
 * Create a new (non-builtin) template. Rejects if id is taken or the
 * payload fails validation.
 */
export function createTemplate(input: Template): { ok: true; template: Template } | { ok: false; error: string } {
  const v = validateTemplate(input);
  if (!v.ok) return { ok: false, error: v.error! };

  const existing = readTemplates();
  if (existing.some(t => t.id === input.id)) {
    return { ok: false, error: `template id "${input.id}" already exists` };
  }
  // builtin is server-controlled; ignore client-supplied value.
  const t: Template = { ...input, builtin: false };
  writeRaw({ version: 1, templates: [...existing, t] });
  return { ok: true, template: t };
}

/**
 * Update fields on an existing template. Builtins can be edited but
 * the `builtin` flag is preserved (clients cannot promote a custom
 * template to builtin, or demote MKStack). The id is also immutable —
 * to rename, delete and recreate.
 */
export function updateTemplate(id: string, patch: Partial<Template>): { ok: true; template: Template } | { ok: false; error: string } {
  const existing = readTemplates();
  const idx = existing.findIndex(t => t.id === id);
  if (idx === -1) return { ok: false, error: `template "${id}" not found` };

  const merged: Template = {
    ...existing[idx],
    ...patch,
    id:      existing[idx].id,
    builtin: existing[idx].builtin,
  };

  const v = validateTemplate(merged);
  if (!v.ok) return { ok: false, error: v.error! };

  const next = existing.slice();
  next[idx] = merged;
  writeRaw({ version: 1, templates: next });
  return { ok: true, template: merged };
}

/**
 * Delete a template. Rejects builtins — they're guaranteed present by
 * `readTemplates`. To "remove" a builtin from the picker, edit it; to
 * undo edits, call `resetTemplate`.
 */
export function deleteTemplate(id: string): { ok: true } | { ok: false; error: string } {
  const existing = readTemplates();
  const t = existing.find(x => x.id === id);
  if (!t) return { ok: false, error: `template "${id}" not found` };
  if (t.builtin) return { ok: false, error: `cannot delete builtin template "${id}" — edit it instead` };
  writeRaw({ version: 1, templates: existing.filter(x => x.id !== id) });
  return { ok: true };
}

/**
 * Restore a builtin template's fields to the seed. No-op for non-
 * builtin templates (they have no canonical "default" to restore to).
 */
export function resetTemplate(id: string): { ok: true; template: Template } | { ok: false; error: string } {
  const seed = BUILTINS.find(b => b.id === id);
  if (!seed) return { ok: false, error: `"${id}" is not a builtin template` };
  return updateTemplate(id, seed);
}
