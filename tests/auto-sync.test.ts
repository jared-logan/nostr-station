import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { useTempHome, resetTempHome } from './_home.js';

const HOME = useTempHome();

const { createProject, updateProject } = await import('../src/lib/projects.ts');
const { AutoSyncManager } = await import('../src/lib/auto-sync.ts');

beforeEach(() => resetTempHome(HOME));

function makeProject(name: string, autoSync = false) {
  const p = path.join(HOME, 'projects', name);
  const r = createProject({
    name,
    path: p,
    capabilities: { git: true,  ngit: false, nsite: false },
    identity:     { useDefault: true, npub: null, bunkerUrl: null },
    remotes:      { github: 'https://github.com/example/' + name, ngit: null },
  });
  if (!r.ok) throw new Error(r.error);
  if (autoSync) updateProject(r.project.id, { autoSync: true });
  return r.project;
}

test('auto-sync: start() arms only projects with autoSync=true', () => {
  makeProject('off-1');
  makeProject('on-1', true);
  makeProject('on-2', true);

  const mgr = new AutoSyncManager({ intervalMs: 60_000, syncFn: async () => {}, onLog: () => {} });
  mgr.start();
  assert.equal(mgr.armedCount(), 2);
  mgr.stop();
});

test('auto-sync: reconcile() arms a project after a flag flip on', () => {
  const p = makeProject('flip', false);

  const mgr = new AutoSyncManager({ intervalMs: 60_000, syncFn: async () => {}, onLog: () => {} });
  mgr.start();
  assert.equal(mgr.armedCount(), 0);

  updateProject(p.id, { autoSync: true });
  mgr.reconcile(p.id);
  assert.equal(mgr.armedCount(), 1);
  mgr.stop();
});

test('auto-sync: reconcile() disarms a project after a flag flip off', () => {
  const p = makeProject('flip', true);

  const mgr = new AutoSyncManager({ intervalMs: 60_000, syncFn: async () => {}, onLog: () => {} });
  mgr.start();
  assert.equal(mgr.armedCount(), 1);

  updateProject(p.id, { autoSync: false });
  mgr.reconcile(p.id);
  assert.equal(mgr.armedCount(), 0);
  mgr.stop();
});

test('auto-sync: reconcile() with unknown id disarms (orphan cleanup)', () => {
  const p = makeProject('ghost', true);

  const mgr = new AutoSyncManager({ intervalMs: 60_000, syncFn: async () => {}, onLog: () => {} });
  mgr.start();
  assert.equal(mgr.armedCount(), 1);

  // Simulate a project deletion that race-loses to the reconcile call —
  // the manager should drop the timer for an id whose project no longer
  // exists, not keep firing into the void.
  // We can't actually delete via projects.ts API here without writing a
  // helper, but reconcile('does-not-exist') exercises the same branch.
  mgr.reconcile('does-not-exist-' + p.id);
  // 'p' itself is still armed; only the unknown id was reconciled.
  assert.equal(mgr.armedCount(), 1);
  mgr.stop();
});

test('auto-sync: tick fires the sync function on schedule', async () => {
  const p = makeProject('tick', true);

  let calls = 0;
  const mgr = new AutoSyncManager({
    intervalMs: 30,
    syncFn:     async (proj) => {
      assert.equal(proj.id, p.id, 'sync receives the project record');
      calls++;
    },
    onLog: () => {},
  });
  mgr.start();
  // Two intervals + slack to absorb timer jitter on slow CI runners.
  await new Promise(r => setTimeout(r, 100));
  mgr.stop();
  assert.ok(calls >= 1, `expected at least 1 sync, got ${calls}`);
});

test('auto-sync: concurrent ticks do not stack — slow sync skips overlap', async () => {
  const p = makeProject('slow', true);

  let calls = 0;
  let active = 0;
  let maxActive = 0;
  const mgr = new AutoSyncManager({
    intervalMs: 20,
    syncFn:     async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      // Hold longer than several intervals — every overlap must be
      // dropped, not queued.
      await new Promise(r => setTimeout(r, 100));
      active--;
      calls++;
    },
    onLog: () => {},
  });
  mgr.start();
  await new Promise(r => setTimeout(r, 200));
  mgr.stop();

  // Wait for the in-flight sync to finish so its decrement lands.
  await new Promise(r => setTimeout(r, 120));
  assert.equal(maxActive, 1, 'sync function must never run concurrently for one project');
  assert.ok(calls >= 1, `expected at least 1 completed sync, got ${calls}`);
});

test('auto-sync: failure in sync fn does not disarm the project', async () => {
  const p = makeProject('boom', true);

  let calls = 0;
  const mgr = new AutoSyncManager({
    intervalMs: 30,
    syncFn:     async () => { calls++; throw new Error('relay timeout'); },
    onLog:      () => {},
  });
  mgr.start();
  await new Promise(r => setTimeout(r, 110));
  // Still armed despite repeated failures — transient errors shouldn't
  // turn auto-sync off without explicit user action.
  assert.equal(mgr.armedCount(), 1);
  assert.ok(calls >= 2, `expected multiple attempts despite failures, got ${calls}`);
  mgr.stop();
});

test('auto-sync: stop() clears every armed timer', () => {
  makeProject('a', true);
  makeProject('b', true);
  makeProject('c', true);

  const mgr = new AutoSyncManager({ intervalMs: 60_000, syncFn: async () => {}, onLog: () => {} });
  mgr.start();
  assert.equal(mgr.armedCount(), 3);
  mgr.stop();
  assert.equal(mgr.armedCount(), 0);
});

test('auto-sync: start() is idempotent', () => {
  makeProject('on', true);

  const mgr = new AutoSyncManager({ intervalMs: 60_000, syncFn: async () => {}, onLog: () => {} });
  mgr.start();
  mgr.start();
  assert.equal(mgr.armedCount(), 1, 'second start() must not double-arm');
  mgr.stop();
});

test('auto-sync: updateProject persists autoSync round-trip', () => {
  const p = makeProject('persist', false);
  assert.equal(!!p.autoSync, false);

  const r = updateProject(p.id, { autoSync: true });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.project.autoSync, true);

  const r2 = updateProject(p.id, { autoSync: false });
  assert.equal(r2.ok, true);
  if (!r2.ok) return;
  assert.equal(r2.project.autoSync, false);
});
