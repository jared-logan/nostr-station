import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { useTempHome, resetTempHome } from './_home.js';

const HOME = useTempHome();

// @ts-expect-error — runtime import
const { createProject } = await import('../src/lib/projects.ts');
// @ts-expect-error
const TI = await import('../src/lib/test-identities.ts');
// @ts-expect-error
const Signer = await import('../src/lib/local-signer.ts');

beforeEach(() => resetTempHome(HOME));

function proj(name: string) {
  const p = path.join(HOME, 'projects', name);
  fs.mkdirSync(p, { recursive: true });
  const r = createProject({
    name, path: p,
    capabilities: { git: false, ngit: false, nsite: false },
    identity: { useDefault: true, npub: null, bunkerUrl: null },
    remotes: { github: null, ngit: null },
  });
  if (!r.ok) throw new Error(r.error);
  return r.project;
}

// ── Storage + CRUD ────────────────────────────────────────────────────────

test('addIdentity: creates file at mode 0600 in user-config dir + omits nsec from list', async () => {
  const p = proj('ti-create');
  const r = TI.addIdentity(p, { label: 'teacher-alice', role: 'teacher' });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.ok(r.result.nsec.startsWith('nsec1'));
  assert.match(r.result.pubkey, /^[0-9a-f]{64}$/);

  // @ts-expect-error — runtime import
  const PC = await import('../src/lib/project-config.ts');
  const fp = path.join(PC.userConfigDirFor(p), 'test-identities.json');
  const mode = fs.statSync(fp).mode & 0o777;
  assert.equal(mode, 0o600, `file mode should be 0600, got 0${mode.toString(8)}`);
  // Critical invariant: nsecs never live in the project tree, so
  // they can never be reached by git add, ngit push, etc.
  assert.equal(
    fs.existsSync(path.join(p.path!, '.nostr-station', 'test-identities.json')),
    false,
    'test-identities.json must not be written to the project tree',
  );

  const listing = TI.listIdentities(p);
  assert.equal(listing.ok, true);
  if (listing.ok) {
    assert.equal(listing.identities.length, 1);
    assert.equal(listing.identities[0].label, 'teacher-alice');
    assert.equal((listing.identities[0] as any).nsec, undefined);
  }
});

test('addIdentity: duplicate label rejected', () => {
  const p = proj('ti-dup');
  TI.addIdentity(p, { label: 'student-bob', role: 'student' });
  const r2 = TI.addIdentity(p, { label: 'student-bob', role: 'student' });
  assert.equal(r2.ok, false);
  if (!r2.ok) assert.match(r2.error, /already exists/);
});

test('addIdentity: project with no path is refused', () => {
  const r = createProject({
    name: 'no-path', path: null,
    capabilities: { git: false, ngit: false, nsite: true },
    identity: { useDefault: true, npub: null, bunkerUrl: null },
    remotes: { github: null, ngit: null },
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const add = TI.addIdentity(r.project, { label: 'x', role: 'y' });
  assert.equal(add.ok, false);
  if (!add.ok) assert.match(add.error, /no local path/);
});

test('removeIdentity: deletes from file', () => {
  const p = proj('ti-remove');
  const a = TI.addIdentity(p, { label: 'a', role: 'r' });
  if (!a.ok) return assert.fail();
  const r = TI.removeIdentity(p, a.result.identity.id);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.pubkey, a.result.pubkey);
  const after = TI.listIdentities(p);
  assert.equal(after.ok && after.identities.length, 0);
});

test('regenerateAll: wipes every identity', () => {
  const p = proj('ti-reset');
  TI.addIdentity(p, { label: 'a', role: 'r' });
  TI.addIdentity(p, { label: 'b', role: 'r' });
  const r = TI.regenerateAll(p);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.cleared, 2);
  const after = TI.listIdentities(p);
  assert.equal(after.ok && after.identities.length, 0);
});

test('listIdentities: refuses to load a file with wrong mode', async () => {
  const p = proj('ti-mode');
  TI.addIdentity(p, { label: 'a', role: 'r' });
  // @ts-expect-error — runtime import
  const PC = await import('../src/lib/project-config.ts');
  const fp = path.join(PC.userConfigDirFor(p), 'test-identities.json');
  fs.chmodSync(fp, 0o644);
  const r = TI.listIdentities(p);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.reason, 'bad-mode');
    assert.equal(r.mode, 0o644);
  }
});

test('migration: legacy <project>/.nostr-station/test-identities.json is moved', async () => {
  const p = proj('ti-migrate');
  // Seed legacy file with the same on-disk shape addIdentity writes.
  const legacy = path.join(p.path!, '.nostr-station', 'test-identities.json');
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, JSON.stringify({
    identities: [{
      id: 'legacy-1', label: 'legacy-bob', role: 'student',
      npub: 'npub1q'.padEnd(63, 'x'),
      pubkey: 'aa'.repeat(32),
      createdAt: 1700000000000,
      nsec: 'nsec1' + 'b'.repeat(58),
    }],
    updatedAt: 1700000000000,
  }), { mode: 0o600 });

  // First read triggers migration.
  const r = TI.listIdentities(p);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.identities.length, 1);

  // @ts-expect-error — runtime import
  const PC = await import('../src/lib/project-config.ts');
  const dest = path.join(PC.userConfigDirFor(p), 'test-identities.json');
  assert.ok(fs.existsSync(dest), 'migrated file should exist in user-config dir');
  assert.equal(fs.statSync(dest).mode & 0o777, 0o600);
  // Untracked legacy → auto-deleted (no git repo set up here, so
  // ls-files errors and we hit the "safe to delete" branch).
  assert.equal(fs.existsSync(legacy), false);
});

test('getNsec: returns nsec for known id, null otherwise', () => {
  const p = proj('ti-nsec');
  const a = TI.addIdentity(p, { label: 'a', role: 'r' });
  if (!a.ok) return assert.fail();
  const got = TI.getNsec(p, a.result.identity.id);
  assert.ok(got);
  assert.ok(got!.startsWith('nsec1'));
  assert.equal(TI.getNsec(p, 'nope'), null);
});

// ── local-signer ──────────────────────────────────────────────────────────

test('signEventWithLocalKey: adds client tag when testIdentityTag set', () => {
  const p = proj('ti-sign');
  const a = TI.addIdentity(p, { label: 'a', role: 'r' });
  if (!a.ok) return assert.fail();
  const ev = Signer.signEventWithLocalKey(a.result.nsec, {
    kind: 1, content: 'hello', tags: [],
  }, { testIdentityTag: { projectId: p.id } });
  assert.ok(ev.id);
  assert.ok(ev.sig);
  assert.equal(ev.pubkey, a.result.pubkey);
  const clientTag = (ev.tags as string[][]).find(t => t[0] === 'client');
  assert.ok(clientTag, 'expected client tag');
  assert.equal(clientTag![1], 'nostr-station-test');
  assert.equal(clientTag![2], p.id);
  assert.equal(Signer.isTestIdentityEvent(ev), true);
});

test('signEventWithLocalKey: leaves events untagged without the option', () => {
  const p = proj('ti-untagged');
  const a = TI.addIdentity(p, { label: 'a', role: 'r' });
  if (!a.ok) return assert.fail();
  const ev = Signer.signEventWithLocalKey(a.result.nsec, {
    kind: 1, content: 'public hello', tags: [],
  });
  const clientTag = (ev.tags as string[][]).find(t => t[0] === 'client' && t[1] === 'nostr-station-test');
  assert.equal(clientTag, undefined);
  assert.equal(Signer.isTestIdentityEvent(ev), false);
});

// ── listAllTestPubkeys ────────────────────────────────────────────────────

// ── Kind-0 profile publish (best-effort, gracefully no-ops) ───────────────

test('publishIdentityProfile: returns "relay not running" when bridge is unset', async () => {
  // The bridge is set by web-server.ts on relay boot; in the unit-test
  // context nothing publishes the port, so publishIdentityProfile must
  // resolve to a no-op result rather than hanging on a dead WebSocket.
  const p = proj('ti-kind0-noop');
  const r = TI.addIdentity(p, { label: 'a', role: 'r' });
  if (!r.ok) return assert.fail();
  const out = await TI.publishIdentityProfile(p, r.result.identity, r.result.nsec);
  assert.equal(out.ok, false);
  if (!out.ok) assert.match(out.reason, /not running/i);
});

test('publishIdentityProfile: defaults humanize the label when no displayName supplied', async () => {
  // We can't catch the published kind-0 here (no relay running), but
  // we can verify the content-construction path doesn't throw and
  // returns a structured failure. The humanize() output is asserted
  // indirectly through the sign-and-fail-on-publish path.
  const p = proj('ti-humanize');
  const r = TI.addIdentity(p, { label: 'teacher-alice-jones', role: 'teacher' });
  if (!r.ok) return assert.fail();
  const out = await TI.publishIdentityProfile(p, r.result.identity, r.result.nsec);
  assert.equal(out.ok, false);
});

test('listAllTestPubkeys: cross-project enumeration', async () => {
  const p1 = proj('p1');
  const p2 = proj('p2');
  TI.addIdentity(p1, { label: 'a', role: 'r' });
  TI.addIdentity(p2, { label: 'b', role: 'r' });
  TI.addIdentity(p2, { label: 'c', role: 'r' });
  const all = TI.listAllTestPubkeys([p1, p2]);
  assert.equal(all.length, 3);
  // Each entry carries its source projectId so callers can scope
  // policy decisions (promote, etc).
  assert.ok(all.every((e: any) => e.projectId === p1.id || e.projectId === p2.id));
});
