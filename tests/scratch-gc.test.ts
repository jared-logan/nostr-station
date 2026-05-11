import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { useTempHome, resetTempHome } from './_home.js';

const HOME = useTempHome();

const { runScratchGc } = await import('../src/lib/scratch-gc.ts');
const { createProject, readProjects, getProject } = await import('../src/lib/projects.ts');

beforeEach(() => resetTempHome(HOME));

function scratchDir(name: string): string {
  return path.join(HOME, '.nostr-station', 'scratch', name);
}

function makeScratchDir(name: string, mtimeMs: number): string {
  const dir = scratchDir(name);
  fs.mkdirSync(dir, { recursive: true });
  // Seed a file inside so the dir is non-empty (realistic for a clone).
  fs.writeFileSync(path.join(dir, 'README.md'), '# hi');
  // utimes accepts numbers in seconds.
  fs.utimesSync(dir, mtimeMs / 1000, mtimeMs / 1000);
  return dir;
}

// ── Empty / missing root ─────────────────────────────────────────────────

test('runScratchGc: scratch root missing → returns empty result, no throw', () => {
  const r = runScratchGc();
  assert.equal(r.scanned, 0);
  assert.deepEqual(r.removed, []);
});

test('runScratchGc: scratch root empty → scanned 0', () => {
  fs.mkdirSync(path.join(HOME, '.nostr-station', 'scratch'), { recursive: true });
  const r = runScratchGc();
  assert.equal(r.scanned, 0);
});

// ── TTL policy ───────────────────────────────────────────────────────────

const NOW = 2_000_000_000_000;       // pinned 'now' for deterministic tests
const DAY = 24 * 60 * 60 * 1000;

test('runScratchGc: fresh dir (< TTL) is preserved', () => {
  // Pinned mtime: 1 day old, TTL 7 days → kept.
  const dir = makeScratchDir('fresh-aaaaaaaa', NOW - 1 * DAY);
  const r = runScratchGc({ now: NOW });
  assert.equal(r.scanned, 1);
  assert.equal(r.removed.length, 0);
  assert.equal(fs.existsSync(dir), true);
});

test('runScratchGc: stale dir (> TTL) is removed', () => {
  // 10 days old, TTL 7 days → gc'd.
  const dir = makeScratchDir('stale-bbbbbbbb', NOW - 10 * DAY);
  const r = runScratchGc({ now: NOW });
  assert.equal(r.scanned, 1);
  assert.deepEqual(r.removed, [dir]);
  assert.equal(fs.existsSync(dir), false);
});

test('runScratchGc: mixed fresh + stale handled independently', () => {
  const fresh = makeScratchDir('keep-cccccccc',   NOW - 2 * DAY);
  const stale = makeScratchDir('drop-dddddddd', NOW - 30 * DAY);
  const r = runScratchGc({ now: NOW });
  assert.equal(r.scanned, 2);
  assert.deepEqual(r.removed, [stale].sort());  // order-insensitive
  assert.equal(fs.existsSync(fresh), true);
  assert.equal(fs.existsSync(stale), false);
});

test('runScratchGc: custom TTL respected', () => {
  // 2 days old with a 1-day TTL → gc'd.
  const dir = makeScratchDir('cust-eeeeeeee', NOW - 2 * DAY);
  const r = runScratchGc({ now: NOW, ttlMs: 1 * DAY });
  assert.deepEqual(r.removed, [dir]);
});

// ── Project-record cleanup ──────────────────────────────────────────────

test('runScratchGc: removing a scratch dir also drops its project record', () => {
  const dir = makeScratchDir('gone-ffffffff', NOW - 30 * DAY);
  // Register the scratch dir as a Project so the GC can match it.
  const r = createProject({
    name: 'gone',
    path: dir,
    capabilities: { git: false, ngit: true, nsite: false },
    identity:     { useDefault: true, npub: null, bunkerUrl: null },
    remotes:      { github: null, ngit: null },
  });
  if (!r.ok) throw new Error(r.error);
  const id = r.project.id;

  const result = runScratchGc({ now: NOW });
  assert.deepEqual(result.projectsRemoved, [id]);
  assert.equal(getProject(id), null);
});

test('runScratchGc: leaves the project record alone when the directory is fresh', () => {
  const dir = makeScratchDir('keep-gggggggg', NOW - 1 * DAY);
  const r = createProject({
    name: 'keep',
    path: dir,
    capabilities: { git: false, ngit: true, nsite: false },
    identity:     { useDefault: true, npub: null, bunkerUrl: null },
    remotes:      { github: null, ngit: null },
  });
  if (!r.ok) throw new Error(r.error);
  const id = r.project.id;

  const result = runScratchGc({ now: NOW });
  assert.deepEqual(result.projectsRemoved, []);
  assert.notEqual(getProject(id), null);
});

test('runScratchGc: does NOT touch projects whose path is outside the scratch root', () => {
  // Defence-in-depth: a project record with a path under
  // ~/projects/ must not be deleted just because we're scanning the
  // scratch root. (Wouldn't happen by design — the GC only looks
  // at dirs INSIDE scratchRoot — but the test pins it.)
  const realPath = path.join(HOME, 'projects', 'real');
  fs.mkdirSync(realPath, { recursive: true });
  const r = createProject({
    name: 'real',
    path: realPath,
    capabilities: { git: true,  ngit: false, nsite: false },
    identity:     { useDefault: true, npub: null, bunkerUrl: null },
    remotes:      { github: null, ngit: null },
  });
  if (!r.ok) throw new Error(r.error);
  // Empty scratch dir alongside — gc has nothing to remove.
  fs.mkdirSync(path.join(HOME, '.nostr-station', 'scratch'), { recursive: true });
  const result = runScratchGc({ now: NOW });
  assert.equal(result.projectsRemoved.length, 0);
  assert.notEqual(getProject(r.project.id), null);
});
