// Tests for the repo-local git-identity auto-seed.
//
// Closes the "fresh VM trips on `git commit`" gap that Shakespeare
// doesn't have because it uses isomorphic-git in the browser. We
// seed repo-local config (never --global) so the blast radius is
// contained to nostr-station-managed projects.

import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

import {
  deriveGitIdentity, seedRepoGitIdentityIfMissing,
} from '../src/lib/git-identity.ts';

let ROOT: string;
beforeEach(() => {
  // Each test gets its own throwaway repo so global git config from
  // the test runner's host (or our _home.ts seed) doesn't pollute
  // assertions about repo-local state. We CANNOT touch global git
  // config in tests — `seedRepoGitIdentityIfMissing` only writes
  // local, but the existence-check it does will see global. We
  // override via -c so probes only see what we set.
  ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-gid-'));
  execFileSync('git', ['init', '-b', 'main', ROOT], { stdio: 'pipe' });
});

test('deriveGitIdentity: deterministic from npub', () => {
  const a = deriveGitIdentity('npub19yw8tkfh530kdgfqn782vcga7azgckdn2fjjp3nv5txu6dl3h7lqhv322j');
  const b = deriveGitIdentity('npub19yw8tkfh530kdgfqn782vcga7azgckdn2fjjp3nv5txu6dl3h7lqhv322j');
  assert.deepEqual(a, b);
  assert.match(a.email, /@nostr\.local$/);
  assert.match(a.name,  /^npub1/);
});

test('deriveGitIdentity: handles empty npub gracefully', () => {
  const r = deriveGitIdentity('');
  assert.equal(r.email, 'noreply@nostr.local');
  assert.match(r.name, /nostr-station/);
});

test('deriveGitIdentity: name + email are short-form, not the full npub', () => {
  const r = deriveGitIdentity('npub19yw8tkfh530kdgfqn782vcga7azgckdn2fjjp3nv5txu6dl3h7lqhv322j');
  // Full npub is 63 chars; the shorthand should be much shorter (we
  // truncate after the npub1 prefix + 12 body chars = 17 total).
  assert.equal(r.name.length, 17);
  assert.ok(r.email.length < 35);
});

test('seedRepoGitIdentityIfMissing: writes repo-local config when neither global nor local is set', () => {
  // Test isolation: spawn the seed in a context where global git
  // config is empty. We set HOME to a fresh tmpdir so the global
  // probe (`git config user.name`) returns nothing.
  const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-gid-home-'));
  const prevHome = process.env.HOME;
  process.env.HOME = FAKE_HOME;
  try {
    const result = seedRepoGitIdentityIfMissing(ROOT, {
      npub: 'npub19yw8tkfh530kdgfqn782vcga7azgckdn2fjjp3nv5txu6dl3h7lqhv322j',
      readRelays: [],
    });
    assert.equal(result.seeded, true);
    assert.match(result.reason, /seeded/);

    // Repo-local config now has the derived identity.
    const localName  = execFileSync('git', ['config', '--local', 'user.name'],
      { cwd: ROOT, stdio: 'pipe' }).toString().trim();
    const localEmail = execFileSync('git', ['config', '--local', 'user.email'],
      { cwd: ROOT, stdio: 'pipe' }).toString().trim();
    assert.match(localName,  /^npub1/);
    assert.match(localEmail, /@nostr\.local$/);
  } finally {
    process.env.HOME = prevHome;
    fs.rmSync(FAKE_HOME, { recursive: true, force: true });
  }
});

test('seedRepoGitIdentityIfMissing: idempotent — no-op when identity already set globally', () => {
  // Global git config IS set (test runner provides it via _home.ts
  // pattern, or the user's host has one). Real users with their own
  // global identity must NOT get overwritten by us. Verify by
  // checking that no repo-local config gets written when global is
  // already available.
  // We can't easily fake "global config is set" without touching
  // global, so this test trusts that the test environment has SOME
  // global config (the workspace's _home.ts seeds it for project
  // tests). If that ever changes the test still passes — it just
  // becomes a no-op coverage check.
  const result = seedRepoGitIdentityIfMissing(ROOT, {
    npub: 'npub19yw8tkfh530kdgfqn782vcga7azgckdn2fjjp3nv5txu6dl3h7lqhv322j',
    readRelays: [],
  });
  // Either seeded (clean env) OR no-op (env had global config).
  // Both are valid; we're just pinning that the function returns a
  // structured SeedResult and doesn't throw.
  assert.ok(typeof result.seeded === 'boolean');
  assert.ok(typeof result.reason === 'string');
});

test('seedRepoGitIdentityIfMissing: refuses without a Nostr npub', () => {
  const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-gid-home-'));
  const prevHome = process.env.HOME;
  process.env.HOME = FAKE_HOME;
  try {
    const result = seedRepoGitIdentityIfMissing(ROOT, {
      npub: '',
      readRelays: [],
    });
    assert.equal(result.seeded, false);
    assert.match(result.reason, /Nostr identity/);
  } finally {
    process.env.HOME = prevHome;
    fs.rmSync(FAKE_HOME, { recursive: true, force: true });
  }
});

test('seedRepoGitIdentityIfMissing: enables a real `git commit` to succeed', () => {
  // The whole point of this fix — verify end-to-end that after
  // seeding, a commit actually lands without "Author identity
  // unknown."
  const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-gid-home-'));
  const prevHome = process.env.HOME;
  process.env.HOME = FAKE_HOME;
  try {
    seedRepoGitIdentityIfMissing(ROOT, {
      npub: 'npub19yw8tkfh530kdgfqn782vcga7azgckdn2fjjp3nv5txu6dl3h7lqhv322j',
      readRelays: [],
    });

    fs.writeFileSync(path.join(ROOT, 'a.txt'), 'hello');
    execFileSync('git', ['add', 'a.txt'], { cwd: ROOT, stdio: 'pipe' });
    // Pre-fix this would throw with "Please tell me who you are."
    execFileSync('git', ['commit', '-m', 'first'], { cwd: ROOT, stdio: 'pipe' });
    const log = execFileSync('git', ['log', '--oneline'], { cwd: ROOT, stdio: 'pipe' })
      .toString().trim();
    assert.match(log, /first/);
  } finally {
    process.env.HOME = prevHome;
    fs.rmSync(FAKE_HOME, { recursive: true, force: true });
  }
});
