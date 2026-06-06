import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  parseLsRemote,
  stateOidForRef,
  defaultBranchFromState,
  compareServerRef,
  classifyDrift,
  classifyLsRemoteFailure,
  stateRefMap,
  otherRefDivergence,
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

test('compareServerRef: differs when oids mismatch (caller refines)', () => {
  assert.equal(compareServerRef(C, A), 'differs');
});

test('compareServerRef: differs when reachable but missing the branch ref', () => {
  // Reachability/missing is decided by the caller; a null oid here means the
  // host answered but doesn't carry the branch → differs, not unreachable.
  assert.equal(compareServerRef(null, A), 'differs');
});

test('compareServerRef: unknown when there is no signed state', () => {
  assert.equal(compareServerRef(A, null), 'unknown');
});

// ── classifyDrift ────────────────────────────────────────────────────────

test('classifyDrift: host ancestor of signed → behind', () => {
  assert.equal(classifyDrift('yes', 'no'), 'behind');
  assert.equal(classifyDrift('yes', 'unknown'), 'behind');
});

test('classifyDrift: signed ancestor of host → ahead', () => {
  assert.equal(classifyDrift('no', 'yes'), 'ahead');
});

test('classifyDrift: neither ancestor → diverged', () => {
  assert.equal(classifyDrift('no', 'no'), 'diverged');
});

test('classifyDrift: unknown ancestry → differs (oid not local)', () => {
  assert.equal(classifyDrift('unknown', 'unknown'), 'differs');
});

// ── classifyLsRemoteFailure ──────────────────────────────────────────────

test('classifyLsRemoteFailure: 404 / not-found → missing', () => {
  assert.equal(classifyLsRemoteFailure('fatal: repository not found'), 'missing');
  assert.equal(classifyLsRemoteFailure('The requested URL returned error: 404'), 'missing');
  assert.equal(classifyLsRemoteFailure('remote: Repository does not exist'), 'missing');
});

test('classifyLsRemoteFailure: network/timeout → unreachable', () => {
  assert.equal(classifyLsRemoteFailure('Could not resolve host: git.example'), 'unreachable');
  assert.equal(classifyLsRemoteFailure('Connection timed out'), 'unreachable');
  assert.equal(classifyLsRemoteFailure(''), 'unreachable');
});

// ── stateRefMap ──────────────────────────────────────────────────────────

test('stateRefMap: keeps only refs/* oid tags, skips HEAD and d', () => {
  const map = stateRefMap([
    ['d', 'r'], ['HEAD', 'ref: refs/heads/main'],
    ['refs/heads/main', A], ['refs/tags/v1', B], ['refs/heads/bad', 'nope'],
  ]);
  assert.equal(map.get('refs/heads/main'), A);
  assert.equal(map.get('refs/tags/v1'), B);
  assert.equal(map.has('HEAD'), false);
  assert.equal(map.has('refs/heads/bad'), false);
});

// ── otherRefDivergence ───────────────────────────────────────────────────

test('otherRefDivergence: flags a tag whose oid differs across servers', () => {
  const signed = new Map([['refs/heads/main', A], ['refs/tags/v1', B]]);
  const servers = [
    { host: 'h1', map: new Map([['refs/heads/main', A], ['refs/tags/v1', B]]) },
    { host: 'h2', map: new Map([['refs/heads/main', A], ['refs/tags/v1', C]]) }, // diverges
  ];
  const out = otherRefDivergence(servers, signed, 'refs/heads/main');
  assert.equal(out.length, 1);
  assert.equal(out[0].ref, 'refs/tags/v1');
  assert.equal(out[0].signed, B.slice(0, 8));
  assert.deepEqual(out[0].servers, [{ host: 'h1', has: B.slice(0, 8) }, { host: 'h2', has: C.slice(0, 8) }]);
});

test('otherRefDivergence: excludes the displayed branch and HEAD', () => {
  const signed = new Map([['refs/heads/main', A]]);
  const servers = [
    { host: 'h1', map: new Map([['refs/heads/main', A], ['HEAD', A]]) },
    { host: 'h2', map: new Map([['refs/heads/main', C], ['HEAD', C]]) }, // main diverges, but excluded
  ];
  assert.deepEqual(otherRefDivergence(servers, signed, 'refs/heads/main'), []);
});

test('otherRefDivergence: agreement across servers is not flagged; failed servers ignored', () => {
  const signed = new Map([['refs/tags/v1', B]]);
  const servers = [
    { host: 'h1', map: new Map([['refs/tags/v1', B]]) },
    { host: 'h2', map: null }, // unreachable — ignored, not a divergence
  ];
  assert.deepEqual(otherRefDivergence(servers, signed, 'refs/heads/main'), []);
});
