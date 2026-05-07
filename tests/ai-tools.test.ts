// AI tools tests — exercise every tool's happy path + each tool's
// error path, plus the dispatcher's permission gating logic. All
// tests use a fresh tmpdir as the project root so the real
// filesystem is never touched.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';

import { runTool, requiresApproval, listTools, getTool } from '../src/lib/ai-tools/index.js';

interface MinimalProject {
  id: string; name: string; path: string | null;
  capabilities: { git: boolean; ngit: boolean; nsite: boolean };
  identity: any; remotes: any; nsite: any;
  readRelays: null; createdAt: string; updatedAt: string;
}

function makeProject(p: string | null, gitCap = false): MinimalProject {
  return {
    id: 't', name: 't', path: p,
    capabilities: { git: gitCap, ngit: false, nsite: false },
    identity: { useDefault: true, npub: null, bunkerUrl: null },
    remotes: { github: null, ngit: null },
    nsite: { url: null, lastDeploy: null },
    readRelays: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

let ROOT: string;
beforeEach(() => {
  ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-tools-'));
});

// ── Registry ────────────────────────────────────────────────────────────

test('registry: listTools returns all expected tools', () => {
  const names = new Set(listTools().map(t => t.name));
  for (const expected of [
    'list_dir', 'read_file', 'write_file', 'apply_patch', 'delete_file',
    'git_status', 'git_log', 'git_diff', 'git_commit',
    'run_command',
  ]) {
    assert.ok(names.has(expected), `missing tool: ${expected}`);
  }
});

test('registry: getTool by name', () => {
  assert.equal(getTool('read_file')?.name, 'read_file');
  assert.equal(getTool('does_not_exist'), null);
});

// ── Permission gating ────────────────────────────────────────────────────

test('requiresApproval: read tools always pass', () => {
  for (const mode of ['read-only', 'auto-edit', 'yolo'] as const) {
    assert.equal(requiresApproval('list_dir', mode), false);
    assert.equal(requiresApproval('read_file', mode), false);
    assert.equal(requiresApproval('git_status', mode), false);
  }
});

test('requiresApproval: write tools gated under read-only', () => {
  assert.equal(requiresApproval('write_file',  'read-only'), true);
  assert.equal(requiresApproval('apply_patch', 'read-only'), true);
  assert.equal(requiresApproval('delete_file', 'read-only'), true);
  assert.equal(requiresApproval('git_commit',  'read-only'), true);
  assert.equal(requiresApproval('run_command', 'read-only'), true);
});

test('requiresApproval: auto-edit lets writes through, still gates exec', () => {
  assert.equal(requiresApproval('write_file',  'auto-edit'), false);
  assert.equal(requiresApproval('apply_patch', 'auto-edit'), false);
  assert.equal(requiresApproval('delete_file', 'auto-edit'), false);
  assert.equal(requiresApproval('git_commit',  'auto-edit'), false);
  assert.equal(requiresApproval('run_command', 'auto-edit'), true);
});

test('requiresApproval: yolo passes everything', () => {
  assert.equal(requiresApproval('write_file',  'yolo'), false);
  assert.equal(requiresApproval('run_command', 'yolo'), false);
});

test('requiresApproval: unknown tool defaults to gated', () => {
  assert.equal(requiresApproval('made_up', 'yolo'), true);
});

// ── list_dir ─────────────────────────────────────────────────────────────

test('list_dir: lists root entries', async () => {
  fs.mkdirSync(path.join(ROOT, 'src'));
  fs.writeFileSync(path.join(ROOT, 'README.md'), 'x');
  const r = await runTool('list_dir', {}, { project: makeProject(ROOT) as any, permissions: 'read-only' });
  assert.equal(r.ok, true);
  if (r.ok) {
    const names = r.content.entries.map((e: any) => e.name);
    assert.ok(names.includes('src'));
    assert.ok(names.includes('README.md'));
  }
});

test('list_dir: skips heavy dirs', async () => {
  fs.mkdirSync(path.join(ROOT, 'node_modules'));
  fs.mkdirSync(path.join(ROOT, '.git'));
  fs.mkdirSync(path.join(ROOT, 'src'));
  const r = await runTool('list_dir', {}, { project: makeProject(ROOT) as any, permissions: 'read-only' });
  if (r.ok) {
    const names = r.content.entries.map((e: any) => e.name);
    assert.ok(!names.includes('node_modules'));
    assert.ok(!names.includes('.git'));
    assert.ok(names.includes('src'));
  }
});

test('list_dir: rejects path escape', async () => {
  const r = await runTool('list_dir', { path: '../escape' }, { project: makeProject(ROOT) as any, permissions: 'read-only' });
  assert.equal(r.ok, false);
});

// ── read_file ────────────────────────────────────────────────────────────

test('read_file: returns text content', async () => {
  fs.writeFileSync(path.join(ROOT, 'foo.txt'), 'hello');
  const r = await runTool('read_file', { path: 'foo.txt' }, { project: makeProject(ROOT) as any, permissions: 'read-only' });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.content.kind, 'text');
    assert.equal(r.content.text, 'hello');
  }
});

test('read_file: detects binary', async () => {
  fs.writeFileSync(path.join(ROOT, 'data.bin'), Buffer.from([0, 1, 2, 0xff]));
  const r = await runTool('read_file', { path: 'data.bin' }, { project: makeProject(ROOT) as any, permissions: 'read-only' });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.content.kind, 'binary');
});

test('read_file: range slicing', async () => {
  fs.writeFileSync(path.join(ROOT, 'big.txt'), 'abcdefghij');
  const r = await runTool('read_file', { path: 'big.txt', range: { start: 2, end: 5 } }, { project: makeProject(ROOT) as any, permissions: 'read-only' });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.content.text, 'cdef');
});

test('read_file: directory falls back to list_dir payload (no dead-end)', async () => {
  // Pre-fix calling read_file on a directory returned an error and
  // the agent often dead-ended on it (loop trace from the OOM repro:
  // the agent burned three turns retrying read_file('.') after each
  // hit the "use list_dir instead" error). Now the same call returns
  // a list_dir-shaped payload + a hint, so the agent can keep going
  // without the recovery turn.
  fs.writeFileSync(path.join(ROOT, 'one.md'), '');
  fs.writeFileSync(path.join(ROOT, 'two.md'), '');
  const r = await runTool('read_file', { path: '.' }, { project: makeProject(ROOT) as any, permissions: 'read-only' });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.content.kind, 'directory-fallback');
  assert.equal(r.content.entries.length, 2);
  const names = r.content.entries.map((e: any) => e.name).sort();
  assert.deepEqual(names, ['one.md', 'two.md']);
  assert.match(r.content.hint, /list_dir/);
});

test('read_file: directories fall back to list_dir (no longer rejects)', async () => {
  // Replaces the prior "rejects directories" test. read_file used to
  // return ok:false with "use list_dir instead"; now it self-heals
  // and returns the listing in the same call. Empty directory still
  // returns ok:true with kind:'directory-fallback' and zero entries.
  fs.mkdirSync(path.join(ROOT, 'd'));
  const r = await runTool('read_file', { path: 'd' }, { project: makeProject(ROOT) as any, permissions: 'read-only' });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.content.kind, 'directory-fallback');
  assert.deepEqual(r.content.entries, []);
});

// ── write_file ───────────────────────────────────────────────────────────

test('write_file: creates parent dirs', async () => {
  const r = await runTool('write_file', { path: 'a/b/c.txt', content: 'hello' }, { project: makeProject(ROOT) as any, permissions: 'auto-edit' });
  assert.equal(r.ok, true);
  assert.equal(fs.readFileSync(path.join(ROOT, 'a', 'b', 'c.txt'), 'utf8'), 'hello');
});

test('write_file: rejects content > 1 MB', async () => {
  const huge = 'x'.repeat(1024 * 1024 + 1);
  const r = await runTool('write_file', { path: 'huge.txt', content: huge }, { project: makeProject(ROOT) as any, permissions: 'auto-edit' });
  assert.equal(r.ok, false);
});

test('write_file: path-safety on absolute path', async () => {
  const r = await runTool('write_file', { path: '/tmp/escape.txt', content: 'oops' }, { project: makeProject(ROOT) as any, permissions: 'yolo' });
  assert.equal(r.ok, false);
});

// ── apply_patch ──────────────────────────────────────────────────────────

test('apply_patch: replaces unique substring', async () => {
  fs.writeFileSync(path.join(ROOT, 'a.txt'), 'before');
  const r = await runTool('apply_patch', { path: 'a.txt', search: 'before', replace: 'after' }, { project: makeProject(ROOT) as any, permissions: 'auto-edit' });
  assert.equal(r.ok, true);
  assert.equal(fs.readFileSync(path.join(ROOT, 'a.txt'), 'utf8'), 'after');
});

test('apply_patch: rejects ambiguous match', async () => {
  fs.writeFileSync(path.join(ROOT, 'a.txt'), 'foo foo foo');
  const r = await runTool('apply_patch', { path: 'a.txt', search: 'foo', replace: 'bar' }, { project: makeProject(ROOT) as any, permissions: 'auto-edit' });
  assert.equal(r.ok, false);
  assert.match(r.error!, /not unique/i);
});

test('apply_patch: rejects no-match', async () => {
  fs.writeFileSync(path.join(ROOT, 'a.txt'), 'hello');
  const r = await runTool('apply_patch', { path: 'a.txt', search: 'absent', replace: 'x' }, { project: makeProject(ROOT) as any, permissions: 'auto-edit' });
  assert.equal(r.ok, false);
});

// ── delete_file ──────────────────────────────────────────────────────────

test('delete_file: removes a file', async () => {
  fs.writeFileSync(path.join(ROOT, 'a.txt'), 'x');
  const r = await runTool('delete_file', { path: 'a.txt' }, { project: makeProject(ROOT) as any, permissions: 'auto-edit' });
  assert.equal(r.ok, true);
  assert.equal(fs.existsSync(path.join(ROOT, 'a.txt')), false);
});

test('delete_file: refuses directory', async () => {
  fs.mkdirSync(path.join(ROOT, 'd'));
  const r = await runTool('delete_file', { path: 'd' }, { project: makeProject(ROOT) as any, permissions: 'auto-edit' });
  assert.equal(r.ok, false);
});

// ── git tools (require an actual git repo) ───────────────────────────────

function gitInit(dir: string) {
  execSync('git init -b main', { cwd: dir, stdio: 'ignore' });
  // Force local identity + disable gpg signing for tests — CI
  // runners may have global signing on (which would fail without
  // a key configured in the sandbox).
  execSync('git config user.email "tests@nostr-station.local"', { cwd: dir });
  execSync('git config user.name  "tests"', { cwd: dir });
  execSync('git config commit.gpgsign false', { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), '# x');
  execSync('git add .', { cwd: dir });
  execSync('git -c commit.gpgsign=false commit -m "init"', { cwd: dir });
}

test('git_status: returns branch + hash', async () => {
  gitInit(ROOT);
  const r = await runTool('git_status', {}, { project: makeProject(ROOT, true) as any, permissions: 'read-only' });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.content.branch, 'main');
    assert.match(r.content.hash, /^[0-9a-f]{7,}$/);
  }
});

test('git_status: rejects when no git capability', async () => {
  const r = await runTool('git_status', {}, { project: makeProject(ROOT, false) as any, permissions: 'read-only' });
  assert.equal(r.ok, false);
});

test('git_log: returns commits with messages', async () => {
  gitInit(ROOT);
  const r = await runTool('git_log', { n: 5 }, { project: makeProject(ROOT, true) as any, permissions: 'read-only' });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.ok(r.content.commits.length >= 1);
    assert.equal(r.content.commits[0].message, 'init');
  }
});

test('git_diff: returns unified diff for unstaged changes', async () => {
  gitInit(ROOT);
  fs.writeFileSync(path.join(ROOT, 'README.md'), '# changed');
  const r = await runTool('git_diff', {}, { project: makeProject(ROOT, true) as any, permissions: 'read-only' });
  assert.equal(r.ok, true);
  if (r.ok) assert.match(r.content.diff, /\+# changed/);
});

test('git_commit: refuses when nothing to commit', async () => {
  gitInit(ROOT);
  const r = await runTool('git_commit', { message: 'noop' }, { project: makeProject(ROOT, true) as any, permissions: 'auto-edit' });
  assert.equal(r.ok, false);
  assert.match(r.error!, /nothing to commit/i);
});

test('git_commit: stages + commits paths', async () => {
  gitInit(ROOT);
  fs.writeFileSync(path.join(ROOT, 'new.txt'), 'hi');
  const r = await runTool('git_commit', { message: 'add new', paths: ['new.txt'] }, { project: makeProject(ROOT, true) as any, permissions: 'auto-edit' });
  assert.equal(r.ok, true);
  if (r.ok) assert.match(r.content.hash, /^[0-9a-f]{7,}$/);
});

// ── run_command ──────────────────────────────────────────────────────────

test('run_command: captures stdout', async () => {
  const r = await runTool('run_command', { argv: ['echo', 'hello'] }, { project: makeProject(ROOT) as any, permissions: 'yolo' });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.content.exitCode, 0);
    assert.match(r.content.stdout, /^hello/);
  }
});

test('run_command: captures stderr + non-zero exit', async () => {
  const r = await runTool('run_command', { argv: ['sh', '-c', 'echo err 1>&2; exit 3'] }, { project: makeProject(ROOT) as any, permissions: 'yolo' });
  // sh -c is itself an argv (not a shell injection — argv[0] is sh).
  // The denylist doesn't catch it; that's fine — we're testing exit
  // code propagation, not denylist coverage. (run_command's contract
  // is "argv only," not "no shell binary ever.")
  if (r.ok) {
    assert.equal(r.content.exitCode, 3);
    assert.match(r.content.stderr, /err/);
  }
});

test('run_command: refuses denylisted argv', async () => {
  const r = await runTool('run_command', { argv: ['rm', '-rf', '/some/path'] }, { project: makeProject(ROOT) as any, permissions: 'yolo' });
  assert.equal(r.ok, false);
  assert.match(r.error!, /destructive/i);
});

test('run_command: refuses curl', async () => {
  const r = await runTool('run_command', { argv: ['curl', 'https://example.com'] }, { project: makeProject(ROOT) as any, permissions: 'yolo' });
  assert.equal(r.ok, false);
});

test('run_command: rejects empty argv', async () => {
  const r = await runTool('run_command', { argv: [] }, { project: makeProject(ROOT) as any, permissions: 'yolo' });
  assert.equal(r.ok, false);
});

test('run_command: rejects non-string argv element', async () => {
  const r = await runTool('run_command', { argv: ['echo', 42 as any] }, { project: makeProject(ROOT) as any, permissions: 'yolo' });
  assert.equal(r.ok, false);
});

test('run_command: enforces timeout', async () => {
  const r = await runTool('run_command',
    { argv: ['sh', '-c', 'sleep 5'], timeoutMs: 200 },
    { project: makeProject(ROOT) as any, permissions: 'yolo' });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.content.timedOut, true);
});

// ── Dispatcher error handling ────────────────────────────────────────────

test('runTool: unknown tool name returns error envelope', async () => {
  const r = await runTool('made_up', {}, { project: makeProject(ROOT) as any, permissions: 'yolo' });
  assert.equal(r.ok, false);
  assert.match(r.error!, /unknown tool/i);
});
