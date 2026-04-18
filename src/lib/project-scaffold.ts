/**
 * Project scaffolding for the dashboard's "New Project" flow.
 *
 * Two templates supported today:
 *   - mkstack — shells to `stacks mkstack <slug>` (Soapbox's Nostr React
 *     scaffolder). Requires the `stacks` binary; caller should gate the
 *     template option in the UI and the server refuses if stacks is
 *     missing so no half-baked directory is created.
 *   - empty — creates an empty dir, runs `git init`, writes a tiny
 *     README. Zero external deps, always available.
 *
 * Both paths live under ~/projects/<slug> and register into projects.json
 * via createProject() so the Projects panel shows them immediately.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, execSync } from 'child_process';
import type http from 'http';
import { createProject } from './projects.js';

export type ScaffoldTemplate = 'mkstack' | 'empty';

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

export function projectsDir(): string {
  return path.join(os.homedir(), 'projects');
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

// ── Stacks relay resilience ───────────────────────────────────────────────
//
// Stacks ships with three Nostr relays in its default config —
// ditto.pub/relay, relay.nostr.band, relay.primal.net. The mkstack
// template event (kind 30717 by pubkey 0461fcbe…) appears to live
// primarily on relay.nostr.band; when nostr.band is slow or wedged,
// `stacks mkstack` spins for minutes before timing out. Adding a
// handful of large general-purpose relays as additional discovery
// candidates dramatically improves first-hit reliability — Soapbox's
// own publishes typically reach nos.lol, relay.damus.io, etc.
//
// Helper is idempotent: reads Stacks's config, appends any of our
// recommended relays that aren't already there, writes back. Called
// once at install time AND on every mkstack scaffold attempt — the
// double-call costs nothing on the steady state (no diff = no write)
// but means existing users get the patch on their next click without
// a reinstall.
const STACKS_RECOMMENDED_RELAYS = [
  'wss://nos.lol',
  'wss://relay.damus.io',
  'wss://nostr.wine',
  'wss://relay.snort.social',
];

export function ensureStacksRelays(): { patched: boolean; path: string | null } {
  const candidates = [
    path.join(os.homedir(), 'Library', 'Preferences', 'stacks', 'config.json'),
    path.join(os.homedir(), '.config', 'stacks', 'config.json'),
  ];
  for (const p of candidates) {
    let raw: string;
    try { raw = fs.readFileSync(p, 'utf8'); }
    catch { continue; /* not at this path */ }
    let cfg: any;
    try { cfg = JSON.parse(raw); }
    catch { return { patched: false, path: p }; /* corrupt — leave alone */ }

    const existing: string[] = Array.isArray(cfg.nostrRelays) ? cfg.nostrRelays.slice() : [];
    const seen = new Set(existing);
    const additions = STACKS_RECOMMENDED_RELAYS.filter(r => !seen.has(r));
    if (additions.length === 0) return { patched: false, path: p };

    cfg.nostrRelays = [...existing, ...additions];
    try {
      fs.writeFileSync(p, JSON.stringify(cfg, null, '\t') + '\n');
      return { patched: true, path: p };
    } catch {
      return { patched: false, path: p };
    }
  }
  return { patched: false, path: null };
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

// Reset a freshly-scaffolded project's git history to a single root commit
// owned by the user. Templates cloned via `stacks mkstack` (or our gitlab
// fallback) carry Soapbox's full upstream history + a remote pointing at
// soapbox-pub/mkstack — accidents waiting to happen. After scaffold we
// always rm -rf .git, git init, and commit. If git user.name/email aren't
// set we still wipe and re-init but skip the commit so we don't fail with
// "please tell me who you are"; the user can commit themselves once they
// configure git. Best-effort throughout — failures here don't fail the
// scaffold (the project files are already correct on disk).
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
// Tools like `stacks mkstack` (and most ora / clack / ink CLIs) animate a
// "working…" indicator using ANSI cursor-control sequences (\x1b[999D to
// jump the cursor home, \x1b[J to clear forward) instead of newlines.
// When piped through SSE the cursor controls become invisible to the
// browser but the redraws still come through as duplicate "frames" — the
// user saw thousands of "◓  Cloning stack..." lines instead of one
// updating line.
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

export async function scaffoldProject(
  name: string,
  template: ScaffoldTemplate,
  res: http.ServerResponse,
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

  // mkstack requires the binary. Fail fast with a clear message rather
  // than letting spawn emit an obscure ENOENT.
  if (template === 'mkstack') {
    let hasStacks = false;
    try {
      execSync('command -v stacks', { stdio: 'pipe', timeout: 1500 });
      hasStacks = true;
    } catch { /* not on PATH */ }
    if (!hasStacks) {
      writeLine(res, 'stderr', '`stacks` binary not found. Install it from Status → Binaries → Stacks, then retry.');
      return writeDone(res, 3);
    }

    // Best-effort: widen Stacks's relay set for template discovery.
    // Surfaces the patch as a "sys" line so the user sees what we did.
    const patch = ensureStacksRelays();
    if (patch.patched) {
      writeLine(res, 'sys', `Added discovery relays to ${patch.path} for faster mkstack lookup.`);
    }
  }

  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e: any) {
    writeLine(res, 'stderr', `could not create ${dir}: ${e?.message ?? 'unknown'}`);
    return writeDone(res, 4);
  }

  let code = 0;
  if (template === 'mkstack') {
    writeLine(res, 'sys', `Scaffolding mkstack template into ${target}…`);
    code = await runStreamed('stacks', ['mkstack', slug], dir, res);
    if (code !== 0) {
      writeLine(res, 'stderr', `stacks mkstack exited with code ${code}`);
      return writeDone(res, code);
    }
  } else {
    writeLine(res, 'sys', `Creating empty git repo at ${target}…`);
    try {
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(
        path.join(target, 'README.md'),
        `# ${name.trim()}\n\nCreated by nostr-station.\n`,
        { mode: 0o644 },
      );
    } catch (e: any) {
      writeLine(res, 'stderr', `could not write to ${target}: ${e?.message ?? 'unknown'}`);
      return writeDone(res, 4);
    }
  }

  // Reset git history so the project starts at the user's commit 1, not
  // Soapbox's mkstack template history. Single code path for both
  // templates — the empty branch lands here without an existing .git
  // (freshenGitRepo's rm is a no-op then), the mkstack branch lands
  // with Soapbox's clone (which freshenGitRepo wipes and re-inits).
  await freshenGitRepo(target, `Initial commit from ${template} template`, res);

  // Adopt into projects.json. git capability is always on (we either ran
  // git init or mkstack, which scaffolds as a git repo). ngit + nsite are
  // follow-ups the user can enable from the project card.
  const created = createProject({
    name: name.trim(),
    path: target,
    capabilities: { git: true, ngit: false, nsite: false },
    identity: { useDefault: true, npub: null, bunkerUrl: null },
    remotes:  { github: null, ngit: null },
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
