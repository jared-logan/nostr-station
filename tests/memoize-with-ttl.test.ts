import test from 'node:test';
import assert from 'node:assert/strict';
import { memoizeWithTtl } from '../src/lib/nvpn.ts';

// memoizeWithTtl is the cache primitive behind probeNvpnStatus and
// probeNvpnServiceStatus — every nvpn-touching API call used to spawn
// its own subprocess, the cache fans many concurrent calls out to one.
// These tests pin the contract: TTL hit, dedupe in-flight, miss-after-
// expiry, error-clears-cache, and explicit invalidate.

function defer<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: any) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('memoizeWithTtl: dedupes concurrent in-flight calls into one', async () => {
  // Same window, same fn — only one underlying invocation should run
  // even if 5 callers hit the wrapper before the first resolves.
  let calls = 0;
  const d = defer<number>();
  const memoized = memoizeWithTtl(async () => { calls++; return d.promise; }, 1_000);
  const a = memoized();
  const b = memoized();
  const c = memoized();
  d.resolve(42);
  assert.equal(await a, 42);
  assert.equal(await b, 42);
  assert.equal(await c, 42);
  assert.equal(calls, 1);
});

test('memoizeWithTtl: returns cached value within TTL', async () => {
  let calls = 0;
  const memoized = memoizeWithTtl(async () => { calls++; return calls; }, 1_000);
  assert.equal(await memoized(), 1);
  assert.equal(await memoized(), 1);
  assert.equal(await memoized(), 1);
  assert.equal(calls, 1);
});

test('memoizeWithTtl: refetches after TTL elapses', async () => {
  let calls = 0;
  const memoized = memoizeWithTtl(async () => { calls++; return calls; }, 5);
  assert.equal(await memoized(), 1);
  await new Promise(r => setTimeout(r, 10));
  assert.equal(await memoized(), 2);
  assert.equal(calls, 2);
});

test('memoizeWithTtl: rejection drops the cache so next caller retries', async () => {
  // A wedged daemon that errored once shouldn't sticky-cache its own
  // failure for the full TTL — the next caller should get a real
  // attempt, since the underlying fault may already be resolved.
  let attempt = 0;
  const memoized = memoizeWithTtl(async () => {
    attempt++;
    if (attempt === 1) throw new Error('first attempt fails');
    return 'ok';
  }, 60_000);
  await assert.rejects(memoized(), /first attempt/);
  assert.equal(await memoized(), 'ok');
  assert.equal(attempt, 2);
});

test('memoizeWithTtl: invalidate() forces the next call to refetch', async () => {
  let calls = 0;
  const memoized = memoizeWithTtl(async () => { calls++; return calls; }, 60_000);
  assert.equal(await memoized(), 1);
  assert.equal(await memoized(), 1);
  memoized.invalidate();
  assert.equal(await memoized(), 2);
  assert.equal(calls, 2);
});

test('memoizeWithTtl: invalidate() during in-flight call still allows the in-flight to complete', async () => {
  // If a state-changed event fires while we're mid-probe, we don't
  // want to leave the in-flight callers hanging or break their
  // already-attached .then handlers — invalidate just clears the
  // cache slot; the existing promise resolves to its callers normally
  // and the NEXT call after that gets a fresh fetch.
  let calls = 0;
  const d1 = defer<number>();
  const memoized = memoizeWithTtl(async () => {
    calls++;
    if (calls === 1) return d1.promise;
    return 99;
  }, 60_000);
  const inFlight = memoized();
  memoized.invalidate();
  d1.resolve(7);
  assert.equal(await inFlight, 7);
  assert.equal(await memoized(), 99);
  assert.equal(calls, 2);
});
