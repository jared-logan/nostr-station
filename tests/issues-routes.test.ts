import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  getRootEventId,
  getParentEventId,
  extractLabels,
  buildCommentTree,
  countComments,
  summariseIssue,
  parseIssueCreateInput,
  parseCommentInput,
} = await import('../src/lib/routes/issues.ts');

const PUBKEY     = 'a'.repeat(64);
const REPO_COORD = `30617:${PUBKEY}:my-repo`;

function ev(over: any): any {
  return {
    id:         'e'.repeat(64),
    pubkey:     PUBKEY,
    kind:       1111,
    created_at: 1_700_000_000,
    tags:       [],
    content:    '',
    sig:        's'.repeat(128),
    ...over,
  };
}

// ── NIP-22 tag helpers ───────────────────────────────────────────────────

test('getRootEventId: uppercase E is the root pointer', () => {
  const e = ev({ tags: [
    ['E', 'root-id'],
    ['e', 'parent-id'],
    ['A', REPO_COORD],
    ['P', PUBKEY],
  ] });
  assert.equal(getRootEventId(e), 'root-id');
});

test('getRootEventId: returns null when no uppercase E', () => {
  const e = ev({ tags: [['e', 'parent-id']] });
  assert.equal(getRootEventId(e), null);
});

test('getParentEventId: lowercase e is the parent pointer', () => {
  // NIP-22 is strict on case: lowercase e is parent. A top-level
  // reply has lowercase e === uppercase E (same target); a reply-
  // to-reply has them different.
  const e = ev({ tags: [
    ['E', 'root-id'],
    ['e', 'parent-comment-id'],
  ] });
  assert.equal(getParentEventId(e), 'parent-comment-id');
});

test('getParentEventId: top-level reply (e === E) still returns the value', () => {
  // For a top-level reply, lowercase e points at the root (same as E).
  // The tree builder distinguishes "parent === rootId" → top-level.
  const e = ev({ tags: [['E', 'root-id'], ['e', 'root-id']] });
  assert.equal(getParentEventId(e), 'root-id');
});

test('getParentEventId: returns null when no lowercase e', () => {
  assert.equal(getParentEventId(ev({ tags: [['E', 'root-id']] })), null);
});

// ── extractLabels ────────────────────────────────────────────────────────

test('extractLabels: deduplicates and filters by length', () => {
  const e = ev({ tags: [
    ['t', 'bug'],
    ['t', 'bug'],          // duplicate
    ['t', 'enhancement'],
    ['t', ''],             // empty → dropped
    ['t', 'a'.repeat(65)], // overlength → dropped
    ['t', 'a'.repeat(64)], // boundary → kept
  ] });
  const labels = extractLabels(e);
  assert.equal(labels.length, 3);
  assert.ok(labels.includes('bug'));
  assert.ok(labels.includes('enhancement'));
  assert.ok(labels.includes('a'.repeat(64)));
});

// ── buildCommentTree ─────────────────────────────────────────────────────

test('buildCommentTree: empty input', () => {
  assert.deepEqual(buildCommentTree('root-id', []), []);
});

test('buildCommentTree: filters by uppercase E === rootId', () => {
  // Two comments — one for our root, one for a different issue.
  // Only the matching one should appear.
  const mine = ev({
    id: 'c1' + 'a'.repeat(62),
    tags: [['E', 'my-issue'], ['e', 'my-issue']],
    content: 'reply',
  });
  const other = ev({
    id: 'c2' + 'a'.repeat(62),
    tags: [['E', 'other-issue'], ['e', 'other-issue']],
    content: 'not mine',
  });
  const tree = buildCommentTree('my-issue', [mine, other]);
  assert.equal(tree.length, 1);
  assert.equal(tree[0].id, mine.id);
});

test('buildCommentTree: top-level reply (parent === root) lives at top', () => {
  const c = ev({
    id: 'c' + 'a'.repeat(63),
    created_at: 1001,
    tags: [['E', 'root-id'], ['e', 'root-id']],
    content: 'hi',
  });
  const tree = buildCommentTree('root-id', [c]);
  assert.equal(tree.length, 1);
  assert.equal(tree[0].children.length, 0);
});

test('buildCommentTree: nested replies form a tree', () => {
  // top -> child -> grandchild
  const top = ev({
    id: 'top' + 'a'.repeat(61),
    created_at: 1000,
    tags: [['E', 'root-id'], ['e', 'root-id']],
  });
  const child = ev({
    id: 'mid' + 'a'.repeat(61),
    created_at: 1100,
    tags: [['E', 'root-id'], ['e', top.id]],
  });
  const grand = ev({
    id: 'low' + 'a'.repeat(61),
    created_at: 1200,
    tags: [['E', 'root-id'], ['e', child.id]],
  });
  const tree = buildCommentTree('root-id', [grand, top, child]);  // out-of-order in
  assert.equal(tree.length, 1);
  assert.equal(tree[0].id, top.id);
  assert.equal(tree[0].children.length, 1);
  assert.equal(tree[0].children[0].id, child.id);
  assert.equal(tree[0].children[0].children.length, 1);
  assert.equal(tree[0].children[0].children[0].id, grand.id);
});

test('buildCommentTree: chronological sort at each level', () => {
  // Two sibling replies at the top level; the OLDER one should
  // come first regardless of input ordering.
  const old = ev({
    id: 'old' + 'a'.repeat(61),
    created_at: 1000,
    tags: [['E', 'root-id'], ['e', 'root-id']],
  });
  const newer = ev({
    id: 'new' + 'a'.repeat(61),
    created_at: 2000,
    tags: [['E', 'root-id'], ['e', 'root-id']],
  });
  const tree = buildCommentTree('root-id', [newer, old]);
  assert.deepEqual(tree.map((n: any) => n.id), [old.id, newer.id]);
});

test('buildCommentTree: orphan comment (parent missing) surfaces at top level', () => {
  // If a relay returns a reply but not its parent, the reply must
  // still appear so the user has a chance to see it.
  const orphan = ev({
    id: 'o' + 'a'.repeat(63),
    tags: [['E', 'root-id'], ['e', 'missing-parent-id']],
  });
  const tree = buildCommentTree('root-id', [orphan]);
  assert.equal(tree.length, 1);
  assert.equal(tree[0].id, orphan.id);
});

test('buildCommentTree: legacy kind 1622 included alongside 1111', () => {
  // Legacy clients (pre-NIP-22) used kind 1622 with the same tag
  // semantics. Treat them identically inbound.
  const legacy = ev({
    id: 'L' + 'a'.repeat(63),
    kind: 1622,
    tags: [['E', 'root-id'], ['e', 'root-id']],
  });
  const tree = buildCommentTree('root-id', [legacy]);
  assert.equal(tree.length, 1);
  assert.equal(tree[0].kind, 1622);
});

// ── countComments ───────────────────────────────────────────────────────

test('countComments: counts every node in the tree', () => {
  const top = ev({
    id: 't' + 'a'.repeat(63),
    tags: [['E', 'root-id'], ['e', 'root-id']],
  });
  const a = ev({
    id: 'a' + 'a'.repeat(63),
    tags: [['E', 'root-id'], ['e', top.id]],
  });
  const b = ev({
    id: 'b' + 'a'.repeat(63),
    tags: [['E', 'root-id'], ['e', top.id]],
  });
  const tree = buildCommentTree('root-id', [top, a, b]);
  assert.equal(countComments(tree), 3);
});

// ── summariseIssue ──────────────────────────────────────────────────────

test('summariseIssue: subject from explicit tag wins', () => {
  const issue = ev({
    kind: 1621,
    tags: [['subject', 'Tagged subject']],
    content: 'Body line one\nBody line two',
  });
  assert.equal(summariseIssue(issue, []).subject, 'Tagged subject');
});

test('summariseIssue: subject falls back to first line of content', () => {
  const issue = ev({
    kind: 1621,
    tags: [],
    content: 'First line\n\nMore body',
  });
  assert.equal(summariseIssue(issue, []).subject, 'First line');
});

test('summariseIssue: status defaults to open in Phase 3 (4 will compute from 163x)', () => {
  const issue = ev({ kind: 1621, content: 'x' });
  assert.equal(summariseIssue(issue, []).status, 'open');
});

test('summariseIssue: commentCount reflects tree size', () => {
  const issue = ev({ id: 'I' + 'a'.repeat(63), kind: 1621, content: 'x' });
  const c1 = ev({ id: 'c1' + 'a'.repeat(62), tags: [['E', issue.id], ['e', issue.id]] });
  const tree = buildCommentTree(issue.id, [c1]);
  const s = summariseIssue(issue, tree);
  assert.equal(s.commentCount, 1);
});

// ── parseIssueCreateInput ───────────────────────────────────────────────
//
// Replaced the old buildIssueCreateArgs ngit-argv builder when issue
// creation went native (src/lib/nip34-events.ts). Validation rules
// are unchanged — these tests pin them.

test('parseIssueCreateInput: minimum (title only)', () => {
  assert.deepEqual(
    parseIssueCreateInput({ title: 'Fix the thing' }),
    { title: 'Fix the thing', body: '', labels: [] },
  );
});

test('parseIssueCreateInput: title + body + labels', () => {
  assert.deepEqual(
    parseIssueCreateInput({
      title:  'Fix it',
      body:   'Details here',
      labels: ['bug', 'urgent'],
    }),
    { title: 'Fix it', body: 'Details here', labels: ['bug', 'urgent'] },
  );
});

test('parseIssueCreateInput: drops invalid labels (non-string, bad chars)', () => {
  const parsed = parseIssueCreateInput({
    title:  'x',
    labels: ['ok', 'has space', '', 42 as any, 'also-ok'],
  });
  // Only 'ok' + 'also-ok' should make it through.
  assert.deepEqual(parsed?.labels, ['ok', 'also-ok']);
});

test('parseIssueCreateInput: rejects empty title', () => {
  assert.equal(parseIssueCreateInput({ title: '' }),     null);
  assert.equal(parseIssueCreateInput({ title: '   ' }),  null);
  assert.equal(parseIssueCreateInput({ title: null as any }), null);
});

test('parseIssueCreateInput: rejects overlong title / body', () => {
  assert.equal(parseIssueCreateInput({ title: 'a'.repeat(241) }), null);
  assert.equal(parseIssueCreateInput({ title: 'ok', body: 'a'.repeat(32_001) }), null);
});

// ── parseCommentInput ───────────────────────────────────────────────────

test('parseCommentInput: shape with valid input', () => {
  assert.deepEqual(
    parseCommentInput({ eventId: 'a'.repeat(64), body: 'looks good' }),
    { eventId: 'a'.repeat(64), body: 'looks good' },
  );
});

test('parseCommentInput: rejects non-hex eventId', () => {
  assert.equal(parseCommentInput({ eventId: 'not-hex', body: 'x' }),       null);
  assert.equal(parseCommentInput({ eventId: 'a'.repeat(15), body: 'x' }),  null); // too short
  assert.equal(parseCommentInput({ eventId: 'a'.repeat(65), body: 'x' }),  null); // too long
  assert.equal(parseCommentInput({ eventId: null as any,  body: 'x' }),    null);
});

test('parseCommentInput: rejects empty / overlong body', () => {
  const id = 'a'.repeat(64);
  assert.equal(parseCommentInput({ eventId: id, body: '' }),               null);
  assert.equal(parseCommentInput({ eventId: id, body: '  ' }),             null);
  assert.equal(parseCommentInput({ eventId: id, body: 'x'.repeat(16_001) }), null);
});
