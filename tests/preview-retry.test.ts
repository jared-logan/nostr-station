import { test } from 'node:test';
import assert from 'node:assert/strict';

// Pure ES module — no DOM, no fetch, no timers. Loads fine in node:test.
// @ts-expect-error — runtime import of a .js module from src/web
const { previewRetryDecision, PREVIEW_BACKOFF_MS } =
  await import('../src/web/preview-retry.js');

// ── Backoff schedule pinned ──────────────────────────────────────────────

test('PREVIEW_BACKOFF_MS: 1 s / 3 s / 10 s, 3 attempts total', () => {
  // Spec'd shape from A2: "3 retries at 1s / 3s / 10s delay, then stop".
  // Pin so a future bump (or accidental sort) is a deliberate choice
  // and the storm regression has a tripwire.
  assert.deepEqual(PREVIEW_BACKOFF_MS, [1000, 3000, 10000]);
});

// ── attempt = 0 → first retry at 1 s ─────────────────────────────────────

test('previewRetryDecision: attempt=0 → retry after 1 s, nextAttempt=1', () => {
  const d = previewRetryDecision(0);
  assert.equal(d.action, 'retry');
  assert.equal(d.delayMs, 1000);
  assert.equal(d.nextAttempt, 1);
});

test('previewRetryDecision: attempt=1 → retry after 3 s, nextAttempt=2', () => {
  const d = previewRetryDecision(1);
  assert.equal(d.action, 'retry');
  assert.equal(d.delayMs, 3000);
  assert.equal(d.nextAttempt, 2);
});

test('previewRetryDecision: attempt=2 → retry after 10 s, nextAttempt=3', () => {
  const d = previewRetryDecision(2);
  assert.equal(d.action, 'retry');
  assert.equal(d.delayMs, 10000);
  assert.equal(d.nextAttempt, 3);
});

// ── attempt ≥ schedule length → circuit break ────────────────────────────

test('previewRetryDecision: attempt=3 → break (no fourth retry)', () => {
  // After 3 retries we surface the manual-retry affordance and stop
  // auto-firing — the storm A2 closes hinged on this branch never
  // existing, so the row must not include a delayMs / nextAttempt.
  const d = previewRetryDecision(3);
  assert.equal(d.action, 'break');
  assert.equal(d.delayMs, undefined);
  assert.equal(d.nextAttempt, undefined);
});

test('previewRetryDecision: attempt=99 → still break (no overflow into a delayMs)', () => {
  // Defence against an overflow edge case where a corrupted closure
  // count somehow bypassed the increment guard. Whatever the number,
  // exhausted budget = break.
  const d = previewRetryDecision(99);
  assert.equal(d.action, 'break');
});

// ── Defensive coercion of bad inputs ─────────────────────────────────────

test('previewRetryDecision: NaN → treated as 0 (retry from the top)', () => {
  // A buggy setState that wrote NaN into the counter must not skip the
  // budget check — that's a fast path back to the storm. Pinned.
  const d = previewRetryDecision(NaN);
  assert.equal(d.action, 'retry');
  assert.equal(d.delayMs, 1000);
  assert.equal(d.nextAttempt, 1);
});

test('previewRetryDecision: negative attempt → treated as 0', () => {
  const d = previewRetryDecision(-5);
  assert.equal(d.action, 'retry');
  assert.equal(d.delayMs, 1000);
  assert.equal(d.nextAttempt, 1);
});

test('previewRetryDecision: floating-point attempt → floored', () => {
  // Unlikely in practice but pinning tolerance — `2.7` should behave
  // exactly like `2` (the third retry).
  const d = previewRetryDecision(2.7);
  assert.equal(d.action, 'retry');
  assert.equal(d.delayMs, 10000);
  assert.equal(d.nextAttempt, 3);
});

// ── Custom backoff array (for forward-flexibility / future tuning) ───────

test('previewRetryDecision: caller can supply a custom backoff array', () => {
  // Lets callers experiment with a tighter schedule (e.g. for a more
  // forgiving endpoint) without a code change to the helper itself.
  const custom = [500, 2000];
  assert.deepEqual(
    previewRetryDecision(0, custom),
    { action: 'retry', delayMs: 500, nextAttempt: 1 },
  );
  assert.deepEqual(
    previewRetryDecision(1, custom),
    { action: 'retry', delayMs: 2000, nextAttempt: 2 },
  );
  // Past the end → break, same contract.
  assert.equal(previewRetryDecision(2, custom).action, 'break');
});
