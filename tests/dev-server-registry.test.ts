import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Module-level state inside dev-server-registry is intentional (in-memory
// only, per-process). We re-import via a fresh module URL each suite so
// the assertions don't bleed across tests.
let reg: typeof import('../src/lib/dev-server-registry.ts');

beforeEach(async () => {
  // Each test gets a fresh module instance — no global reset hook to call.
  reg = await import('../src/lib/dev-server-registry.ts?ts=' + Date.now());
});

test('allocatePort: assigns the base port to the first project', () => {
  const p = reg.allocatePort('proj-A');
  assert.equal(p, 5173);
});

test('allocatePort: is sticky — same project gets the same port', () => {
  const first  = reg.allocatePort('proj-A');
  const second = reg.allocatePort('proj-A');
  assert.equal(first, second);
});

test('allocatePort: assigns distinct ports to distinct projects', () => {
  const a = reg.allocatePort('proj-A');
  const b = reg.allocatePort('proj-B');
  const c = reg.allocatePort('proj-C');
  assert.notEqual(a, b);
  assert.notEqual(b, c);
  assert.notEqual(a, c);
});

test('allocatePort: skips the reserved relay / web-UI / inproc-relay ports', () => {
  // Allocate enough that a naive incrementing allocator would hit 8080.
  const ports = new Set<number>();
  for (let i = 0; i < 30; i++) {
    ports.add(reg.allocatePort(`p-${i}`));
  }
  assert.ok(!ports.has(3000), '3000 should be reserved (web UI)');
  assert.ok(!ports.has(7777), '7777 should be reserved (in-proc relay)');
  assert.ok(!ports.has(8080), '8080 should be reserved (relay)');
});

test('bindSession + getState: running flag reflects the bind', () => {
  reg.allocatePort('proj-A');
  assert.equal(reg.getState('proj-A')?.running, false);
  reg.bindSession('proj-A', 'session-1');
  const s = reg.getState('proj-A');
  assert.equal(s?.running, true);
  assert.equal(s?.sessionId, 'session-1');
  assert.ok(typeof s?.startedAt === 'number');
});

test('releaseSession: clears the running flag but keeps the port', () => {
  const port = reg.allocatePort('proj-A');
  reg.bindSession('proj-A', 'session-1');
  reg.releaseSession('session-1');
  const s = reg.getState('proj-A');
  assert.equal(s?.running, false);
  assert.equal(s?.sessionId, null);
  // Port survives release so a restart lands on the same socket.
  assert.equal(s?.port, port);
});

test('releaseSession: idempotent for unknown sessions', () => {
  // Must not throw — terminal.ts calls it from destroySession unconditionally.
  reg.releaseSession('never-bound');
});

test('bindSession: a newer session for the same project supersedes the old one', () => {
  reg.allocatePort('proj-A');
  reg.bindSession('proj-A', 'session-1');
  reg.bindSession('proj-A', 'session-2');
  assert.equal(reg.getState('proj-A')?.sessionId, 'session-2');
  // Releasing the old (now-detached) session must not flip the registry off.
  reg.releaseSession('session-1');
  assert.equal(reg.getState('proj-A')?.running, true);
  assert.equal(reg.getState('proj-A')?.sessionId, 'session-2');
});

test('forgetProject: drops allocation + session binding', () => {
  reg.allocatePort('proj-A');
  reg.bindSession('proj-A', 'session-1');
  reg.forgetProject('proj-A');
  assert.equal(reg.getState('proj-A'), null);
  // Subsequent allocation may reuse the freed port.
  const reuse = reg.allocatePort('proj-B');
  assert.equal(reuse, 5173);
});

test('projectForSession: maps active bindings back to projectIds', () => {
  reg.allocatePort('proj-A');
  reg.bindSession('proj-A', 'session-1');
  assert.equal(reg.projectForSession('session-1'), 'proj-A');
  reg.releaseSession('session-1');
  assert.equal(reg.projectForSession('session-1'), null);
});

test('getState: returns null for projects with no allocation', () => {
  assert.equal(reg.getState('never-allocated'), null);
});

test('getState.url: matches the assigned port', () => {
  reg.allocatePort('proj-A');
  const s = reg.getState('proj-A');
  assert.equal(s?.url, `http://localhost:${s?.port}`);
});
