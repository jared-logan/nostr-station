/**
 * Tests for the native NIP-34 / NIP-22 event builders.
 *
 * Expected tag shapes are taken DIRECTLY from ngit-cli's Rust source
 * (the canonical NIP-34 producer — gitworkshop.dev must render our
 * events identically to ngit's):
 *   - issues:   src/bin/ngit/sub_commands/issue_create.rs:44-83
 *   - comments: src/bin/ngit/sub_commands/comment.rs:108-136
 *   - status:   src/bin/ngit/sub_commands/pr_status.rs:120-167 and
 *               issue_status.rs:112-157
 *   - a-tag shape (NO relay hint): src/lib/repo_ref.rs:307-329
 *     (coordinates() builds Nip19Coordinate{relays: vec![]}, so
 *     TagStandard::Coordinate serializes to 2 elements)
 *   - e-tag root marker with empty-string relay placeholder:
 *     rust-nostr TagStandard::Event serialization — observable in
 *     real ngit events, e.g. ["e", <id>, "", "root"].
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  buildIssueTemplate,
  buildCommentTemplate,
  buildIssueCommentTemplate,
  buildStatusTemplate,
  statusAltText,
  repoCoordinateTags,
  STATUS_KIND_BY_VERB,
  KIND_GIT_ISSUE,
  KIND_GIT_COMMENT,
} = await import('../src/lib/nip34-events.ts');
const { CLIENT_TAG, isCanonicalClientTag } = await import('../src/lib/client-tag.ts');

const ANCHOR     = 'a'.repeat(64);
const MAINTAINER = 'b'.repeat(64);
const AUTHOR     = 'c'.repeat(64);
const ROOT_ID    = 'd'.repeat(64);
const PARENT_ID  = 'f'.repeat(64);
const EUC        = '1'.repeat(40);

const REPO = {
  identifier:  'my-repo',
  maintainers: [ANCHOR, MAINTAINER],
  relays:      ['wss://relay.example.com', 'wss://backup.example.com'],
  euc:         EUC,
};

function tagsOf(t: { tags: string[][] }, name: string): string[][] {
  return t.tags.filter((x) => x[0] === name);
}

// ── repoCoordinateTags ──────────────────────────────────────────────────

test('repoCoordinateTags: one bare a tag per maintainer, anchor first, no relay hint', () => {
  // ngit repo_ref.rs:307-329 — coordinates() has relays: vec![] so the
  // serialized a tag is exactly 2 elements.
  assert.deepEqual(repoCoordinateTags(REPO), [
    ['a', `30617:${ANCHOR}:my-repo`],
    ['a', `30617:${MAINTAINER}:my-repo`],
  ]);
});

test('repoCoordinateTags: dedupes and drops non-hex maintainers', () => {
  const tags = repoCoordinateTags({
    ...REPO,
    maintainers: [ANCHOR, ANCHOR, 'npub1notahexkey', MAINTAINER],
  });
  assert.equal(tags.length, 2);
});

// ── buildIssueTemplate (kind 1621) ──────────────────────────────────────

test('buildIssueTemplate: kind 1621 with ngit tag order (a…, subject, t…, alt, p…)', () => {
  // Mirrors issue_create.rs:50-83.
  const t = buildIssueTemplate(REPO, {
    title:  'Fix the thing',
    body:   'It is broken.',
    labels: ['bug', 'urgent'],
  });
  assert.equal(t.kind, KIND_GIT_ISSUE);
  assert.equal(t.kind, 1621);
  assert.equal(t.content, 'It is broken.');
  assert.deepEqual(t.tags, [
    ['a', `30617:${ANCHOR}:my-repo`],            // issue_create.rs:52-59
    ['a', `30617:${MAINTAINER}:my-repo`],
    ['subject', 'Fix the thing'],                // issue_create.rs:61-62
    ['t', 'bug'],                                // issue_create.rs:64-67
    ['t', 'urgent'],
    ['alt', 'git issue: Fix the thing'],         // issue_create.rs:69-73
    ['p', ANCHOR],                               // issue_create.rs:75-78
    ['p', MAINTAINER],
    [...CLIENT_TAG],                             // nostr-station addition
  ]);
});

test('buildIssueTemplate: empty body / no labels', () => {
  const t = buildIssueTemplate(REPO, { title: 'Just a title' });
  assert.equal(t.content, '');
  assert.equal(tagsOf(t, 't').length, 0);
  assert.deepEqual(tagsOf(t, 'subject'), [['subject', 'Just a title']]);
  assert.deepEqual(tagsOf(t, 'alt'), [['alt', 'git issue: Just a title']]);
});

test('buildIssueTemplate: carries the canonical NIP-89 client tag', () => {
  const t = buildIssueTemplate(REPO, { title: 'x' });
  const client = tagsOf(t, 'client');
  assert.equal(client.length, 1, 'exactly one client tag');
  assert.equal(isCanonicalClientTag(client[0]), true, 'must be the 4-element canonical form');
  assert.deepEqual(client[0], [...CLIENT_TAG]);
});

test('buildIssueTemplate: created_at is current unix seconds', () => {
  const before = Math.floor(Date.now() / 1000);
  const t = buildIssueTemplate(REPO, { title: 'x' });
  const after = Math.floor(Date.now() / 1000);
  assert.ok(t.created_at >= before && t.created_at <= after);
});

// ── buildCommentTemplate (kind 1111, NIP-22) ────────────────────────────

test('buildCommentTemplate: top-level on a patch root — E/K/P == e/k/p', () => {
  // Mirrors comment.rs:108-136 with reply_to None (parent == root,
  // comment.rs:90-93). Root here is a kind-1617 patch.
  const root = { id: ROOT_ID, kind: 1617, pubkey: AUTHOR };
  const t = buildCommentTemplate(REPO, { root, parent: root, body: 'nice patch' });
  assert.equal(t.kind, KIND_GIT_COMMENT);
  assert.equal(t.kind, 1111);
  assert.equal(t.content, 'nice patch');
  const hint = 'wss://relay.example.com';        // repo_ref.relays.first() — comment.rs:99-103
  assert.deepEqual(t.tags, [
    ['E', ROOT_ID, hint, AUTHOR],                // comment.rs:110-116
    ['K', '1617'],                               // comment.rs:117-118
    ['P', AUTHOR, hint],                         // comment.rs:119-124
    ['e', ROOT_ID, hint, AUTHOR],                // comment.rs:125-131
    ['k', '1617'],                               // comment.rs:132-133
    ['p', AUTHOR, hint],                         // comment.rs:135
    [...CLIENT_TAG],
  ]);
});

test('buildCommentTemplate: reply — uppercase points at root, lowercase at parent', () => {
  const root   = { id: ROOT_ID,   kind: 1621, pubkey: AUTHOR };
  const parent = { id: PARENT_ID, kind: 1111, pubkey: MAINTAINER };
  const t = buildCommentTemplate(REPO, { root, parent, body: 'replying' });
  const hint = 'wss://relay.example.com';
  assert.deepEqual(tagsOf(t, 'E'), [['E', ROOT_ID, hint, AUTHOR]]);
  assert.deepEqual(tagsOf(t, 'K'), [['K', '1621']]);
  assert.deepEqual(tagsOf(t, 'P'), [['P', AUTHOR, hint]]);
  assert.deepEqual(tagsOf(t, 'e'), [['e', PARENT_ID, hint, MAINTAINER]]);
  assert.deepEqual(tagsOf(t, 'k'), [['k', '1111']]);
  assert.deepEqual(tagsOf(t, 'p'), [['p', MAINTAINER, hint]]);
});

test('buildCommentTemplate: no repo relays → empty-string relay hint (ngit unwrap_or_default)', () => {
  // comment.rs:99-103 — relay_hint falls back to "" and STILL occupies
  // its tag slot (the pubkey stays in position 4).
  const root = { id: ROOT_ID, kind: 1621, pubkey: AUTHOR };
  const t = buildCommentTemplate({ ...REPO, relays: [] }, { root, parent: root, body: 'x' });
  assert.deepEqual(tagsOf(t, 'E'), [['E', ROOT_ID, '', AUTHOR]]);
  assert.deepEqual(tagsOf(t, 'P'), [['P', AUTHOR, '']]);
});

test('buildCommentTemplate: comments carry NO repo a tag and NO maintainer p tags (ngit parity)', () => {
  // ngit's publish_comment emits ONLY the six NIP-22 threading tags —
  // no `a` coordinate, no maintainer notification p-tags
  // (comment.rs:108-136 is the complete tag list).
  const root = { id: ROOT_ID, kind: 1621, pubkey: AUTHOR };
  const t = buildCommentTemplate(REPO, { root, parent: root, body: 'x' });
  assert.equal(tagsOf(t, 'a').length, 0);
  // exactly ONE p tag (the parent author), not one per maintainer
  assert.deepEqual(tagsOf(t, 'p'), [['p', AUTHOR, 'wss://relay.example.com']]);
});

test('buildIssueCommentTemplate: root kind pinned to 1621, parent == root', () => {
  // comment.rs:218-261 launch_issue_comment pins Kind::GitIssue.
  const t = buildIssueCommentTemplate(REPO, {
    issueId: ROOT_ID, issuePubkey: AUTHOR, body: 'me too',
  });
  assert.equal(t.kind, 1111);
  assert.deepEqual(tagsOf(t, 'K'), [['K', '1621']]);
  assert.deepEqual(tagsOf(t, 'k'), [['k', '1621']]);
  assert.equal(tagsOf(t, 'E')[0][1], ROOT_ID);
  assert.equal(tagsOf(t, 'e')[0][1], ROOT_ID);
});

test('buildCommentTemplate: client tag present and canonical', () => {
  const root = { id: ROOT_ID, kind: 1621, pubkey: AUTHOR };
  const t = buildCommentTemplate(REPO, { root, parent: root, body: 'x' });
  const client = tagsOf(t, 'client');
  assert.equal(client.length, 1);
  assert.equal(isCanonicalClientTag(client[0]), true);
});

// ── buildStatusTemplate (kinds 1630-1633) ───────────────────────────────

test('STATUS_KIND_BY_VERB: kind-to-verb mapping matches ngit launch_* entry points', () => {
  // open   → 1630 GitStatusOpen    (pr_status.rs:200-206, issue_status.rs:186-188)
  // resolved → 1631 GitStatusApplied (issue_status.rs:190-192)
  // closed → 1632 GitStatusClosed  (pr_status.rs:196-198, issue_status.rs:182-184)
  // draft  → 1633 GitStatusDraft   (pr_status.rs:208-217)
  assert.deepEqual(STATUS_KIND_BY_VERB, {
    open: 1630, resolved: 1631, closed: 1632, draft: 1633,
  });
});

test('buildStatusTemplate: full ngit tag shape (alt, e-root, p…, a…, r)', () => {
  // Mirrors pr_status.rs:135-167.
  const t = buildStatusTemplate(REPO, {
    target: 'patch', verb: 'closed', rootId: ROOT_ID, rootAuthor: AUTHOR,
  });
  assert.equal(t.kind, 1632);
  assert.equal(t.content, '');
  assert.deepEqual(t.tags, [
    ['alt', 'PR closed'],                                  // pr_status.rs:122,139-142
    ['e', ROOT_ID, 'wss://relay.example.com', 'root'],     // pr_status.rs:143-149
    ['p', ANCHOR],                                         // pr_status.rs:129-131,151
    ['p', MAINTAINER],
    ['p', AUTHOR],                                         // root author joins the set
    ['a', `30617:${ANCHOR}:my-repo`],                      // pr_status.rs:152-162
    ['a', `30617:${MAINTAINER}:my-repo`],
    ['r', EUC],                                            // pr_status.rs:163-165
    [...CLIENT_TAG],
  ]);
});

test('buildStatusTemplate: kind per (target, verb) — patch open/draft/closed', () => {
  assert.equal(buildStatusTemplate(REPO, { target: 'patch', verb: 'open',   rootId: ROOT_ID }).kind, 1630);
  assert.equal(buildStatusTemplate(REPO, { target: 'patch', verb: 'draft',  rootId: ROOT_ID }).kind, 1633);
  assert.equal(buildStatusTemplate(REPO, { target: 'patch', verb: 'closed', rootId: ROOT_ID }).kind, 1632);
});

test('buildStatusTemplate: kind per (target, verb) — issue open/resolved/closed', () => {
  assert.equal(buildStatusTemplate(REPO, { target: 'issue', verb: 'open',     rootId: ROOT_ID }).kind, 1630);
  assert.equal(buildStatusTemplate(REPO, { target: 'issue', verb: 'resolved', rootId: ROOT_ID }).kind, 1631);
  assert.equal(buildStatusTemplate(REPO, { target: 'issue', verb: 'closed',   rootId: ROOT_ID }).kind, 1632);
});

test('statusAltText: matches ngit copy byte-for-byte', () => {
  // pr_status.rs:120-126 / issue_status.rs:112-117. The dashboard's
  // own 1631 merged-vs-resolved heuristic (status.ts mapKind1631)
  // reads this copy, so drift would misclassify our own events.
  assert.equal(statusAltText('patch', 'open'),     'PR reopened');
  assert.equal(statusAltText('patch', 'closed'),   'PR closed');
  assert.equal(statusAltText('patch', 'draft'),    'PR marked as draft');
  assert.equal(statusAltText('issue', 'open'),     'issue reopened');
  assert.equal(statusAltText('issue', 'closed'),   'issue closed');
  assert.equal(statusAltText('issue', 'resolved'), 'issue resolved');
});

test('buildStatusTemplate: issue resolved does NOT trip the merged heuristic alt copy', () => {
  // 1631 is shared between "applied/merged" (patches) and "resolved"
  // (issues); status.ts disambiguates via /\bmerg(e|ed)\b/ on alt.
  const t = buildStatusTemplate(REPO, { target: 'issue', verb: 'resolved', rootId: ROOT_ID });
  const alt = tagsOf(t, 'alt')[0][1];
  assert.equal(/\bmerg(e|ed)\b/i.test(alt), false);
});

test('buildStatusTemplate: no relays → e tag keeps the empty-string relay placeholder', () => {
  // rust-nostr TagStandard::Event with marker Root and relay_url None
  // serializes ["e", id, "", "root"] — seen on real ngit 1631s.
  const t = buildStatusTemplate({ ...REPO, relays: [] }, {
    target: 'issue', verb: 'closed', rootId: ROOT_ID,
  });
  assert.deepEqual(tagsOf(t, 'e'), [['e', ROOT_ID, '', 'root']]);
});

test('buildStatusTemplate: missing euc → ["r", ""] (ngit Reference(root_commit) parity)', () => {
  // pr_status.rs:163-165 emits the r tag unconditionally; real ngit
  // merge events show ["r", ""] when no euc is known.
  const t = buildStatusTemplate({ ...REPO, euc: undefined }, {
    target: 'patch', verb: 'open', rootId: ROOT_ID,
  });
  assert.deepEqual(tagsOf(t, 'r'), [['r', '']]);
});

test('buildStatusTemplate: root author deduped when already a maintainer', () => {
  const t = buildStatusTemplate(REPO, {
    target: 'patch', verb: 'open', rootId: ROOT_ID, rootAuthor: MAINTAINER,
  });
  assert.deepEqual(tagsOf(t, 'p'), [['p', ANCHOR], ['p', MAINTAINER]]);
});

test('buildStatusTemplate: unknown root author → maintainer p tags only', () => {
  const t = buildStatusTemplate(REPO, {
    target: 'patch', verb: 'open', rootId: ROOT_ID, rootAuthor: '',
  });
  assert.deepEqual(tagsOf(t, 'p'), [['p', ANCHOR], ['p', MAINTAINER]]);
});

test('buildStatusTemplate: optional reason becomes content (ngit pr_status.rs:133)', () => {
  const t = buildStatusTemplate(REPO, {
    target: 'issue', verb: 'closed', rootId: ROOT_ID, reason: 'fixed in v2',
  });
  assert.equal(t.content, 'fixed in v2');
});

test('buildStatusTemplate: client tag present and canonical', () => {
  const t = buildStatusTemplate(REPO, { target: 'patch', verb: 'open', rootId: ROOT_ID });
  const client = tagsOf(t, 'client');
  assert.equal(client.length, 1);
  assert.equal(isCanonicalClientTag(client[0]), true);
  assert.deepEqual(client[0], [...CLIENT_TAG]);
});

// ── cross-builder: status events round-trip through computeEffectiveStatus ──

test('our own status events compute correctly in the dashboard read path', async () => {
  const { computeEffectiveStatus } = await import('../src/lib/routes/status.ts');
  const mk = (target: 'patch' | 'issue', verb: any, id: string) => {
    const tpl = buildStatusTemplate(REPO, { target, verb, rootId: ROOT_ID, rootAuthor: AUTHOR });
    return { ...tpl, id, pubkey: ANCHOR, sig: 's'.repeat(128) } as any;
  };
  const maint = new Set([ANCHOR, MAINTAINER]);
  assert.equal(computeEffectiveStatus(ROOT_ID, AUTHOR, maint, [mk('patch', 'closed', '1'.repeat(64))]).status, 'closed');
  assert.equal(computeEffectiveStatus(ROOT_ID, AUTHOR, maint, [mk('patch', 'draft',  '2'.repeat(64))]).status, 'draft');
  assert.equal(computeEffectiveStatus(ROOT_ID, AUTHOR, maint, [mk('issue', 'resolved', '3'.repeat(64))]).status, 'resolved');
  assert.equal(computeEffectiveStatus(ROOT_ID, AUTHOR, maint, [mk('issue', 'open', '4'.repeat(64))]).status, 'open');
});
