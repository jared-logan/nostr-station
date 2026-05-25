// Verify the new templated system prompt renders the env block,
// mode switch, template list, and project-template chip. Existing
// project-context-overlay.test.ts still covers the README + overlay
// invariants.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { useTempHome, resetTempHome } from './_home.js';

const HOME = useTempHome();

const aiCtx = await import('../src/lib/ai-context.js');
const { buildAiContext } = aiCtx;
const { writeProjectTemplate, ensureConfigDir } = await import('../src/lib/project-config.js');
const { setPrivacy } = await import('../src/lib/ai-config.js');
const { USER_REGION_BEGIN, USER_REGION_END } = await import('../src/lib/editor.js');

interface Project {
  id: string; name: string; path: string | null;
  capabilities: { git: boolean; ngit: boolean; nsite: boolean };
  identity: { useDefault: boolean; npub: string | null; bunkerUrl: string | null };
  remotes: { github: string | null; ngit: string | null };
  nsite: { url: string | null; lastDeploy: string | null };
  readRelays: string[] | null;
  createdAt: string;
  updatedAt: string;
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p',
    name: 'p',
    path: null,
    capabilities: { git: false, ngit: false, nsite: false },
    identity: { useDefault: true, npub: null, bunkerUrl: null },
    remotes: { github: null, ngit: null },
    nsite: { url: null, lastDeploy: null },
    readRelays: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function registerProject(p: Project) {
  const dir = path.join(HOME, '.config', 'nostr-station');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([p], null, 2));
}

beforeEach(() => resetTempHome(HOME));

// ── Env block ────────────────────────────────────────────────────────────

test('renders model.fullId from passed ModelInfo', () => {
  const ctx = buildAiContext(null, { provider: 'anthropic', fullId: 'claude-opus-4-7' });
  assert.match(ctx.text, /AI Model: claude-opus-4-7/);
});

test('falls back to "unknown" model when none passed', () => {
  const ctx = buildAiContext(null);
  assert.match(ctx.text, /AI Model: unknown/);
});

test('emits "Permissions Mode: auto-edit" by default', () => {
  // Default flipped from 'read-only' → 'auto-edit' so chat feels closer
  // to shakespeare.diy's bias-toward-action UX. Users can still flip
  // back via the chat-header permissions toggle (separate commit on
  // this branch).
  const ctx = buildAiContext(null);
  assert.match(ctx.text, /Permissions Mode: auto-edit/);
});

test('emits "not deployed" when project has no nsite', () => {
  const ctx = buildAiContext(null);
  assert.match(ctx.text, /Deployed \(nsite\): not deployed/);
});

// ── Mode switch ──────────────────────────────────────────────────────────

test('mode = edit when no project / no template', () => {
  const ctx = buildAiContext(null);
  assert.match(ctx.text, /work on the project in the current directory/);
  assert.doesNotMatch(ctx.text, /transform this template into a working project/);
});

test('mode = init when template recorded + only scaffold root commit', async () => {
  // Create a real project dir with a single commit so projectGitLog
  // returns length 1 → 'init' mode.
  const repo = path.join(HOME, 'projects', 'just-scaffolded');
  fs.mkdirSync(repo, { recursive: true });
  // git init + initial commit
  const { execSync } = await import('node:child_process');
  execSync('git init -b main', { cwd: repo });
  fs.writeFileSync(path.join(repo, 'README.md'), '# fresh\n');
  execSync('git add . && git -c user.name=test -c user.email=test@x.local commit -m initial', { cwd: repo });

  const project = makeProject({
    id: 'init-test', name: 'fresh', path: repo,
    capabilities: { git: true, ngit: false, nsite: false },
  });
  registerProject(project);
  ensureConfigDir(project);
  writeProjectTemplate(project, {
    templateId: 'mkstack', templateName: 'MKStack',
    sourceUrl: 'https://example.com/mkstack.git',
    scaffoldedAt: new Date().toISOString(),
  });

  const ctx = buildAiContext('init-test', { provider: 'anthropic', fullId: 'claude' });
  assert.match(ctx.text, /transform this template into a working project/);
  assert.match(ctx.text, /MKStack/);
});

// ── Template list ────────────────────────────────────────────────────────

test('emits the templates registry under "# Project Templates"', () => {
  const ctx = buildAiContext(null);
  // MKStack is the seeded built-in.
  assert.match(ctx.text, /# Project Templates/);
  assert.match(ctx.text, /- MKStack: Build Nostr clients with React/);
});

// ── Tools section (only when project active) ─────────────────────────────

test('tools section is omitted when no project is active', () => {
  const ctx = buildAiContext(null);
  assert.doesNotMatch(ctx.text, /# Your Tools/);
});

test('tools section renders when project is active and lists each tool', () => {
  const repo = path.join(HOME, 'projects', 'tools-section-test');
  fs.mkdirSync(repo, { recursive: true });
  registerProject(makeProject({
    id: 'tools-test', name: 'tools-test', path: repo,
    capabilities: { git: false, ngit: false, nsite: false },
  }));
  const ctx = buildAiContext('tools-test');
  assert.match(ctx.text, /# Your Tools/);
  for (const tool of ['list_dir', 'read_file', 'write_file', 'apply_patch',
                      'delete_file', 'git_status', 'git_log', 'git_diff',
                      'git_commit', 'run_command']) {
    assert.match(ctx.text, new RegExp(`\`${tool}\``), `expected ${tool} to be mentioned`);
  }
});

// ── User block ───────────────────────────────────────────────────────────

test('user.npub renders when identity.json has one AND privacy opt-in', () => {
  // Seed an identity.json under tmp HOME.
  const dir = path.join(HOME, '.config', 'nostr-station');
  fs.mkdirSync(dir, { recursive: true });
  // 64-char hex pubkey — readUserVars converts via hexToNpub.
  fs.writeFileSync(path.join(dir, 'identity.json'), JSON.stringify({
    npub: 'a'.repeat(64),
    readRelays: [],
  }));
  // Default is to withhold the npub; the existing assertion only holds
  // when the user has opted in explicitly. setPrivacy persists through
  // ai-config.json so buildAiContext picks it up on the next call.
  setPrivacy({ includeNpub: true });
  const ctx = buildAiContext(null);
  assert.match(ctx.text, /Nostr npub: npub1/);
});

test('npub is withheld by default even when identity.json has one', () => {
  // No setPrivacy() call — default behavior. The model should see a
  // "(withheld)" line rather than the actual npub, and the prompt
  // should not contain any `npub1…` substring.
  const dir = path.join(HOME, '.config', 'nostr-station');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'identity.json'), JSON.stringify({
    npub: 'a'.repeat(64),
    readRelays: [],
  }));
  const ctx = buildAiContext(null);
  assert.match(ctx.text, /withheld by their AI privacy setting/);
  assert.doesNotMatch(ctx.text, /npub1/);
});

test('user section falls back to "not yet paired" prompt when no identity', () => {
  const ctx = buildAiContext(null);
  assert.match(ctx.text, /not yet paired with a Nostr identity/);
  // Withheld branch must NOT fire when there is no identity at all.
  assert.doesNotMatch(ctx.text, /withheld by their AI privacy setting/);
});

// ── Privacy: cwd / path redaction (always-on) ────────────────────────────

test('cwd is always anonymized to ~ or $(PROJECT_ROOT)', async () => {
  // No project → cwd falls back to HOME, which must render as `~`.
  const ctxNoProj = buildAiContext(null);
  assert.match(ctxNoProj.text, /Current Working Directory: ~/);
  // The actual HOME path should not appear anywhere in the prompt.
  assert.ok(!ctxNoProj.text.includes(HOME),
    `expected HOME (${HOME}) to be redacted, but it appeared in the prompt`);

  // With a project → cwd renders as $(PROJECT_ROOT). The project's real
  // path must not leak into the body either.
  const repo = path.join(HOME, 'projects', 'redact-test');
  fs.mkdirSync(repo, { recursive: true });
  registerProject(makeProject({
    id: 'redact', name: 'redact', path: repo,
    capabilities: { git: false, ngit: false, nsite: false },
  }));
  const ctxProj = buildAiContext('redact');
  assert.match(ctxProj.text, /Current Working Directory: \$\(PROJECT_ROOT\)/);
  assert.ok(!ctxProj.text.includes(repo),
    `expected project path (${repo}) to be redacted, but it appeared in the prompt`);
});

// ── Privacy: project-context.md honors USER_REGION markers ───────────────

test('project-context.md with USER_REGION markers splices only the inner region', () => {
  const repo = path.join(HOME, 'projects', 'overlay-region');
  fs.mkdirSync(repo, { recursive: true });
  const project = makeProject({
    id: 'overlay-region', name: 'overlay-region', path: repo,
    capabilities: { git: false, ngit: false, nsite: false },
  });
  registerProject(project);
  ensureConfigDir(project);
  const overlay =
    `# Local reference notes that should NOT be sent upstream\n` +
    `LOCAL_ONLY_SENTINEL\n\n` +
    `${USER_REGION_BEGIN}\n` +
    `UPSTREAM_ONLY_SENTINEL\n` +
    `${USER_REGION_END}\n` +
    `# More local-only material\n` +
    `ANOTHER_LOCAL_SENTINEL\n`;
  fs.writeFileSync(path.join(repo, '.nostr-station', 'project-context.md'), overlay);
  const ctx = buildAiContext('overlay-region');
  assert.match(ctx.text, /UPSTREAM_ONLY_SENTINEL/);
  assert.doesNotMatch(ctx.text, /LOCAL_ONLY_SENTINEL/);
  assert.doesNotMatch(ctx.text, /ANOTHER_LOCAL_SENTINEL/);
});

test('project-context.md without USER_REGION markers splices the whole file (back-compat)', () => {
  const repo = path.join(HOME, 'projects', 'overlay-whole');
  fs.mkdirSync(repo, { recursive: true });
  const project = makeProject({
    id: 'overlay-whole', name: 'overlay-whole', path: repo,
    capabilities: { git: false, ngit: false, nsite: false },
  });
  registerProject(project);
  ensureConfigDir(project);
  fs.writeFileSync(
    path.join(repo, '.nostr-station', 'project-context.md'),
    'NO_MARKERS_WHOLE_FILE_CONTENT',
  );
  const ctx = buildAiContext('overlay-whole');
  assert.match(ctx.text, /NO_MARKERS_WHOLE_FILE_CONTENT/);
});

// ── Permissions reflection ───────────────────────────────────────────────

test('permission mode reflects project override', () => {
  const repo = path.join(HOME, 'projects', 'perm-test');
  fs.mkdirSync(repo, { recursive: true });
  const project = makeProject({ id: 'perm-test', name: 'perm', path: repo });
  registerProject(project);
  ensureConfigDir(project);
  fs.writeFileSync(
    path.join(repo, '.nostr-station', 'permissions.json'),
    JSON.stringify({ mode: 'auto-edit' }),
  );
  const ctx = buildAiContext('perm-test');
  assert.match(ctx.text, /Permissions Mode: auto-edit/);
  assert.equal(ctx.permissions, 'auto-edit');
});

// ── Project override ─────────────────────────────────────────────────────

test('project system-prompt.md override replaces the built-in template', () => {
  const repo = path.join(HOME, 'projects', 'override-test');
  fs.mkdirSync(repo, { recursive: true });
  const project = makeProject({ id: 'override-test', name: 'override', path: repo });
  registerProject(project);
  ensureConfigDir(project);
  fs.writeFileSync(
    path.join(repo, '.nostr-station', 'system-prompt.md'),
    'CUSTOM PROMPT for {{ project.name }} on {{ model.fullId }}.',
  );
  const ctx = buildAiContext('override-test', { fullId: 'claude-opus-4-7' });
  assert.equal(ctx.text, 'CUSTOM PROMPT for override on claude-opus-4-7.');
});
