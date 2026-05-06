import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createSession, destroySession,
  awaitApproval, resolveApproval,
  _activeSessionCount, _pendingApprovalCount,
} from '../src/lib/ai-tools/approval-gate.js';

test('approve resolves the awaiting Promise', async () => {
  const sid = createSession();
  const { approvalId, promise } = awaitApproval(sid);
  resolveApproval(sid, approvalId, 'approve');
  assert.equal(await promise, 'approve');
  destroySession(sid);
});

test('reject resolves the awaiting Promise with reject', async () => {
  const sid = createSession();
  const { approvalId, promise } = awaitApproval(sid);
  resolveApproval(sid, approvalId, 'reject');
  assert.equal(await promise, 'reject');
  destroySession(sid);
});

test('resolveApproval returns false for unknown session', () => {
  assert.equal(resolveApproval('not-a-session', 'x', 'approve'), false);
});

test('resolveApproval returns false for unknown approvalId', () => {
  const sid = createSession();
  assert.equal(resolveApproval(sid, 'no-such-id', 'approve'), false);
  destroySession(sid);
});

test('resolveApproval is idempotent after first resolution', async () => {
  const sid = createSession();
  const { approvalId, promise } = awaitApproval(sid);
  assert.equal(resolveApproval(sid, approvalId, 'approve'), true);
  await promise;
  assert.equal(resolveApproval(sid, approvalId, 'approve'), false);
  destroySession(sid);
});

test('destroySession rejects pending approvals', async () => {
  const sid = createSession();
  const { promise } = awaitApproval(sid);
  destroySession(sid);
  assert.equal(await promise, 'reject');
});

test('multiple concurrent approvals on one session', async () => {
  const sid = createSession();
  const a = awaitApproval(sid);
  const b = awaitApproval(sid);
  assert.equal(_pendingApprovalCount(sid), 2);
  resolveApproval(sid, a.approvalId, 'approve');
  resolveApproval(sid, b.approvalId, 'reject');
  assert.equal(await a.promise, 'approve');
  assert.equal(await b.promise, 'reject');
  destroySession(sid);
});

test('session count tracks lifecycle', () => {
  const before = _activeSessionCount();
  const sid = createSession();
  assert.equal(_activeSessionCount(), before + 1);
  destroySession(sid);
  assert.equal(_activeSessionCount(), before);
});

test('destroySession unblocks an awaiter even with no resolve call', async () => {
  // Simulates a client disconnect: the chat handler destroys the
  // session in its req.on('close') handler; the tool-loop's awaiter
  // resolves with 'reject' so the loop unwinds cleanly instead of
  // hanging forever on a dangling Promise.
  const sid = createSession();
  const { promise } = awaitApproval(sid);
  // Simulate disconnect — no /api/ai/chat/approve call.
  destroySession(sid);
  const decision = await promise;
  assert.equal(decision, 'reject');
  // Session is gone — subsequent resolveApproval is a no-op.
  assert.equal(_pendingApprovalCount(sid), 0);
});
