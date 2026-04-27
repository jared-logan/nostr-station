import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { useTempHome, resetTempHome } from './_home.js';

const HOME = useTempHome();

// Import after HOME is pinned so the module's runtime homedir() lookups
// land in our tmpdir. projects.ts resolves paths per-call (not at load
// time), so static import would also work — but matching the ai-config
// pattern keeps both files uniform.
const {
  createProject,
  updateProject,
  deleteProject,
  readProjects,
  getProject,
  validateProjectPath,
  resolveSafeAbsolute,
  projectGitLog,
  // @ts-expect-error — imported at runtime, not checked against .d.ts
} = await import('../src/lib/projects.ts');

beforeEach(() => resetTempHome(HOME));

// All "valid path" fixtures live inside HOME so the B2 traversal guard
// in createProject / updateProject doesn't reject otherwise-good inputs.
// Helper centralizes the join + leaves room for future hardening (e.g.
// requiring the leaf's parent to exist).
function projInHome(name: string): string {
  return path.join(HOME, 'projects', name);
}

// ── Validation / creation branches ────────────────────────────────────────

test('createProject: rejects empty name', () => {
  const r = createProject({
    name: '',
    path: projInHome('proj'),
    capabilities: { git: false, ngit: false, nsite: false },
    identity: { useDefault: true, npub: null, bunkerUrl: null },
    remotes: { github: null, ngit: null },
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /name/i);
});

test('createProject: rejects zero-capability project with no path', () => {
  const r = createProject({
    name: 'orphan',
    path: null,
    capabilities: { git: false, ngit: false, nsite: false },
    identity: { useDefault: true, npub: null, bunkerUrl: null },
    remotes: { github: null, ngit: null },
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /path or a capability/i);
});

test('createProject: local-only (path, no caps) is valid', () => {
  const p = projInHome('local-only');
  const r = createProject({
    name: 'local-only',
    path: p,
    capabilities: { git: false, ngit: false, nsite: false },
    identity: { useDefault: true, npub: null, bunkerUrl: null },
    remotes: { github: null, ngit: null },
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.project.path, p);
    assert.equal(r.project.capabilities.git, false);
  }
});

test('createProject: git capability requires a local path', () => {
  const r = createProject({
    name: 'no-path-git',
    path: null,
    capabilities: { git: true, ngit: false, nsite: false },
    identity: { useDefault: true, npub: null, bunkerUrl: null },
    remotes: { github: 'https://github.com/x/y', ngit: null },
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /require a local path/i);
});

test('createProject: ngit capability requires a local path', () => {
  const r = createProject({
    name: 'no-path-ngit',
    path: null,
    capabilities: { git: false, ngit: true, nsite: false },
    identity: { useDefault: true, npub: null, bunkerUrl: null },
    remotes: { github: null, ngit: 'nostr://naddr1...' },
  });
  assert.equal(r.ok, false);
});

test('createProject: nsite-only (no path) is the documented exception', () => {
  const r = createProject({
    name: 'nsite-only',
    path: null,
    capabilities: { git: false, ngit: false, nsite: true },
    identity: { useDefault: true, npub: null, bunkerUrl: null },
    remotes: { github: null, ngit: null },
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.project.path, null);
    assert.equal(r.project.capabilities.nsite, true);
  }
});

// ── Path-collision guard ──────────────────────────────────────────────────

test('createProject: duplicate path is rejected with actionable error', () => {
  const dup = projInHome('dup-test');
  const first = createProject({
    name: 'orig',
    path: dup,
    capabilities: { git: true, ngit: false, nsite: false },
    identity: { useDefault: true, npub: null, bunkerUrl: null },
    remotes: { github: 'https://github.com/x/y', ngit: null },
  });
  assert.equal(first.ok, true);

  const second = createProject({
    name: 'same-path-different-name',
    path: dup,
    capabilities: { git: true, ngit: false, nsite: false },
    identity: { useDefault: true, npub: null, bunkerUrl: null },
    remotes: { github: null, ngit: null },
  });
  assert.equal(second.ok, false);
  if (!second.ok) {
    assert.match(second.error, /already exists/i);
    // Error must name the conflicting project so the user can locate it
    // in the UI — verified because users hit this during scaffold-then-
    // adopt flows where the dup looks like a bug.
    assert.match(second.error, /orig/);
  }
});

// ── Credential scrubbing ──────────────────────────────────────────────────

test('createProject: strips embedded basic-auth from git remote', () => {
  const r = createProject({
    name: 'with-creds',
    path: projInHome('with-creds'),
    capabilities: { git: true, ngit: false, nsite: false },
    identity: { useDefault: true, npub: null, bunkerUrl: null },
    remotes: {
      github: 'https://oauth2:ghp_SECRETTOKEN@github.com/owner/repo.git',
      ngit: null,
    },
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.project.remotes.github, 'https://github.com/owner/repo.git');
    // Explicit guard — easy to regress if someone edits stripCredentials.
    assert.doesNotMatch(r.project.remotes.github ?? '', /ghp_SECRETTOKEN/);
  }
});

// ── Identity ──────────────────────────────────────────────────────────────

test('createProject: custom identity requires valid npub', () => {
  const r = createProject({
    name: 'custom-id',
    path: projInHome('custom-id'),
    capabilities: { git: false, ngit: false, nsite: false },
    identity: { useDefault: false, npub: 'not-an-npub', bunkerUrl: null },
    remotes: { github: null, ngit: null },
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /npub must be/i);
});

test('createProject: custom identity rejects nsec', () => {
  const r = createProject({
    name: 'leaky',
    path: projInHome('leaky'),
    capabilities: { git: false, ngit: false, nsite: false },
    identity: { useDefault: false, npub: 'nsec1leakthisplease', bunkerUrl: null },
    remotes: { github: null, ngit: null },
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /nsec/i);
});

test('createProject: hex pubkey accepted for custom identity', () => {
  const r = createProject({
    name: 'hex-id',
    path: projInHome('hex-id'),
    capabilities: { git: false, ngit: false, nsite: false },
    identity: { useDefault: false, npub: 'a'.repeat(64), bunkerUrl: null },
    remotes: { github: null, ngit: null },
  });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.project.identity.npub, 'a'.repeat(64));
});

// ── updateProject ─────────────────────────────────────────────────────────

test('updateProject: toggling capability off clears its remote', () => {
  const created = createProject({
    name: 'toggle',
    path: projInHome('toggle'),
    capabilities: { git: true, ngit: false, nsite: false },
    identity: { useDefault: true, npub: null, bunkerUrl: null },
    remotes: { github: 'https://github.com/x/y', ngit: null },
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const updated = updateProject(created.project.id, {
    capabilities: { git: false, ngit: false, nsite: false },
  });
  // Zero-capability + path is a valid local-only shape, so the update
  // succeeds — the real invariant under test is that the github remote
  // gets cleared when its capability is turned off.
  assert.equal(updated.ok, true);
  if (updated.ok) {
    assert.equal(updated.project.remotes.github, null);
    assert.equal(updated.project.capabilities.git, false);
  }
});

test('updateProject: useDefault=true clears custom npub/bunker', () => {
  const created = createProject({
    name: 'custom-then-default',
    path: projInHome('custom-then-default'),
    capabilities: { git: false, ngit: false, nsite: false },
    identity: { useDefault: false, npub: 'a'.repeat(64), bunkerUrl: 'bunker://xyz' },
    remotes: { github: null, ngit: null },
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const updated = updateProject(created.project.id, {
    identity: { useDefault: true, npub: 'a'.repeat(64), bunkerUrl: 'bunker://xyz' },
  });
  assert.equal(updated.ok, true);
  if (updated.ok) {
    assert.equal(updated.project.identity.npub, null);
    assert.equal(updated.project.identity.bunkerUrl, null);
  }
});

test('updateProject: unknown id returns error', () => {
  const r = updateProject('does-not-exist', { name: 'new' });
  assert.equal(r.ok, false);
});

// ── deleteProject + registry round-trip ───────────────────────────────────

test('deleteProject: removes from registry', () => {
  const r = createProject({
    name: 'doomed',
    path: projInHome('doomed'),
    capabilities: { git: false, ngit: false, nsite: true },
    identity: { useDefault: true, npub: null, bunkerUrl: null },
    remotes: { github: null, ngit: null },
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;

  assert.equal(readProjects().length, 1);
  const d = deleteProject(r.project.id);
  assert.equal(d.ok, true);
  assert.equal(readProjects().length, 0);
  assert.equal(getProject(r.project.id), null);
});

test('readProjects: tolerates missing file', () => {
  assert.deepEqual(readProjects(), []);
});

// ── B2: path traversal ────────────────────────────────────────────────────
//
// Threat: client posts a project with `path` outside the user's home
// directory, server later reads README/CLAUDE/NOSTR_STATION.md from there
// into the chat system prompt — arbitrary file read via chat.

test('validateProjectPath: accepts a HOME-relative path that already exists', () => {
  const real = path.join(HOME, 'projects', 'real');
  fs.mkdirSync(real, { recursive: true });
  const out = validateProjectPath(real);
  // realpath may resolve /var/folders → /private/var/folders on macOS;
  // both sides are realpath'd internally so the relative check still works.
  assert.equal(typeof out, 'string');
  assert.equal(path.isAbsolute(out), true);
});

test('validateProjectPath: accepts a HOME-relative path that does NOT yet exist', () => {
  // createProject is invoked in the new-project flow on a path that may
  // not have been mkdir'd yet — the helper must walk up to the longest
  // existing ancestor (HOME itself, in this case) rather than throwing
  // on the missing leaf.
  const ghost = path.join(HOME, 'projects', 'never-mkdir-d', 'deep');
  const out = validateProjectPath(ghost);
  assert.equal(typeof out, 'string');
  assert.equal(path.isAbsolute(out), true);
});

test('validateProjectPath: rejects paths outside HOME (e.g. /etc)', () => {
  assert.throws(() => validateProjectPath('/etc'), /must be inside/i);
  assert.throws(() => validateProjectPath('/etc/passwd'), /must be inside/i);
});

test('validateProjectPath: rejects HOME itself', () => {
  assert.throws(() => validateProjectPath(HOME), /home directory itself/i);
});

test('validateProjectPath: rejects relative paths', () => {
  assert.throws(() => validateProjectPath('projects/foo'), /must be absolute/i);
  assert.throws(() => validateProjectPath('./foo'), /must be absolute/i);
  assert.throws(() => validateProjectPath('../etc'), /must be absolute/i);
});

test('validateProjectPath: rejects empty / non-string inputs', () => {
  assert.throws(() => validateProjectPath(''), /non-empty/i);
  assert.throws(() => validateProjectPath('   '), /non-empty/i);
  // @ts-expect-error — testing runtime behavior on bad types
  assert.throws(() => validateProjectPath(null), /must be a string/i);
  // @ts-expect-error
  assert.throws(() => validateProjectPath(undefined), /must be a string/i);
  // @ts-expect-error
  assert.throws(() => validateProjectPath(123), /must be a string/i);
});

test('validateProjectPath: rejects `..` traversal escaping HOME', () => {
  // path.resolve normalizes `..` early, so this collapses to a path
  // outside HOME before the helper even sees it. Pinned anyway because
  // it's the canonical attack shape.
  const escape = path.join(HOME, '..', 'jared-evil', 'secrets');
  assert.throws(() => validateProjectPath(escape), /must be inside/i);
});

test('validateProjectPath: rejects a HOME-prefix-collision path (no startsWith bug)', () => {
  // The classic bug: `homedir + path.sep` check catches `/home/jared/foo`
  // but `homedir.startsWith(other)` mistakenly accepts `/home/jared-evil`.
  // Our helper uses path.relative + `..` so siblings of HOME are rejected.
  const sibling = HOME + '-evil';
  // Don't mkdir — even a non-existent sibling must be rejected.
  assert.throws(() => validateProjectPath(path.join(sibling, 'x')), /must be inside/i);
});

test('validateProjectPath: rejects symlink that escapes HOME', () => {
  // realpath resolves the link, so the resolved path lives outside HOME
  // and the relative check catches it. Skipped on platforms where
  // symlink creation is restricted (Windows non-admin) — we're macOS/linux
  // for this project, so unconditional create is fine.
  const linkParent = path.join(HOME, 'links');
  fs.mkdirSync(linkParent, { recursive: true });
  const link = path.join(linkParent, 'escape');
  fs.symlinkSync('/tmp', link);
  assert.throws(() => validateProjectPath(link), /must be inside/i);
});

test('validateProjectPath: trims surrounding whitespace before validating', () => {
  const real = path.join(HOME, 'projects', 'whitespace');
  fs.mkdirSync(real, { recursive: true });
  // A stray newline from a clipboard-paste must not flip a valid path
  // into an invalid one.
  const out = validateProjectPath(`  ${real}\n`);
  assert.equal(typeof out, 'string');
});

test('createProject: rejects path outside HOME (B2)', () => {
  const r = createProject({
    name: 'evil',
    path: '/etc',
    capabilities: { git: false, ngit: false, nsite: false },
    identity: { useDefault: true, npub: null, bunkerUrl: null },
    remotes: { github: null, ngit: null },
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /must be inside/i);
});

test('createProject: rejects relative path (B2)', () => {
  const r = createProject({
    name: 'relative',
    path: 'foo/bar',
    capabilities: { git: false, ngit: false, nsite: false },
    identity: { useDefault: true, npub: null, bunkerUrl: null },
    remotes: { github: null, ngit: null },
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /must be absolute/i);
});

test('updateProject: rejects path patch that points outside HOME (B2)', () => {
  const created = createProject({
    name: 'patch-me',
    path: projInHome('patch-me'),
    capabilities: { git: false, ngit: false, nsite: false },
    identity: { useDefault: true, npub: null, bunkerUrl: null },
    remotes: { github: null, ngit: null },
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const updated = updateProject(created.project.id, { path: '/etc' });
  assert.equal(updated.ok, false);
  if (!updated.ok) assert.match(updated.error, /must be inside/i);
});

// ── B4: projectGitLog argv hygiene ────────────────────────────────────────
//
// Pre-B4 the git log call used a template-string into a shell. Now it goes
// through execFileSync with an argv array. Confidence test: seed a tiny
// repo, call projectGitLog, assert we get the commit metadata back.
// Locks the contract that the new no-shell invocation still parses.

function makeRepo(dir: string, commits: string[]): void {
  fs.mkdirSync(dir, { recursive: true });
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.com',
  };
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, env });
  // Seed one file so each subsequent commit has something to record.
  fs.writeFileSync(path.join(dir, 'README'), 'x');
  for (const msg of commits) {
    fs.appendFileSync(path.join(dir, 'README'), msg);
    execFileSync('git', ['add', '.'],                { cwd: dir, env });
    execFileSync('git', ['commit', '-q', '-m', msg], { cwd: dir, env });
  }
}

test('projectGitLog: returns parsed entries for a real repo', () => {
  const repo = path.join(HOME, 'projects', 'gitlog-real');
  makeRepo(repo, ['first', 'second']);
  const log = projectGitLog(repo);
  assert.equal(log.length, 2);
  assert.equal(log[0].message, 'second');
  assert.equal(log[1].message, 'first');
  assert.match(log[0].hash, /^[0-9a-f]{7,}$/);
  assert.equal(log[0].author, 'Test');
  assert.ok(log[0].timestamp > 0);
});

test('projectGitLog: respects the limit parameter', () => {
  const repo = path.join(HOME, 'projects', 'gitlog-limit');
  makeRepo(repo, ['a', 'b', 'c', 'd']);
  assert.equal(projectGitLog(repo, 2).length, 2);
  assert.equal(projectGitLog(repo, 4).length, 4);
});

test('projectGitLog: returns [] when path has no .git', () => {
  const not = path.join(HOME, 'projects', 'not-a-repo');
  fs.mkdirSync(not, { recursive: true });
  assert.deepEqual(projectGitLog(not), []);
});

test('projectGitLog: defensively coerces a non-numeric limit (no shell-injection surface)', () => {
  // The pre-B4 implementation interpolated `${limit}` into a shell command,
  // so a string limit like "5; rm -rf /" would have been disastrous. The
  // execFile-based replacement coerces to a clamped integer; this test
  // pins that behavior so a future caller passing user input through
  // doesn't reintroduce the gap.
  const repo = path.join(HOME, 'projects', 'gitlog-coerce');
  makeRepo(repo, ['only']);
  // @ts-expect-error — testing defensive coercion of bad input
  const out = projectGitLog(repo, '2; echo pwn');
  // Non-numeric → falls back to default 10. Tiny repo only has 1 commit.
  assert.equal(out.length, 1);
});

test('updateProject: a non-path patch does not retroactively reject a row', () => {
  // Defensive — the path validator runs only when patch.path is set, so
  // a name-only PATCH on an existing row succeeds even if (hypothetically)
  // the stored path failed the new validation.
  const created = createProject({
    name: 'rename-me',
    path: projInHome('rename-me'),
    capabilities: { git: false, ngit: false, nsite: false },
    identity: { useDefault: true, npub: null, bunkerUrl: null },
    remotes: { github: null, ngit: null },
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const updated = updateProject(created.project.id, { name: 'renamed' });
  assert.equal(updated.ok, true);
});
