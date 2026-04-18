import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { useTempHome, resetTempHome } from './_home.js';

const HOME = useTempHome();

// Import after HOME is pinned so the module's runtime homedir() lookups
// land in our tmpdir. projects.ts resolves paths per-call (not at load
// time), so static import would also work — but matching the ai-config
// pattern keeps both files uniform.
const {
  createProject,
  updateProject,
  deleteProject,
  readProjects,
  getProject,
  // @ts-expect-error — imported at runtime, not checked against .d.ts
} = await import('../src/lib/projects.ts');

beforeEach(() => resetTempHome(HOME));

// ── Validation / creation branches ────────────────────────────────────────

test('createProject: rejects empty name', () => {
  const r = createProject({
    name: '',
    path: '/tmp/proj',
    capabilities: { git: false, ngit: false, nsite: false },
    identity: { useDefault: true, npub: null, bunkerUrl: null },
    remotes: { github: null, ngit: null },
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /name/i);
});

test('createProject: rejects zero-capability project with no path', () => {
  const r = createProject({
    name: 'orphan',
    path: null,
    capabilities: { git: false, ngit: false, nsite: false },
    identity: { useDefault: true, npub: null, bunkerUrl: null },
    remotes: { github: null, ngit: null },
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /path or a capability/i);
});

test('createProject: local-only (path, no caps) is valid', () => {
  const r = createProject({
    name: 'local-only',
    path: '/tmp/local-only',
    capabilities: { git: false, ngit: false, nsite: false },
    identity: { useDefault: true, npub: null, bunkerUrl: null },
    remotes: { github: null, ngit: null },
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.project.path, '/tmp/local-only');
    assert.equal(r.project.capabilities.git, false);
  }
});

test('createProject: git capability requires a local path', () => {
  const r = createProject({
    name: 'no-path-git',
    path: null,
    capabilities: { git: true, ngit: false, nsite: false },
    identity: { useDefault: true, npub: null, bunkerUrl: null },
    remotes: { github: 'https://github.com/x/y', ngit: null },
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /require a local path/i);
});

test('createProject: ngit capability requires a local path', () => {
  const r = createProject({
    name: 'no-path-ngit',
    path: null,
    capabilities: { git: false, ngit: true, nsite: false },
    identity: { useDefault: true, npub: null, bunkerUrl: null },
    remotes: { github: null, ngit: 'nostr://naddr1...' },
  });
  assert.equal(r.ok, false);
});

test('createProject: nsite-only (no path) is the documented exception', () => {
  const r = createProject({
    name: 'nsite-only',
    path: null,
    capabilities: { git: false, ngit: false, nsite: true },
    identity: { useDefault: true, npub: null, bunkerUrl: null },
    remotes: { github: null, ngit: null },
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.project.path, null);
    assert.equal(r.project.capabilities.nsite, true);
  }
});

// ── Path-collision guard ──────────────────────────────────────────────────

test('createProject: duplicate path is rejected with actionable error', () => {
  const first = createProject({
    name: 'orig',
    path: '/tmp/dup-test',
    capabilities: { git: true, ngit: false, nsite: false },
    identity: { useDefault: true, npub: null, bunkerUrl: null },
    remotes: { github: 'https://github.com/x/y', ngit: null },
  });
  assert.equal(first.ok, true);

  const second = createProject({
    name: 'same-path-different-name',
    path: '/tmp/dup-test',
    capabilities: { git: true, ngit: false, nsite: false },
    identity: { useDefault: true, npub: null, bunkerUrl: null },
    remotes: { github: null, ngit: null },
  });
  assert.equal(second.ok, false);
  if (!second.ok) {
    assert.match(second.error, /already exists/i);
    // Error must name the conflicting project so the user can locate it
    // in the UI — verified because users hit this during scaffold-then-
    // adopt flows where the dup looks like a bug.
    assert.match(second.error, /orig/);
  }
});

// ── Credential scrubbing ──────────────────────────────────────────────────

test('createProject: strips embedded basic-auth from git remote', () => {
  const r = createProject({
    name: 'with-creds',
    path: '/tmp/with-creds',
    capabilities: { git: true, ngit: false, nsite: false },
    identity: { useDefault: true, npub: null, bunkerUrl: null },
    remotes: {
      github: 'https://oauth2:ghp_SECRETTOKEN@github.com/owner/repo.git',
      ngit: null,
    },
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.project.remotes.github, 'https://github.com/owner/repo.git');
    // Explicit guard — easy to regress if someone edits stripCredentials.
    assert.doesNotMatch(r.project.remotes.github ?? '', /ghp_SECRETTOKEN/);
  }
});

// ── Identity ──────────────────────────────────────────────────────────────

test('createProject: custom identity requires valid npub', () => {
  const r = createProject({
    name: 'custom-id',
    path: '/tmp/custom-id',
    capabilities: { git: false, ngit: false, nsite: false },
    identity: { useDefault: false, npub: 'not-an-npub', bunkerUrl: null },
    remotes: { github: null, ngit: null },
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /npub must be/i);
});

test('createProject: custom identity rejects nsec', () => {
  const r = createProject({
    name: 'leaky',
    path: '/tmp/leaky',
    capabilities: { git: false, ngit: false, nsite: false },
    identity: { useDefault: false, npub: 'nsec1leakthisplease', bunkerUrl: null },
    remotes: { github: null, ngit: null },
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /nsec/i);
});

test('createProject: hex pubkey accepted for custom identity', () => {
  const r = createProject({
    name: 'hex-id',
    path: '/tmp/hex-id',
    capabilities: { git: false, ngit: false, nsite: false },
    identity: { useDefault: false, npub: 'a'.repeat(64), bunkerUrl: null },
    remotes: { github: null, ngit: null },
  });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.project.identity.npub, 'a'.repeat(64));
});

// ── updateProject ─────────────────────────────────────────────────────────

test('updateProject: toggling capability off clears its remote', () => {
  const created = createProject({
    name: 'toggle',
    path: '/tmp/toggle',
    capabilities: { git: true, ngit: false, nsite: false },
    identity: { useDefault: true, npub: null, bunkerUrl: null },
    remotes: { github: 'https://github.com/x/y', ngit: null },
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const updated = updateProject(created.project.id, {
    capabilities: { git: false, ngit: false, nsite: false },
  });
  // Zero-capability + path is a valid local-only shape, so the update
  // succeeds — the real invariant under test is that the github remote
  // gets cleared when its capability is turned off.
  assert.equal(updated.ok, true);
  if (updated.ok) {
    assert.equal(updated.project.remotes.github, null);
    assert.equal(updated.project.capabilities.git, false);
  }
});

test('updateProject: useDefault=true clears custom npub/bunker', () => {
  const created = createProject({
    name: 'custom-then-default',
    path: '/tmp/custom-then-default',
    capabilities: { git: false, ngit: false, nsite: false },
    identity: { useDefault: false, npub: 'a'.repeat(64), bunkerUrl: 'bunker://xyz' },
    remotes: { github: null, ngit: null },
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const updated = updateProject(created.project.id, {
    identity: { useDefault: true, npub: 'a'.repeat(64), bunkerUrl: 'bunker://xyz' },
  });
  assert.equal(updated.ok, true);
  if (updated.ok) {
    assert.equal(updated.project.identity.npub, null);
    assert.equal(updated.project.identity.bunkerUrl, null);
  }
});

test('updateProject: unknown id returns error', () => {
  const r = updateProject('does-not-exist', { name: 'new' });
  assert.equal(r.ok, false);
});

// ── deleteProject + registry round-trip ───────────────────────────────────

test('deleteProject: removes from registry', () => {
  const r = createProject({
    name: 'doomed',
    path: '/tmp/doomed',
    capabilities: { git: false, ngit: false, nsite: true },
    identity: { useDefault: true, npub: null, bunkerUrl: null },
    remotes: { github: null, ngit: null },
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;

  assert.equal(readProjects().length, 1);
  const d = deleteProject(r.project.id);
  assert.equal(d.ok, true);
  assert.equal(readProjects().length, 0);
  assert.equal(getProject(r.project.id), null);
});

test('readProjects: tolerates missing file', () => {
  assert.deepEqual(readProjects(), []);
});
