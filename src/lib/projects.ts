/**
 * Project registry — ~/.config/nostr-station/projects.json.
 *
 * A project is the top-level concept in nostr-station: a bundle of one or more
 * capabilities (git, ngit, nsite). Every combination of the three is valid;
 * callers MUST NOT assume any capability implies another.
 *
 * Persistence is a single JSON file. No migrations (yet) — old records that
 * are missing fields are read defensively by `readProjects` and rewritten on
 * next update. nsec is never stored; setters reject it at the boundary.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { execSync, execFileSync } from 'child_process';
import { isNpubOrHex, isNsec, isValidRelayUrl } from './identity.js';

export interface ProjectCapabilities {
  git:   boolean;
  ngit:  boolean;
  nsite: boolean;
}

export interface ProjectIdentity {
  useDefault: boolean;
  npub:       string | null;
  bunkerUrl:  string | null;
}

export interface ProjectRemotes {
  github: string | null;
  ngit:   string | null;
}

export interface ProjectNsite {
  url:        string | null;
  lastDeploy: string | null;
}

// Per-environment endpoints. relays are ws://localhost:7777 (local) or
// wss://… (public); blossoms are http://localhost:8081 (local) or https://…
// (public). Both arrays may be empty — a project that doesn't use blob
// storage yet keeps blossoms=[] and any blossom-aware code falls back
// gracefully.
export interface ProjectEnvironmentBlock {
  relays:   string[];
  blossoms: string[];
}

// Per-project dev/prod separation introduced for the local-to-production
// testing-infrastructure feature. `active` picks which block the env
// injection (`NOSTR_STATION_RELAY`, `_BLOSSOM`, etc. in spawned PTYs and
// streamExec calls) sees, and which the built-in Nostr client reads.
// Legacy projects without this field continue to read through `readRelays`
// — `normalize()` populates `environment.prod` from `readRelays` on load.
export interface ProjectEnvironment {
  active: 'dev' | 'prod';
  dev:    ProjectEnvironmentBlock;
  prod:   ProjectEnvironmentBlock;
}

export interface Project {
  id:           string;
  name:         string;
  path:         string | null;
  capabilities: ProjectCapabilities;
  identity:     ProjectIdentity;
  remotes:      ProjectRemotes;
  nsite:        ProjectNsite;
  // Legacy public-relays field. Kept on the in-memory Project for one
  // release cycle so old dashboard clients and any external scripts that
  // read /api/projects keep working; writes via PATCH are mirrored to
  // `environment.prod.relays` and reads are derived from it whenever the
  // environment block is present. Will be removed entirely after the
  // promote (Phase E) flow ships.
  readRelays:   string[] | null;
  environment?: ProjectEnvironment;
  // Per-project auto-sync (pull-only on a 5-minute interval). Stored on
  // the Project record so it survives dashboard restarts; the in-memory
  // AutoSyncManager (src/lib/auto-sync.ts) reads this on boot to arm
  // intervals for any project where the user previously toggled it on.
  // Optional / undefined-as-false so legacy entries written before this
  // field landed read as "off" without a migration step.
  autoSync?:    boolean;
  createdAt:    string;
  updatedAt:    string;
}

function configDir(): string {
  return path.join(os.homedir(), '.config', 'nostr-station');
}

// ── Path validation (B2) ───────────────────────────────────────────────────
//
// Project paths come from the client (POST /api/projects, PATCH
// /api/projects/:id) and downstream are read by `resolveProjectContext`,
// which reads README.md / CLAUDE.md / NOSTR_STATION.md and forwards their
// content into the chat system prompt. An untrusted path = arbitrary file
// read into chat. The guard below rejects anything that resolves outside
// the user's home directory.
//
// `fs.realpathSync` only succeeds on existing paths. createProject sees
// directories that may be about to be scaffolded but don't exist yet, so
// `resolveSafeAbsolute` walks up to the longest existing ancestor, realpaths
// THAT (so symlink escapes in the existing prefix are caught), then
// re-attaches the unresolved tail. path.resolve on the way back collapses
// any `..` segments in the tail relative to the resolved head — so
// `~jared/../jared-evil/x` where the first segment exists and is a symlink
// to `/etc` ends up canonicalized as `/etc/jared-evil/x`, which the
// relative-to-home check then rejects.
//
// We use `path.relative(home, resolved)` and reject when the result is
// empty (= home itself) or starts with `..`. We do NOT use
// `startsWith(home + path.sep)` because the prefix-string check has bugs
// on directories like `/home/jared` vs `/home/jared-evil`.
export function resolveSafeAbsolute(p: string): string {
  let head = path.resolve(p);
  const tail: string[] = [];
  // Bounded loop — `path.dirname` converges to the root within a handful
  // of iterations; the cap protects against degenerate inputs.
  for (let i = 0; i < 4096; i++) {
    try {
      const real = fs.realpathSync(head);
      return tail.length ? path.resolve(real, ...tail) : real;
    } catch { /* head doesn't exist on disk — strip a segment and retry */ }
    const parent = path.dirname(head);
    if (parent === head) break;
    tail.unshift(path.basename(head));
    head = parent;
  }
  // Truly unreachable on a real filesystem (the root always exists), but
  // fall back to the literal absolute path so we never silently accept an
  // unresolvable input.
  return path.resolve(p);
}

/**
 * Resolves the directory project paths must live under. By default this is
 * the user's home directory; STATION_PROJECTS_ROOT overrides for tests +
 * any future deployment that wants project state under a custom root.
 * Resolved through realpath so symlinks (common on macOS, e.g.
 * `/var/folders/.../tmp` → `/private/var/folders/...`) compare correctly.
 */
function projectsRoot(): string {
  const envRoot = process.env.STATION_PROJECTS_ROOT;
  const base = envRoot && envRoot.trim() ? envRoot.trim() : os.homedir();
  try { return fs.realpathSync(base); }
  catch { return path.resolve(base); }
}

/**
 * Throws on invalid input, returns the resolved absolute path on valid.
 * Invariants on the returned path:
 *   - absolute
 *   - inside the projects root (HOME, or STATION_PROJECTS_ROOT when set)
 *     after symlink + `..` collapse
 *   - never equal to the projects root itself
 *
 * Trims surrounding whitespace before validation so a stray newline doesn't
 * tip an otherwise-valid path into the rejection branch.
 */
export function validateProjectPath(p: string): string {
  if (typeof p !== 'string') {
    throw new Error('project path must be a string');
  }
  const trimmed = p.trim();
  if (!trimmed) {
    throw new Error('project path must be non-empty');
  }
  if (!path.isAbsolute(trimmed)) {
    throw new Error(`project path must be absolute, got "${trimmed}"`);
  }
  const resolved = resolveSafeAbsolute(trimmed);
  const root = projectsRoot();

  const rel = path.relative(root, resolved);
  if (rel === '' || rel === '.') {
    throw new Error('project path cannot be the projects root itself');
  }
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`project path must be inside ${root}, got "${trimmed}"`);
  }
  return resolved;
}
function projectsPath(): string {
  return path.join(configDir(), 'projects.json');
}

// ── Env contract for spawned processes (PTYs + streamExec) ─────────────────
//
// Stable contract: every project-bound subprocess sees these variables in
// its environment. Apps developed inside nostr-station read them at startup
// to discover which relay / blossom to talk to, which project they're
// running under, and where their per-project test identities live. Active
// env (`dev` | `prod`) is the single switch users flip in the dashboard.
//
// Projects without an environment block (legacy + cloned/imported) get a
// degenerate contract — only PROJECT_ID is set, so app code can detect
// "running under nostr-station" without assuming any specific infra.

export function projectEnvContract(project: Project): Record<string, string> {
  const out: Record<string, string> = {
    NOSTR_STATION_PROJECT_ID: project.id,
  };
  const env = project.environment;
  if (!env) return out;
  const block = env[env.active] || { relays: [], blossoms: [] };
  out.NOSTR_STATION_ACTIVE_ENV = env.active;
  out.NOSTR_STATION_RELAY      = block.relays[0]   || '';
  out.NOSTR_STATION_RELAYS     = block.relays.join(',');
  out.NOSTR_STATION_BLOSSOM    = block.blossoms[0] || '';
  out.NOSTR_STATION_BLOSSOMS   = block.blossoms.join(',');
  if (project.path) {
    // Mirrors userConfigDirFor() in project-config.ts. Inlined to keep
    // projects.ts free of upward imports from project-config (which
    // already depends on Project's type).
    out.NOSTR_STATION_TEST_IDENTITIES_PATH = path.join(
      configDir(), 'projects', project.id, 'test-identities.json',
    );
  }
  return out;
}

// ── Read / write ────────────────────────────────────────────────────────────

// Loose http(s) URL validator for the `blossoms` arrays. Mirrors
// `isValidRelayUrl` in identity.ts (which only accepts ws/wss) but for
// HTTP — Blossom servers speak http(s), with http:// reserved for the
// loopback dev case. Trailing-whitespace rejection matches the relay
// validator so a copy-pasted URL with a stray newline gets caught before
// it lands in the persisted JSON.
function isValidBlossomUrl(s: string): boolean {
  return typeof s === 'string' && /^https?:\/\/[^\s]+$/.test(s);
}

function normalizeEnvBlock(raw: any): ProjectEnvironmentBlock {
  return {
    relays: Array.isArray(raw?.relays)
      ? raw.relays.filter((x: any) => typeof x === 'string' && x)
      : [],
    blossoms: Array.isArray(raw?.blossoms)
      ? raw.blossoms.filter((x: any) => typeof x === 'string' && x)
      : [],
  };
}

// Migration: legacy projects (pre-environment) keep their public relay
// list under `readRelays`. The first time they're loaded we DO NOT
// auto-populate the environment block — opt-in only, per the plan.
// Cloned / imported projects (where `environment` is missing) keep
// `environment === undefined`; the "Isolate to local infra" dashboard
// button is the user-driven path that flips them into dev/prod mode.
// Only `readRelays` continues to flow through for backward-compat reads.
function normalizeEnvironment(raw: any): ProjectEnvironment | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const active = raw.active === 'dev' ? 'dev'
              : raw.active === 'prod' ? 'prod'
              : 'prod';
  return {
    active,
    dev:  normalizeEnvBlock(raw.dev),
    prod: normalizeEnvBlock(raw.prod),
  };
}

function normalize(raw: any): Project | null {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.id !== 'string' || !raw.id) return null;
  const caps = raw.capabilities || {};
  const ident = raw.identity || {};
  const remotes = raw.remotes || {};
  const nsite = raw.nsite || {};
  const environment = normalizeEnvironment(raw.environment);
  // When an environment block exists, derive readRelays from
  // environment.prod.relays so old clients that GET /api/projects see
  // the same list regardless of which field was written. When it
  // doesn't, fall back to the legacy persisted readRelays.
  const legacyReadRelays = Array.isArray(raw.readRelays)
    ? raw.readRelays.filter((x: any) => typeof x === 'string')
    : null;
  const readRelays = environment
    ? (environment.prod.relays.length ? environment.prod.relays.slice() : null)
    : legacyReadRelays;
  const p: Project = {
    id:   raw.id,
    name: typeof raw.name === 'string' ? raw.name : '',
    path: typeof raw.path === 'string' && raw.path ? raw.path : null,
    capabilities: {
      git:   !!caps.git,
      ngit:  !!caps.ngit,
      nsite: !!caps.nsite,
    },
    identity: {
      useDefault: ident.useDefault !== false,
      npub:       typeof ident.npub === 'string' && ident.npub ? ident.npub : null,
      bunkerUrl:  typeof ident.bunkerUrl === 'string' && ident.bunkerUrl ? ident.bunkerUrl : null,
    },
    remotes: {
      github: typeof remotes.github === 'string' && remotes.github ? remotes.github : null,
      ngit:   typeof remotes.ngit   === 'string' && remotes.ngit   ? remotes.ngit   : null,
    },
    nsite: {
      url:        typeof nsite.url        === 'string' && nsite.url        ? nsite.url        : null,
      lastDeploy: typeof nsite.lastDeploy === 'string' && nsite.lastDeploy ? nsite.lastDeploy : null,
    },
    readRelays,
    ...(environment ? { environment } : {}),
    // autoSync is optional — coerce truthy non-bool to true (defensive
    // against legacy entries written before strict coercion landed in
    // updateProject) and leave undefined as undefined so the field
    // stays absent on rows that never opted in.
    ...(raw.autoSync !== undefined ? { autoSync: !!raw.autoSync } : {}),
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString(),
  };
  return p;
}

export function readProjects(): Project[] {
  try {
    const raw = fs.readFileSync(projectsPath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalize).filter((x): x is Project => !!x);
  } catch {
    return [];
  }
}

// Derived check — Stacks projects have a `stack.json` at their root
// (created by `stacks mkstack` and `stacks init`). Returns false for
// projects with no local path or whose path is missing/inaccessible.
// Cheap (one statSync per call) and intentionally NOT cached: users
// can convert a non-Stacks dir into one with `stacks init` between
// dashboard refreshes, and we want the next /api/projects GET to
// reflect that without a server restart.
export function isStacksProject(p: Project): boolean {
  if (!p.path) return false;
  try { return fs.statSync(`${p.path}/stack.json`).isFile(); }
  catch { return false; }
}

// Derived check — does this project ship an `npm run dev` script? This is
// the gate for the chat panel's live-preview pane: any Vite/Next/etc.
// project with a `dev` script can be iframed once it's running, even if
// it's not a stacks/MKStack project (e.g. a shakespeare.diy clone has
// vite.config.ts + package.json but no stack.json).
//
// Read package.json synchronously and parse the bare minimum. Returns
// false for any I/O or parse failure — preview pane just stays hidden,
// no error surfaced. Same not-cached rationale as isStacksProject:
// users can `npm init` a directory between dashboard polls.
export function hasDevScript(p: Project): boolean {
  if (!p.path) return false;
  try {
    const raw = fs.readFileSync(`${p.path}/package.json`, 'utf8');
    const pkg = JSON.parse(raw);
    return typeof pkg?.scripts?.dev === 'string' && pkg.scripts.dev.length > 0;
  } catch { return false; }
}

function writeProjects(projects: Project[]): void {
  fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(projectsPath(), JSON.stringify(projects, null, 2), { mode: 0o600 });
}

export function getProject(id: string): Project | null {
  return readProjects().find(p => p.id === id) ?? null;
}

// ── Validation ──────────────────────────────────────────────────────────────

function validateInput(input: Partial<Project>, existing?: Project): { ok: true } | { ok: false; error: string } {
  const caps = input.capabilities ?? existing?.capabilities;
  const resolvedPath = input.path !== undefined ? input.path : existing?.path;

  // A project must have SOME reason to exist. Two legitimate shapes:
  //   1. Local-only (folder on disk, no capabilities yet) — path required.
  //   2. Has at least one capability — git/ngit require a path (checked
  //      below); nsite-only can be path-less.
  // Before local-only was first-class, zero-capability projects were
  // rejected outright. Now they're valid as long as there's a path.
  const anyCap = caps && (caps.git || caps.ngit || caps.nsite);
  if (caps && !anyCap && !resolvedPath) {
    return { ok: false, error: 'project needs a local path or a capability (git, ngit, or nsite)' };
  }

  const ident = input.identity;
  if (ident && !ident.useDefault) {
    if (!ident.npub || typeof ident.npub !== 'string') {
      return { ok: false, error: 'project-specific identity requires an npub' };
    }
    if (isNsec(ident.npub)) {
      return { ok: false, error: 'nsec detected — nostr-station never stores private keys' };
    }
    if (!isNpubOrHex(ident.npub)) {
      return { ok: false, error: 'npub must be bech32 (npub1…) or 64-char hex' };
    }
    if (ident.bunkerUrl && !/^bunker:\/\//i.test(ident.bunkerUrl)) {
      return { ok: false, error: 'bunker URL must start with bunker://' };
    }
  }

  if (input.readRelays) {
    for (const r of input.readRelays) {
      if (!isValidRelayUrl(r)) {
        return { ok: false, error: `invalid relay URL: ${r}` };
      }
    }
  }

  if (input.environment) {
    if (input.environment.active !== 'dev' && input.environment.active !== 'prod') {
      return { ok: false, error: 'environment.active must be "dev" or "prod"' };
    }
    for (const which of ['dev', 'prod'] as const) {
      const block = input.environment[which];
      if (!block || typeof block !== 'object') {
        return { ok: false, error: `environment.${which} must be an object` };
      }
      if (!Array.isArray(block.relays) || !Array.isArray(block.blossoms)) {
        return { ok: false, error: `environment.${which}.relays and .blossoms must be arrays` };
      }
      for (const r of block.relays) {
        if (!isValidRelayUrl(r)) {
          return { ok: false, error: `invalid relay URL in environment.${which}: ${r}` };
        }
      }
      for (const b of block.blossoms) {
        if (!isValidBlossomUrl(b)) {
          return { ok: false, error: `invalid blossom URL in environment.${which}: ${b}` };
        }
      }
    }
  }

  const name = input.name ?? existing?.name;
  if (name !== undefined && (typeof name !== 'string' || !name.trim())) {
    return { ok: false, error: 'project name is required' };
  }
  if (name && name.length > 64) {
    return { ok: false, error: 'project name too long (max 64 chars)' };
  }

  // nsite-only is the only combo that may skip a local path — git and
  // ngit both need one. `resolvedPath` is hoisted above for the
  // no-capabilities check; reuse it here.
  if (caps && !resolvedPath && (caps.git || caps.ngit)) {
    return { ok: false, error: 'git and ngit projects require a local path' };
  }

  return { ok: true };
}

// ── CRUD ────────────────────────────────────────────────────────────────────

export interface CreateInput {
  name:         string;
  path:         string | null;
  capabilities: ProjectCapabilities;
  identity:     ProjectIdentity;
  remotes:      ProjectRemotes;
  nsite?:       ProjectNsite;
  readRelays?:  string[] | null;
  // Optional environment seed. New local-project scaffolds populate this
  // with the running in-process relay URL in dev and public defaults in
  // prod; imported / cloned projects leave it undefined and opt in later
  // via the dashboard's "Isolate to local infra" action.
  environment?: ProjectEnvironment;
}

export function createProject(input: CreateInput): { ok: true; project: Project } | { ok: false; error: string } {
  const v = validateInput(input);
  if (!v.ok) return v;

  // Reject duplicate-path adds. Without this, hitting Add Project twice
  // for the same dir (or scaffold-then-adopt) silently appended a second
  // entry with the new capabilities — leaving the user with two cards
  // pointing at the same checkout. If the user wants to enable additional
  // capabilities on an existing project, they should edit the existing
  // entry, not add a new one. Path normalization is intentionally
  // shallow — exact-string match on the trimmed input. Path comparison
  // doesn't try to canonicalize symlinks or trailing slashes; if a user
  // wants to add /foo and /foo/ as separate projects, that's their call.
  const incomingPath = (input.path ?? '').trim();
  if (incomingPath) {
    // Path-traversal guard (B2). Refuse anything outside ~/. Without this,
    // a malicious POST could register a path like `/etc` and downstream
    // `resolveProjectContext` would happily read /etc/README.md (or any
    // CLAUDE.md / NOSTR_STATION.md it found) into the chat system prompt
    // — turning the registry into an arbitrary-file-read primitive over
    // the chat surface.
    try { validateProjectPath(incomingPath); }
    catch (e) { return { ok: false, error: (e as Error).message }; }

    const existing = readProjects().find(p => p.path === incomingPath);
    if (existing) {
      return {
        ok: false,
        error: `A project at ${incomingPath} already exists ("${existing.name}"). Edit it to enable additional capabilities instead of adding a duplicate.`,
      };
    }
  }

  const now = new Date().toISOString();
  const project: Project = {
    id:   crypto.randomUUID(),
    name: input.name.trim(),
    path: input.path && input.path.trim() ? input.path.trim() : null,
    capabilities: { ...input.capabilities },
    identity: {
      useDefault: input.identity.useDefault !== false,
      npub:       input.identity.useDefault !== false ? null : (input.identity.npub || null),
      bunkerUrl:  input.identity.useDefault !== false ? null : (input.identity.bunkerUrl || null),
    },
    remotes: {
      github: input.capabilities.git  && input.remotes.github ? stripCredentials(input.remotes.github) : null,
      ngit:   input.capabilities.ngit && input.remotes.ngit   ? stripCredentials(input.remotes.ngit)   : null,
    },
    nsite: {
      url:        input.nsite?.url        ?? null,
      lastDeploy: input.nsite?.lastDeploy ?? null,
    },
    readRelays: input.environment
      ? (input.environment.prod.relays.length ? input.environment.prod.relays.slice() : null)
      : (input.readRelays && input.readRelays.length ? input.readRelays.slice() : null),
    ...(input.environment ? {
      environment: {
        active: input.environment.active,
        dev:    {
          relays:   (input.environment.dev.relays   || []).slice(),
          blossoms: (input.environment.dev.blossoms || []).slice(),
        },
        prod:   {
          relays:   (input.environment.prod.relays   || []).slice(),
          blossoms: (input.environment.prod.blossoms || []).slice(),
        },
      },
    } : {}),
    createdAt: now,
    updatedAt: now,
  };
  const projects = readProjects();
  projects.push(project);
  writeProjects(projects);
  return { ok: true, project };
}

// Update shape mostly mirrors Project, but `environment: null` is a valid
// patch (means "remove the environment block / revert to legacy mode")
// even though Project's own type leaves the field as `?: ProjectEnvironment`.
export type UpdateInput =
  & Partial<Omit<Project, 'id' | 'createdAt' | 'updatedAt' | 'environment'>>
  & { environment?: ProjectEnvironment | null };

export function updateProject(id: string, patch: UpdateInput): { ok: true; project: Project } | { ok: false; error: string } {
  const projects = readProjects();
  const idx = projects.findIndex(p => p.id === id);
  if (idx < 0) return { ok: false, error: 'project not found' };
  const current = projects[idx];

  // Path-traversal guard (B2): only run when the patch actually changes
  // the path. PATCHes that only update name / capabilities / identity must
  // not retroactively reject pre-existing rows whose paths happen to fall
  // outside HOME (legacy entries seeded by older versions, or by tests
  // before this guard existed).
  if (patch.path !== undefined && patch.path !== null && patch.path !== '') {
    try { validateProjectPath(patch.path); }
    catch (e) { return { ok: false, error: (e as Error).message }; }
  }

  // Deprecation: `readRelays` writes are dropped. Old clients that PATCH
  // it get a 200 but the field is not persisted — the canonical source
  // of truth for public relays is now `environment.prod.relays`. The
  // read-through in normalize() keeps GET responses populated so any
  // consumer reading the field still works.
  const nextEnvironment: ProjectEnvironment | undefined =
    patch.environment !== undefined
      ? (patch.environment ? {
          active: patch.environment.active,
          dev:    {
            relays:   (patch.environment.dev?.relays   || []).slice(),
            blossoms: (patch.environment.dev?.blossoms || []).slice(),
          },
          prod:   {
            relays:   (patch.environment.prod?.relays   || []).slice(),
            blossoms: (patch.environment.prod?.blossoms || []).slice(),
          },
        } : undefined)
      : current.environment;

  const merged: Project = {
    ...current,
    name:         patch.name         !== undefined ? patch.name : current.name,
    path:         patch.path         !== undefined ? (patch.path || null) : current.path,
    capabilities: patch.capabilities !== undefined ? { ...patch.capabilities } : current.capabilities,
    identity:     patch.identity     !== undefined ? { ...patch.identity } : current.identity,
    remotes:      patch.remotes      !== undefined ? { ...patch.remotes } : current.remotes,
    nsite:        patch.nsite        !== undefined ? { ...patch.nsite } : current.nsite,
    // readRelays is no longer writable through PATCH. The in-memory
    // field stays populated via the read-through in normalize() when
    // an environment block is present, OR carries over from `current`
    // for projects that never adopted the environment block.
    readRelays:   current.readRelays,
    autoSync:     patch.autoSync     !== undefined ? !!patch.autoSync : current.autoSync,
    updatedAt:    new Date().toISOString(),
  };
  if (nextEnvironment) {
    merged.environment = nextEnvironment;
    // Keep readRelays in lockstep with environment.prod.relays so any
    // legacy reader of the field sees the same list as the new one.
    merged.readRelays = nextEnvironment.prod.relays.length
      ? nextEnvironment.prod.relays.slice()
      : null;
  } else if (patch.environment === null) {
    // Explicit unset — caller asked to remove the environment block
    // (e.g. when reverting a project back to "no isolation").
    delete (merged as any).environment;
  }

  // Normalize identity: useDefault=true clears npub/bunker.
  if (merged.identity.useDefault) {
    merged.identity.npub = null;
    merged.identity.bunkerUrl = null;
  }
  // Drop remote URLs for capabilities that are off, and strip any embedded
  // credentials from ones that remain. Defense in depth — the drawer already
  // scrubs detect results, but a user might paste a PAT directly.
  if (!merged.capabilities.git)  merged.remotes.github = null;
  else if (merged.remotes.github) merged.remotes.github = stripCredentials(merged.remotes.github);
  if (!merged.capabilities.ngit) merged.remotes.ngit   = null;
  else if (merged.remotes.ngit)   merged.remotes.ngit   = stripCredentials(merged.remotes.ngit);

  const v = validateInput(merged, current);
  if (!v.ok) return v;

  projects[idx] = merged;
  writeProjects(projects);
  return { ok: true, project: merged };
}

export function deleteProject(id: string): { ok: boolean } {
  const projects = readProjects();
  const next = projects.filter(p => p.id !== id);
  if (next.length === projects.length) return { ok: false };
  writeProjects(next);
  return { ok: true };
}

// ── Capability detection ────────────────────────────────────────────────────

export interface DetectResult {
  exists:         boolean;
  isGitRepo:      boolean;
  githubRemote:   string | null;
  ngitRemote:     string | null;
  hasNsyte:       boolean;
  suggestedName:  string | null;
}

function runIn(cwd: string, cmd: string): string | null {
  try {
    return execSync(cmd, { cwd, stdio: 'pipe' }).toString().trim();
  } catch {
    return null;
  }
}

export function detectPath(targetPath: string): DetectResult {
  const result: DetectResult = {
    exists: false, isGitRepo: false,
    githubRemote: null, ngitRemote: null,
    hasNsyte: false, suggestedName: null,
  };
  if (!targetPath) return result;

  let stat: fs.Stats | null = null;
  try { stat = fs.statSync(targetPath); } catch { return result; }
  if (!stat.isDirectory()) return result;
  result.exists = true;
  result.suggestedName = path.basename(targetPath);

  // nsyte detection is independent of git — a static site may live anywhere.
  result.hasNsyte =
    fs.existsSync(path.join(targetPath, '.nsite')) ||
    fs.existsSync(path.join(targetPath, 'nsyte.toml')) ||
    fs.existsSync(path.join(targetPath, '.nsite.json'));

  if (fs.existsSync(path.join(targetPath, '.git'))) {
    result.isGitRepo = true;
    const raw = runIn(targetPath, 'git remote -v');
    if (raw) {
      for (const line of raw.split('\n')) {
        const m = line.match(/^(\S+)\s+(\S+)\s+\(fetch\)/);
        if (!m) continue;
        const url = m[2];
        if (!result.githubRemote && url.includes('github.com')) result.githubRemote = stripCredentials(url);
        if (!result.ngitRemote && (url.startsWith('nostr://') || url.startsWith('naddr') || url.includes('.nostr'))) {
          result.ngitRemote = stripCredentials(url);
        }
      }
    }
  }

  return result;
}

// ── Git status helpers (scoped to a project path) ───────────────────────────

export interface ProjectGitFile {
  // Final (destination) path as reported by git. May contain spaces; not
  // shell-escaped. Renames/copies expose the source in `origPath`.
  path:      string;
  origPath?: string;
  // Two-char XY status from `git status --porcelain=v1`. X = index/staged,
  // Y = working tree. Frontend interprets — e.g. '??' = untracked, ' M' =
  // modified unstaged, 'M ' = modified staged, 'MM' = both, 'A ' = added,
  // ' D' = deleted unstaged, 'R ' = renamed staged, etc.
  index:     string;
  worktree:  string;
}

export interface ProjectGitStatus {
  inRepo:    boolean;
  branch?:   string;
  hash?:     string;
  message?:  string;
  timestamp?: number;
  author?:   string;
  dirty?:    number;
  files?:    ProjectGitFile[];
  remotes?:  Array<{ name: string; url: string; type: 'github' | 'ngit' | 'other' }>;
  error?:    string;
}

// Decode git's C-style quoted pathnames. Git quotes a path when it contains
// special chars (control bytes, embedded quotes, or non-ASCII when
// `core.quotePath=true`, which is the default). The output is wrapped in
// double-quotes with backslash escapes per the C string convention plus
// three-digit octal for raw bytes. We mirror that minimally — enough to
// round-trip the names users actually have in their repos.
function unquoteGitPath(raw: string): string {
  if (raw.length < 2 || raw[0] !== '"' || raw[raw.length - 1] !== '"') return raw;
  const body = raw.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== '\\') { bytes.push(body.charCodeAt(i)); continue; }
    const next = body[++i];
    if (next === undefined) break;
    if (next >= '0' && next <= '7') {
      // Octal triplet.
      const oct = body.slice(i, i + 3);
      if (/^[0-7]{3}$/.test(oct)) {
        bytes.push(parseInt(oct, 8));
        i += 2;
        continue;
      }
    }
    const map: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '\\': 92, '"': 34 };
    if (map[next] !== undefined) { bytes.push(map[next]); continue; }
    bytes.push(next.charCodeAt(0));
  }
  return Buffer.from(bytes).toString('utf8');
}

function parsePorcelainV1(raw: string): ProjectGitFile[] {
  const files: ProjectGitFile[] = [];
  for (const line of raw.split('\n')) {
    if (line.length < 4) continue;
    const X = line[0];
    const Y = line[1];
    // Spec: "XY <path>" or for R/C "XY <orig> -> <new>". The space at
    // index 2 is always present.
    let rest = line.slice(3);
    let pathStr: string;
    let origPath: string | undefined;
    if (X === 'R' || X === 'C' || Y === 'R' || Y === 'C') {
      const arrow = rest.indexOf(' -> ');
      if (arrow >= 0) {
        const left = rest.slice(0, arrow);
        const right = rest.slice(arrow + 4);
        origPath = left.startsWith('"') ? unquoteGitPath(left) : left;
        pathStr  = right.startsWith('"') ? unquoteGitPath(right) : right;
      } else {
        pathStr = rest.startsWith('"') ? unquoteGitPath(rest) : rest;
      }
    } else {
      pathStr = rest.startsWith('"') ? unquoteGitPath(rest) : rest;
    }
    files.push({ path: pathStr, origPath, index: X, worktree: Y });
  }
  return files;
}

export function projectGitStatus(projectPath: string): ProjectGitStatus {
  if (!projectPath) return { inRepo: false, error: 'no local path' };
  if (!fs.existsSync(projectPath)) return { inRepo: false, error: 'path not found' };
  if (!fs.existsSync(path.join(projectPath, '.git'))) return { inRepo: false };
  const branch  = runIn(projectPath, 'git branch --show-current') ?? '';
  const hash    = runIn(projectPath, 'git rev-parse --short HEAD') ?? '';
  const message = runIn(projectPath, "git log -1 --pretty=%s") ?? '';
  const ts      = Number(runIn(projectPath, "git log -1 --pretty=%ct") ?? '0') * 1000;
  const author  = runIn(projectPath, "git log -1 --pretty=%an") ?? '';
  // Porcelain v1 output MUST NOT be trimmed — every status line starts
  // with the XY two-character column, and X is space whenever there's
  // no staged change. `runIn` calls .trim(), which would strip the
  // leading space and shift the parser onto the wrong byte (the bug
  // that turned `README.md` into `EADME.md` in early testing).
  const dirtyRaw = runFileIn(projectPath, 'git', ['status', '--porcelain=v1']) ?? '';
  const files   = parsePorcelainV1(dirtyRaw);
  const dirty   = files.length;
  const remotesRaw = runIn(projectPath, 'git remote -v') ?? '';
  const seen = new Set<string>();
  const remotes: ProjectGitStatus['remotes'] = [];
  for (const line of remotesRaw.split('\n')) {
    const m = line.match(/^(\S+)\s+(\S+)\s+\(fetch\)/);
    if (!m) continue;
    const [, name, url] = m;
    if (seen.has(name)) continue;
    seen.add(name);
    let type: 'github' | 'ngit' | 'other' = 'other';
    if (url.includes('github.com')) type = 'github';
    else if (url.startsWith('nostr://') || url.startsWith('naddr') || url.includes('.nostr')) type = 'ngit';
    remotes!.push({ name, url: scrubRemoteUrl(url), type });
  }
  return { inRepo: true, branch, hash, message, timestamp: ts, author, dirty, files, remotes };
}

// ── Per-file diff helpers ──────────────────────────────────────────────────
//
// Backs GET /api/projects/:id/git/diff?path=<repo-relative path>. Drives the
// Code tab's Changes view: shows what changed in a single file. We give the
// frontend the raw `git diff HEAD -- <path>` (covering both staged and
// unstaged work in one hunk-set) for tracked changes, and the verbatim
// working-tree contents for untracked files (since there's no HEAD blob to
// diff against — a wall of green "all added" lines is noise).

export interface ProjectGitDiff {
  // Path is echoed back so the client can correlate. `status` is one of the
  // human-readable codes; the raw XY is also returned for parity with the
  // status list.
  path:       string;
  status:     'modified' | 'untracked' | 'added' | 'deleted' | 'renamed' | 'unknown';
  index:      string;
  worktree:   string;
  origPath?:  string;
  binary?:    boolean;
  // For tracked changes — unified diff text from `git diff HEAD --`. Empty
  // when the file has no working-tree changes (e.g. fully staged + a stale
  // index check). For untracked files we leave this empty and populate
  // `content` instead so the frontend can render it as a "new file" view.
  diff?:      string;
  // Only set for untracked files small enough to fit in MAX_UNTRACKED_BYTES.
  content?:   string;
  size?:      number;
  truncated?: boolean;
  error?:     string;
}

// Same per-file size cap as the readBlob path (2 MiB). Untracked binaries or
// huge text logs would otherwise blow the JSON response — and the user can't
// usefully review a megabyte of unstructured text in a panel anyway.
const MAX_UNTRACKED_BYTES = 2 * 1024 * 1024;

// Safe-path guard for the diff endpoint. The path comes from the URL, so we
// must reject anything that could escape the project root or address a
// special git file. Pathnames git itself emits (status -> diff click) are
// always relative, forward-slash separated, and never start with '/'.
export function isSafeRepoPath(p: string): boolean {
  if (!p) return false;
  if (p.length > 4096) return false;
  if (p.startsWith('/') || p.includes('\\')) return false;
  // Reject NUL and other control bytes.
  if (/[\x00-\x1f]/.test(p)) return false;
  // No traversal — `..` as its own segment, anywhere.
  for (const seg of p.split('/')) {
    if (seg === '..' || seg === '.') return false;
  }
  return true;
}

function runFileIn(cwd: string, file: string, args: string[]): string | null {
  try {
    return execFileSync(file, args, { cwd, stdio: 'pipe' }).toString();
  } catch {
    return null;
  }
}

function statusForXY(X: string, Y: string): ProjectGitDiff['status'] {
  if (X === '?' && Y === '?') return 'untracked';
  // Index status (X) wins when both columns disagree — staging is the more
  // semantically loaded state ("you've decided this goes in the next
  // commit"). Working-tree-only states fall through to the Y column below.
  if (X === 'A') return 'added';
  if (X === 'D' || Y === 'D') return 'deleted';
  if (X === 'R' || Y === 'R') return 'renamed';
  if (X === 'M' || Y === 'M' || X === 'T' || Y === 'T') return 'modified';
  return 'unknown';
}

export function projectGitDiff(projectPath: string, filePath: string): ProjectGitDiff {
  if (!projectPath || !fs.existsSync(path.join(projectPath, '.git'))) {
    return { path: filePath, status: 'unknown', index: ' ', worktree: ' ', error: 'not a git repo' };
  }
  if (!isSafeRepoPath(filePath)) {
    return { path: filePath, status: 'unknown', index: ' ', worktree: ' ', error: 'invalid path' };
  }

  // Re-query git for THIS file's current XY codes. We can't trust an XY
  // baked into the URL because the working tree may have changed since the
  // last status list was rendered — and the diff vs. untracked branching
  // below hinges on whether the file is tracked.
  const statusRaw = runFileIn(projectPath, 'git', ['status', '--porcelain=v1', '--', filePath]) ?? '';
  const lines = statusRaw.split('\n').filter(Boolean);
  let X = ' ';
  let Y = ' ';
  let origPath: string | undefined;
  if (lines.length > 0) {
    const parsed = parsePorcelainV1(lines.join('\n'));
    // Multiple lines can come back if `filePath` is actually a directory
    // (git expands to per-file entries). For the diff view we only need
    // the first entry that matches our exact path.
    const exact = parsed.find(f => f.path === filePath) ?? parsed[0];
    X = exact.index;
    Y = exact.worktree;
    origPath = exact.origPath;
  }

  const status = statusForXY(X, Y);

  if (status === 'untracked') {
    // Read the working-tree file directly — there's no git object to ask
    // for content. Size-cap mirrors readBlob: above the threshold we show
    // metadata only so the panel never has to hold a megabyte payload in
    // memory.
    const abs = path.join(projectPath, filePath);
    let stat: fs.Stats | null = null;
    try { stat = fs.statSync(abs); } catch (e: any) {
      return { path: filePath, status, index: X, worktree: Y, error: e?.message ?? 'stat failed' };
    }
    if (!stat.isFile()) {
      return { path: filePath, status, index: X, worktree: Y, error: 'not a regular file' };
    }
    if (stat.size > MAX_UNTRACKED_BYTES) {
      return { path: filePath, status, index: X, worktree: Y, size: stat.size, truncated: true };
    }
    let buf: Buffer;
    try { buf = fs.readFileSync(abs); }
    catch (e: any) {
      return { path: filePath, status, index: X, worktree: Y, error: e?.message ?? 'read failed' };
    }
    // Same binary heuristic as repo.ts uses (NUL byte in the first 8 KiB).
    const sniff = buf.slice(0, 8192);
    let binary = false;
    for (let i = 0; i < sniff.length; i++) {
      if (sniff[i] === 0) { binary = true; break; }
    }
    if (binary) {
      return { path: filePath, status, index: X, worktree: Y, size: stat.size, binary: true };
    }
    return { path: filePath, status, index: X, worktree: Y, size: stat.size, content: buf.toString('utf8') };
  }

  // Tracked changes (modified/added/deleted/renamed). `git diff HEAD --`
  // combines staged + unstaged so the user sees the full delta to commit.
  // For renames we diff the destination — git tracks the rename internally,
  // so passing the new path is sufficient.
  const diffRaw = runFileIn(projectPath, 'git',
    ['diff', '--no-color', '--no-ext-diff', 'HEAD', '--', filePath]) ?? '';

  // Detect binary diffs from the marker git emits. We strip the diff body
  // so the JSON stays small; the frontend renders a "binary file changed"
  // placeholder using the flag.
  const binary = /^Binary files /m.test(diffRaw);

  return {
    path: filePath,
    status,
    index: X,
    worktree: Y,
    origPath,
    binary: binary || undefined,
    diff: binary ? '' : diffRaw,
  };
}

export function projectGitLog(projectPath: string, limit = 10): Array<{ hash: string; message: string; author: string; timestamp: number }> {
  if (!projectPath || !fs.existsSync(path.join(projectPath, '.git'))) return [];
  // B4: argv-array invocation — never compose a git command with template
  // strings, even when the only interpolation is a default-numeric limit.
  // execFileSync skips the shell entirely so `|` chars in --pretty don't
  // need single-quoting (no shell to misinterpret them as pipes), and any
  // future caller that passes a string `limit` won't be able to inject.
  // Defensive integer coercion + clamp keeps the argv canonical.
  const n = Number.isFinite(limit) ? Math.max(1, Math.min(1000, Math.floor(Number(limit)))) : 10;
  let raw: string;
  try {
    raw = execFileSync(
      'git',
      ['log', `-${n}`, '--pretty=%h|%s|%an|%ct'],
      { cwd: projectPath, stdio: 'pipe' },
    ).toString().trim();
  } catch {
    return [];
  }
  if (!raw) return [];
  return raw.split('\n').filter(Boolean).map(line => {
    const [hash, message, author, ct] = line.split('|');
    return {
      hash: hash || '',
      message: message || '',
      author: author || '',
      timestamp: (Number(ct) || 0) * 1000,
    };
  });
}

function scrubRemoteUrl(url: string): string {
  return url.replace(/^(https?:\/\/)([^@\/]+)@/, '$1•••@');
}

// Strip embedded credentials entirely before storing or echoing back to the
// client. We can't persist a PAT to projects.json (disk, screenshots, memory
// dumps) and we can't display it in the drawer input either. Git falls back
// to the system credential helper at push time, so stripping is safe.
function stripCredentials(url: string): string {
  return url.replace(/^(https?:\/\/)([^@\/]+)@/, '$1');
}

// ── Context resolution for Chat ─────────────────────────────────────────────

export interface ContextResult {
  content: string;
  source:  string;
}

const GLOBAL_CONTEXT_PATHS = [
  path.join(os.homedir(), 'nostr-station', 'projects', 'NOSTR_STATION.md'),
];

export function resolveProjectContext(project: Project | null): ContextResult {
  const candidates: string[] = [];
  if (project?.path) {
    candidates.push(path.join(project.path, '.nostr-station', 'context.md'));
    candidates.push(path.join(project.path, 'CLAUDE.md'));
    candidates.push(path.join(project.path, 'NOSTR_STATION.md'));
    candidates.push(path.join(project.path, 'README.md'));
  }
  candidates.push(...GLOBAL_CONTEXT_PATHS);
  for (const p of candidates) {
    try {
      const content = fs.readFileSync(p, 'utf8');
      return { content, source: p };
    } catch {}
  }
  return {
    content: 'You are a helpful assistant for Nostr protocol development.',
    source: '(default)',
  };
}
