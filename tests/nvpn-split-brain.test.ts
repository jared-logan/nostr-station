import { test } from 'node:test';
import assert from 'node:assert/strict';

import { reconcile } from '../src/lib/nvpn-split-brain.js';

test('reconcile: both daemons alive → splitBrain true', () => {
  const r = reconcile(
    { origin: 'user',    pidFile: '/home/x/.config/nvpn/daemon.pid', pid: 1234, alive: true },
    { origin: 'systemd', pidFile: '/root/.config/nvpn/daemon.pid',    pid: 5678, alive: true },
  );
  assert.equal(r.splitBrain, true);
  assert.ok(r.summary.includes('Two nvpn daemons'));
});

test('reconcile: only user daemon alive → not split-brain', () => {
  const r = reconcile(
    { origin: 'user',    pidFile: 'p', pid: 1234, alive: true },
    { origin: 'systemd', pidFile: 'q', pid: 5678, alive: false },
  );
  assert.equal(r.splitBrain, false);
  assert.ok(r.summary.includes('user-mode'));
});

test('reconcile: only systemd daemon alive → not split-brain', () => {
  const r = reconcile(
    { origin: 'user',    pidFile: 'p', pid: 1234, alive: false },
    { origin: 'systemd', pidFile: 'q', pid: 5678, alive: true },
  );
  assert.equal(r.splitBrain, false);
  assert.ok(r.summary.includes('systemd'));
});

test('reconcile: neither daemon alive → not split-brain', () => {
  const r = reconcile(null, null);
  assert.equal(r.splitBrain, false);
  assert.ok(r.summary.includes('No nvpn'));
});

test('reconcile: user PID file present but process dead → not split-brain', () => {
  const r = reconcile(
    { origin: 'user',    pidFile: 'p', pid: 1234, alive: false },
    { origin: 'systemd', pidFile: 'q', pid: 5678, alive: true },
  );
  assert.equal(r.splitBrain, false);
});
