import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { useTempHome, resetTempHome } from './_home.js';

const HOME = useTempHome();

// @ts-expect-error — runtime import of .ts
const services = await import('../src/lib/services.ts');
const { symlinkEditorFile, EDITOR_FILENAMES } = services;

beforeEach(() => resetTempHome(HOME));

// Minimal Platform shape — symlinkEditorFile only reads `projectsDir`.
// Full type has many more fields but the symlink path doesn't touch
// them, so a partial mock keeps the test focused on the contract
// under exercise (which filename → which editor).
function makePlatform() {
  const projectsDir = path.join(HOME, 'projects');
  fs.mkdirSync(projectsDir, { recursive: true });
  // Write the canonical file so the symlink resolves to real content.
  fs.writeFileSync(
    path.join(projectsDir, 'NOSTR_STATION.md'),
    '# Nori\n\nminimal stub for the symlink test.\n',
  );
  return { projectsDir } as any;
}

// ── AGENTS.md target ─────────────────────────────────────────────────────

test('symlinkEditorFile: codex editor lands on AGENTS.md', () => {
  // Pinned: spec says AGENTS.md is the canonical target for Codex
  // (and Stacks Dork — same filename convention). A future EDITOR_
  // FILENAMES tweak that quietly renamed the codex entry would
  // surface here.
  const p = makePlatform();
  const linkPath = symlinkEditorFile(p, 'codex');
  assert.equal(path.basename(linkPath), 'AGENTS.md');
  assert.ok(fs.existsSync(linkPath), `symlink not created at ${linkPath}`);

  // Reading through the link should produce the canonical file's
  // content — proves the link targets NOSTR_STATION.md, not just
  // any file with a similar name.
  const through = fs.readFileSync(linkPath, 'utf8');
  assert.match(through, /# Nori/);
});

test('symlinkEditorFile: `other` editor also lands on AGENTS.md (generic fallback)', () => {
  // EDITOR_FILENAMES['other'] is the generic AGENTS.md slot — anything
  // that respects the AGENTS.md convention gets environmental
  // awareness without us teaching it about every tool's filename.
  // Pinned because new agentic tools (Cline, Continue, …) often
  // ship AGENTS.md support before they ship their own brand of
  // sentinel filename.
  const p = makePlatform();
  const linkPath = symlinkEditorFile(p, 'other');
  assert.equal(path.basename(linkPath), 'AGENTS.md');
  assert.ok(fs.existsSync(linkPath));
});

test('symlinkEditorFile: AGENTS.md is a symlink (not a file copy)', () => {
  // The whole switching-tools story works because the link points
  // back to NOSTR_STATION.md — re-running editor across tools
  // updates one file's worth of state, not N. If a refactor ever
  // turned this into a copy, switching would silently stale.
  const p = makePlatform();
  const linkPath = symlinkEditorFile(p, 'codex');
  const stat = fs.lstatSync(linkPath);
  assert.equal(stat.isSymbolicLink(), true,
    'AGENTS.md must be a symlink, not a regular file');
  // Symlink target should be the canonical filename — relative so
  // moving the projects dir doesn't break the link.
  assert.equal(fs.readlinkSync(linkPath), 'NOSTR_STATION.md');
});

// ── Other editor mappings (sanity checks) ─────────────────────────────────

test('symlinkEditorFile: claude-code → CLAUDE.md', () => {
  const p = makePlatform();
  const linkPath = symlinkEditorFile(p, 'claude-code');
  assert.equal(path.basename(linkPath), 'CLAUDE.md');
  assert.equal(fs.readlinkSync(linkPath), 'NOSTR_STATION.md');
});

test('symlinkEditorFile: copilot → .github/copilot-instructions.md (subdir case)', () => {
  // The copilot link lives one directory deep — the helper has to
  // mkdir the .github subdir first. Pinned because a regression
  // here would surface as a silent ENOENT and the link wouldn't
  // exist.
  const p = makePlatform();
  const linkPath = symlinkEditorFile(p, 'copilot');
  assert.equal(linkPath, path.join(p.projectsDir, '.github', 'copilot-instructions.md'));
  assert.ok(fs.lstatSync(linkPath).isSymbolicLink());
});

// ── Idempotency ──────────────────────────────────────────────────────────

test('symlinkEditorFile: re-running on the same editor replaces the link cleanly', () => {
  // The editor command is meant to be re-runnable any time the user
  // switches tools. Calling it twice for the same editor must not
  // EEXIST — the unlink + symlink dance handles that.
  const p = makePlatform();
  const first  = symlinkEditorFile(p, 'codex');
  const second = symlinkEditorFile(p, 'codex');
  assert.equal(first, second);
  assert.ok(fs.lstatSync(second).isSymbolicLink());
});

test('symlinkEditorFile: switching editors leaves the previous link in place (independent files)', () => {
  // Switching from `claude-code` to `codex` should leave CLAUDE.md
  // alone — different filenames, different symlinks, both pointing
  // at the same canonical file. The user can switch back without
  // re-running editor; both tools' files remain valid.
  const p = makePlatform();
  symlinkEditorFile(p, 'claude-code');
  symlinkEditorFile(p, 'codex');
  assert.ok(fs.existsSync(path.join(p.projectsDir, 'CLAUDE.md')),
    'switching editors should not delete the previous tool\'s symlink');
  assert.ok(fs.existsSync(path.join(p.projectsDir, 'AGENTS.md')));
});

// ── Mapping table ────────────────────────────────────────────────────────

test('EDITOR_FILENAMES: documented contract — every value in the table is a real path', () => {
  // Pin the documented mapping so a future entry can't slip in with
  // a typo. AGENTS.md is the codex + other slot per spec.
  assert.equal(EDITOR_FILENAMES['claude-code'], 'CLAUDE.md');
  assert.equal(EDITOR_FILENAMES['cursor'],      '.cursorrules');
  assert.equal(EDITOR_FILENAMES['windsurf'],    '.windsurfrules');
  assert.equal(EDITOR_FILENAMES['copilot'],     '.github/copilot-instructions.md');
  assert.equal(EDITOR_FILENAMES['aider'],       'CONVENTIONS.md');
  assert.equal(EDITOR_FILENAMES['codex'],       'AGENTS.md');
  assert.equal(EDITOR_FILENAMES['other'],       'AGENTS.md');
});
