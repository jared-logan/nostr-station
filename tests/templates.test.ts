// Templates registry tests — exercise the self-healing, validation,
// and CRUD surface of src/lib/templates.ts. HOME is pinned to a tmpdir
// so the writes land in an isolated ~/.config/nostr-station/.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { useTempHome, resetTempHome } from './_home.js';

const HOME = useTempHome();

const {
  readTemplates, getTemplate, createTemplate, updateTemplate,
  deleteTemplate, resetTemplate, validateTemplate, BUILTINS,
  templatesPath,
} = await import('../src/lib/templates.js');

beforeEach(() => resetTempHome(HOME));

// ── Self-healing read ──────────────────────────────────────────────────────

test('readTemplates: seeds builtins on first read', () => {
  // No file present.
  assert.equal(fs.existsSync(templatesPath()), false);
  const list = readTemplates();
  assert.ok(list.length >= 1);
  assert.ok(list.find(t => t.id === 'mkstack'));
  // File now exists with the seeded list.
  assert.ok(fs.existsSync(templatesPath()));
});

test('readTemplates: re-seeds a builtin removed by hand', () => {
  // First read seeds.
  readTemplates();
  // User edits the file to remove MKStack.
  fs.writeFileSync(templatesPath(), JSON.stringify({ version: 1, templates: [] }));
  // Next read re-splices it back in.
  const list = readTemplates();
  assert.ok(list.find(t => t.id === 'mkstack' && t.builtin === true));
});

test('readTemplates: preserves user edits to a builtin', () => {
  readTemplates();
  updateTemplate('mkstack', { description: 'My custom MKStack notes.' });
  const list = readTemplates();
  const t = list.find(x => x.id === 'mkstack')!;
  assert.equal(t.description, 'My custom MKStack notes.');
  // Still flagged as builtin.
  assert.equal(t.builtin, true);
});

test('readTemplates: corrupted file → seeds clean', () => {
  fs.mkdirSync(path.dirname(templatesPath()), { recursive: true });
  fs.writeFileSync(templatesPath(), 'not json');
  const list = readTemplates();
  assert.ok(list.find(t => t.id === 'mkstack'));
});

test('readTemplates: wrong version → re-seeds', () => {
  fs.mkdirSync(path.dirname(templatesPath()), { recursive: true });
  fs.writeFileSync(templatesPath(), JSON.stringify({ version: 999, templates: [] }));
  const list = readTemplates();
  assert.ok(list.find(t => t.id === 'mkstack'));
});

// ── Validation ─────────────────────────────────────────────────────────────

test('validateTemplate: rejects bad ids', () => {
  for (const id of ['', 'BAD', 'has space', 'has/slash', '🦊', 'a'.repeat(50)]) {
    const v = validateTemplate({ id, name: 'x', description: 'x', source: { type: 'local-only' } });
    assert.equal(v.ok, false, `expected reject for id=${JSON.stringify(id)}`);
  }
});

test('validateTemplate: accepts canonical ids', () => {
  for (const id of ['mkstack', 'a', 'a-b', 'foo-1', 'a1b2c3']) {
    const v = validateTemplate({ id, name: 'x', description: 'x', source: { type: 'local-only' } });
    assert.equal(v.ok, true, `expected accept for id=${JSON.stringify(id)}`);
  }
});

test('validateTemplate: rejects non-git URLs in git-url source', () => {
  const v = validateTemplate({
    id: 'x', name: 'x', description: 'x',
    source: { type: 'git-url', url: 'not a url at all' },
  });
  assert.equal(v.ok, false);
});

test('validateTemplate: accepts standard git URLs', () => {
  for (const url of [
    'https://github.com/foo/bar',
    'http://gitlab.com/foo/bar.git',
    'git@github.com:foo/bar.git',
    'ssh://git@example.com/foo.git',
    'git://example.com/foo.git',
  ]) {
    const v = validateTemplate({ id: 'x', name: 'x', description: 'x', source: { type: 'git-url', url } });
    assert.equal(v.ok, true, `expected accept for url=${url}`);
  }
});

// ── CRUD ───────────────────────────────────────────────────────────────────

test('createTemplate: success path', () => {
  const r = createTemplate({
    id: 'my-template',
    name: 'My Template',
    description: 'A custom template.',
    source: { type: 'git-url', url: 'https://github.com/foo/bar.git' },
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.template.id, 'my-template');
    assert.equal(r.template.builtin, false);
  }
});

test('createTemplate: rejects duplicate id', () => {
  const r = createTemplate({
    id: 'mkstack', // collides with builtin
    name: 'x', description: 'x',
    source: { type: 'local-only' },
  });
  assert.equal(r.ok, false);
});

test('createTemplate: client-supplied builtin: true is ignored', () => {
  const r = createTemplate({
    id: 'sneaky',
    name: 'Sneaky', description: 'try to forge a builtin',
    source: { type: 'local-only' },
    builtin: true,
  } as any);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.template.builtin, false);
});

test('updateTemplate: id and builtin are immutable', () => {
  const r = updateTemplate('mkstack', { id: 'renamed', builtin: false } as any);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.template.id, 'mkstack');
    assert.equal(r.template.builtin, true);
  }
});

test('deleteTemplate: rejects builtins', () => {
  const r = deleteTemplate('mkstack');
  assert.equal(r.ok, false);
  // Still in the registry.
  assert.ok(getTemplate('mkstack'));
});

test('deleteTemplate: removes a non-builtin', () => {
  createTemplate({
    id: 'temp', name: 'Temp', description: 'temp',
    source: { type: 'local-only' },
  });
  assert.ok(getTemplate('temp'));
  const r = deleteTemplate('temp');
  assert.equal(r.ok, true);
  assert.equal(getTemplate('temp'), null);
});

test('resetTemplate: restores a builtin to its seed values', () => {
  const seed = BUILTINS.find(b => b.id === 'mkstack')!;
  updateTemplate('mkstack', { description: 'edited' });
  assert.notEqual(getTemplate('mkstack')!.description, seed.description);

  const r = resetTemplate('mkstack');
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.template.description, seed.description);
    assert.equal(r.template.builtin, true);
  }
});

test('resetTemplate: rejects non-builtins', () => {
  createTemplate({
    id: 'custom', name: 'Custom', description: 'custom',
    source: { type: 'local-only' },
  });
  const r = resetTemplate('custom');
  assert.equal(r.ok, false);
});

// ── File mode ─────────────────────────────────────────────────────────────

test('readTemplates: writes file with mode 0600', () => {
  readTemplates();
  const stat = fs.statSync(templatesPath());
  // Mode is the lower nine bits.
  const mode = stat.mode & 0o777;
  assert.equal(mode, 0o600, `expected 0o600, got 0o${mode.toString(8)}`);
});
