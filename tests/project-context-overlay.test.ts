import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { useTempHome, resetTempHome } from './_home.js';

const HOME = useTempHome();

// @ts-expect-error — runtime import of .ts; tsx handles resolution
const aiCtx = await import('../src/lib/ai-context.ts');
const { readProjectContext, buildAiContext } = aiCtx;

beforeEach(() => resetTempHome(HOME));

// ── readProjectContext (pure file-read helper) ────────────────────────────

test('readProjectContext: returns the file contents verbatim when present', () => {
  const repo = path.join(HOME, 'projects', 'with-context');
  fs.mkdirSync(repo, { recursive: true });
  const body = [
    '## Project conventions',
    '- Target NIP-23 for long-form drafts.',
    '- All event publishing flows through Amber bunker A.',
    '- Avoid storing raw nsec anywhere.',
  ].join('\n');
  fs.writeFileSync(path.join(repo, 'project-context.md'), body + '\n');

  const got = readProjectContext(repo);
  // No truncation — the spec says verbatim. trailing-whitespace trim
  // is fine (we documented that in the helper) but the body must
  // round-trip otherwise unchanged.
  assert.equal(got, body);
});

test('readProjectContext: missing file → null', () => {
  // Default state — no project-context.md — returns null so the
  // overlay block silently drops out of the system prompt. The spec
  // is explicit that we never auto-create the file.
  const repo = path.join(HOME, 'projects', 'no-context');
  fs.mkdirSync(repo, { recursive: true });
  assert.equal(readProjectContext(repo), null);
});

test('readProjectContext: empty file → null', () => {
  // A zero-byte project-context.md is treated the same as missing —
  // splicing an empty section into the system prompt would just be
  // noise. The developer can populate it later.
  const repo = path.join(HOME, 'projects', 'empty-context');
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, 'project-context.md'), '');
  assert.equal(readProjectContext(repo), null);
});

test('readProjectContext: whitespace-only file → null', () => {
  // Tab/newline-only is also treated as empty — the trimEnd in the
  // helper ensures a file containing only "\n\n  \n" reads as null.
  const repo = path.join(HOME, 'projects', 'ws-only-context');
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, 'project-context.md'), '\n\n\t \n');
  assert.equal(readProjectContext(repo), null);
});

test('readProjectContext: unreadable / non-directory path → null (defensive)', () => {
  // Path doesn't exist at all → null without throwing. Important
  // because buildAiContext runs on every chat turn and a missing
  // project-context.md is the common case.
  const ghost = path.join(HOME, 'projects', 'never-mkdir-d');
  assert.equal(readProjectContext(ghost), null);
});

test('readProjectContext: developer markup with multiple sections round-trips', () => {
  // The spec's expected developer-authored shape — mixed prose,
  // bullets, and a `## Wiki namespaces` section. We splice it
  // verbatim today; future code may parse the namespaces. The test
  // pins that we DON'T mangle that section while passing it through.
  const repo = path.join(HOME, 'projects', 'rich-context');
  fs.mkdirSync(repo, { recursive: true });
  const body = [
    '## Architecture',
    'This is a NIP-23 long-form publishing app.',
    '',
    '## Wiki namespaces',
    '- nostr-protocol',
    '- nostr-apps',
    '',
    '## Conventions',
    '- All commits signed via Amber.',
  ].join('\n');
  fs.writeFileSync(path.join(repo, 'project-context.md'), body);
  assert.equal(readProjectContext(repo), body);
});

// ── buildAiContext integration — overlay actually shows up ────────────────

interface ProjectShape {
  id: string;
  name: string;
  path: string | null;
  capabilities: { git: boolean; ngit: boolean; nsite: boolean };
  identity: { useDefault: boolean; npub: string | null; bunkerUrl: string | null };
  remotes: { github: string | null; ngit: string | null };
  nsite: { url: string | null; lastDeploy: string | null };
  readRelays: string[] | null;
  createdAt: string;
  updatedAt: string;
}

function makeProject(overrides: Partial<ProjectShape>): ProjectShape {
  return {
    id:   'overlay-test',
    name: 'overlay-test',
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

// Helper: write a project to the registry so getProject can find it.
// Mirrors the store layout used by src/lib/projects.ts.
function registerProject(p: ProjectShape): void {
  const dir = path.join(HOME, '.config', 'nostr-station');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([p], null, 2));
}

test('buildAiContext: overlay appears under "## Project context overlay" when present', () => {
  const repo = path.join(HOME, 'projects', 'with-overlay');
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, 'project-context.md'),
    '- target NIP-23\n- all signing via Amber\n');
  registerProject(makeProject({
    id: 'overlay-test', name: 'with-overlay', path: repo,
    capabilities: { git: false, ngit: false, nsite: false },
  }));

  const ctx = buildAiContext('overlay-test');
  assert.match(ctx.text, /## Project context overlay/);
  assert.match(ctx.text, /from `project-context\.md` at the project root/);
  assert.match(ctx.text, /target NIP-23/);
  assert.match(ctx.text, /all signing via Amber/);
});

test('buildAiContext: NO overlay header when project-context.md is missing', () => {
  // Crucial: silent omission — the section header would be confusing
  // with no body, and the spec explicitly says no auto-create.
  const repo = path.join(HOME, 'projects', 'no-overlay');
  fs.mkdirSync(repo, { recursive: true });
  // intentionally no project-context.md
  registerProject(makeProject({
    id: 'overlay-test', name: 'no-overlay', path: repo,
    capabilities: { git: false, ngit: false, nsite: false },
  }));

  const ctx = buildAiContext('overlay-test');
  assert.doesNotMatch(ctx.text, /Project context overlay/);
});

test('buildAiContext: overlay sits AFTER README excerpt in the prompt', () => {
  // Spec'd order: header → README → overlay. The brief says tail
  // placement gives the most intentional guidance the best survival
  // odds in pathological-truncation scenarios. Pin it here so a
  // future refactor can't quietly invert the order.
  const repo = path.join(HOME, 'projects', 'order-check');
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, 'README.md'), '# the readme\n\nproject readme body\n');
  fs.writeFileSync(path.join(repo, 'project-context.md'), 'overlay-marker-line\n');
  registerProject(makeProject({
    id: 'overlay-test', name: 'order-check', path: repo,
    capabilities: { git: false, ngit: false, nsite: false },
  }));

  const ctx = buildAiContext('overlay-test');
  const readmeAt  = ctx.text.indexOf('## README excerpt');
  const overlayAt = ctx.text.indexOf('## Project context overlay');
  assert.ok(readmeAt > 0,  `expected README section, got: ${ctx.text}`);
  assert.ok(overlayAt > 0, `expected overlay section, got: ${ctx.text}`);
  assert.ok(overlayAt > readmeAt,
    `overlay (${overlayAt}) must come AFTER README (${readmeAt})`);
});
