import { test } from 'node:test';
import assert from 'node:assert/strict';

// @ts-expect-error — runtime import
const { classifyKind } = await import('../src/lib/nostr-kinds.ts');

// Legacy individually-classified kinds (NIP-01 carve-outs).

test('classifyKind: kind 0 (metadata) is replaceable, ts preserved', () => {
  const k = classifyKind(0);
  assert.equal(k.class, 'replaceable');
  assert.equal(k.preserveTs, true);
  assert.equal(k.promotable, true);
});

test('classifyKind: kind 1 (note) is regular, ts NOT preserved', () => {
  const k = classifyKind(1);
  assert.equal(k.class, 'regular');
  assert.equal(k.preserveTs, false);
  assert.equal(k.promotable, true);
});

test('classifyKind: kind 3 (contact list) is replaceable', () => {
  const k = classifyKind(3);
  assert.equal(k.class, 'replaceable');
  assert.equal(k.preserveTs, true);
});

test('classifyKind: kind 5 (deletion) carries an advisory note', () => {
  const k = classifyKind(5);
  assert.equal(k.class, 'deletion');
  assert.equal(k.promotable, true);
  assert.match(k.note || '', /deletion/i);
});

// Numeric range classification.

test('classifyKind: 10000–19999 is replaceable', () => {
  for (const k of [10000, 10002, 15000, 19999]) {
    const info = classifyKind(k);
    assert.equal(info.class, 'replaceable', `kind ${k}`);
    assert.equal(info.preserveTs, true);
  }
});

test('classifyKind: 20000–29999 is ephemeral (NOT promotable)', () => {
  for (const k of [20000, 22242, 29999]) {
    const info = classifyKind(k);
    assert.equal(info.class, 'ephemeral', `kind ${k}`);
    assert.equal(info.promotable, false);
  }
});

test('classifyKind: 30000–39999 is addressable, ts preserved', () => {
  for (const k of [30000, 30023, 30617, 39999]) {
    const info = classifyKind(k);
    assert.equal(info.class, 'addressable', `kind ${k}`);
    assert.equal(info.preserveTs, true);
  }
});

test('classifyKind: experimental kinds in the regular range pass through', () => {
  // The whole point of the dev relay is that someone iterating on a
  // new NIP can publish (and promote) whatever weird kind they invent
  // without us shipping an update. Pick a few "unknown" regular-range
  // kinds and confirm they're promotable.
  for (const k of [1234, 5678, 9999]) {
    const info = classifyKind(k);
    assert.equal(info.promotable, true, `kind ${k} must be promotable`);
    assert.equal(info.class, 'regular');
  }
});

test('classifyKind: out-of-range inputs are rejected', () => {
  for (const k of [-1, 65536, 1.5, NaN] as number[]) {
    const info = classifyKind(k);
    assert.equal(info.promotable, false, `kind ${k}`);
  }
});
