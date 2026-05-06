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
  ensureConfigDir, seedProjectConfig,
  readSystemPromptOverride, writeSystemPromptOverride,
  readProjectContextOverlay, writeProjectContextOverlay,
  readProjectTemplate, writeProjectTemplate,
  readProjectPermissions, writeProjectPermissions,
  readProjectChatOverride, writeProjectChatOverride,
  readProjectAiConfig,
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

// ── ensureConfigDir + .gitignore ──────────────────────────────────────────

test('ensureConfigDir: creates the dir and gitignore', () => {
  const dir = makeProjectDir();
  const project = makeProject({ path: dir });
  const created = ensureConfigDir(project);
  assert.equal(created, path.join(dir, CONFIG_DIRNAME));
  assert.ok(fs.statSync(created!).isDirectory());
  const gi = fs.readFileSync(path.join(created!, '.gitignore'), 'utf8');
  assert.match(gi, /permissions\.json/);
  assert.match(gi, /chat\.json/);
});

test('ensureConfigDir: idempotent — preserves existing gitignore', () => {
  const dir = makeProjectDir();
  const project = makeProject({ path: dir });
  ensureConfigDir(project);
  // User customizes .gitignore.
  const giPath = path.join(dir, CONFIG_DIRNAME, '.gitignore');
  fs.writeFileSync(giPath, 'custom\n');
  ensureConfigDir(project);
  assert.equal(fs.readFileSync(giPath, 'utf8'), 'custom\n');
});

test('ensureConfigDir: returns null for path-less project', () => {
  const project = makeProject();
  assert.equal(ensureConfigDir(project), null);
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
  const dir = makeProjectDir();
  fs.mkdirSync(path.join(dir, CONFIG_DIRNAME));
  fs.writeFileSync(path.join(dir, CONFIG_DIRNAME, 'permissions.json'), '{"mode":"god-mode"}');
  const project = makeProject({ path: dir });
  assert.equal(readProjectPermissions(project), null);
});

test('permissions: round-trip for each valid mode', () => {
  const dir = makeProjectDir();
  const project = makeProject({ path: dir });
  for (const mode of ['read-only', 'auto-edit', 'yolo'] as const) {
    writeProjectPermissions(project, { mode });
    assert.deepEqual(readProjectPermissions(project), { mode });
  }
});

test('chat override: only persists known fields', () => {
  const dir = makeProjectDir();
  const project = makeProject({ path: dir });
  writeProjectChatOverride(project, { provider: 'anthropic', model: 'claude-opus-4-7' } as any);
  const got = readProjectChatOverride(project);
  assert.equal(got!.provider, 'anthropic');
  assert.equal(got!.model, 'claude-opus-4-7');
});

test('chat override: returns null when both fields blank', () => {
  const dir = makeProjectDir();
  fs.mkdirSync(path.join(dir, CONFIG_DIRNAME));
  fs.writeFileSync(path.join(dir, CONFIG_DIRNAME, 'chat.json'), '{}');
  const project = makeProject({ path: dir });
  assert.equal(readProjectChatOverride(project), null);
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
  // But the dir + gitignore are seeded.
  assert.ok(fs.existsSync(path.join(dir, CONFIG_DIRNAME, '.gitignore')));
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
