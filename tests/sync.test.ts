// Tests for src/lib/sync.ts — the git-state parser, the background
// remote-refresh loop (fetch + auto-pull), the per-project repo lock,
// and the never-dead-end recovery primitives (mergeRemote, rescueBranch,
// checkoutBranch).
//
// Fixture model: makeRepoPair builds a bare "remote" plus two clones.
// Clone A plays the nostr-station project; clone B plays the other
// client (shakespeare.diy, a second machine) whose pushes the station
// must notice.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { useTempHome } from './_home.js';

const HOME = useTempHome();

const {
  parseGitState, getProjectGitState,
  refreshRemoteState, resetRemoteRefreshState, setActiveSessionProbe,
  withRepoLock, mergeRemote, rescueBranch, checkoutBranch,
  snapshotProject,
} = await import('../src/lib/sync.js');
const { updateProject, createProject } = await import('../src/lib/projects.js');
import type { Project } from '../src/lib/projects.js';

// ── Fixture helpers ────────────────────────────────────────────────────────

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.com',
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] })
    .toString().trim();
}

function commitFile(repo: string, file: string, content: string, msg: string): void {
  fs.writeFileSync(path.join(repo, file), content);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', msg);
}

// Bare remote + two clones, with one seed commit pushed from A so both
// clones share history and origin/HEAD is set in A.
function makeRepoPair(name: string): { bare: string; a: string; b: string } {
  const bare = path.join(HOME, `${name}-remote.git`);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { env: GIT_ENV });
  const a = path.join(HOME, `${name}-a`);
  execFileSync('git', ['clone', '-q', bare, a], { env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
  git(a, 'checkout', '-q', '-B', 'main');
  commitFile(a, 'README', 'seed\n', 'seed');
  git(a, 'push', '-q', '-u', 'origin', 'main');
  git(a, 'remote', 'set-head', 'origin', 'main');
  const b = path.join(HOME, `${name}-b`);
  execFileSync('git', ['clone', '-q', bare, b], { env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
  return { bare, a, b };
}

function proj(repoPath: string, extra: Partial<Project> = {}): Project {
  return {
    id:           extra.id ?? crypto.randomBytes(8).toString('hex'),
    name:         'sync-test',
    path:         repoPath,
    capabilities: { git: true, ngit: false, nsite: false },
    identity:     { useDefault: true, npub: null, bunkerUrl: null },
    remotes:      { github: null, ngit: null },
    nsite:        { url: null, lastDeploy: null },
    readRelays:   null,
    createdAt:    new Date().toISOString(),
    updatedAt:    new Date().toISOString(),
    ...extra,
  };
}

// ── parseGitState (pure) ───────────────────────────────────────────────────

test('parseGitState: clean repo with upstream', () => {
  const out = [
    '# branch.oid abc123',
    '# branch.head main',
    '# branch.upstream origin/main',
    '# branch.ab +0 -0',
  ].join('\n');
  const s = parseGitState(out, 'git');
  assert.deepEqual(
    { ahead: s.ahead, behind: s.behind, dirty: s.dirty, diverged: s.diverged, branch: s.branch, label: s.label },
    { ahead: 0, behind: 0, dirty: false, diverged: false, branch: 'main', label: 'up to date' },
  );
});

test('parseGitState: ahead / behind / diverged', () => {
  const mk = (ab: string) => parseGitState(
    `# branch.head main\n# branch.upstream origin/main\n# branch.ab ${ab}`, 'git');
  const ahead = mk('+2 -0');
  assert.equal(ahead.ahead, 2);
  assert.equal(ahead.label, '2 ahead');
  const behind = mk('+0 -3');
  assert.equal(behind.behind, 3);
  assert.equal(behind.label, '3 behind');
  const div = mk('+1 -2');
  assert.equal(div.diverged, true);
  assert.equal(div.label, 'diverged');
});

test('parseGitState: any non-# line marks dirty, and dirty outranks counts', () => {
  for (const line of ['1 .M N... 100644 100644 100644 a b file.txt', '? new-file', 'u UU ...']) {
    const s = parseGitState(`# branch.head main\n# branch.ab +1 -1\n${line}`, 'git');
    assert.equal(s.dirty, true, `line "${line}" should mark dirty`);
    assert.equal(s.label, 'dirty');
  }
});

test('parseGitState: detached HEAD token is preserved verbatim', () => {
  const s = parseGitState('# branch.oid abc\n# branch.head (detached)', 'git');
  assert.equal(s.branch, '(detached)');
});

test('parseGitState: no branch.ab line (no upstream) → zero counts', () => {
  const s = parseGitState('# branch.oid abc\n# branch.head feat', 'git');
  assert.equal(s.ahead, 0);
  assert.equal(s.behind, 0);
  assert.equal(s.label, 'up to date');
});

test('parseGitState: local-only backend zeroes ahead/behind', () => {
  const s = parseGitState('# branch.head main\n# branch.ab +4 -2', 'local-only');
  assert.equal(s.ahead, 0);
  assert.equal(s.behind, 0);
});

test('parseGitState: garbage input degrades to clean defaults', () => {
  const s = parseGitState('not porcelain at all', 'git');
  assert.equal(s.dirty, true); // a non-# line is, by contract, a change
  assert.equal(parseGitState('', 'git').label, 'up to date');
});

// ── withRepoLock ───────────────────────────────────────────────────────────

test('withRepoLock: serializes concurrent ops per project', async () => {
  const order: string[] = [];
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
  const first = withRepoLock('lock-test', async () => {
    order.push('a-start'); await sleep(50); order.push('a-end');
  });
  const second = withRepoLock('lock-test', async () => {
    order.push('b-start'); await sleep(10); order.push('b-end');
  });
  await Promise.all([first, second]);
  assert.deepEqual(order, ['a-start', 'a-end', 'b-start', 'b-end']);
});

test('withRepoLock: a rejected op does not wedge the next waiter', async () => {
  await assert.rejects(withRepoLock('lock-rej', async () => { throw new Error('boom'); }));
  const r = await withRepoLock('lock-rej', async () => 'ran');
  assert.equal(r, 'ran');
});

// ── The stale-badge incident, reproduced and fixed ────────────────────────

test('git-state is stale until refreshRemoteState fetches (the incident)', async () => {
  resetRemoteRefreshState();
  const { a, b } = makeRepoPair('stale');
  const p = proj(a);

  // Another client pushes…
  commitFile(b, 'from-b.txt', 'hello\n', 'pushed elsewhere');
  git(b, 'push', '-q', 'origin', 'main');

  // …and without a fetch the station's state says "in sync" — the lie.
  const before = await getProjectGitState(p);
  assert.equal(before.behind, 0, 'documents the pre-fix blind spot');

  // A forced refresh fetches; auto-pull then fast-forwards (clean repo),
  // so the project lands back in true sync rather than just "1 behind".
  const r = await refreshRemoteState(p, { force: true });
  assert.equal(r.fetched, true);
  assert.equal(r.autoPulled?.commits, 1);
  assert.equal(git(a, 'rev-parse', 'HEAD'), git(a, 'rev-parse', 'origin/main'));

  const after = await getProjectGitState(p);
  assert.equal(after.behind, 0);
  assert.ok(after.fetchedAt && after.fetchedAt > 0, 'freshness stamp surfaces on git-state');
  assert.equal(after.autoPulled?.commits, 1);
});

test('refreshRemoteState: TTL suppresses immediate re-fetch; force bypasses', async () => {
  resetRemoteRefreshState();
  const { a, b } = makeRepoPair('ttl');
  const p = proj(a, { autoPull: false }); // isolate fetch behavior from auto-pull

  assert.equal((await refreshRemoteState(p, { force: true })).fetched, true);

  commitFile(b, 'x.txt', 'x\n', 'newer');
  git(b, 'push', '-q', 'origin', 'main');

  // Within the TTL a non-forced refresh is a no-op…
  assert.equal((await refreshRemoteState(p)).fetched, false);
  assert.equal((await getProjectGitState(p)).behind, 0);

  // …while force fetches and the truth lands.
  assert.equal((await refreshRemoteState(p, { force: true })).fetched, true);
  assert.equal((await getProjectGitState(p)).behind, 1);
});

test('refreshRemoteState: a dead remote reports an error, never throws', async () => {
  resetRemoteRefreshState();
  const { a } = makeRepoPair('dead');
  git(a, 'remote', 'set-url', 'origin', path.join(HOME, 'no-such-remote.git'));
  const p = proj(a);
  const r = await refreshRemoteState(p, { force: true });
  assert.equal(r.fetched, false);
  assert.ok(r.error, 'failure is reported, not thrown');
  const state = await getProjectGitState(p);
  assert.ok(state.fetchError, 'fetch failure surfaces on git-state');
});

test('refreshRemoteState: local-only and remoteless repos are quiet no-ops', async () => {
  resetRemoteRefreshState();
  const repo = path.join(HOME, 'no-remote');
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  const p = proj(repo);
  const r = await refreshRemoteState(p, { force: true });
  assert.equal(r.fetched, false);
  assert.equal(r.error, undefined);
  const localOnly = proj(repo, { capabilities: { git: false, ngit: false, nsite: false } });
  assert.equal((await refreshRemoteState(localOnly, { force: true })).fetched, false);
});

// ── Auto-pull guards ───────────────────────────────────────────────────────

test('auto-pull: skipped while the working tree is dirty', async () => {
  resetRemoteRefreshState();
  const { a, b } = makeRepoPair('dirty-guard');
  commitFile(b, 'y.txt', 'y\n', 'remote moves');
  git(b, 'push', '-q', 'origin', 'main');
  fs.writeFileSync(path.join(a, 'wip.txt'), 'uncommitted\n');

  const r = await refreshRemoteState(proj(a), { force: true });
  assert.equal(r.fetched, true);
  assert.equal(r.autoPulled, undefined);
  const s = await getProjectGitState(proj(a));
  assert.equal(s.behind, 1, 'badge shows behind; nothing was merged');
  assert.equal(s.dirty, true);
});

test('auto-pull: skipped when local is ahead (incl. diverged)', async () => {
  resetRemoteRefreshState();
  const { a, b } = makeRepoPair('ahead-guard');
  commitFile(a, 'local.txt', 'mine\n', 'local work');
  commitFile(b, 'remote.txt', 'theirs\n', 'remote work');
  git(b, 'push', '-q', 'origin', 'main');

  const r = await refreshRemoteState(proj(a), { force: true });
  assert.equal(r.fetched, true);
  assert.equal(r.autoPulled, undefined);
  const s = await getProjectGitState(proj(a));
  assert.equal(s.diverged, true);
});

test('auto-pull: respects the per-project autoPull:false opt-out', async () => {
  resetRemoteRefreshState();
  const { a, b } = makeRepoPair('optout');
  commitFile(b, 'z.txt', 'z\n', 'remote moves');
  git(b, 'push', '-q', 'origin', 'main');

  const r = await refreshRemoteState(proj(a, { autoPull: false }), { force: true });
  assert.equal(r.fetched, true);
  assert.equal(r.autoPulled, undefined);
  assert.equal((await getProjectGitState(proj(a))).behind, 1);
});

test('auto-pull: skipped while a project-bound terminal session is alive', async () => {
  resetRemoteRefreshState();
  const { a, b } = makeRepoPair('pty-guard');
  commitFile(b, 'w.txt', 'w\n', 'remote moves');
  git(b, 'push', '-q', 'origin', 'main');

  const p = proj(a);
  setActiveSessionProbe((id) => id === p.id);
  try {
    const r = await refreshRemoteState(p, { force: true });
    assert.equal(r.fetched, true, 'fetch itself is always safe');
    assert.equal(r.autoPulled, undefined, 'but HEAD must not move under a live PTY');
  } finally {
    setActiveSessionProbe(() => false);
  }
  // With the session gone the next refresh fast-forwards.
  const r2 = await refreshRemoteState(p, { force: true });
  assert.equal(r2.autoPulled?.commits, 1);
});

test('auto-pull: skipped on a detached HEAD', async () => {
  resetRemoteRefreshState();
  const { a, b } = makeRepoPair('detached');
  git(a, 'checkout', '-q', '--detach', 'HEAD');
  commitFile(b, 'd.txt', 'd\n', 'remote moves');
  git(b, 'push', '-q', 'origin', 'main');

  const r = await refreshRemoteState(proj(a), { force: true });
  assert.equal(r.fetched, true);
  assert.equal(r.autoPulled, undefined);
});

// ── mergeRemote (diverged recovery) ───────────────────────────────────────

test('mergeRemote: combines non-conflicting divergence with a merge commit', async () => {
  resetRemoteRefreshState();
  const { a, b } = makeRepoPair('merge-ok');
  commitFile(a, 'ours.txt', 'ours\n', 'local commit');
  commitFile(b, 'theirs.txt', 'theirs\n', 'remote commit');
  git(b, 'push', '-q', 'origin', 'main');

  const r = await mergeRemote(proj(a));
  assert.equal(r.ok, true);
  assert.equal(r.conflict, undefined);
  // Remote tip is now an ancestor of HEAD and the tree is clean.
  git(a, 'merge-base', '--is-ancestor', 'origin/main', 'HEAD');
  assert.equal(git(a, 'status', '--porcelain'), '');
  assert.ok(fs.existsSync(path.join(a, 'ours.txt')));
  assert.ok(fs.existsSync(path.join(a, 'theirs.txt')));
});

test('mergeRemote: conflicts abort cleanly and report conflict:true', async () => {
  resetRemoteRefreshState();
  const { a, b } = makeRepoPair('merge-conflict');
  commitFile(a, 'README', 'local version\n', 'local change');
  commitFile(b, 'README', 'remote version\n', 'remote change');
  git(b, 'push', '-q', 'origin', 'main');

  const localHead = git(a, 'rev-parse', 'HEAD');
  const r = await mergeRemote(proj(a));
  assert.equal(r.ok, false);
  assert.equal(r.conflict, true);
  assert.ok(!fs.existsSync(path.join(a, '.git', 'MERGE_HEAD')), 'merge fully aborted');
  assert.equal(git(a, 'status', '--porcelain'), '', 'tree restored');
  assert.equal(git(a, 'rev-parse', 'HEAD'), localHead, 'local commit intact');
});

test('mergeRemote: self-heals a repo stuck mid-merge (stale MERGE_HEAD)', async () => {
  resetRemoteRefreshState();
  const { a, b } = makeRepoPair('merge-stuck');
  commitFile(a, 'README', 'local version\n', 'local change');
  commitFile(b, 'README', 'remote version\n', 'remote change');
  git(b, 'push', '-q', 'origin', 'main');

  // Wedge the repo the way a crash mid-merge would.
  git(a, 'fetch', '-q', 'origin');
  try { git(a, 'merge', 'origin/main'); } catch { /* expected conflict */ }
  assert.ok(fs.existsSync(path.join(a, '.git', 'MERGE_HEAD')), 'precondition: stuck');

  const r = await mergeRemote(proj(a));
  assert.equal(r.ok, false);
  assert.equal(r.conflict, true);
  assert.ok(!fs.existsSync(path.join(a, '.git', 'MERGE_HEAD')));
  assert.equal(git(a, 'status', '--porcelain'), '');
});

test('mergeRemote: refuses a dirty tree; fast-forwards a plain behind', async () => {
  resetRemoteRefreshState();
  const { a, b } = makeRepoPair('merge-misc');
  commitFile(b, 'n.txt', 'n\n', 'remote moves');
  git(b, 'push', '-q', 'origin', 'main');

  fs.writeFileSync(path.join(a, 'wip.txt'), 'wip\n');
  const dirty = await mergeRemote(proj(a, { autoPull: false }));
  assert.equal(dirty.ok, false);
  assert.match(dirty.message, /uncommitted/i);

  fs.rmSync(path.join(a, 'wip.txt'));
  const ff = await mergeRemote(proj(a, { autoPull: false }));
  assert.equal(ff.ok, true);
  assert.match(ff.message, /fast-forwarded/i);
  assert.equal(git(a, 'rev-parse', 'HEAD'), git(a, 'rev-parse', 'origin/main'));
});

// ── rescueBranch + checkoutBranch ─────────────────────────────────────────

test('rescueBranch: parks local work on a branch and resets to upstream', async () => {
  resetRemoteRefreshState();
  const { a, b } = makeRepoPair('rescue');
  commitFile(a, 'README', 'local version\n', 'conflicting local work');
  const localHead = git(a, 'rev-parse', 'HEAD');
  commitFile(b, 'README', 'remote version\n', 'remote change');
  git(b, 'push', '-q', 'origin', 'main');
  git(a, 'fetch', '-q', 'origin');

  const lines: string[] = [];
  const r = await rescueBranch(proj(a), 'my-rescue', (l) => lines.push(l));
  assert.equal(r.ok, true, r.message);
  assert.equal(r.branch, 'my-rescue');
  assert.equal(git(a, 'rev-parse', '--abbrev-ref', 'HEAD'), 'my-rescue', 'user lands ON their work');
  assert.equal(git(a, 'rev-parse', 'my-rescue'), localHead, 'commits preserved');
  assert.equal(git(a, 'rev-parse', 'main'), git(a, 'rev-parse', 'origin/main'), 'main matches remote');
  assert.ok(lines.some(l => l.includes('git branch my-rescue')), 'streams its steps');

  // Branch awareness: the off-default chip's data is on git-state now.
  const s = await getProjectGitState(proj(a));
  assert.equal(s.offDefault, true);
  assert.equal(s.defaultBranch, 'main');
  assert.equal(s.aheadOfDefault, 1);

  // And "Back to main" is one guarded checkout away.
  const back = await checkoutBranch(proj(a), 'main');
  assert.equal(back.ok, true);
  assert.equal(git(a, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  assert.equal((await getProjectGitState(proj(a))).offDefault, false);
});

test('rescueBranch: rejects bad names, existing branches, and dirty trees', async () => {
  resetRemoteRefreshState();
  const { a } = makeRepoPair('rescue-guards');
  assert.equal((await rescueBranch(proj(a), '-flag')).ok, false);
  assert.equal((await rescueBranch(proj(a), 'main')).ok, false);
  fs.writeFileSync(path.join(a, 'wip.txt'), 'wip\n');
  const dirty = await rescueBranch(proj(a), 'fine-name');
  assert.equal(dirty.ok, false);
  assert.match(dirty.message, /uncommitted/i);
});

test('checkoutBranch: refuses dirty trees and unknown branches', async () => {
  resetRemoteRefreshState();
  const { a } = makeRepoPair('co-guards');
  assert.equal((await checkoutBranch(proj(a), 'nope')).ok, false);
  git(a, 'branch', 'other');
  fs.writeFileSync(path.join(a, 'wip.txt'), 'wip\n');
  const dirty = await checkoutBranch(proj(a), 'other');
  assert.equal(dirty.ok, false);
  assert.match(dirty.message, /uncommitted/i);
});

// ── Branch awareness extras on git-state ──────────────────────────────────

test('git-state: detached HEAD sets detached, not offDefault', async () => {
  resetRemoteRefreshState();
  const { a } = makeRepoPair('detached-state');
  git(a, 'checkout', '-q', '--detach', 'HEAD');
  const s = await getProjectGitState(proj(a));
  assert.equal(s.detached, true);
  assert.equal(s.offDefault, false);
});

test('git-state: local-only backend carries no branch-awareness fields', async () => {
  resetRemoteRefreshState();
  const repo = path.join(HOME, 'local-only-state');
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'scratch');
  const p = proj(repo, { capabilities: { git: false, ngit: false, nsite: false } });
  const s = await getProjectGitState(p);
  assert.equal(s.offDefault, undefined);
  assert.equal(s.defaultBranch, undefined);
});

// ── snapshot still works under the lock ───────────────────────────────────

test('snapshotProject: commits through the repo lock', async () => {
  resetRemoteRefreshState();
  const { a } = makeRepoPair('snap');
  fs.writeFileSync(path.join(a, 'new.txt'), 'content\n');
  const r = await snapshotProject(proj(a), 'test snapshot');
  assert.equal(r.ok, true);
  assert.match(r.sha ?? '', /^[0-9a-f]{4,}$/);
});

// ── autoPull persists through the registry PATCH path ─────────────────────

test('updateProject: autoPull round-trips (and absent means default-on)', () => {
  const dir = path.join(HOME, 'projects', 'autopull-roundtrip');
  fs.mkdirSync(dir, { recursive: true });
  const created = createProject({
    name: 'autopull-rt', path: dir,
    capabilities: { git: true, ngit: false, nsite: false },
    identity:     { useDefault: true, npub: null, bunkerUrl: null },
    remotes:      { github: null, ngit: null },
  } as any);
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.equal(created.project.autoPull, undefined, 'absent by default = auto-pull on');

  const off = updateProject(created.project.id, { autoPull: false });
  assert.equal(off.ok, true);
  if (off.ok) assert.equal(off.project.autoPull, false);

  const on = updateProject(created.project.id, { autoPull: true });
  assert.equal(on.ok, true);
  if (on.ok) assert.equal(on.project.autoPull, true);
});
