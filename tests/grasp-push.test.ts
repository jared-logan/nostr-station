import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  selectGraspCloneUrls,
  buildRepoStateTags,
  repoStateTagsEqual,
  readLocalRefs,
  validPreservedHead,
} = await import('../src/lib/grasp-push.ts');
const { CLIENT_TAG } = await import('../src/lib/client-tag.ts');

// ── selectGraspCloneUrls ─────────────────────────────────────────────────

test('selectGraspCloneUrls: keeps only https URLs, order preserved', () => {
  const out = selectGraspCloneUrls([
    'https://git.shakespeare.diy/npub1/amon-din.git',
    'https://relay.ngit.dev/npub1/amon-din.git',
    'nostr://npub1/amon-din',
    'git://example.com/x.git',
    'ssh://git@example.com/x.git',
  ]);
  assert.deepEqual(out, [
    'https://git.shakespeare.diy/npub1/amon-din.git',
    'https://relay.ngit.dev/npub1/amon-din.git',
  ]);
});

test('selectGraspCloneUrls: dedupes by normalized href, drops junk', () => {
  const out = selectGraspCloneUrls([
    'https://git.shakespeare.diy/a.git',
    'https://git.shakespeare.diy/a.git',
    '  ',
    'not a url',
    42 as unknown as string,
  ]);
  assert.deepEqual(out, ['https://git.shakespeare.diy/a.git']);
});

test('selectGraspCloneUrls: empty input → empty output', () => {
  assert.deepEqual(selectGraspCloneUrls([]), []);
});

// ── buildRepoStateTags ───────────────────────────────────────────────────

const refs = (over: any = {}) => ({
  currentBranch: 'main',
  headOid: 'a'.repeat(40),
  branches: [['main', 'a'.repeat(40)], ['dev', 'b'.repeat(40)]] as [string, string][],
  tags: [['v1', 'c'.repeat(40)]] as [string, string][],
  ...over,
});

test('buildRepoStateTags: symbolic HEAD + all refs in NIP-34 shape', () => {
  const tags = buildRepoStateTags('amon-din', refs());
  assert.deepEqual(tags, [
    ['d', 'amon-din'],
    ['HEAD', 'ref: refs/heads/main'],
    ['refs/heads/main', 'a'.repeat(40)],
    ['refs/heads/dev', 'b'.repeat(40)],
    ['refs/tags/v1', 'c'.repeat(40)],
    [...CLIENT_TAG],
  ]);
});

test('buildRepoStateTags: stamps the canonical 4-element client tag', () => {
  const tags = buildRepoStateTags('r', refs());
  const clients = tags.filter(t => t[0] === 'client');
  assert.deepEqual(clients, [[...CLIENT_TAG]]);
});

// A prior published state, in 30618 tag shape. Announces main + dev + v1.
const priorState = (over: string[][] = []) => ([
  ['d', 'amon-din'],
  ['HEAD', 'ref: refs/heads/main'],
  ['refs/heads/main', 'a'.repeat(40)],
  ['refs/heads/dev', 'b'.repeat(40)],
  ['refs/tags/v1', 'c'.repeat(40)],
  [...CLIENT_TAG],
  ...over,
] as string[][]);

test('buildRepoStateTags: preserves an existing HEAD tag that still resolves', () => {
  const tags = buildRepoStateTags('amon-din', refs({ currentBranch: 'feature' }), priorState());
  // HEAD stays pinned to main even though the local branch is `feature` —
  // `main` is still among the announced branches, so the pin is honoured.
  assert.deepEqual(tags[1], ['HEAD', 'ref: refs/heads/main']);
});

// ── deliverable-set narrowing (the TUI scratch-branch fix) ─────────────────
//
// We push only the current branch, so the announced ref set is
// {current branch, local oid} ∪ {prior-announced branches, prior oids}. Local-
// only scratch branches that were never pushed must NOT be announced — else
// every throwaway claude/* branch reads as "differs on git server" forever.

test('buildRepoStateTags: drops local-only scratch branches never in the prior state', () => {
  const local = refs({
    currentBranch: 'claude/feature',
    branches: [
      ['main', 'a'.repeat(40)],
      ['claude/feature', 'd'.repeat(40)],   // current → announced
      ['claude/scratch', 'e'.repeat(40)],   // local-only, not current → DROPPED
    ] as [string, string][],
    tags: [] as [string, string][],
  });
  const tags = buildRepoStateTags('amon-din', local, priorState());
  const branches = tags.filter(t => t[0].startsWith('refs/heads/')).map(t => t[0]);
  assert.deepEqual(branches.sort(), ['refs/heads/claude/feature', 'refs/heads/dev', 'refs/heads/main']);
  assert.equal(branches.includes('refs/heads/claude/scratch'), false);
});

test('buildRepoStateTags: non-current branches keep the PRIOR oid, not the local one', () => {
  // Local main is AHEAD of the host (committed locally, only pushed the
  // feature branch). Announcing the local oid would pin a commit the host
  // lacks → drift. We must re-announce main at its prior (host) oid.
  const local = refs({
    currentBranch: 'claude/feature',
    branches: [
      ['main', 'f'.repeat(40)],                  // local main moved ahead
      ['claude/feature', 'd'.repeat(40)],
    ] as [string, string][],
    tags: [] as [string, string][],
  });
  const tags = buildRepoStateTags('amon-din', local, priorState());
  assert.deepEqual(tags.find(t => t[0] === 'refs/heads/main'), ['refs/heads/main', 'a'.repeat(40)]);
  assert.deepEqual(tags.find(t => t[0] === 'refs/heads/claude/feature'), ['refs/heads/claude/feature', 'd'.repeat(40)]);
});

test('buildRepoStateTags: the current branch IS upserted to its local oid', () => {
  // On main, local main advanced — the branch we push gets the new oid.
  const local = refs({ currentBranch: 'main', branches: [['main', 'f'.repeat(40)], ['dev', 'b'.repeat(40)]] as [string, string][], tags: [] as [string, string][] });
  const tags = buildRepoStateTags('amon-din', local, priorState());
  assert.deepEqual(tags.find(t => t[0] === 'refs/heads/main'), ['refs/heads/main', 'f'.repeat(40)]);
});

test('buildRepoStateTags: tags are preserved from the prior state, local-only tags dropped', () => {
  // We never deliver tags, so a local tag that was never pushed must not be
  // announced; the prior state's tags ride through unchanged.
  const local = refs({ tags: [['v1', 'c'.repeat(40)], ['v2-local', '9'.repeat(40)]] as [string, string][] });
  const tags = buildRepoStateTags('amon-din', local, priorState());
  const tagRefs = tags.filter(t => t[0].startsWith('refs/tags/')).map(t => t[0]);
  assert.deepEqual(tagRefs, ['refs/tags/v1']);
});

// ── stale-HEAD guard ──────────────────────────────────────────────────────
//
// A preserved HEAD must still resolve within the ANNOUNCED ref set. Re-
// announcing a rebased-away commit or a branch outside (current ∪ prior) is
// the "announced commit not found on git server" warning gitworkshop shows.

test('buildRepoStateTags: a preserved HEAD to a branch outside (current ∪ prior) falls back', () => {
  // Prior carries a HEAD→master pointer but NO refs/heads/master tag (the
  // branch was deleted), and master isn't the current branch → not announced.
  const tags = buildRepoStateTags(
    'amon-din',
    refs(),                                              // on main
    [['d', 'amon-din'], ['HEAD', 'ref: refs/heads/master'], ['refs/heads/dev', 'b'.repeat(40)], [...CLIENT_TAG]],
  );
  assert.deepEqual(tags[1], ['HEAD', 'ref: refs/heads/main']);
});

test('buildRepoStateTags: a preserved detached-oid HEAD is kept only while it is an announced tip', () => {
  // Prior pins HEAD to the dev tip (an announced branch oid) → preserved.
  const kept = buildRepoStateTags('amon-din', refs(), [
    ['d', 'amon-din'],
    ['HEAD', 'b'.repeat(40)],                // detached, == the dev tip below
    ['refs/heads/main', 'a'.repeat(40)],
    ['refs/heads/dev', 'b'.repeat(40)],
    [...CLIENT_TAG],
  ]);
  assert.deepEqual(kept[1], ['HEAD', 'b'.repeat(40)]);
  // Prior pins HEAD to a commit matching no announced tip (rebased away) →
  // falls back to the current branch.
  const dropped = buildRepoStateTags('amon-din', refs(), [['d', 'amon-din'], ['HEAD', 'e'.repeat(40)], ['refs/heads/main', 'a'.repeat(40)], [...CLIENT_TAG]]);
  assert.deepEqual(dropped[1], ['HEAD', 'ref: refs/heads/main']);
});

test('validPreservedHead: malformed tags are never preserved', () => {
  const branches = new Map([['main', 'a'.repeat(40)]]);
  const tags = new Map<string, string>();
  assert.equal(validPreservedHead(null, branches, tags), null);
  assert.equal(validPreservedHead(['HEAD'], branches, tags), null);
  assert.equal(validPreservedHead(['head', 'ref: refs/heads/main'], branches, tags), null);
});

test('buildRepoStateTags: detached HEAD falls back to the commit oid (bootstrap, no prior)', () => {
  const tags = buildRepoStateTags('r', refs({ currentBranch: '', headOid: 'f'.repeat(40) }));
  assert.deepEqual(tags[1], ['HEAD', 'f'.repeat(40)]);
});

test('buildRepoStateTags: skips refs missing a name or oid', () => {
  const tags = buildRepoStateTags('r', refs({
    branches: [['main', 'a'.repeat(40)], ['', 'x'], ['broken', '']] as [string, string][],
    tags: [],
  }));
  const refNames = tags.filter(t => t[0].startsWith('refs/')).map(t => t[0]);
  assert.deepEqual(refNames, ['refs/heads/main']);
});

// ── repoStateTagsEqual ───────────────────────────────────────────────────

test('repoStateTagsEqual: order-insensitive equality', () => {
  const a = [['d', 'r'], ['refs/heads/main', 'aaa'], ['refs/heads/dev', 'bbb']];
  const b = [['refs/heads/dev', 'bbb'], ['d', 'r'], ['refs/heads/main', 'aaa']];
  assert.equal(repoStateTagsEqual(a, b), true);
});

test('repoStateTagsEqual: detects a changed oid', () => {
  const a = [['d', 'r'], ['refs/heads/main', 'aaa']];
  const b = [['d', 'r'], ['refs/heads/main', 'zzz']];
  assert.equal(repoStateTagsEqual(a, b), false);
});

test('repoStateTagsEqual: different lengths are unequal', () => {
  assert.equal(repoStateTagsEqual([['d', 'r']], [['d', 'r'], ['x', 'y']]), false);
});

// Client tags are attribution, not state — a published 30618 that predates the
// client tag must still count as equal so unchanged refs never force a fresh
// signer prompt just to stamp it.
test('repoStateTagsEqual: ignores client tags on either side', () => {
  const prior = [['d', 'r'], ['refs/heads/main', 'aaa']];
  const next  = [['d', 'r'], ['refs/heads/main', 'aaa'], [...CLIENT_TAG]];
  assert.equal(repoStateTagsEqual(prior, next), true);
  assert.equal(repoStateTagsEqual(next, prior), true);
  // A stale bare client tag vs the canonical one is also a non-difference.
  assert.equal(
    repoStateTagsEqual([...prior, ['client', 'nostr-station']], next),
    true,
  );
  // But a real ref change is still detected even with matching client tags.
  assert.equal(
    repoStateTagsEqual(next, [['d', 'r'], ['refs/heads/main', 'zzz'], [...CLIENT_TAG]]),
    false,
  );
});

// ── readLocalRefs ────────────────────────────────────────────────────────

test('readLocalRefs: parses symbolic-ref, rev-parse and for-each-ref', async () => {
  const run = async (args: string[]): Promise<string> => {
    if (args[0] === 'symbolic-ref') return 'main\n';
    if (args[0] === 'rev-parse')    return `${'a'.repeat(40)}\n`;
    if (args[0] === 'for-each-ref' && args[2] === 'refs/heads') {
      return `main\0${'a'.repeat(40)}\ndev\0${'b'.repeat(40)}\n`;
    }
    if (args[0] === 'for-each-ref' && args[2] === 'refs/tags') {
      return `v1\0${'c'.repeat(40)}\n`;
    }
    return '';
  };
  const out = await readLocalRefs(run);
  assert.equal(out.currentBranch, 'main');
  assert.equal(out.headOid, 'a'.repeat(40));
  assert.deepEqual(out.branches, [['main', 'a'.repeat(40)], ['dev', 'b'.repeat(40)]]);
  assert.deepEqual(out.tags, [['v1', 'c'.repeat(40)]]);
});

test('readLocalRefs: detached HEAD → empty currentBranch, refs still read', async () => {
  const run = async (args: string[]): Promise<string> => {
    if (args[0] === 'symbolic-ref') throw new Error('not a symbolic ref');
    if (args[0] === 'rev-parse')    return `${'d'.repeat(40)}\n`;
    if (args[0] === 'for-each-ref' && args[2] === 'refs/heads') return `main\0${'a'.repeat(40)}\n`;
    return '';
  };
  const out = await readLocalRefs(run);
  assert.equal(out.currentBranch, '');
  assert.equal(out.headOid, 'd'.repeat(40));
  assert.deepEqual(out.branches, [['main', 'a'.repeat(40)]]);
  assert.deepEqual(out.tags, []);
});
