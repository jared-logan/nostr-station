import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  hasTagValue,
  getReplyTag,
  parseAuthorFromContent,
  parseSubject,
  isCoverLetter,
  buildPatchSeries,
  parsePatchContent,
} = await import('../src/lib/routes/patches.ts');

// ── Helpers for fixture construction ─────────────────────────────────────

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);

function ev(over: any): any {
  return {
    id:         'e'.repeat(64),
    pubkey:     A,
    kind:       1617,
    created_at: 1_700_000_000,
    tags:       [],
    content:    '',
    sig:        's'.repeat(128),
    ...over,
  };
}

const SAMPLE_PATCH = `From abc0001122334455667788990011223344556677 Mon Sep 17 00:00:00 2001
From: Alice <alice@example.com>
Date: Mon, 1 Jan 2024 12:00:00 +0000
Subject: [PATCH 1/2] add greeting

Body lines.

---
 hello.txt | 2 ++
 1 file changed, 2 insertions(+)

diff --git a/hello.txt b/hello.txt
index 0000..1111 100644
--- a/hello.txt
+++ b/hello.txt
@@ -0,0 +1,2 @@
+hello
+world
`;

// ── hasTagValue ──────────────────────────────────────────────────────────

test('hasTagValue: matches by name + value', () => {
  const e = ev({ tags: [['t', 'root'], ['t', 'rust']] });
  assert.equal(hasTagValue(e, 't', 'root'),         true);
  assert.equal(hasTagValue(e, 't', 'rust'),         true);
  assert.equal(hasTagValue(e, 't', 'root-revision'), false);
  assert.equal(hasTagValue(e, 'p', 'root'),          false);
});

// ── getReplyTag (NIP-10) ─────────────────────────────────────────────────

test('getReplyTag: returns the marker-form "reply" tag', () => {
  const e = ev({ tags: [
    ['e', 'root-id', 'wss://r', 'root'],
    ['e', 'parent-id', 'wss://r', 'reply'],
  ] });
  assert.deepEqual(getReplyTag(e), ['e', 'parent-id', 'wss://r', 'reply']);
});

test('getReplyTag: single unmarked `e` is the reply (NIP-10 deprecated form)', () => {
  const e = ev({ tags: [['e', 'parent-id']] });
  assert.deepEqual(getReplyTag(e), ['e', 'parent-id']);
});

test('getReplyTag: multiple unmarked `e` tags — last is reply (positional)', () => {
  const e = ev({ tags: [
    ['e', 'first'],
    ['e', 'second'],
    ['e', 'last-is-reply'],
  ] });
  assert.deepEqual(getReplyTag(e)?.[1], 'last-is-reply');
});

test('getReplyTag: marker form takes precedence over positional', () => {
  const e = ev({ tags: [
    ['e', 'unmarked-1'],
    ['e', 'unmarked-2'],
    ['e', 'marked', '', 'reply'],
  ] });
  assert.equal(getReplyTag(e)?.[1], 'marked');
});

test('getReplyTag: returns null when no `e` tag present', () => {
  assert.equal(getReplyTag(ev({})), null);
});

// ── parseAuthorFromContent ───────────────────────────────────────────────

test('parseAuthorFromContent: extracts Name + email from "From:" header', () => {
  const a = parseAuthorFromContent(SAMPLE_PATCH);
  assert.deepEqual(a, { name: 'Alice', email: 'alice@example.com' });
});

test('parseAuthorFromContent: bare email form', () => {
  assert.deepEqual(
    parseAuthorFromContent('From: alice@example.com\n\nbody'),
    { email: 'alice@example.com' },
  );
});

test('parseAuthorFromContent: bare name (no email) is preserved as name', () => {
  assert.deepEqual(
    parseAuthorFromContent('From: Just A Name\n\nbody'),
    { name: 'Just A Name' },
  );
});

test('parseAuthorFromContent: returns undefined when no From: header', () => {
  assert.equal(parseAuthorFromContent('# README\n\ncover letter content'), undefined);
});

// ── parseSubject ─────────────────────────────────────────────────────────

test('parseSubject: explicit subject tag wins', () => {
  // Some clients carry an explicit ["subject", "..."] tag — use it
  // verbatim rather than re-deriving from content.
  const e = ev({
    tags: [['subject', 'Tagged subject']],
    content: 'Subject: [PATCH] derived subject\n\nbody',
  });
  assert.equal(parseSubject(e), 'Tagged subject');
});

test('parseSubject: extracts from "Subject: [PATCH n/m]" line', () => {
  const e = ev({ content: SAMPLE_PATCH });
  assert.equal(parseSubject(e), 'add greeting');
});

test('parseSubject: handles bare "Subject:" without [PATCH] prefix', () => {
  const e = ev({ content: 'Subject: just a subject\n\nrest' });
  assert.equal(parseSubject(e), 'just a subject');
});

test('parseSubject: cover letter — first non-empty line', () => {
  const e = ev({ content: '\n\n# Cover letter title\n\nMore body…' });
  assert.equal(parseSubject(e), '# Cover letter title');
});

test('parseSubject: empty content falls back to event id prefix', () => {
  const e = ev({ id: 'd'.repeat(64), content: '' });
  assert.equal(parseSubject(e), 'd'.repeat(8));
});

test('parseSubject: long subject truncated at 240 chars', () => {
  const long = 'x'.repeat(500);
  const e = ev({ content: `Subject: [PATCH] ${long}\n\n` });
  assert.equal(parseSubject(e).length, 240);
});

// ── isCoverLetter ────────────────────────────────────────────────────────

test('isCoverLetter: false for git format-patch content', () => {
  assert.equal(isCoverLetter(ev({ content: SAMPLE_PATCH })), false);
});

test('isCoverLetter: true for markdown / narrative content', () => {
  assert.equal(isCoverLetter(ev({ content: '# Cover\n\nA series.' })), true);
});

test('isCoverLetter: true for empty content', () => {
  assert.equal(isCoverLetter(ev({ content: '' })), true);
});

// ── buildPatchSeries: simple cases ───────────────────────────────────────

test('buildPatchSeries: single root, no revisions, no chain', () => {
  const root = ev({
    id: 'root1' + 'a'.repeat(59),
    content: '# Cover letter\n\nFix things.',
    tags: [['t', 'root']],
  });
  const series = buildPatchSeries([root]);
  assert.equal(series.length, 1);
  assert.equal(series[0].rootId, root.id);
  assert.equal(series[0].revisions.length, 1);
  assert.equal(series[0].revisions[0].version, 1);
  assert.equal(series[0].revisions[0].patches.length, 1);
  assert.equal(series[0].revisions[0].patches[0].id, root.id);
});

test('buildPatchSeries: root + chain of follower patches', () => {
  // A typical 3-patch series: cover letter (root) + 2 commit patches
  // chained NIP-10-style.
  const root = ev({
    id: 'r' + 'a'.repeat(63),
    created_at: 1000,
    content: '# Cover letter',
    tags: [['t', 'root']],
  });
  const p1 = ev({
    id: 'p1' + 'a'.repeat(62),
    created_at: 1001,
    content: SAMPLE_PATCH,
    tags: [['e', root.id, '', 'reply']],
  });
  const p2 = ev({
    id: 'p2' + 'a'.repeat(62),
    created_at: 1002,
    content: SAMPLE_PATCH.replace('1/2', '2/2'),
    tags: [['e', p1.id, '', 'reply']],
  });
  const series = buildPatchSeries([root, p1, p2]);
  assert.equal(series.length, 1);
  assert.equal(series[0].patchCount, 3);
  // Root first, then chain in created_at order.
  assert.deepEqual(
    series[0].revisions[0].patches.map((p: any) => p.id),
    [root.id, p1.id, p2.id],
  );
});

// ── buildPatchSeries: revisions ──────────────────────────────────────────

test('buildPatchSeries: root + root-revision form a 2-version series', () => {
  // v1: original root + one follower
  // v2: root-revision pointing at v1's root + one follower
  const v1Root = ev({
    id: 'v1r' + 'a'.repeat(61),
    created_at: 1000,
    tags: [['t', 'root']],
  });
  const v1Patch = ev({
    id: 'v1p' + 'a'.repeat(61),
    created_at: 1001,
    tags: [['e', v1Root.id, '', 'reply']],
  });
  const v2Root = ev({
    id: 'v2r' + 'a'.repeat(61),
    created_at: 2000,
    tags: [
      ['t', 'root-revision'],
      ['e', v1Root.id, '', 'reply'],
    ],
  });
  const v2Patch = ev({
    id: 'v2p' + 'a'.repeat(61),
    created_at: 2001,
    tags: [['e', v2Root.id, '', 'reply']],
  });
  const series = buildPatchSeries([v1Root, v1Patch, v2Root, v2Patch]);
  assert.equal(series.length, 1, 'one logical series');
  assert.equal(series[0].rootId, v1Root.id, 'series rooted at v1');
  assert.equal(series[0].revisionCount, 2);
  assert.equal(series[0].revisions[0].version, 1);
  assert.equal(series[0].revisions[1].version, 2);
  assert.equal(series[0].revisions[0].patches.length, 2);
  assert.equal(series[0].revisions[1].patches.length, 2);
  // v1 chain must NOT include v2 patches (and vice versa).
  assert.ok(!series[0].revisions[0].patches.find((p: any) => p.id === v2Patch.id));
  assert.ok(!series[0].revisions[1].patches.find((p: any) => p.id === v1Patch.id));
});

test('buildPatchSeries: multi-roll v1 → v2 → v3 chain', () => {
  // v3 reply points at v2; v2 reply points at v1. We must walk all
  // the way back to v1 (depth-capped, but 2 hops is well within).
  const v1 = ev({ id: 'v1' + 'a'.repeat(62), created_at: 1000, tags: [['t', 'root']] });
  const v2 = ev({
    id: 'v2' + 'a'.repeat(62), created_at: 2000,
    tags: [['t', 'root-revision'], ['e', v1.id, '', 'reply']],
  });
  const v3 = ev({
    id: 'v3' + 'a'.repeat(62), created_at: 3000,
    tags: [['t', 'root-revision'], ['e', v2.id, '', 'reply']],
  });
  const series = buildPatchSeries([v1, v2, v3]);
  assert.equal(series.length, 1);
  assert.equal(series[0].revisionCount, 3);
  assert.deepEqual(series[0].revisions.map((r: any) => r.version), [1, 2, 3]);
});

test('buildPatchSeries: dangling root-revision (v1 not in event set) still surfaces', () => {
  // When relays return v2 but not v1, the revision should still
  // render anchored to the dangling parent id rather than vanish.
  const v2 = ev({
    id: 'v2' + 'a'.repeat(62), created_at: 2000,
    tags: [['t', 'root-revision'], ['e', 'missing-v1-id', '', 'reply']],
  });
  const series = buildPatchSeries([v2]);
  assert.equal(series.length, 1);
  assert.equal(series[0].rootId, 'missing-v1-id', 'anchored to the dangling parent');
  assert.equal(series[0].revisions.length, 1);
});

// ── buildPatchSeries: orphans ───────────────────────────────────────────

test('buildPatchSeries: orphan patch (no t=root, no chain) becomes its own series', () => {
  // A bare event with no thread markers — surface it as a 1-patch
  // series rather than dropping it silently. Better legible than lossy.
  const orphan = ev({ id: 'o' + 'a'.repeat(63), content: SAMPLE_PATCH });
  const series = buildPatchSeries([orphan]);
  assert.equal(series.length, 1);
  assert.equal(series[0].patchCount, 1);
  assert.equal(series[0].revisions[0].patches[0].id, orphan.id);
});

// ── buildPatchSeries: sibling series isolation ──────────────────────────

test('buildPatchSeries: sibling series do not bleed into each other', () => {
  // Two independent series, both with root + one follower. Each
  // chain must contain only its own follower.
  const aRoot = ev({ id: 'A' + 'a'.repeat(63), created_at: 1000, tags: [['t', 'root']] });
  const aFol  = ev({ id: 'a' + 'a'.repeat(63), created_at: 1001, tags: [['e', aRoot.id, '', 'reply']] });
  const bRoot = ev({ id: 'B' + 'a'.repeat(63), created_at: 1500, tags: [['t', 'root']] });
  const bFol  = ev({ id: 'b' + 'a'.repeat(63), created_at: 1501, tags: [['e', bRoot.id, '', 'reply']] });
  const series = buildPatchSeries([aRoot, aFol, bRoot, bFol]);
  assert.equal(series.length, 2);
  for (const s of series) {
    assert.equal(s.revisions[0].patches.length, 2,
      'each series has root + one follower, no cross-pollination');
  }
});

// ── buildPatchSeries: ordering ──────────────────────────────────────────

test('buildPatchSeries: result sorted by latestRevisionAt descending', () => {
  // Older series listed second even though its v1 root is newer than
  // the other series' v1 — what matters for the inbox view is which
  // PR has the most recent activity.
  const oldRoot = ev({ id: 'old' + 'a'.repeat(61), created_at: 1000, tags: [['t', 'root']] });
  const newRoot = ev({ id: 'new' + 'a'.repeat(61), created_at: 5000, tags: [['t', 'root']] });
  const series = buildPatchSeries([oldRoot, newRoot]);
  assert.equal(series[0].rootId, newRoot.id, 'newest activity first');
  assert.equal(series[1].rootId, oldRoot.id);
});

// ── parsePatchContent ───────────────────────────────────────────────────

test('parsePatchContent: extracts file + chunk metadata from a unified diff', () => {
  const r = parsePatchContent(SAMPLE_PATCH);
  assert.equal(r.fileCount,      1);
  assert.equal(r.totalAdditions, 2);
  assert.equal(r.totalDeletions, 0);
  const f = r.files[0];
  assert.equal(f.from,      'hello.txt');
  assert.equal(f.to,        'hello.txt');
  assert.equal(f.additions, 2);
  assert.equal(f.deletions, 0);
  assert.equal(f.chunks.length, 1);
  assert.equal(f.chunks[0].newStart, 1);
  assert.equal(f.chunks[0].newLines, 2);
});

test('parsePatchContent: empty input returns empty result (no throw)', () => {
  const r = parsePatchContent('');
  assert.deepEqual(r, { files: [], totalAdditions: 0, totalDeletions: 0, fileCount: 0 });
});

test('parsePatchContent: malformed input returns empty result rather than throwing', () => {
  // Cover letters end up here too — pure narrative with no diff
  // chunks. Should not crash.
  const r = parsePatchContent('# Just a cover letter\n\nNo diff in sight.');
  assert.equal(r.fileCount, 0);
  assert.equal(r.totalAdditions, 0);
});
