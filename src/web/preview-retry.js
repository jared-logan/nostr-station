// Preview retry decision helper (A2).
//
// Pure ES module — no DOM, no fetch, no timers. Given the current
// consecutive-failure count for a single npub, returns either:
//   { action: 'retry', delayMs, nextAttempt }  — schedule another fetch
//   { action: 'break' }                         — give up; surface manual retry
//
// 3 retries at 1 s / 3 s / 10 s, then circuit-break. Caller is
// responsible for:
//   - resetting `attempt` to 0 whenever the user changes the npub
//     (a fresh subject deserves a fresh budget)
//   - skipping the next auto-retry once `break` has fired (only the
//     user's manual click should re-arm it; auto-retry would fan back
//     into the storm A2 closes)
//
// Living in src/web/ rather than src/lib/ because it's strictly
// browser-side wiring. Re-imported by node:test for unit coverage —
// no DOM dependencies make that safe.

export const PREVIEW_BACKOFF_MS = [1000, 3000, 10000];

export function previewRetryDecision(currentAttempt, backoffMs = PREVIEW_BACKOFF_MS) {
  // Defensive: clamp non-finite / negative inputs to 0 so a corrupted
  // closure variable (e.g. NaN from a setState bug) can't accidentally
  // skip the budget and tip into the storm. Pinned by a unit test.
  const safeAttempt = Number.isFinite(currentAttempt) && currentAttempt >= 0
    ? Math.floor(currentAttempt)
    : 0;
  const nextAttempt = safeAttempt + 1;
  if (nextAttempt > backoffMs.length) {
    return { action: 'break' };
  }
  return {
    action:      'retry',
    delayMs:     backoffMs[nextAttempt - 1],
    nextAttempt,
  };
}
