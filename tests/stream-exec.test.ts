// streamExec safety-net tests.
//
// streamExec is the SSE wrapper around child processes used by every
// long-running route (ngit init/push/fetch, git pull/push, deploys).
// Pre-fix it had no upper bound on stderr volume, no subprocess
// timeout, and no consecutive-identical-line guard — meaning a
// misbehaving child (e.g. ngit 2.x retry-looping its nsec prompt
// against a closed stdin) could flood the SSE buffer at thousands of
// lines/sec until the dashboard heap blew. These tests pin the cap
// + timeout behaviour so a future regression can't reopen that hole.
//
// We run streamExec end-to-end against real subprocesses (no mocks)
// and capture the SSE bytes off a pair of in-memory http streams.
// Spawning `sh` is portable enough across the supported macOS/Linux
// targets — the test asserts on the bounded message + done-frame
// contract that the dashboard front-end relies on.

import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import http from 'node:http';

const { streamExec } = await import('../src/lib/routes/_shared.ts');

// SSE frame collector. streamExec writes `data: <json>\n\n` per frame;
// we re-parse so tests assert against structured output, not raw text.
type Frame = { line?: string; stream?: 'stdout' | 'stderr'; done?: boolean; code?: number };
function collect(buf: string): Frame[] {
  return buf
    .split('\n\n')
    .map(b => b.replace(/^data: /, '').trim())
    .filter(Boolean)
    .map(s => { try { return JSON.parse(s); } catch { return null; } })
    .filter((x): x is Frame => x !== null);
}

// Minimal req/res harness. ServerResponse writes to an in-memory
// socket; we capture every byte via a `data` listener on the
// PassThrough. The `'finish'` event on res fires after streamExec
// calls res.end(), which is when we know all SSE frames have
// been written and we can resolve the drain promise. Using
// `'finish'` avoids the PassThrough-doesn't-auto-close hang we hit
// with the for-await pattern.
function makeHarness(): {
  req:    http.IncomingMessage;
  res:    http.ServerResponse;
  sseEnd: Promise<string>;
} {
  const sink = new PassThrough();
  const res = new http.ServerResponse({ method: 'POST', url: '/' } as any);
  res.assignSocket(sink as any);

  // Capture by intercepting res.write/res.end directly. Listening on
  // the socket's `'data'` event was racy: res.on('finish') fires when
  // res.end() completes, but the queued 'data' callbacks for the
  // last few synchronous writes hadn't all run yet, so the captured
  // string was missing tail frames. Wrapping the methods themselves
  // captures every byte synchronously, regardless of socket plumbing.
  const captured: string[] = [];
  const origWrite = res.write.bind(res);
  const origEnd   = res.end.bind(res);
  res.write = ((chunk: any, ...rest: any[]) => {
    if (chunk != null) captured.push(chunk.toString());
    return origWrite(chunk, ...rest);
  }) as any;
  res.end = ((chunk?: any, ...rest: any[]) => {
    if (chunk != null) captured.push(chunk.toString());
    return origEnd(chunk, ...rest);
  }) as any;

  const req = new PassThrough() as any;
  req.url = '/';
  req.method = 'POST';

  const sseEnd = new Promise<string>((resolve) => {
    res.on('finish', () => {
      const all = captured.join('');
      // First chunk is the HTTP status line + headers; SSE frames
      // follow after the blank-line separator. Strip everything
      // before the first `data: ` so collect() only sees frames.
      const idx = all.indexOf('data: ');
      resolve(idx >= 0 ? all.slice(idx) : '');
    });
  });

  return { req, res, sseEnd };
}

test('streamExec: passes a normal command through cleanly', async () => {
  const { req, res, sseEnd } = makeHarness();
  streamExec({ bin: 'sh', args: ['-c', 'echo hello; echo world'] }, res, req);
  const frames = collect(await sseEnd);
  const lines = frames.filter(f => f.line).map(f => f.line);
  assert.deepEqual(lines, ['hello', 'world']);
  const done = frames.find(f => f.done);
  assert.equal(done?.code, 0);
});

test('streamExec: caps a runaway retry-loop and kills the subprocess', async () => {
  // Reproduces the production OOM pattern: same stderr line emitted
  // far more than the 50-line cap. We expect the cap to fire, kill
  // the child, and emit a single "[bounded: …]" stderr frame plus a
  // done frame with a non-zero code.
  const { req, res, sseEnd } = makeHarness();
  streamExec({
    bin:  'sh',
    args: ['-c', 'i=0; while [ $i -lt 5000 ]; do echo same-line-spam >&2; i=$((i+1)); done'],
  }, res, req);

  const frames = collect(await sseEnd);
  const spam = frames.filter(f => f.line === 'same-line-spam');
  // Cap is 50; we allow some slack because data events arrive in
  // chunks and the inflight chunk's lines all push before the cap
  // observation kills the child. The hard ceiling is "bounded
  // message present, way fewer frames than the 5000 the child
  // tried to emit".
  assert.ok(spam.length <= 200, `expected line cap to fire, got ${spam.length} matching frames`);
  assert.ok(spam.length > 0,    'expected at least one repeated line through before cap');

  const bounded = frames.find(f => f.line && /^\[bounded:/.test(f.line));
  assert.ok(bounded, 'expected [bounded: …] message after cap fires');
  assert.equal(bounded?.stream, 'stderr');

  const done = frames.find(f => f.done);
  assert.ok(done, 'expected a done frame');
  // Cap-kill uses code -3 (distinct from timeout's -2 and child errors -1).
  assert.equal(done?.code, -3);
});

test('streamExec: mixed output does not trip the line cap', async () => {
  // Negative: a noisy-but-varied subprocess (alternating lines) must
  // emit every line. Only consecutive identical lines count toward
  // the cap; intermittent repeats stay under the runLength bar.
  const { req, res, sseEnd } = makeHarness();
  streamExec({
    bin:  'sh',
    args: ['-c', 'i=0; while [ $i -lt 200 ]; do echo a; echo b; i=$((i+1)); done'],
  }, res, req);

  const frames = collect(await sseEnd);
  const lines = frames.filter(f => f.line).map(f => f.line);
  // 200 a's + 200 b's, alternating — neither hits a consecutive run
  // of 50. All 400 must come through.
  assert.equal(lines.length, 400);

  const done = frames.find(f => f.done);
  assert.equal(done?.code, 0, 'normal run must exit 0, not the bounded code');
});

test('streamExec: timeoutMs kills a hanging subprocess', async () => {
  // sleep 30s, but give the wrapper a 200ms timeout. The kill path
  // emits a [killed: …] message and a done frame with code -2.
  const { req, res, sseEnd } = makeHarness();
  streamExec({ bin: 'sh', args: ['-c', 'sleep 30'], timeoutMs: 200 }, res, req);

  const frames = collect(await sseEnd);
  const killed = frames.find(f => f.line && /^\[killed:/.test(f.line));
  assert.ok(killed, 'expected [killed: …] message after timeout fires');
  assert.equal(killed?.stream, 'stderr');

  const done = frames.find(f => f.done);
  assert.equal(done?.code, -2, 'timeout uses code -2');
});

test('streamExec: timeoutMs:0 disables the timeout', async () => {
  // Long-running ops (deploys) opt out of the default 60s ceiling
  // by passing 0. We test the opt-out by running a quick command
  // that finishes well before any plausible default — if the
  // override is wrong we'd see -2 in the done frame.
  const { req, res, sseEnd } = makeHarness();
  streamExec({ bin: 'sh', args: ['-c', 'echo ok'], timeoutMs: 0 }, res, req);

  const frames = collect(await sseEnd);
  const done = frames.find(f => f.done);
  assert.equal(done?.code, 0, 'timeoutMs:0 must not interfere with normal completion');
});

test('streamExec: maxRepeatedLines override raises the cap', async () => {
  // Allow a longer run before the cap fires; useful for ops where
  // identical lines are part of normal output (e.g. progress dots).
  const { req, res, sseEnd } = makeHarness();
  streamExec({
    bin:              'sh',
    args:             ['-c', 'i=0; while [ $i -lt 80 ]; do echo .; i=$((i+1)); done'],
    maxRepeatedLines: 200,                    // raise above 80
  }, res, req);

  const frames = collect(await sseEnd);
  const dots = frames.filter(f => f.line === '.');
  assert.equal(dots.length, 80, 'all 80 dots must come through when cap is raised above 80');

  const done = frames.find(f => f.done);
  assert.equal(done?.code, 0);
});
