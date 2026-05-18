// Per-project .nostr-station/ directory tests — verify the seed flow,
// read/write helpers, and back-compat read of root-level
// project-context.md. HOME pinned to a tmpdir so the project record
// (in projects.json) doesn't leak.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { useTempHome, resetTempHome } from './_home.js';

const HOME = useTempHome();

const {
  ensureConfigDir, ensureUserConfigDir, seedProjectConfig,
  readSystemPromptOverride, writeSystemPromptOverride,
  readProjectContextOverlay, writeProjectContextOverlay,
  readProjectTemplate, writeProjectTemplate,
  readProjectPermissions, writeProjectPermissions,
  readProjectChatOverride, writeProjectChatOverride,
  deleteProjectPermissions, deleteProjectChatOverride,
  readProjectAiConfig, legacyLocalFiles,
  isOrphanGitignore, detectNsecsInHistory,
  userConfigDirFor,
  CONFIG_DIRNAME,
} = await import('../src/lib/project-config.js');

const { BUILTINS } = await import('../src/lib/templates.js');

// Build a minimal Project shape for the helpers — they only read .path.
function makeProject(overrides: any = {}) {
  return {
    id:           'test-id',
    name:         'test',
    path:         null,
    capabilities: { git: false, ngit: false, nsite: false },
    identity:     { useDefault: true, npub: null, bunkerUrl: null },
    remotes:      { github: null, ngit: null },
    nsite:        { url: null, lastDeploy: null },
    readRelays:   null,
    createdAt:    new Date().toISOString(),
    updatedAt:    new Date().toISOString(),
    ...overrides,
  };
}

function makeProjectDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-proj-'));
  return dir;
}

beforeEach(() => resetTempHome(HOME));

// ── ensureConfigDir + ensureUserConfigDir ────────────────────────────────

test('ensureConfigDir: creates the shareable dir but no longer writes .gitignore', () => {
  const dir = makeProjectDir();
  const project = makeProject({ path: dir });
  const created = ensureConfigDir(project);
  assert.equal(created, path.join(dir, CONFIG_DIRNAME));
  assert.ok(fs.statSync(created!).isDirectory());
  // Auto-managed .gitignore is gone — the files it used to ignore now
  // live outside the project tree entirely, so there's nothing to
  // ignore here. We must NOT touch <project>/.nostr-station/.gitignore
  // because any pre-existing file there may be user-authored.
  assert.equal(fs.existsSync(path.join(created!, '.gitignore')), false);
});

test('ensureConfigDir: does not overwrite an existing .gitignore', () => {
  const dir = makeProjectDir();
  const project = makeProject({ path: dir });
  ensureConfigDir(project);
  const giPath = path.join(dir, CONFIG_DIRNAME, '.gitignore');
  fs.writeFileSync(giPath, 'user-custom\n');
  ensureConfigDir(project);
  assert.equal(fs.readFileSync(giPath, 'utf8'), 'user-custom\n');
});

test('ensureConfigDir: returns null for path-less project', () => {
  const project = makeProject();
  assert.equal(ensureConfigDir(project), null);
});

test('ensureUserConfigDir: creates ~/.config/nostr-station/projects/<id>/ at 0o700', () => {
  const project = makeProject({ id: 'user-cfg-test', path: makeProjectDir() });
  const created = ensureUserConfigDir(project);
  assert.equal(created, userConfigDirFor(project));
  const st = fs.statSync(created);
  assert.ok(st.isDirectory());
  // Owner-only permissions; protects nsecs and per-machine preferences
  // on shared systems.
  assert.equal(st.mode & 0o777, 0o700);
});

// ── Round-trip writes ────────────────────────────────────────────────────

test('system-prompt override: write then read', () => {
  const dir = makeProjectDir();
  const project = makeProject({ path: dir });
  writeSystemPromptOverride(project, '# My Project Prompt\n\nDo X.');
  assert.equal(readSystemPromptOverride(project), '# My Project Prompt\n\nDo X.');
});

test('system-prompt override: returns null when missing', () => {
  const project = makeProject({ path: makeProjectDir() });
  assert.equal(readSystemPromptOverride(project), null);
});

test('system-prompt override: empty file → null', () => {
  const dir = makeProjectDir();
  const project = makeProject({ path: dir });
  fs.mkdirSync(path.join(dir, CONFIG_DIRNAME));
  fs.writeFileSync(path.join(dir, CONFIG_DIRNAME, 'system-prompt.md'), '   \n\n');
  assert.equal(readSystemPromptOverride(project), null);
});

test('project-context overlay: round-trip through dot-dir', () => {
  const dir = makeProjectDir();
  const project = makeProject({ path: dir });
  writeProjectContextOverlay(project, '## Wiki namespaces\n- foo\n');
  assert.match(readProjectContextOverlay(project)!, /Wiki namespaces/);
});

test('project-context overlay: back-compat reads root-level file when dot-dir absent', () => {
  const dir = makeProjectDir();
  fs.writeFileSync(path.join(dir, 'project-context.md'), 'legacy guidance');
  const project = makeProject({ path: dir });
  assert.equal(readProjectContextOverlay(project), 'legacy guidance');
});

test('project-context overlay: dot-dir wins when both present', () => {
  const dir = makeProjectDir();
  fs.writeFileSync(path.join(dir, 'project-context.md'), 'old');
  fs.mkdirSync(path.join(dir, CONFIG_DIRNAME));
  fs.writeFileSync(path.join(dir, CONFIG_DIRNAME, 'project-context.md'), 'new');
  const project = makeProject({ path: dir });
  assert.equal(readProjectContextOverlay(project), 'new');
});

test('template record: round-trip', () => {
  const dir = makeProjectDir();
  const project = makeProject({ path: dir });
  const record = {
    templateId:   'mkstack',
    templateName: 'MKStack',
    sourceUrl:    'https://example.com/foo.git',
    scaffoldedAt: '2026-05-06T12:00:00.000Z',
  };
  writeProjectTemplate(project, record);
  assert.deepEqual(readProjectTemplate(project), record);
});

test('template record: returns null for malformed file', () => {
  const dir = makeProjectDir();
  fs.mkdirSync(path.join(dir, CONFIG_DIRNAME));
  fs.writeFileSync(path.join(dir, CONFIG_DIRNAME, 'template.json'), '{ "bad": true }');
  const project = makeProject({ path: dir });
  assert.equal(readProjectTemplate(project), null);
});

test('permissions: rejects unknown modes on read', () => {
  const project = makeProject({ id: 'perm-bad', path: makeProjectDir() });
  ensureUserConfigDir(project);
  fs.writeFileSync(path.join(userConfigDirFor(project), 'permissions.json'), '{"mode":"god-mode"}');
  assert.equal(readProjectPermissions(project), null);
});

test('permissions: round-trip writes to user-config dir, not the project tree', () => {
  const dir = makeProjectDir();
  const project = makeProject({ id: 'perm-rt', path: dir });
  for (const mode of ['read-only', 'auto-edit', 'yolo'] as const) {
    writeProjectPermissions(project, { mode });
    assert.deepEqual(readProjectPermissions(project), { mode });
  }
  // File lives outside the project tree — guarantees no git noise.
  assert.equal(fs.existsSync(path.join(dir, CONFIG_DIRNAME, 'permissions.json')), false);
  assert.ok(fs.existsSync(path.join(userConfigDirFor(project), 'permissions.json')));
});

test('chat override: only persists known fields', () => {
  const project = makeProject({ id: 'chat-rt', path: makeProjectDir() });
  writeProjectChatOverride(project, { provider: 'anthropic', model: 'claude-opus-4-7' } as any);
  const got = readProjectChatOverride(project);
  assert.equal(got!.provider, 'anthropic');
  assert.equal(got!.model, 'claude-opus-4-7');
});

test('chat override: returns null when both fields blank', () => {
  const project = makeProject({ id: 'chat-blank', path: makeProjectDir() });
  ensureUserConfigDir(project);
  fs.writeFileSync(path.join(userConfigDirFor(project), 'chat.json'), '{}');
  assert.equal(readProjectChatOverride(project), null);
});

test('chat override: delete clears the user-config file', () => {
  const project = makeProject({ id: 'chat-del', path: makeProjectDir() });
  writeProjectChatOverride(project, { provider: 'anthropic' });
  assert.ok(readProjectChatOverride(project));
  deleteProjectChatOverride(project);
  assert.equal(readProjectChatOverride(project), null);
});

// ── Migration: legacy <project>/.nostr-station/{permissions,chat}.json ────

test('migration: untracked legacy permissions.json is copied + deleted', () => {
  const dir = makeProjectDir();
  const project = makeProject({ id: 'mig-untracked', path: dir });
  // Seed legacy file.
  fs.mkdirSync(path.join(dir, CONFIG_DIRNAME));
  fs.writeFileSync(
    path.join(dir, CONFIG_DIRNAME, 'permissions.json'),
    '{"mode":"yolo"}',
  );
  // Trigger migration via a read.
  const perms = readProjectPermissions(project);
  assert.deepEqual(perms, { mode: 'yolo' });
  // Untracked legacy file should be auto-removed (no git repo here, so
  // ls-files errors → "untracked" branch).
  assert.equal(fs.existsSync(path.join(dir, CONFIG_DIRNAME, 'permissions.json')), false);
  // And the new location now has it.
  assert.ok(fs.existsSync(path.join(userConfigDirFor(project), 'permissions.json')));
});

test('migration: tracked legacy chat.json is copied but NOT deleted', async () => {
  const { execFileSync } = await import('node:child_process');
  const dir = makeProjectDir();
  const project = makeProject({ id: 'mig-tracked', path: dir });
  // Make it a git repo, then commit the legacy file so it's tracked.
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@e.l'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: dir });
  fs.mkdirSync(path.join(dir, CONFIG_DIRNAME));
  fs.writeFileSync(
    path.join(dir, CONFIG_DIRNAME, 'chat.json'),
    '{"provider":"anthropic"}',
  );
  execFileSync('git', ['add', `${CONFIG_DIRNAME}/chat.json`], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: dir });
  // Trigger migration.
  const chat = readProjectChatOverride(project);
  assert.deepEqual(chat, { provider: 'anthropic' });
  // Tracked legacy stays — leaves no surprise staged deletion.
  assert.ok(fs.existsSync(path.join(dir, CONFIG_DIRNAME, 'chat.json')));
  // New location populated.
  assert.ok(fs.existsSync(path.join(userConfigDirFor(project), 'chat.json')));
  // Banner surfaces the leftover.
  assert.ok(legacyLocalFiles(project).includes('chat.json'));
});

// ── seedProjectConfig (scaffold-time) ─────────────────────────────────────

test('seedProjectConfig: writes template.json + project-context from defaults', () => {
  const dir = makeProjectDir();
  const project = makeProject({ path: dir });
  const mkstack = BUILTINS.find(t => t.id === 'mkstack')!;
  seedProjectConfig(project, mkstack);

  const t = readProjectTemplate(project);
  assert.equal(t!.templateId, 'mkstack');
  assert.equal(t!.templateName, 'MKStack');
  assert.equal(t!.sourceUrl, 'https://gitlab.com/soapbox-pub/mkstack.git');
  assert.match(t!.scaffoldedAt, /^\d{4}-\d{2}-\d{2}T/);

  const overlay = readProjectContextOverlay(project);
  assert.match(overlay!, /Wiki namespaces/);
});

test('seedProjectConfig: leaves existing project-context.md alone (dot-dir version)', () => {
  const dir = makeProjectDir();
  fs.mkdirSync(path.join(dir, CONFIG_DIRNAME));
  fs.writeFileSync(path.join(dir, CONFIG_DIRNAME, 'project-context.md'), 'developer-authored');
  const project = makeProject({ path: dir });
  const mkstack = BUILTINS.find(t => t.id === 'mkstack')!;
  seedProjectConfig(project, mkstack);
  assert.equal(readProjectContextOverlay(project), 'developer-authored');
});

test('seedProjectConfig: leaves existing legacy root-level project-context.md alone', () => {
  const dir = makeProjectDir();
  fs.writeFileSync(path.join(dir, 'project-context.md'), 'legacy');
  const project = makeProject({ path: dir });
  const mkstack = BUILTINS.find(t => t.id === 'mkstack')!;
  seedProjectConfig(project, mkstack);
  // Legacy file untouched; dot-dir version not seeded so legacy still wins.
  assert.equal(fs.readFileSync(path.join(dir, 'project-context.md'), 'utf8'), 'legacy');
  assert.equal(readProjectContextOverlay(project), 'legacy');
});

test('seedProjectConfig: works with null template (no-op for template fields)', () => {
  const dir = makeProjectDir();
  const project = makeProject({ path: dir });
  seedProjectConfig(project, null);
  assert.equal(readProjectTemplate(project), null);
  assert.equal(readProjectContextOverlay(project), null);
  // The shareable dir is seeded. No gitignore — that file got
  // retired now that private files don't live here.
  assert.ok(fs.existsSync(path.join(dir, CONFIG_DIRNAME)));
  assert.equal(fs.existsSync(path.join(dir, CONFIG_DIRNAME, '.gitignore')), false);
});

// ── readProjectAiConfig bundle ────────────────────────────────────────────

test('readProjectAiConfig: empty project → all nulls + legacyContext false', () => {
  const dir = makeProjectDir();
  const project = makeProject({ path: dir });
  const b = readProjectAiConfig(project);
  assert.equal(b.systemPrompt, null);
  assert.equal(b.projectContext, null);
  assert.equal(b.template, null);
  assert.equal(b.permissions, null);
  assert.equal(b.chat, null);
  assert.equal(b.legacyContext, false);
});

test('readProjectAiConfig: legacyContext flag set when only root file exists', () => {
  const dir = makeProjectDir();
  fs.writeFileSync(path.join(dir, 'project-context.md'), 'legacy');
  const project = makeProject({ path: dir });
  const b = readProjectAiConfig(project);
  assert.equal(b.legacyContext, true);
  assert.equal(b.projectContext, 'legacy');
});

test('readProjectAiConfig: legacyContext false once dot-dir version exists', () => {
  const dir = makeProjectDir();
  fs.writeFileSync(path.join(dir, 'project-context.md'), 'legacy');
  fs.mkdirSync(path.join(dir, CONFIG_DIRNAME));
  fs.writeFileSync(path.join(dir, CONFIG_DIRNAME, 'project-context.md'), 'new');
  const project = makeProject({ path: dir });
  const b = readProjectAiConfig(project);
  assert.equal(b.legacyContext, false);
  assert.equal(b.projectContext, 'new');
});

// ── isOrphanGitignore ─────────────────────────────────────────────────────

test('isOrphanGitignore: true for the "cache/" only gitignore (real-world case)', () => {
  // The exact contents Claude Code found in Blip's .nostr-station/
  // after the pre-refactor cache writer clobbered project-config's
  // gitignore. The retired-only check must recognize this so the
  // banner can offer the user a deliberate `git rm`.
  const dir = makeProjectDir();
  fs.mkdirSync(path.join(dir, CONFIG_DIRNAME));
  fs.writeFileSync(path.join(dir, CONFIG_DIRNAME, '.gitignore'), 'cache/\n');
  const project = makeProject({ id: 'gi-cache-only', path: dir });
  assert.equal(isOrphanGitignore(project), true);
});

test('isOrphanGitignore: true for the full retired set', () => {
  const dir = makeProjectDir();
  fs.mkdirSync(path.join(dir, CONFIG_DIRNAME));
  fs.writeFileSync(
    path.join(dir, CONFIG_DIRNAME, '.gitignore'),
    'permissions.json\nchat.json\ntest-identities.json\ncache/\n',
  );
  const project = makeProject({ id: 'gi-full', path: dir });
  assert.equal(isOrphanGitignore(project), true);
});

test('isOrphanGitignore: false when user added a custom rule', () => {
  // Even one unfamiliar line means we leave the file alone — never
  // wipe a user-authored gitignore.
  const dir = makeProjectDir();
  fs.mkdirSync(path.join(dir, CONFIG_DIRNAME));
  fs.writeFileSync(
    path.join(dir, CONFIG_DIRNAME, '.gitignore'),
    'cache/\nmy-scratch-notes.md\n',
  );
  const project = makeProject({ id: 'gi-custom', path: dir });
  assert.equal(isOrphanGitignore(project), false);
});

test('isOrphanGitignore: false when file is absent', () => {
  const project = makeProject({ id: 'gi-missing', path: makeProjectDir() });
  assert.equal(isOrphanGitignore(project), false);
});

test('isOrphanGitignore: false for an empty gitignore (could be intentional)', () => {
  // An empty file isn't ours — could be a user's deliberate placeholder
  // (e.g. about to add rules). Leave alone.
  const dir = makeProjectDir();
  fs.mkdirSync(path.join(dir, CONFIG_DIRNAME));
  fs.writeFileSync(path.join(dir, CONFIG_DIRNAME, '.gitignore'), '');
  const project = makeProject({ id: 'gi-empty', path: dir });
  assert.equal(isOrphanGitignore(project), false);
});

// ── detectNsecsInHistory ──────────────────────────────────────────────────

test('detectNsecsInHistory: null when project has no .git', () => {
  const project = makeProject({ id: 'nh-no-git', path: makeProjectDir() });
  assert.equal(detectNsecsInHistory(project), null);
});

test('detectNsecsInHistory: empty when repo is clean of the file', async () => {
  const { execFileSync } = await import('node:child_process');
  const dir = makeProjectDir();
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@e.l'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), '# hi\n');
  execFileSync('git', ['add', 'README.md'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  const project = makeProject({ id: 'nh-clean', path: dir });
  assert.deepEqual(detectNsecsInHistory(project), []);
});

test('detectNsecsInHistory: surfaces commits that added test-identities.json', async () => {
  const { execFileSync } = await import('node:child_process');
  const dir = makeProjectDir();
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@e.l'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: dir });
  // Two commits — first adds the file, second removes it. The
  // detector must STILL flag the first commit, because the plaintext
  // nsec is forever in history (and on any remote the user pushed to).
  fs.mkdirSync(path.join(dir, CONFIG_DIRNAME));
  fs.writeFileSync(
    path.join(dir, CONFIG_DIRNAME, 'test-identities.json'),
    '{"identities":[{"nsec":"nsec1leaked"}]}',
  );
  execFileSync('git', ['add', `${CONFIG_DIRNAME}/test-identities.json`], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'leak'], { cwd: dir });
  execFileSync('git', ['rm', `${CONFIG_DIRNAME}/test-identities.json`], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'remove'], { cwd: dir });

  // Memoization is per project.id — use a fresh id so this test isn't
  // affected by any earlier-in-file detector call.
  const project = makeProject({ id: 'nh-leaked', path: dir });
  const commits = detectNsecsInHistory(project);
  assert.ok(Array.isArray(commits));
  assert.equal(commits!.length, 1, `expected exactly one ADD commit, got ${commits!.length}`);
  assert.match(commits![0], /^[0-9a-f]{40}$/);
});

// ── readProjectAiConfig with the new banner fields ────────────────────────

test('readProjectAiConfig: orphanGitignore + nsecsInHistory wired through to bundle', async () => {
  // Two-condition test:
  //   - gitignore must be TRACKED in git so the migration's auto-
  //     cleanup leaves it alone — only then does the banner field
  //     have something to report.
  //   - nsecsInHistory uses --all so the leak commit must really be
  //     reachable from a ref; HEAD here suffices.
  const { execFileSync } = await import('node:child_process');
  const dir = makeProjectDir();
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@e.l'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: dir });
  fs.mkdirSync(path.join(dir, CONFIG_DIRNAME));
  fs.writeFileSync(path.join(dir, CONFIG_DIRNAME, '.gitignore'), 'cache/\n');
  fs.writeFileSync(
    path.join(dir, CONFIG_DIRNAME, 'test-identities.json'),
    '{"identities":[]}',
  );
  execFileSync('git', ['add', `${CONFIG_DIRNAME}/.gitignore`,
                                `${CONFIG_DIRNAME}/test-identities.json`], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: dir });

  const project = makeProject({ id: 'bundle-banners', path: dir });
  const b = readProjectAiConfig(project);
  assert.equal(b.orphanGitignore, true);
  assert.ok(Array.isArray(b.nsecsInHistory));
  assert.equal(b.nsecsInHistory!.length, 1);
});
