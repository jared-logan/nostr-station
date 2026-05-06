// Path-safety tests — exhaustively cover the rejection cases for
// resolveProjectPath. These guards are the difference between
// "AI can edit project files" and "AI can edit /etc/passwd".

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { resolveProjectPath } from '../src/lib/ai-tools/path-safety.js';

interface MinimalProject {
  id: string; name: string; path: string | null;
  capabilities: { git: boolean; ngit: boolean; nsite: boolean };
  identity: { useDefault: boolean; npub: string | null; bunkerUrl: string | null };
  remotes: { github: string | null; ngit: string | null };
  nsite: { url: string | null; lastDeploy: string | null };
  readRelays: string[] | null;
  createdAt: string;
  updatedAt: string;
}

function makeProject(p: string | null = null): MinimalProject {
  return {
    id: 'p',
    name: 'p',
    path: p,
    capabilities: { git: false, ngit: false, nsite: false },
    identity: { useDefault: true, npub: null, bunkerUrl: null },
    remotes: { github: null, ngit: null },
    nsite: { url: null, lastDeploy: null },
    readRelays: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

let ROOT: string;
let OUTSIDE: string;

beforeEach(() => {
  ROOT    = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-ps-'));
  OUTSIDE = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-ps-out-'));
});

// ── Reject: no project path ──────────────────────────────────────────────

test('rejects when project has no path', () => {
  const r = resolveProjectPath(makeProject(null) as any, 'foo');
  assert.equal(r.ok, false);
});

// ── Reject: type / structural ────────────────────────────────────────────

test('rejects non-string input', () => {
  const r = resolveProjectPath(makeProject(ROOT) as any, 123 as any);
  assert.equal(r.ok, false);
});

test('rejects NUL byte in path', () => {
  const r = resolveProjectPath(makeProject(ROOT) as any, 'foo\0bar');
  assert.equal(r.ok, false);
  assert.match(r.error!, /null byte/i);
});

// ── Reject: absolute paths ───────────────────────────────────────────────

test('rejects absolute UNIX path', () => {
  const r = resolveProjectPath(makeProject(ROOT) as any, '/etc/passwd');
  assert.equal(r.ok, false);
  assert.match(r.error!, /absolute/i);
});

test('rejects ~/ path (bash home expansion)', () => {
  // Bash would expand `~/foo` to $HOME/foo. We don't run bash, so
  // path.isAbsolute('~/foo') is false and path.resolve drops it
  // under project root — but rejecting ~ leading segments stops
  // the LLM from accidentally relying on shell-style expansion.
  const r = resolveProjectPath(makeProject(ROOT) as any, '~/secret');
  assert.equal(r.ok, false);
});

// ── Reject: traversal ────────────────────────────────────────────────────

test('rejects ..', () => {
  const r = resolveProjectPath(makeProject(ROOT) as any, '..');
  assert.equal(r.ok, false);
});

test('rejects ../foo', () => {
  const r = resolveProjectPath(makeProject(ROOT) as any, '../foo');
  assert.equal(r.ok, false);
});

test('rejects deep ../../escape', () => {
  const r = resolveProjectPath(makeProject(ROOT) as any, 'a/b/../../../etc');
  assert.equal(r.ok, false);
});

test('rejects mixed prefix ../ even after normalization', () => {
  const r = resolveProjectPath(makeProject(ROOT) as any, 'subdir/../../escape');
  assert.equal(r.ok, false);
});

// ── Accept: in-root paths ────────────────────────────────────────────────

test('accepts the project root via .', () => {
  const r = resolveProjectPath(makeProject(ROOT) as any, '.');
  assert.equal(r.ok, true);
  assert.equal(r.abs, fs.realpathSync(ROOT));
});

test('accepts the project root via empty string', () => {
  const r = resolveProjectPath(makeProject(ROOT) as any, '');
  assert.equal(r.ok, true);
});

test('accepts a top-level file', () => {
  fs.writeFileSync(path.join(ROOT, 'README.md'), 'x');
  const r = resolveProjectPath(makeProject(ROOT) as any, 'README.md');
  assert.equal(r.ok, true);
  assert.equal(r.abs, path.join(fs.realpathSync(ROOT), 'README.md'));
});

test('accepts a nested path', () => {
  fs.mkdirSync(path.join(ROOT, 'src', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'src', 'lib', 'foo.ts'), 'x');
  const r = resolveProjectPath(makeProject(ROOT) as any, 'src/lib/foo.ts');
  assert.equal(r.ok, true);
});

test('accepts a not-yet-existing file under an existing dir', () => {
  // Important: write_file targets paths that don't exist yet.
  fs.mkdirSync(path.join(ROOT, 'src'), { recursive: true });
  const r = resolveProjectPath(makeProject(ROOT) as any, 'src/new-file.ts');
  assert.equal(r.ok, true);
});

test('accepts a not-yet-existing nested dir tree', () => {
  // mkdir -p style — the deepest existing ancestor is the project root.
  const r = resolveProjectPath(makeProject(ROOT) as any, 'a/b/c/d.txt');
  assert.equal(r.ok, true);
});

// ── Reject: symlink escapes ──────────────────────────────────────────────

test('rejects symlink pointing outside the project', () => {
  fs.symlinkSync(OUTSIDE, path.join(ROOT, 'escape'));
  const r = resolveProjectPath(makeProject(ROOT) as any, 'escape/secret.txt');
  assert.equal(r.ok, false);
  assert.match(r.error!, /symlink|outside/i);
});

test('rejects symlinked file pointing outside', () => {
  fs.writeFileSync(path.join(OUTSIDE, 'secret'), 'hidden');
  fs.symlinkSync(path.join(OUTSIDE, 'secret'), path.join(ROOT, 'link-to-secret'));
  const r = resolveProjectPath(makeProject(ROOT) as any, 'link-to-secret');
  assert.equal(r.ok, false);
});

test('rejects parent-dir symlink — child path resolves through escape', () => {
  // Realistic attack: root has a `data/` symlink to /etc; LLM asks
  // for `data/passwd`. The realpath of `data` is /etc, so the
  // canonical resolved file is /etc/passwd — must be rejected.
  fs.symlinkSync('/etc', path.join(ROOT, 'data'));
  const r = resolveProjectPath(makeProject(ROOT) as any, 'data/passwd');
  assert.equal(r.ok, false);
});

test('accepts symlink to within project', () => {
  fs.mkdirSync(path.join(ROOT, 'real'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'real', 'a.txt'), 'x');
  fs.symlinkSync(path.join(ROOT, 'real'), path.join(ROOT, 'shortcut'));
  const r = resolveProjectPath(makeProject(ROOT) as any, 'shortcut/a.txt');
  assert.equal(r.ok, true);
});

// ── Edge case: project root is itself a symlink ──────────────────────────

test('handles project root that is itself a symlink', () => {
  // /tmp/X → /private/tmp/X on macOS — fs.realpathSync of project.path
  // expands. Make sure the in-root check still works.
  const r = resolveProjectPath(makeProject(ROOT) as any, 'foo.txt');
  assert.equal(r.ok, true);
});

// ── Look-alike directory bug (CVE-class) ─────────────────────────────────

test('does not confuse /home/jared with /home/jared-evil', () => {
  const sibling = fs.mkdtempSync(path.join(path.dirname(ROOT), 'evil-'));
  // Build a path that string-prefix-matches the project root but is
  // a sibling. resolveProjectPath should reject this.
  const sneaky = path.relative(ROOT, sibling); // typically '../evil-XXXX'
  const r = resolveProjectPath(makeProject(ROOT) as any, sneaky);
  assert.equal(r.ok, false);
});
