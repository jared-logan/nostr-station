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

export interface Project {
  id:           string;
  name:         string;
  path:         string | null;
  capabilities: ProjectCapabilities;
  identity:     ProjectIdentity;
  remotes:      ProjectRemotes;
  nsite:        ProjectNsite;
  readRelays:   string[] | null;
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
 * the user's home directory (host-install shape). When `STATION_PROJECTS_ROOT`
 * is set, that path is used instead — the container deployment mounts a named
 * `projects` volume at `/root/projects` and sets this env var so the dashboard
 * scaffolds projects into the volume rather than the container's ephemeral
 * overlayfs. Resolved through realpath so symlinks (common on macOS, e.g.
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

// ── Read / write ────────────────────────────────────────────────────────────

function normalize(raw: any): Project | null {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.id !== 'string' || !raw.id) return null;
  const caps = raw.capabilities || {};
  const ident = raw.identity || {};
  const remotes = raw.remotes || {};
  const nsite = raw.nsite || {};
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
    readRelays: Array.isArray(raw.readRelays)
      ? raw.readRelays.filter((x: any) => typeof x === 'string')
      : null,
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
    readRelays: input.readRelays && input.readRelays.length ? input.readRelays.slice() : null,
    createdAt: now,
    updatedAt: now,
  };
  const projects = readProjects();
  projects.push(project);
  writeProjects(projects);
  return { ok: true, project };
}

export type UpdateInput = Partial<Omit<Project, 'id' | 'createdAt' | 'updatedAt'>>;

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

  const merged: Project = {
    ...current,
    name:         patch.name         !== undefined ? patch.name : current.name,
    path:         patch.path         !== undefined ? (patch.path || null) : current.path,
    capabilities: patch.capabilities !== undefined ? { ...patch.capabilities } : current.capabilities,
    identity:     patch.identity     !== undefined ? { ...patch.identity } : current.identity,
    remotes:      patch.remotes      !== undefined ? { ...patch.remotes } : current.remotes,
    nsite:        patch.nsite        !== undefined ? { ...patch.nsite } : current.nsite,
    readRelays:   patch.readRelays   !== undefined
      ? (patch.readRelays && patch.readRelays.length ? patch.readRelays.slice() : null)
      : current.readRelays,
    updatedAt:    new Date().toISOString(),
  };

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

export interface ProjectGitStatus {
  inRepo:    boolean;
  branch?:   string;
  hash?:     string;
  message?:  string;
  timestamp?: number;
  author?:   string;
  dirty?:    number;
  remotes?:  Array<{ name: string; url: string; type: 'github' | 'ngit' | 'other' }>;
  error?:    string;
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
  const dirtyRaw = runIn(projectPath, 'git status --short') ?? '';
  const dirty   = dirtyRaw.split('\n').filter(Boolean).length;
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
  return { inRepo: true, branch, hash, message, timestamp: ts, author, dirty, remotes };
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
