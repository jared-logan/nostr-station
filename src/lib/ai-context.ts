/**
 * Project-scoped context builder for the Chat pane's system prompt.
 *
 * Resolution chain at chat time:
 *
 *   1. Project's `<project>/.nostr-station/system-prompt.md` (if present)
 *   2. Built-in default template (DEFAULT_PROMPT_TEMPLATE below)
 *
 * The chosen source is then run through `renderPrompt()` with the
 * variable surface documented in `Vars` so authors can write a
 * Shakespeare-style prompt with `{{ model.fullId }}`, `{{ cwd }}`, an
 * `{% if mode === "init" %}` switch, and so on.
 *
 * Project metadata (README excerpt, last 10 commits, project-context
 * overlay) is computed up front and exposed as variables so authors
 * can decide *where* in their template they want each block. The
 * default template emits them in the same order the legacy block used
 * (header → README → overlay) so the existing prompt invariants hold.
 *
 * `readProjectContext()` stays exported with its old signature — other
 * tests/callers depend on the helper directly.
 *
 * ── project-context.md conventions ─────────────────────────────────────
 *
 * `project-context.md` is a developer-authored overlay — placed at the
 * project root or in `.nostr-station/`, read on every chat turn,
 * never auto-created or auto-truncated. Stable conventions:
 *
 *   ## Wiki namespaces
 *   - nostr-protocol
 *   - nostr-apps
 *
 * Developers can add a `## Wiki namespaces` section to signal which
 * llm-wiki namespaces Nori should query for that project specifically.
 * Today we splice the whole file; a future pass can parse this section
 * and feed it into the wiki-lookup hint at request time.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { getProject, projectGitLog, type Project } from './projects.js';
import { readTemplates, type PermissionMode } from './templates.js';
import {
  readSystemPromptOverride, readProjectContextOverlay,
  readProjectTemplate, readProjectPermissions,
  type ProjectTemplateRecord,
} from './project-config.js';
import { renderPrompt } from './prompt-render.js';
import { readIdentity, hexToNpub, isNpubOrHex } from './identity.js';
import { extractUserRegion, USER_REGION_BEGIN, USER_REGION_END } from './editor.js';

export interface AiContext {
  text:        string;
  source:      'project' | 'station';
  projectId?:  string;
  projectName?: string;
  permissions: PermissionMode;
}

export interface ModelInfo {
  /** Provider id ("anthropic", "opencode-zen", …) */
  provider?: string;
  /** Model id ("claude-opus-4-7", …) */
  fullId?:   string;
}

const README_CHARS_MAX = 500;

// ── Helpers (kept for back-compat with existing tests) ────────────────────

/**
 * Reads the developer-authored `project-context.md` from the project
 * root. Returns null when the file is missing, empty, or unreadable.
 *
 * Today this is a thin wrapper over fs — future code might parse the
 * `## Wiki namespaces` block and feed it into a wiki-lookup hint. Kept
 * exported so tests + future code can call it directly without going
 * through the full buildAiContext round-trip.
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

/**
 * Path to the user-editable station context file. Always-on layer that
 * applies to every chat turn regardless of which project (if any) is
 * active. Seeded once at first run by `seedStationContext()` in
 * web-server.ts; users edit it from the Config panel.
 *
 * Centralized here so the editor route, the preview route, and
 * `buildVars()` all agree on the location — no second source of truth.
 */
export function stationContextPath(): string {
  return path.join(os.homedir(), 'nostr-station', 'projects', 'NOSTR_STATION.md');
}

/**
 * Read the user-editable station context for splicing into the live
 * system prompt. Returns null when there's nothing useful to inject so
 * the template's `{% if stationContext %}` block omits the section
 * cleanly.
 *
 * The seeded file ships with Nori-persona / NIP-reference / command-table
 * sections that already live verbatim in DEFAULT_PROMPT_TEMPLATE — re-
 * injecting them would duplicate hundreds of tokens per turn. The seed
 * fences the user's own additive notes between USER_REGION_BEGIN /
 * USER_REGION_END markers, so:
 *
 *   - Markers present → splice only the user region (additive notes).
 *   - Markers absent  → user has rewritten the file freely; splice the
 *                       whole content rather than silently dropping it.
 *   - File missing or empty after the above → null.
 */
export function readStationContext(): string | null {
  let raw: string;
  try {
    raw = fs.readFileSync(stationContextPath(), 'utf8');
  } catch {
    return null;
  }
  if (raw.includes(USER_REGION_BEGIN) && raw.includes(USER_REGION_END)) {
    const region = extractUserRegion(raw);
    return region || null;
  }
  const trimmed = raw.trimEnd();
  if (!trimmed) return null;
  return trimmed;
}

function readReadmeExcerpt(projectPath: string): string | null {
  let entries: string[] = [];
  try { entries = fs.readdirSync(projectPath); } catch { return null; }
  const hit = entries.find(e => /^readme(\.\w+)?$/i.test(e));
  if (!hit) return null;
  try {
    const raw = fs.readFileSync(path.join(projectPath, hit), 'utf8');
    const trimmed = raw.trim();
    if (!trimmed) return null;
    if (trimmed.length > README_CHARS_MAX) {
      return trimmed.slice(0, README_CHARS_MAX).trimEnd() + '\n\n… (truncated)';
    }
    return trimmed;
  } catch {
    return null;
  }
}

// ── Mode inference ────────────────────────────────────────────────────────
//
// 'init' = project has a template record AND its git log shows only the
// scaffold root commit (the user hasn't done any work yet). 'edit' for
// everything else, including projects with no template.

function inferMode(project: Project | null, template: ProjectTemplateRecord | null): 'init' | 'edit' {
  if (!project || !project.path || !template) return 'edit';
  // ngit projects sit on a real git working tree underneath — same
  // log inspection applies. Pre-fix this gated on `cap.git` only and
  // skipped the log read for ngit-only projects, which forced them
  // into 'edit' mode regardless of commit count.
  if (!project.capabilities.git && !project.capabilities.ngit) return 'edit';
  const log = projectGitLog(project.path, 2);
  // Exactly one commit → still on the scaffold root. More than one →
  // user has written code. Zero (no commits at all) → init.
  return log.length <= 1 ? 'init' : 'edit';
}

// ── User profile ──────────────────────────────────────────────────────────
//
// The Chat pane's templated prompt has a "The User" section that wants
// npub + display name + nip-05 + lud16. We have npub from
// identity.json. The kind-0 profile (name, picture, nip-05, lud16)
// isn't currently cached on disk — we'd have to fetch from relays
// every turn, which is too slow. Pass through what's known and let
// future caching populate the rest.

interface UserVars {
  npub:  string | null;
  name:  string | null;
  nip05: string | null;
  lud16: string | null;
}

function readUserVars(): UserVars {
  try {
    const ident = readIdentity();
    if (!ident.npub) return { npub: null, name: null, nip05: null, lud16: null };
    const npub = isNpubOrHex(ident.npub)
      ? (ident.npub.startsWith('npub') ? ident.npub : hexToNpub(ident.npub))
      : null;
    return { npub, name: null, nip05: null, lud16: null };
  } catch {
    return { npub: null, name: null, nip05: null, lud16: null };
  }
}

// ── Default templated prompt ──────────────────────────────────────────────
//
// The built-in fallback when no project-level system-prompt.md is
// present. Nori persona + env block + Shakespeare-style template-list
// + project metadata sections (README, overlay) at the tail.
//
// Authors can override this verbatim by placing their own template at
// <project>/.nostr-station/system-prompt.md — the same variable surface
// is available there.

export const DEFAULT_PROMPT_TEMPLATE = `# Nori — nostr-station's AI assistant

{% if mode === "init" %}You are Nori, the AI assistant for nostr-station. The files in the current directory are a template ({{ projectTemplate.name }}). Your goal is to transform this template into a working project according to the user's request — pick sensible defaults, propose a concrete plan, and start editing.{% else %}You are Nori, the AI assistant for nostr-station. Your goal is to work on the project in the current directory according to the user's request. First, explore and understand the project structure, examine the existing files, and understand the context before making any assumptions about what the user is asking for.{% endif %}

You are direct, practical, and privacy-aware. You prefer terminal-first approaches. When a dashboard UI exists for a task (Status, Relay, Logs, Projects panels), point there before suggesting shell commands. Ask before destructive operations: rm -rf, force push, relay database wipe, whitelist removals, uninstall.

# Your Environment

- AI Model: {{ model.fullId }}
- Current Date: {{ date }}
- Current Working Directory: {{ cwd }}
- Repository URL: {% if repositoryUrl %}{{ repositoryUrl }}{% else %}none{% endif %}
- Deployed (nsite): {% if deployedUrl %}{{ deployedUrl }}{% else %}not deployed{% endif %}
{% if projectTemplate %}- Project Template: {{ projectTemplate.name }}
{% endif %}- Permissions Mode: {{ permissions.mode }}

# The User

{% if user.npub %}- Nostr npub: {{ user.npub }}
{% if user.name %}- Name: {{ user.name }}
{% endif %}{% if user.nip05 %}- NIP-05: {{ user.nip05 }}
{% endif %}{% if user.lud16 %}- Lightning: {{ user.lud16 }}
{% endif %}{% else %}The user is not yet paired with a Nostr identity. Suggest the setup wizard at /setup if they ask about publishing.{% endif %}

# Project Templates

When a project is first created, the AI chooses a template from the list below based on the user's intent. After creation the template cannot be changed.

{% for t in config.templates %}- {{ t.name }}{% if projectTemplate.id === t.id %} (CURRENT){% endif %}: {{ t.description }}
{% endfor %}

# Your role

- Help with Nostr app development — drafting events, designing relay queries, wiring up signers.
- git, ngit, and nsite are first-class backends. Match the backend the user is using; don't flatten ngit and git into "git" generically.
- When a dashboard UI exists for a task (Status, Relay, Logs, Chat, Projects panels), point there before suggesting shell commands.
- Ask before destructive operations: rm -rf, force push, relay database wipe, whitelist removals, uninstall.

# Nostr / NIP reference

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

{% if stationContext %}# Station context
*(user notes from \`~/nostr-station/projects/NOSTR_STATION.md\` — applies to every chat turn)*

{{ stationContext }}

{% endif %}{% if project %}# Your Tools

You have file-system tools scoped to the active project ({{ cwd }}). Use them
to explore and edit code; do not ask the user to paste files when you can read
them yourself.

- \`list_dir\`     — directory tree (default depth 2, max 5; skips node_modules / .git / dist / build / target / .next)
- \`read_file\`    — UTF-8 text content; binary files return a stub; 256 KB cap; use \`range\` to slice large files
- \`write_file\`   — create or overwrite a file (gated unless permissions are auto-edit/yolo)
- \`apply_patch\`  — surgical search/replace in a file; the search must be unique (gated)
- \`delete_file\`  — remove a single file; refuses directories (gated)
- \`git_status\`   — branch, hash, dirty file count
- \`git_log\`      — last N commits (default 10, max 100)
- \`git_diff\`     — unified diff for working tree, staged (\`staged: true\`), or a single \`path\`
- \`git_commit\`   — stage paths + commit with a message (gated)
- \`run_command\`  — argv-only execution scoped to the project; argv arrays only, no shell (gated)

Permissions Mode = \`{{ permissions.mode }}\`. Under \`read-only\`, every gated
tool prompts the user to approve or reject. Under \`auto-edit\`, file writes
auto-approve but \`run_command\` still prompts. Under \`yolo\`, everything
auto-approves. Don't try to defeat the gate — when a write or command is
relevant, just call the tool and the user will decide. If a call is rejected,
ask what they'd prefer instead.

\`run_command\` refuses obviously destructive argv prefixes (rm -rf, git push
--force, npm publish, curl, wget, sudo) regardless of permissions mode. If
you need one of those, explain what you want to do and ask the user to run it.

# Active project: {{ project.name }}

{% if project.path %}Path: {{ project.path }}
{% endif %}Capabilities: {{ project.capabilities }}

{% if recentCommits %}## Recent commits (last 10)

{% for c in recentCommits %}- {{ c.hash }} — {{ c.message }}
{% endfor %}
{% endif %}{% if README %}## README excerpt

{{ README }}

{% endif %}{% if projectContextOverlay %}## Project context overlay
*(from \`project-context.md\` at the project root)*

{{ projectContextOverlay }}

{% endif %}{% endif %}---
*Source: project \`.nostr-station/system-prompt.md\` (when present) or built-in default. Edit per-project under Project → Settings → AI configuration.*
`;

// ── Variable assembly ─────────────────────────────────────────────────────

interface CommitVar { hash: string; message: string; }

interface Vars {
  mode:           'init' | 'edit';
  date:           string;
  cwd:            string;
  repositoryUrl:  string | null;
  deployedUrl:    string | null;
  model:          { provider: string; fullId: string };
  permissions:    { mode: PermissionMode };
  user:           UserVars;
  config:         { templates: Array<{ id: string; name: string; description: string }> };
  // Always-on station-level overlay from ~/nostr-station/projects/NOSTR_STATION.md.
  // null when the file is missing or empty.
  stationContext: string | null;
  // Project-specific (null when no project)
  project:        null | {
    name:         string;
    path:         string | null;
    capabilities: string;
  };
  projectTemplate: ProjectTemplateRecord | null;
  recentCommits:  CommitVar[];
  README:         string | null;
  projectContextOverlay: string | null;
}

function formatCapabilities(p: Project): string {
  const active: string[] = [];
  if (p.capabilities.git)   active.push('git');
  if (p.capabilities.ngit)  active.push('ngit');
  if (p.capabilities.nsite) active.push('nsite');
  return active.length ? active.join(', ') : '(none detected)';
}

function buildVars(project: Project | null, model?: ModelInfo): Vars {
  const tplRecord  = project ? readProjectTemplate(project) : null;
  const permLocal  = project ? readProjectPermissions(project) : null;
  // Default mirrors the dispatcher's default in routes/ai.ts: 'auto-edit'
  // for new projects (writes auto-approve; run_command stays gated).
  // Surfaced into the system prompt so the model knows which class of
  // tool calls will run silently vs. require approval.
  const permission = permLocal?.mode ?? 'auto-edit';
  const mode       = inferMode(project, tplRecord);

  const README          = project?.path ? readReadmeExcerpt(project.path) : null;
  const overlay         = project ? readProjectContextOverlay(project) : null;
  // Recent commits surface in the system prompt as project context.
  // ngit-only projects have git history too (ngit init runs on top
  // of a real git repo), so we accept either capability.
  const recentCommits   = (project?.path && (project.capabilities.git || project.capabilities.ngit))
    ? projectGitLog(project.path, 10).map(c => ({ hash: c.hash, message: c.message }))
    : [];

  // Templates registry for the system-prompt's "## Project Templates"
  // section. Trim to id/name/description so the prompt doesn't leak
  // implementation-detail fields like `defaults.permissions`.
  const templates = readTemplates().map(t => ({
    id: t.id, name: t.name, description: t.description,
  }));

  return {
    mode,
    date:           new Date().toISOString(),
    cwd:            project?.path ?? os.homedir(),
    repositoryUrl:  project?.remotes?.github ?? project?.remotes?.ngit ?? null,
    deployedUrl:    project?.nsite?.url ?? null,
    model:          { provider: model?.provider ?? 'unknown', fullId: model?.fullId ?? 'unknown' },
    permissions:    { mode: permission },
    user:           readUserVars(),
    config:         { templates },
    stationContext: readStationContext(),
    project:        project ? {
      name:         project.name,
      path:         project.path,
      capabilities: formatCapabilities(project),
    } : null,
    projectTemplate: tplRecord,
    recentCommits,
    README,
    projectContextOverlay: overlay,
  };
}

// ── Public entry point ────────────────────────────────────────────────────

/**
 * Build the rendered system prompt for a chat turn.
 *
 * `model` is optional — buildAiContext is also called by the legacy
 * /api/chat code path which doesn't always have it; falls back to
 * "unknown" in those rare cases. New callers should pass the resolved
 * provider + model id so the {{ model.fullId }} interpolation lands.
 *
 * Never throws — missing files / git errors trim the corresponding
 * variables to null/empty and the template's `{% if %}` blocks omit
 * the section.
 */
export function buildAiContext(projectId?: string | null, model?: ModelInfo): AiContext {
  const project = projectId ? getProject(projectId) : null;
  const vars    = buildVars(project, model);

  // Template resolution: project file → built-in default. Global
  // override file (~/.config/nostr-station/system-prompt.md) is a
  // future feature; the built-in fallback is the default for now.
  let template = DEFAULT_PROMPT_TEMPLATE;
  if (project) {
    const projOverride = readSystemPromptOverride(project);
    if (projOverride) template = projOverride;
  }

  const text = renderPrompt(template, vars as unknown as Record<string, unknown>);

  return {
    text,
    source:      project ? 'project' : 'station',
    projectId:   project?.id,
    projectName: project?.name,
    permissions: vars.permissions.mode,
  };
}
