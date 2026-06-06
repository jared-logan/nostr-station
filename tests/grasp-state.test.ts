import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  parseLsRemote,
  stateOidForRef,
  defaultBranchFromState,
  compareServerRef,
} = await import('../src/lib/grasp-state.ts');

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);

// ── parseLsRemote ────────────────────────────────────────────────────────

test('parseLsRemote: parses oid/ref pairs and HEAD', () => {
  const out = [
    `${A}\tHEAD`,
    `${A}\trefs/heads/main`,
    `${B}\trefs/heads/dev`,
  ].join('\n');
  const map = parseLsRemote(out);
  assert.equal(map.get('refs/heads/main'), A);
  assert.equal(map.get('refs/heads/dev'), B);
  assert.equal(map.get('HEAD'), A);
});

test('parseLsRemote: drops peeled tag rows, keeps the tag ref', () => {
  const out = [
    `${A}\trefs/tags/v1`,
    `${B}\trefs/tags/v1^{}`,   // peeled — must be ignored
  ].join('\n');
  const map = parseLsRemote(out);
  assert.equal(map.get('refs/tags/v1'), A);
  assert.equal(map.has('refs/tags/v1^{}'), false);
});

test('parseLsRemote: tolerates blanks and junk lines', () => {
  const map = parseLsRemote(`\n  \nnot-a-ref-line\n${A}\trefs/heads/main\n`);
  assert.equal(map.size, 1);
  assert.equal(map.get('refs/heads/main'), A);
});

// ── stateOidForRef ───────────────────────────────────────────────────────

test('stateOidForRef: returns the oid for a matching ref', () => {
  const tags = [['d', 'r'], ['HEAD', 'ref: refs/heads/main'], ['refs/heads/main', A]];
  assert.equal(stateOidForRef(tags, 'refs/heads/main'), A);
});

test('stateOidForRef: null when ref absent or value not an oid', () => {
  assert.equal(stateOidForRef([['refs/heads/main', 'nope']], 'refs/heads/main'), null);
  assert.equal(stateOidForRef([['d', 'r']], 'refs/heads/main'), null);
});

// ── defaultBranchFromState ───────────────────────────────────────────────

test('defaultBranchFromState: reads the symbolic HEAD branch', () => {
  assert.equal(defaultBranchFromState([['HEAD', 'ref: refs/heads/trunk']]), 'trunk');
});

test('defaultBranchFromState: null for a detached/oid HEAD or missing', () => {
  assert.equal(defaultBranchFromState([['HEAD', A]]), null);
  assert.equal(defaultBranchFromState([['d', 'r']]), null);
});

// ── compareServerRef ─────────────────────────────────────────────────────

test('compareServerRef: in-sync when host oid matches the signed oid', () => {
  assert.equal(compareServerRef(A, A), 'in-sync');
  assert.equal(compareServerRef(A.toUpperCase(), A), 'in-sync'); // case-insensitive
});

test('compareServerRef: out-of-sync when they differ', () => {
  assert.equal(compareServerRef(C, A), 'out-of-sync');
});

test('compareServerRef: unreachable when the host gave no oid', () => {
  assert.equal(compareServerRef(null, A), 'unreachable');
});

test('compareServerRef: unknown when there is no signed state', () => {
  assert.equal(compareServerRef(A, null), 'unknown');
});
