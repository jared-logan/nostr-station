import test from 'node:test';
import assert from 'node:assert/strict';
import { LogBuffer } from '../src/lib/log-buffer.ts';

test('log-buffer: drain returns lines in push order', () => {
  const b = new LogBuffer(10);
  b.info('first');
  b.warn('second');
  b.error('third');
  const out = b.drain();
  assert.equal(out.length, 3);
  assert.equal(out[0].text, 'first');
  assert.equal(out[0].level, 'info');
  assert.equal(out[1].level, 'warn');
  assert.equal(out[2].level, 'error');
});

test('log-buffer: ring evicts oldest beyond capacity', () => {
  const b = new LogBuffer(3);
  for (let i = 0; i < 5; i++) b.info(`m${i}`);
  const out = b.drain();
  assert.deepEqual(out.map(l => l.text), ['m2', 'm3', 'm4']);
});

test('log-buffer: subscribe sees only new lines, not history', () => {
  const b = new LogBuffer();
  b.info('before');
  const seen: string[] = [];
  b.subscribe(l => seen.push(l.text));
  b.info('after-1');
  b.info('after-2');
  assert.deepEqual(seen, ['after-1', 'after-2']);
});

test('log-buffer: unsubscribe stops delivery', () => {
  const b = new LogBuffer();
  const seen: string[] = [];
  const off = b.subscribe(l => seen.push(l.text));
  b.info('in');
  off();
  b.info('out');
  assert.deepEqual(seen, ['in']);
});

test('log-buffer: a faulty listener does not break delivery to others', () => {
  const b = new LogBuffer();
  const seen: string[] = [];
  b.subscribe(() => { throw new Error('boom'); });
  b.subscribe(l => seen.push(l.text));
  b.info('still-delivered');
  assert.deepEqual(seen, ['still-delivered']);
});

test('log-buffer: clear empties the ring without notifying', () => {
  const b = new LogBuffer();
  const seen: string[] = [];
  b.subscribe(l => seen.push(l.text));
  b.info('a');
  b.info('b');
  b.clear();
  assert.equal(b.size(), 0);
  assert.equal(b.drain().length, 0);
  // Listener should NOT have been notified by clear() itself.
  assert.deepEqual(seen, ['a', 'b']);
});

test('log-buffer: timestamps are monotonically non-decreasing', () => {
  const b = new LogBuffer();
  for (let i = 0; i < 50; i++) b.info(`m${i}`);
  const ts = b.drain().map(l => l.ts);
  for (let i = 1; i < ts.length; i++) {
    assert.ok(ts[i] >= ts[i - 1], `ts[${i}]=${ts[i]} should be >= ts[${i - 1}]=${ts[i - 1]}`);
  }
});
