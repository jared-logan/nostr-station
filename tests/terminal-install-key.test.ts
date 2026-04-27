import { test } from 'node:test';
import assert from 'node:assert/strict';

// resolveCmd is pure (modulo SHELL env + cwd validation, both stubbable).
// We exercise it directly to pin the new A5 dispatch without spinning up
// node-pty / a real PTY session.
// @ts-expect-error — runtime import of .ts
const { resolveCmd } = await import('../src/lib/terminal.ts');

const FAKE_CLI = {
  bin: '/path/to/node',
  prefix: ['/path/to/dist/cli.js'],
};

test('resolveCmd: doctor-fix → invokes our CLI with `doctor --fix` argv', () => {
  // A5 contract: clicking Install in the Status panel routes through this
  // key when node-pty is available. The terminal tab must drive the same
  // `nostr-station doctor --fix` flow that the SSE fallback runs, just
  // rendered against a real TTY so cargo's compile stderr streams live.
  const spec = resolveCmd({ key: 'doctor-fix' }, FAKE_CLI);
  assert.notEqual(spec, null);
  assert.equal(spec.cmd, FAKE_CLI.bin);
  // argv must end with ['doctor', '--fix'] — no shell-injection surface,
  // no per-slug interpolation. The whole point of the resolver is that
  // the client sends a key, the server owns argv.
  assert.deepEqual(
    spec.args,
    [...FAKE_CLI.prefix, 'doctor', '--fix'],
  );
});

test('resolveCmd: doctor-fix tab carries an unambiguous label', () => {
  // The strip label needs to read distinctly from the plain `doctor` tab,
  // because users often run both (a read-only doctor pass to inspect, then
  // doctor --fix to repair). Pin the literal so the strip doesn't quietly
  // collapse the two into the same name on a future refactor.
  const spec = resolveCmd({ key: 'doctor-fix' }, FAKE_CLI);
  assert.equal(spec.label, 'doctor --fix');
});

test('resolveCmd: existing doctor key is unchanged (no --fix)', () => {
  // Defense against an accidental swap during the A5 edit. The plain
  // doctor terminal must still be a read-only pass — it's the entry
  // point users hit from `status-doctor` who don't want to touch
  // their install.
  const spec = resolveCmd({ key: 'doctor' }, FAKE_CLI);
  assert.notEqual(spec, null);
  assert.deepEqual(
    spec.args,
    [...FAKE_CLI.prefix, 'doctor'],
  );
  assert.doesNotMatch(spec.args.join(' '), /--fix/);
});

test('resolveCmd: unknown key returns null (whitelist invariant)', () => {
  // A5 added one new entry; everything else still goes through the
  // whitelist. A typo'd / attacker-supplied key must never resolve to
  // something runnable.
  const spec = resolveCmd({ key: 'doctor--fix' }, FAKE_CLI);  // typo
  assert.equal(spec, null);
});
