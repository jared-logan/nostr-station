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

test('addIdentity: creates file at mode 0600 + omits nsec from list', () => {
  const p = proj('ti-create');
  const r = TI.addIdentity(p, { label: 'teacher-alice', role: 'teacher' });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.ok(r.result.nsec.startsWith('nsec1'));
  assert.match(r.result.pubkey, /^[0-9a-f]{64}$/);

  const fp = path.join(p.path!, '.nostr-station', 'test-identities.json');
  const mode = fs.statSync(fp).mode & 0o777;
  assert.equal(mode, 0o600, `file mode should be 0600, got 0${mode.toString(8)}`);

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

test('listIdentities: refuses to load a file with wrong mode', () => {
  const p = proj('ti-mode');
  TI.addIdentity(p, { label: 'a', role: 'r' });
  const fp = path.join(p.path!, '.nostr-station', 'test-identities.json');
  fs.chmodSync(fp, 0o644);
  const r = TI.listIdentities(p);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.reason, 'bad-mode');
    assert.equal(r.mode, 0o644);
  }
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
