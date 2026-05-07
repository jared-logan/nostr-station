// Regression: the Config panel reads /api/config to display the "Context"
// row. Before this fix, getContextStatus() always reported the project
// currently active in chat — so opening project "blip" in chat and then
// navigating to Config flipped the row from the global station context to
// "project: blip". The Config panel now requests scope='global', which must
// describe the station context regardless of chat state.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { useTempHome, resetTempHome } from './_home.js';

const HOME = useTempHome();

const { getContextStatus } = await import('../src/lib/web-server.js');
const { setActiveChatProjectId } = await import('../src/lib/routes/_shared.js');

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

beforeEach(() => {
  resetTempHome(HOME);
  setActiveChatProjectId(null);
});

test('scope="global" reports station context even when a project is active in chat', () => {
  registerProject(makeProject('blip'));
  setActiveChatProjectId('blip');

  // 'active' (chat header) still tracks the live chat project.
  const active = getContextStatus('active');
  assert.equal(active.source, 'project');
  assert.equal(active.projectName, 'blip');

  // 'global' (Config panel) ignores chat state.
  const global = getContextStatus('global');
  assert.equal(global.source, 'station');
  assert.equal(global.projectName, undefined);
});

test('scope defaults to "active" so existing chat-header callers are unaffected', () => {
  registerProject(makeProject('blip'));
  setActiveChatProjectId('blip');

  const def = getContextStatus();
  assert.equal(def.source, 'project');
  assert.equal(def.projectName, 'blip');
});

test('with no project active, both scopes report station', () => {
  setActiveChatProjectId(null);

  assert.equal(getContextStatus('active').source, 'station');
  assert.equal(getContextStatus('global').source, 'station');
});
