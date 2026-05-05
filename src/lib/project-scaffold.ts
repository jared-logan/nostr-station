/**
 * Project scaffolding for the dashboard's "New Project" flow.
 *
 * Two source types supported:
 *   - local-only — creates a fresh ~/nostr-station/projects/<slug> with
 *     `git init -b main`, a minimal README and .gitignore, and an initial
 *     commit. Zero external deps. This is the blank-canvas path; the user
 *     plugs in whatever AI / editor / build system they want afterward.
 *   - git-url — shells to `git clone <url> <target>` for any standard git
 *     URL (github, gitlab, codeberg, self-hosted). After clone, git history
 *     is reset to a single root commit owned by the user so the project
 *     doesn't carry the template's upstream history or remote.
 *
 * ngit clones (nostr:// / naddr1…) live in /api/ngit/clone — separate from
 * this scaffold because they use the existing Scan flow's orchestration
 * (git clone + detect + register). No ngit init happens at scaffold time:
 * ngit init publishes a repo announcement to nostr relays and belongs in
 * the user-initiated Publish flow, not automatically on creation.
 *
 * Both scaffold paths land at ~/nostr-station/projects/<slug> and register
 * into projects.json via createProject() so the Projects panel shows them.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, execSync } from 'child_process';
import type http from 'http';
import { createProject } from './projects.js';

export type ScaffoldSource =
  | { type: 'local-only' }
  | { type: 'git-url'; url: string };

export interface ScaffoldIdentity {
  useDefault: boolean;
  npub:       string | null;
  bunkerUrl:  string | null;
}

const DEFAULT_IDENTITY: ScaffoldIdentity = {
  useDefault: true,
  npub:       null,
  bunkerUrl:  null,
};

// Slug rules: lower-case, replace runs of non-alphanumerics with a single
// dash, trim leading/trailing dashes, cap at 40 chars. "My Cool App!" →
// "my-cool-app". Matches common npm/GitHub slugging conventions so users
// coming from those tools get the transformation they expect.
export function slugifyName(raw: string): string {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '') // strip combining marks
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

// Branded parent directory: everything nostr-station owns lives under
// ~/nostr-station, so `rm -rf ~/nostr-station` is a clean uninstall.
export function projectsDir(): string {
  return path.join(os.homedir(), 'nostr-station', 'projects');
}

export function previewPath(slug: string): string {
  return path.join(projectsDir(), slug);
}

export interface CollisionReport {
  exists: boolean;
  path:   string;
  slug:   string;
}

export function checkCollision(name: string): CollisionReport {
  const slug = slugifyName(name);
  const p    = previewPath(slug);
  return { exists: fs.existsSync(p), path: p, slug };
}

// ── Scaffold flow (SSE-streamed) ──────────────────────────────────────────
//
// Emits the same line/done/info frame shape as /api/exec/install/* so the
// client's openExecModal can render it without special casing.

type Stream = 'stdout' | 'stderr' | 'sys';

function writeLine(res: http.ServerResponse, stream: Stream, line: string): void {
  try { res.write(`data: ${JSON.stringify({ stream, line })}\n\n`); } catch {}
}
function writeInfo(res: http.ServerResponse, info: string, value: any): void {
  try { res.write(`data: ${JSON.stringify({ info, value })}\n\n`); } catch {}
}
function writeDone(res: http.ServerResponse, code: number): void {
  try { res.write(`data: ${JSON.stringify({ done: true, code })}\n\n`); } catch {}
  try { res.end(); } catch {}
}

// Reset a freshly-cloned project's git history to a single root commit
// owned by the user. Repos cloned from any git URL carry the upstream's
// full history + a remote pointing at the source — if the user pushes
// naively they could end up pushing to someone else's repo. After clone
// we always rm -rf .git, git init, and commit. If git user.name/email
// aren't set we still wipe and re-init but skip the commit so we don't
// fail with "please tell me who you are"; the user can commit themselves
// once they configure git. Best-effort throughout — failures here don't
// fail the scaffold (the project files are already correct on disk).
async function freshenGitRepo(target: string, message: string, res: http.ServerResponse): Promise<void> {
  // Wipe inherited history. Safe even if the dir was created without one.
  try { fs.rmSync(path.join(target, '.git'), { recursive: true, force: true }); }
  catch (e: any) {
    writeLine(res, 'stderr', `(git reset) could not remove .git: ${e?.message ?? 'unknown'}`);
    return;
  }

  // Fresh init. -b main names the branch so we don't get the legacy
  // "master" default + the noisy hint git prints with no override.
  const initCode = await runStreamed('git', ['init', '-b', 'main'], target, res);
  if (initCode !== 0) {
    writeLine(res, 'stderr', `(git reset) git init failed (code ${initCode})`);
    return;
  }

  // Check for git identity. Without name+email, `git commit` aborts with
  // a multi-line "please tell me who you are" error that adds nothing
  // useful to the modal. Skip the commit silently; the user gets a
  // staged-and-ready repo to commit themselves once they configure git.
  let hasIdentity = true;
  try {
    execSync('git config user.name && git config user.email', {
      cwd: target, stdio: 'pipe', timeout: 1500,
    });
  } catch { hasIdentity = false; }

  if (!hasIdentity) {
    writeLine(res, 'sys',
      'Note: git user.name / user.email not set — skipping initial commit. ' +
      'Configure git, then `git add . && git commit -m "Initial commit"` in the project dir.');
    return;
  }

  const addCode = await runStreamed('git', ['add', '.'], target, res);
  if (addCode !== 0) return;
  const commitCode = await runStreamed('git', ['commit', '-m', message], target, res);
  if (commitCode === 0) {
    writeLine(res, 'sys', 'Reset git history — project starts at commit 1.');
  }
}

async function runStreamed(
  cmd: string, args: string[], cwd: string, res: http.ServerResponse,
): Promise<number> {
  return new Promise((resolve) => {
    writeLine(res, 'sys', `$ ${cmd} ${args.join(' ')}`);
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', makeLineEmitter(res, 'stdout'));
    child.stderr.on('data', makeLineEmitter(res, 'stderr'));
    child.on('error',  e => { writeLine(res, 'stderr', String(e.message)); resolve(-1); });
    child.on('close',  code => resolve(code ?? -1));
  });
}

// Spinner / cursor-control aware line emitter.
//
// Tools like `git clone` (and most ora / clack / ink CLIs) animate a
// "working…" indicator using ANSI cursor-control sequences (\x1b[999D to
// jump the cursor home, \x1b[J to clear forward) instead of newlines.
// When piped through SSE the cursor controls become invisible to the
// browser but the redraws still come through as duplicate "frames" —
// without dedup the user sees thousands of identical lines.
//
// This emitter:
//   1. Treats every CSI sequence and bare \r as a logical newline so the
//      stream factors into one "line" per visible state.
//   2. Strips a leading spinner glyph when comparing two consecutive lines
//      so { ◓ Cloning, ◑ Cloning, ◒ Cloning } collapse to one emission.
//   3. Buffers across chunk boundaries — the splitter doesn't tear a
//      multi-byte UTF-8 spinner glyph apart at TCP packet boundaries.
const SPINNER_GLYPHS = /^[◓◑◒◐⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏│]+\s*/u;
const CSI_OR_CR = /\x1b\[[0-9;?]*[a-zA-Z]|\r/g;

function makeLineEmitter(res: http.ServerResponse, stream: Stream) {
  let buffer = '';
  let lastVisible = '';
  return (chunk: Buffer) => {
    buffer += chunk.toString();
    const normalized = buffer.replace(CSI_OR_CR, '\n');
    const parts = normalized.split('\n');
    // Last fragment is incomplete (no terminating control yet) — keep for
    // the next chunk so we don't tear a partial line.
    buffer = parts.pop() ?? '';
    for (const raw of parts) {
      const line = raw.trim();
      if (!line) continue;
      const visible = line.replace(SPINNER_GLYPHS, '');
      if (visible === lastVisible) continue;   // animation frame — drop
      lastVisible = visible;
      writeLine(res, stream, line);
    }
  };
}

// Minimum-surface starter for a local-only project. Just a README with
// the project name so the folder isn't empty. No .gitignore (meaningless
// without git), no framework, no npm init. Local-only means literally a
// folder of files — git/ngit are opt-in later via the project card.
function writeLocalStarter(target: string, name: string): void {
  const readme = `# ${name}\n\nCreated by nostr-station.\n`;
  fs.writeFileSync(path.join(target, 'README.md'), readme, { mode: 0o644 });
}

// Validate a URL we're about to hand to `git clone`. We allow http/https
// and git-over-ssh. We explicitly reject `nostr://` and bare naddr values
// — those route through /api/ngit/clone, not here. Rejecting early gives
// the client a clear error instead of a confusing `git clone` failure.
function validateGitUrl(url: string): string | null {
  const u = url.trim();
  if (!u) return 'url is required';
  if (u.startsWith('nostr://') || u.startsWith('naddr1')) {
    return 'nostr URLs belong to the ngit clone flow, not git-url';
  }
  if (/^https?:\/\//i.test(u))           return null;
  if (/^git@[\w.-]+:[\w./-]+$/i.test(u)) return null;
  if (/^ssh:\/\//i.test(u))              return null;
  if (/^git:\/\//i.test(u))              return null;
  return 'url must be http(s), ssh, or git@host:path';
}

export async function scaffoldProject(
  name: string,
  source: ScaffoldSource,
  res: http.ServerResponse,
  identity: ScaffoldIdentity = DEFAULT_IDENTITY,
): Promise<void> {
  res.writeHead(200, {
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
  });

  const slug = slugifyName(name);
  if (!slug) {
    writeLine(res, 'stderr', 'name did not produce a valid slug (use letters/numbers)');
    return writeDone(res, 1);
  }
  const dir = projectsDir();
  const target = previewPath(slug);

  // Collision — the client should have pre-checked, but re-check here so
  // we never overwrite anything on disk even if a race slipped through.
  if (fs.existsSync(target)) {
    writeLine(res, 'stderr', `${target} already exists — aborting to avoid overwrite`);
    writeInfo(res, 'collision', { path: target, slug });
    return writeDone(res, 2);
  }

  // Per-source validation up front. Fail fast before touching the fs.
  if (source.type === 'git-url') {
    const err = validateGitUrl(source.url);
    if (err) {
      writeLine(res, 'stderr', err);
      return writeDone(res, 3);
    }
  }

  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e: any) {
    writeLine(res, 'stderr', `could not create ${dir}: ${e?.message ?? 'unknown'}`);
    return writeDone(res, 4);
  }

  // Remotes we record on the project after scaffolding. Populated per
  // source so the future multi-remote UI has real data to render.
  let githubRemote: string | null = null;
  // "git" capability means "has a traditional git remote (github/gitlab/
  // self-hosted)", NOT "is a .git directory on disk." Local-only starts
  // without either. A git-url import starts with git=true because the
  // traditional remote is inherent to the clone.
  let gitCapability = false;

  if (source.type === 'local-only') {
    // Folder of files, period. No git init, no initial commit, no
    // .gitignore. Matches shakespeare's "no version control until you
    // pick a sync destination" model. User can initialize git later from
    // the project card (or their own terminal) when they're ready to
    // start tracking history.
    writeLine(res, 'sys', `Creating local project at ${target}…`);
    try {
      fs.mkdirSync(target, { recursive: true });
      writeLocalStarter(target, name.trim());
    } catch (e: any) {
      writeLine(res, 'stderr', `could not write to ${target}: ${e?.message ?? 'unknown'}`);
      return writeDone(res, 4);
    }
  } else {
    // git-url — clone the remote into the target dir, then freshen the
    // git history so the initial commit is the user's and the upstream
    // remote pointer is dropped (prevents accidental push-to-source).
    writeLine(res, 'sys', `Cloning ${source.url} into ${target}…`);
    const code = await runStreamed('git', ['clone', source.url, target], dir, res);
    if (code !== 0) {
      writeLine(res, 'stderr', `git clone exited with code ${code}`);
      return writeDone(res, code);
    }
    // Record github/gitlab/etc. as the github remote so it's visible on
    // the project card. The multi-remote UI (future) will generalize
    // this field name to support arbitrary named remotes.
    if (/^https?:\/\//i.test(source.url)) githubRemote = source.url;
    gitCapability = true;
    await freshenGitRepo(target, `Initial commit`, res);
  }

  // Adopt into projects.json. Capabilities map to the visible chips on
  // the project card — local-only shows no version-control chip, git-url
  // shows "git". ngit + nsite are explicit follow-ups the user enables
  // from the project card (via Publish flow — never auto-published).
  // Identity: station default unless the caller passed a project-specific
  // one. validateInput in projects.ts rejects nsec in the npub field and
  // validates bunker URL format, so bad input gets caught at the boundary
  // and we don't need to guard here.
  const projectIdentity = identity.useDefault
    ? { useDefault: true, npub: null, bunkerUrl: null }
    : {
        useDefault: false,
        npub:       identity.npub || null,
        bunkerUrl:  identity.bunkerUrl || null,
      };

  const created = createProject({
    name: name.trim(),
    path: target,
    capabilities: { git: gitCapability, ngit: false, nsite: false },
    identity: projectIdentity,
    remotes:  { github: githubRemote, ngit: null },
    nsite:    { url: null, lastDeploy: null },
  });

  if (!created.ok) {
    writeLine(res, 'stderr', `scaffold succeeded but registration failed: ${created.error}`);
    return writeDone(res, 5);
  }

  writeLine(res, 'sys', `Registered as project "${created.project.name}".`);
  writeInfo(res, 'project', created.project);
  writeDone(res, 0);
}
