// The user-editable NOSTR_STATION.md is now an always-on layer that
// reaches the live /api/ai/chat path (previously only the legacy /api/chat
// proxy read it). These tests pin the layering rules:
//
//   - Markers present + non-empty user region → splice the user region.
//   - Markers present + empty user region     → splice nothing (seeded but unedited).
//   - Markers absent + non-empty file         → splice the whole file (free-form).
//   - File missing                            → splice nothing.
//
// And: the layer is independent of which project is active in chat —
// opening a project doesn't drop the station notes.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { useTempHome, resetTempHome } from './_home.js';

const HOME = useTempHome();

const aiCtx       = await import('../src/lib/ai-context.js');
const editor      = await import('../src/lib/editor.js');
const { buildAiContext, readStationContext, stationContextPath } = aiCtx;
const { USER_REGION_BEGIN, USER_REGION_END } = editor;

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

function registerProject(p: Project): void {
  const dir = path.join(HOME, '.config', 'nostr-station');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([p], null, 2));
}

function makeProject(name: string): Project {
  return {
    id: name,
    name,
    path: null,
    capabilities: { git: false, ngit: false, nsite: false },
    identity: { useDefault: true, npub: null, bunkerUrl: null },
    remotes: { github: null, ngit: null },
    nsite: { url: null, lastDeploy: null },
    readRelays: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function writeStationFile(content: string): void {
  const p = stationContextPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

beforeEach(() => resetTempHome(HOME));

// ── readStationContext() ──────────────────────────────────────────────────

test('returns null when file missing', () => {
  assert.equal(readStationContext(), null);
});

test('splices only the user region when markers are present', () => {
  const file = `# Persona text we don't want duplicated\n\n${USER_REGION_BEGIN}\n\nHello from my notes.\n\n${USER_REGION_END}\n\n---\n*footer*`;
  writeStationFile(file);
  const r = readStationContext();
  assert.equal(r, 'Hello from my notes.');
});

test('returns null when markers are present but the user region is empty', () => {
  const file = `# Persona\n\n${USER_REGION_BEGIN}\n\n${USER_REGION_END}\n`;
  writeStationFile(file);
  assert.equal(readStationContext(), null);
});

test('splices the whole file when markers are absent (free-form rewrite)', () => {
  const file = '# My custom notes\n\nNothing fenced — this should all reach chat.';
  writeStationFile(file);
  assert.equal(readStationContext(), file);
});

// ── buildAiContext() integration ──────────────────────────────────────────

test('user-region notes appear in the rendered system prompt (no project)', () => {
  writeStationFile(
    `# Persona\n\n${USER_REGION_BEGIN}\n\nMy private wiki namespace is acme/nostr.\n\n${USER_REGION_END}\n`,
  );
  const ctx = buildAiContext(null);
  assert.match(ctx.text, /My private wiki namespace is acme\/nostr\./);
  assert.match(ctx.text, /# Station context/);
  // Persona section above the markers must NOT be duplicated into the
  // prompt — DEFAULT_PROMPT_TEMPLATE already supplies it.
  assert.equal(ctx.text.match(/# Persona/g), null);
});

test('user-region notes appear when a project is active too (layering, not replacement)', () => {
  registerProject(makeProject('blip'));
  writeStationFile(
    `${USER_REGION_BEGIN}\nLocal relay listens on :7777.\n${USER_REGION_END}`,
  );
  const ctx = buildAiContext('blip');
  // Station notes layer in regardless of project state.
  assert.match(ctx.text, /Local relay listens on :7777\./);
  // Project info still appears alongside.
  assert.match(ctx.text, /Active project: blip/);
});

test('rendered prompt omits the Station context heading when the file is empty', () => {
  // No file at all.
  const ctx = buildAiContext(null);
  assert.equal(ctx.text.includes('# Station context'), false);
});

test('free-form (no markers) station file is spliced under the Station context heading', () => {
  writeStationFile('Just a one-liner.');
  const ctx = buildAiContext(null);
  assert.match(ctx.text, /# Station context[\s\S]+Just a one-liner\./);
});
