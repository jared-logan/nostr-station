import test from 'node:test';
import assert from 'node:assert/strict';
import { memoizeWithSwr } from '../src/lib/nvpn.ts';

// memoizeWithSwr is the stale-while-revalidate variant of memoizeWithTtl,
// used to cache nvpn probes (probeNvpnStatus / probeNvpnServiceStatus)
// and /api/status. The contract differs from plain TTL in one critical
// way: after TTL expiry, the cached value is returned IMMEDIATELY (the
// "stale" half) and a refresh fires in the background (the "revalidate"
// half). The first call ever still blocks; only the post-TTL refresh
// is non-blocking. These tests pin that contract.

function defer<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: any) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('memoizeWithSwr: first call blocks on the underlying fetch', async () => {
  // No cache yet → no stale value to return; first call MUST await
  // the real fetch, otherwise the caller would get `undefined`.
  let calls = 0;
  const d = defer<number>();
  const memoized = memoizeWithSwr(async () => { calls++; return d.promise; }, 1_000);
  const a = memoized();
  d.resolve(42);
  assert.equal(await a, 42);
  assert.equal(calls, 1);
});

test('memoizeWithSwr: dedupes concurrent first-call invocations', async () => {
  let calls = 0;
  const d = defer<number>();
  const memoized = memoizeWithSwr(async () => { calls++; return d.promise; }, 1_000);
  const a = memoized();
  const b = memoized();
  const c = memoized();
  d.resolve(42);
  assert.equal(await a, 42);
  assert.equal(await b, 42);
  assert.equal(await c, 42);
  assert.equal(calls, 1);
});

test('memoizeWithSwr: returns cached value within TTL', async () => {
  let calls = 0;
  const memoized = memoizeWithSwr(async () => { calls++; return calls; }, 1_000);
  assert.equal(await memoized(), 1);
  assert.equal(await memoized(), 1);
  assert.equal(await memoized(), 1);
  assert.equal(calls, 1);
});

test('memoizeWithSwr: post-TTL caller gets stale value immediately, refresh runs in background', async () => {
  // The whole point — after TTL elapses, the next caller does NOT
  // block on a fresh fetch. They get the previously-cached value;
  // the underlying fn is invoked in the background. A short pause
  // gives the background refresh time to resolve before we re-check.
  //
  // TTL chosen generously (50ms) so the final fresh-window assertion
  // doesn't accidentally fall outside the new TTL slice. The two
  // sleeps below cover: (a) elapse the first TTL window, and (b)
  // give the background refresh time to update the cache while
  // staying well inside the next TTL window.
  let calls = 0;
  const memoized = memoizeWithSwr(async () => { calls++; return calls; }, 50);
  assert.equal(await memoized(), 1);
  assert.equal(calls, 1);
  await new Promise(r => setTimeout(r, 60));

  // Stale read — still serves the cached 1, kicks off refresh.
  assert.equal(await memoized(), 1);
  // The refresh has been scheduled but may not have resolved yet —
  // calls might be 1 or 2 here. Either is fine; the contract is
  // "the user-facing call did not block."

  // Drain the microtask + a short tick to let the background refresh
  // complete. We stay well under the next TTL window (50ms) so the
  // final read below lands in fresh territory and doesn't trigger
  // another refresh.
  await new Promise(r => setTimeout(r, 10));
  assert.equal(calls, 2, 'background refresh fired');

  // Now the fresh value is cached. Within the new TTL window it's
  // served instantly with no additional refresh.
  assert.equal(await memoized(), 2);
  assert.equal(calls, 2);
});

test('memoizeWithSwr: refresh failure keeps the previously-cached value', async () => {
  // Transient probe failures (e.g. a nvpn CLI hiccup) shouldn't drop
  // the last-known-good state. With SWR, a rejecting refresh leaves
  // the cache as it was; subsequent callers still get the stale value,
  // and the NEXT post-TTL caller triggers another refresh attempt.
  let attempt = 0;
  const memoized = memoizeWithSwr(async () => {
    attempt++;
    if (attempt === 1) return 'first';
    if (attempt === 2) throw new Error('refresh failed');
    return 'third';
  }, 5);
  assert.equal(await memoized(), 'first');
  await new Promise(r => setTimeout(r, 10));

  // Trigger a refresh that will reject; the caller still gets 'first'.
  assert.equal(await memoized(), 'first');
  await new Promise(r => setTimeout(r, 10));
  assert.equal(attempt, 2, 'refresh attempted');

  // Cache still holds 'first'. The next stale read kicks off another
  // refresh attempt (attempt === 3 succeeds with 'third').
  assert.equal(await memoized(), 'first');
  await new Promise(r => setTimeout(r, 10));
  assert.equal(attempt, 3);

  // Now the cache reflects the successful refresh.
  assert.equal(await memoized(), 'third');
});

test('memoizeWithSwr: first-call rejection clears the slot so the next call retries', async () => {
  // With no cached value, there's nothing to fall back to — the
  // caller's promise rejects. The next caller should kick off a
  // fresh attempt rather than re-using the rejected promise.
  let attempt = 0;
  const memoized = memoizeWithSwr(async () => {
    attempt++;
    if (attempt === 1) throw new Error('first attempt fails');
    return 'ok';
  }, 60_000);
  await assert.rejects(memoized(), /first attempt/);
  assert.equal(await memoized(), 'ok');
  assert.equal(attempt, 2);
});

test('memoizeWithSwr: invalidate() drops the cache so the next call refetches', async () => {
  let calls = 0;
  const memoized = memoizeWithSwr(async () => { calls++; return calls; }, 60_000);
  assert.equal(await memoized(), 1);
  assert.equal(await memoized(), 1);
  memoized.invalidate();

  // No cache → next call blocks on a real fetch (like first-call semantics).
  assert.equal(await memoized(), 2);
  assert.equal(calls, 2);
});

test('memoizeWithSwr: invalidate() during in-flight refresh discards that refresh result', async () => {
  // Important for action helpers: when the user clicks Stop, the
  // .invalidate() call MUST drop a then-in-flight refresh's result,
  // so the next probe sees the post-action world instead of the
  // pre-action one a stale refresh would have re-cached.
  let calls = 0;
  const d1 = defer<number>();
  const memoized = memoizeWithSwr(async () => {
    calls++;
    if (calls === 1) return 1;
    if (calls === 2) return d1.promise;
    return 99;
  }, 5);

  assert.equal(await memoized(), 1);
  await new Promise(r => setTimeout(r, 10));

  // Stale read kicks off refresh #2, which we won't resolve yet.
  assert.equal(await memoized(), 1);
  assert.equal(calls, 2);

  // User invalidates mid-flight; cache cleared, epoch bumped.
  memoized.invalidate();
  // The pending refresh resolves AFTER invalidate. Its result must NOT
  // be cached — it belongs to the pre-invalidate world.
  d1.resolve(7);
  await new Promise(r => setTimeout(r, 10));

  // Next call sees no cache (invalidate cleared it; the d1 resolution
  // was discarded because its epoch was stale) → blocks on call #3.
  assert.equal(await memoized(), 99);
  assert.equal(calls, 3);
});
