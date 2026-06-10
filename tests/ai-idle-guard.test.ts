import { test } from 'node:test';
import assert from 'node:assert/strict';

const { makeIdleGuard, rethrowIdleAware, STREAM_IDLE_TIMEOUT_MS } =
  await import('../src/lib/ai-tools/idle-guard.ts');

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

test('idle guard: aborts after the idle window with no touch', async () => {
  const guard = makeIdleGuard(20);
  assert.equal(guard.signal.aborted, false);
  await sleep(60);
  assert.equal(guard.signal.aborted, true);
  assert.equal(guard.timedOut(), true);
  guard.clear();
});

test('idle guard: touch() re-arms the timer — an active stream never trips it', async () => {
  const guard = makeIdleGuard(40);
  for (let i = 0; i < 4; i++) {
    await sleep(15);
    guard.touch();
  }
  assert.equal(guard.signal.aborted, false);
  assert.equal(guard.timedOut(), false);
  guard.clear();
  // After clear, the timer is dead — no late abort.
  await sleep(60);
  assert.equal(guard.signal.aborted, false);
});

test('idle guard: clear() before expiry prevents the abort', async () => {
  const guard = makeIdleGuard(20);
  guard.clear();
  await sleep(50);
  assert.equal(guard.signal.aborted, false);
  assert.equal(guard.timedOut(), false);
});

test('rethrowIdleAware: maps a guard abort to an actionable provider message', async () => {
  const guard = makeIdleGuard(10);
  await sleep(40);
  assert.equal(guard.timedOut(), true);
  assert.throws(
    () => rethrowIdleAware(new Error('aborted'), guard, 'Anthropic'),
    (e: Error) => e.message.includes('Anthropic stream stalled')
               && e.message.includes(`${Math.round(STREAM_IDLE_TIMEOUT_MS / 1000)}s`),
  );
  guard.clear();
});

test('rethrowIdleAware: passes through failures the guard did not cause', () => {
  const guard = makeIdleGuard(10_000);
  const original = new Error('ECONNRESET');
  assert.throws(
    () => rethrowIdleAware(original, guard, 'Anthropic'),
    (e: Error) => e === original,
  );
  guard.clear();
});
