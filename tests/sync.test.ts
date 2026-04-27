import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { useTempHome, resetTempHome } from './_home.js';

const HOME = useTempHome();

// @ts-expect-error — runtime import of .ts; tsx handles resolution
const sync = await import('../src/lib/sync.ts');
const {
  parseGitState,
  detectBackend,
  getProjectGitState,
  syncProject,
  snapshotProject,
} = sync;

beforeEach(() => resetTempHome(HOME));

// ── Test fixtures ─────────────────────────────────────────────────────────

interface ProjectShape {
  id:           string;
  name:         string;
  path:         string | null;
  capabilities: { git: boolean; ngit: boolean; nsite: boolean };
  identity:     { useDefault: boolean; npub: string | null; bunkerUrl: string | null };
  remotes:      { github: string | null; ngit: string | null };
  nsite:        { url: string | null; lastDeploy: string | null };
  readRelays:   string[] | null;
  createdAt:    string;
  updatedAt:    string;
}

function makeProject(overrides: Partial<ProjectShape>): ProjectShape {
  return {
    id:   'test-project-id',
    name: 'test',
    path: null,
    capabilities: { git: false, ngit: false, nsite: false },
    identity: { useDefault: true, npub: null, bunkerUrl: null },
    remotes:  { github: null, ngit: null },
    nsite:    { url: null, lastDeploy: null },
    readRelays: null,
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    ...overrides,
  };
}

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.com',
};

function makeRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, env: ENV });
  fs.writeFileSync(path.join(dir, 'README'), 'seed\n');
  execFileSync('git', ['add', '.'],                { cwd: dir, env: ENV });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir, env: ENV });
}

// Set up a "remote" bare repo + a clone tracking it. Returns paths.
function makeRepoWithRemote(name: string): { local: string; remote: string } {
  const remote = path.join(HOME, `${name}-remote.git`);
  const local  = path.join(HOME, name);
  execFileSync('git', ['init', '--bare', '-q', '-b', 'main', remote], { env: ENV });
  fs.mkdirSync(local, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: local, env: ENV });
  fs.writeFileSync(path.join(local, 'README'), 'seed\n');
  execFileSync('git', ['add', '.'],                            { cwd: local, env: ENV });
  execFileSync('git', ['commit', '-q', '-m', 'init'],          { cwd: local, env: ENV });
  execFileSync('git', ['remote', 'add', 'origin', remote],     { cwd: local, env: ENV });
  execFileSync('git', ['push', '-q', '-u', 'origin', 'main'],  { cwd: local, env: ENV });
  return { local, remote };
}

// ── parseGitState (pure) ──────────────────────────────────────────────────

test('parseGitState: clean repo with upstream → up to date', () => {
  const out = [
    '# branch.oid abcdef0',
    '# branch.head main',
    '# branch.upstream origin/main',
    '# branch.ab +0 -0',
    '',
  ].join('\n');
  const s = parseGitState(out, 'git');
  assert.equal(s.label, 'up to date');
  assert.equal(s.ahead, 0);
  assert.equal(s.behind, 0);
  assert.equal(s.dirty, false);
  assert.equal(s.diverged, false);
  assert.equal(s.branch, 'main');
  assert.equal(s.backend, 'git');
});

test('parseGitState: ahead-only renders as "N ahead"', () => {
  const out = [
    '# branch.head main',
    '# branch.ab +2 -0',
    '',
  ].join('\n');
  const s = parseGitState(out, 'git');
  assert.equal(s.label, '2 ahead');
  assert.equal(s.ahead, 2);
  assert.equal(s.behind, 0);
  assert.equal(s.diverged, false);
});

test('parseGitState: behind-only renders as "N behind"', () => {
  const out = '# branch.head main\n# branch.ab +0 -1\n';
  const s = parseGitState(out, 'git');
  assert.equal(s.label, '1 behind');
  assert.equal(s.ahead, 0);
  assert.equal(s.behind, 1);
});

test('parseGitState: ahead AND behind → diverged', () => {
  const out = '# branch.head main\n# branch.ab +1 -1\n';
  const s = parseGitState(out, 'git');
  assert.equal(s.label, 'diverged');
  assert.equal(s.diverged, true);
  assert.equal(s.ahead, 1);
  assert.equal(s.behind, 1);
});

test('parseGitState: any non-# line marks the tree dirty', () => {
  // Single untracked file is enough to flip the dirty flag — we don't
  // try to enumerate; the dashboard only needs the boolean.
  const out = [
    '# branch.head main',
    '# branch.ab +0 -0',
    '? newfile.txt',
    '',
  ].join('\n');
  const s = parseGitState(out, 'git');
  assert.equal(s.dirty, true);
  assert.equal(s.label, 'dirty');
});

test('parseGitState: dirty wins over ahead/diverged in the label', () => {
  // Priority is a behavioral contract — the user must see the local-
  // edit signal before the remote-relation signal because they can't
  // safely sync until they commit/stash. Pinned.
  const out = [
    '# branch.head main',
    '# branch.ab +1 -1',           // would be diverged
    '1 .M N... 100644 100644 100644 0 0 file.ts',  // dirty
    '',
  ].join('\n');
  const s = parseGitState(out, 'git');
  assert.equal(s.label, 'dirty');
  // ahead/behind are still reported on the object — only the label
  // priority changes.
  assert.equal(s.ahead, 1);
  assert.equal(s.behind, 1);
  assert.equal(s.diverged, true);
});

test('parseGitState: missing upstream → ahead/behind = 0', () => {
  // Just-initialized repo with one commit and no `git push -u`. There
  // is no `# branch.ab` line at all. Default 0/0 keeps the badge from
  // claiming a phantom remote relation.
  const out = '# branch.oid abc123\n# branch.head main\n';
  const s = parseGitState(out, 'git');
  assert.equal(s.ahead, 0);
  assert.equal(s.behind, 0);
  assert.equal(s.label, 'up to date');
});

test('parseGitState: detached HEAD surfaces "(detached)" as the branch', () => {
  const out = '# branch.oid abc\n# branch.head (detached)\n';
  const s = parseGitState(out, 'git');
  assert.equal(s.branch, '(detached)');
});

test('parseGitState: local-only backend zeroes ahead/behind even if upstream exists', () => {
  // Defensive — if a project is mis-classified (ngit/git=false but the
  // repo locally tracks an upstream), the badge should still reflect
  // "no remote story to tell" rather than a false "1 ahead".
  const out = '# branch.head main\n# branch.ab +1 -1\n';
  const s = parseGitState(out, 'local-only');
  assert.equal(s.ahead, 0);
  assert.equal(s.behind, 0);
  assert.equal(s.label, 'up to date');
  assert.equal(s.backend, 'local-only');
});

test('parseGitState: empty input → safe defaults', () => {
  const s = parseGitState('', 'git');
  assert.equal(s.label, 'up to date');
  assert.equal(s.ahead, 0);
  assert.equal(s.behind, 0);
  assert.equal(s.dirty, false);
  assert.equal(s.branch, '');
});

// ── detectBackend ─────────────────────────────────────────────────────────

test('detectBackend: capability flags map to the documented backend', () => {
  // ngit=true wins over git (ngit projects are ALSO git locally; the
  // dashboard treats ngit as the headline backend).
  assert.equal(
    detectBackend(makeProject({ capabilities: { git: true,  ngit: true,  nsite: false } })),
    'ngit',
  );
  assert.equal(
    detectBackend(makeProject({ capabilities: { git: true,  ngit: false, nsite: false } })),
    'git',
  );
  assert.equal(
    detectBackend(makeProject({ capabilities: { git: false, ngit: false, nsite: false } })),
    'local-only',
  );
});

// ── getProjectGitState (integration — real `git`) ─────────────────────────

test('getProjectGitState: clean fresh repo reports up to date', async () => {
  const repo = path.join(HOME, 'fresh');
  makeRepo(repo);
  const p = makeProject({
    path: repo,
    capabilities: { git: false, ngit: false, nsite: false },
  });
  const s = await getProjectGitState(p);
  assert.equal(s.label, 'up to date');
  assert.equal(s.dirty, false);
  assert.equal(s.backend, 'local-only');
});

test('getProjectGitState: untracked file flips dirty', async () => {
  const repo = path.join(HOME, 'dirty');
  makeRepo(repo);
  fs.writeFileSync(path.join(repo, 'untracked.txt'), 'x');
  const p = makeProject({
    path: repo,
    capabilities: { git: true, ngit: false, nsite: false },
  });
  const s = await getProjectGitState(p);
  assert.equal(s.dirty, true);
  assert.equal(s.label, 'dirty');
  assert.equal(s.backend, 'git');
});

test('getProjectGitState: 1 commit ahead of upstream renders as "1 ahead"', async () => {
  const { local } = makeRepoWithRemote('ahead');
  fs.writeFileSync(path.join(local, 'NEW'), 'work\n');
  execFileSync('git', ['add', '.'],                          { cwd: local, env: ENV });
  execFileSync('git', ['commit', '-q', '-m', 'local-edit'],  { cwd: local, env: ENV });

  const p = makeProject({
    path: local,
    capabilities: { git: true, ngit: false, nsite: false },
  });
  const s = await getProjectGitState(p);
  assert.equal(s.ahead, 1);
  assert.equal(s.behind, 0);
  assert.equal(s.label, '1 ahead');
});

test('getProjectGitState: missing path returns neutral state, not throw', async () => {
  const p = makeProject({ path: null });
  const s = await getProjectGitState(p);
  assert.equal(s.label, 'up to date');
  assert.equal(s.backend, 'local-only');
});

test('getProjectGitState: non-repo path returns neutral state', async () => {
  const notRepo = path.join(HOME, 'plain-dir');
  fs.mkdirSync(notRepo, { recursive: true });
  const p = makeProject({
    path: notRepo,
    capabilities: { git: true, ngit: false, nsite: false },
  });
  const s = await getProjectGitState(p);
  assert.equal(s.label, 'up to date');
  assert.equal(s.backend, 'git');
  // Branch is empty when git failed — distinguishable from a real
  // healthy repo where branch is at minimum 'main' / a real ref.
  assert.equal(s.branch, '');
});

// ── syncProject backend dispatch ─────────────────────────────────────────

test('syncProject: local-only short-circuits with no spawn', async () => {
  // Critical contract: local-only never invokes git/ngit. We pin it by
  // pointing path at a non-repo and asserting the success message —
  // any actual spawn would either error or produce different text.
  const p = makeProject({
    path: path.join(HOME, 'definitely-not-a-repo'),
    capabilities: { git: false, ngit: false, nsite: false },
  });
  const r = await syncProject(p);
  assert.equal(r.ok, true);
  assert.equal(r.backend, 'local-only');
  assert.match((r as any).message, /local-only project/);
});

test('syncProject: git backend with no remote → fetch failure surfaces actionable message', async () => {
  // No remote configured — `git fetch --all` succeeds in modern git
  // (treats no-remote as a no-op). Expect ok and a clean state.
  const repo = path.join(HOME, 'no-remote');
  makeRepo(repo);
  const p = makeProject({
    path: repo,
    capabilities: { git: true, ngit: false, nsite: false },
  });
  const r = await syncProject(p);
  // Either ok (no-remote fetch is a no-op) OR an actionable error —
  // both are acceptable; flag that we never crash and we always have a
  // human-readable message.
  assert.equal(typeof r.message, 'string');
  assert.ok(r.message.length > 0);
});

test('syncProject: ff-only behind → fast-forwards', async () => {
  const { local, remote } = makeRepoWithRemote('ffsync');

  // Push a new commit through a sibling clone so `local` legitimately
  // sees a behind state without us touching its working tree.
  const sibling = path.join(HOME, 'ffsync-sibling');
  execFileSync('git', ['clone', '-q', remote, sibling],         { env: ENV });
  fs.writeFileSync(path.join(sibling, 'NEW'), 'remote-edit\n');
  execFileSync('git', ['add', '.'],                             { cwd: sibling, env: ENV });
  execFileSync('git', ['commit', '-q', '-m', 'remote-edit'],    { cwd: sibling, env: ENV });
  execFileSync('git', ['push', '-q'],                           { cwd: sibling, env: ENV });

  const p = makeProject({
    path: local,
    capabilities: { git: true, ngit: false, nsite: false },
  });
  const r = await syncProject(p);
  assert.equal(r.ok, true);
  assert.equal(r.backend, 'git');
  assert.match(r.message, /fast-forwarded|already up to date/);

  // Confirm the new file landed locally — this is the actual ff effect.
  assert.equal(fs.existsSync(path.join(local, 'NEW')), true);
});

test('syncProject: dirty repo refuses with an actionable message', async () => {
  const { local } = makeRepoWithRemote('dirty-sync');
  fs.writeFileSync(path.join(local, 'WIP'), 'unfinished\n');
  // NOT staged — leaves the tree dirty so the sync precondition fails.

  const p = makeProject({
    path: local,
    capabilities: { git: true, ngit: false, nsite: false },
  });
  const r = await syncProject(p);
  assert.equal(r.ok, false);
  assert.match(r.message, /uncommitted|dirty|stash/i);
});

// ── snapshotProject ───────────────────────────────────────────────────────

test('snapshotProject: empty message falls back to ISO timestamp', async () => {
  const repo = path.join(HOME, 'snap-default');
  makeRepo(repo);
  fs.writeFileSync(path.join(repo, 'NEW'), 'work\n');

  const p = makeProject({
    path: repo,
    capabilities: { git: true, ngit: false, nsite: false },
  });
  const r = await snapshotProject(p, '');
  assert.equal(r.ok, true);
  assert.match(r.sha ?? '', /^[0-9a-f]{4,}$/);

  // Verify the commit message used the ISO timestamp fallback. A real
  // ISO 8601 has T and Z, so look for that shape in the log.
  const out = execFileSync('git', ['log', '-1', '--pretty=%s'],
    { cwd: repo, env: ENV }).toString().trim();
  assert.match(out, /^snapshot \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
});

test('snapshotProject: explicit message is preserved verbatim', async () => {
  const repo = path.join(HOME, 'snap-msg');
  makeRepo(repo);
  fs.writeFileSync(path.join(repo, 'NEW'), 'work\n');

  const p = makeProject({
    path: repo,
    capabilities: { git: true, ngit: false, nsite: false },
  });
  const r = await snapshotProject(p, 'WIP: trying a thing');
  assert.equal(r.ok, true);
  const out = execFileSync('git', ['log', '-1', '--pretty=%s'],
    { cwd: repo, env: ENV }).toString().trim();
  assert.equal(out, 'WIP: trying a thing');
});

test('snapshotProject: message with quotes / special chars round-trips safely (no shell)', async () => {
  // Whole point of using execFile + argv is that nothing here goes
  // through a shell. Pin that contract by passing a message that
  // would tear apart any naive `git commit -m "${msg}"` template.
  const repo = path.join(HOME, 'snap-unsafe');
  makeRepo(repo);
  fs.writeFileSync(path.join(repo, 'NEW'), 'x\n');

  const p = makeProject({
    path: repo,
    capabilities: { git: true, ngit: false, nsite: false },
  });
  const tricky = `oops "; rm -rf / # really`;
  const r = await snapshotProject(p, tricky);
  assert.equal(r.ok, true);
  const out = execFileSync('git', ['log', '-1', '--pretty=%s'],
    { cwd: repo, env: ENV }).toString().trim();
  assert.equal(out, tricky);
});

test('snapshotProject: no changes → ok with "nothing to commit" note', async () => {
  // Clicking save on a clean tree shouldn't surface a confusing
  // "git commit failed" — we treat the empty-commit case as a graceful
  // ok with a hint message in the error field.
  const repo = path.join(HOME, 'snap-clean');
  makeRepo(repo);

  const p = makeProject({
    path: repo,
    capabilities: { git: true, ngit: false, nsite: false },
  });
  const r = await snapshotProject(p, 'try-save');
  assert.equal(r.ok, true);
  assert.equal(r.error, 'nothing to commit');
});

test('snapshotProject: missing project.path → error', async () => {
  const p = makeProject({ path: null });
  const r = await snapshotProject(p, 'whatever');
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /no local path/i);
});

test('snapshotProject: trims whitespace-only message before falling back', async () => {
  // "   \n\t " is functionally empty — the fallback should fire so the
  // commit doesn't end up with a literal whitespace-only subject.
  const repo = path.join(HOME, 'snap-ws');
  makeRepo(repo);
  fs.writeFileSync(path.join(repo, 'NEW'), 'x\n');

  const p = makeProject({
    path: repo,
    capabilities: { git: true, ngit: false, nsite: false },
  });
  const r = await snapshotProject(p, '   \n\t ');
  assert.equal(r.ok, true);
  const out = execFileSync('git', ['log', '-1', '--pretty=%s'],
    { cwd: repo, env: ENV }).toString().trim();
  assert.match(out, /^snapshot \d{4}-\d{2}-\d{2}T/);
});
