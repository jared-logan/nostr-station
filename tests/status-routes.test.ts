import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  isAuthorisedToSetStatus,
  computeEffectiveStatus,
  parseStatusInput,
  buildStatusRelayFilters,
} = await import('../src/lib/routes/status.ts');

const ROOT_AUTHOR = 'a'.repeat(64);
const MAINTAINER  = 'b'.repeat(64);
const STRANGER    = 'c'.repeat(64);
const ROOT_ID     = 'r'.repeat(64);

function statusEv(over: any): any {
  return {
    id:         'e'.repeat(64),
    pubkey:     ROOT_AUTHOR,
    kind:       1630,
    created_at: 1_700_000_000,
    tags:       [['e', ROOT_ID]],
    content:    '',
    sig:        's'.repeat(128),
    ...over,
  };
}

// ── isAuthorisedToSetStatus ──────────────────────────────────────────────

test('isAuthorisedToSetStatus: root author is always authorised', () => {
  assert.equal(isAuthorisedToSetStatus(ROOT_AUTHOR, ROOT_AUTHOR, new Set()), true);
});

test('isAuthorisedToSetStatus: maintainer-set membership grants authority', () => {
  const m = new Set([MAINTAINER]);
  assert.equal(isAuthorisedToSetStatus(MAINTAINER, ROOT_AUTHOR, m), true);
});

test('isAuthorisedToSetStatus: stranger refused', () => {
  const m = new Set([MAINTAINER]);
  assert.equal(isAuthorisedToSetStatus(STRANGER, ROOT_AUTHOR, m), false);
});

// ── computeEffectiveStatus ──────────────────────────────────────────────

test('computeEffectiveStatus: no events → defaults to open', () => {
  const r = computeEffectiveStatus(ROOT_ID, ROOT_AUTHOR, new Set(), []);
  assert.equal(r.status, 'open');
  assert.equal(r.statusEventId, null);
  assert.equal(r.lastChangedAt, 0);
});

test('computeEffectiveStatus: 1630 from root author → open', () => {
  const ev = statusEv({ kind: 1630, pubkey: ROOT_AUTHOR });
  const r = computeEffectiveStatus(ROOT_ID, ROOT_AUTHOR, new Set(), [ev]);
  assert.equal(r.status, 'open');
});

test('computeEffectiveStatus: 1632 → closed', () => {
  const ev = statusEv({ kind: 1632, pubkey: ROOT_AUTHOR });
  assert.equal(computeEffectiveStatus(ROOT_ID, ROOT_AUTHOR, new Set(), [ev]).status, 'closed');
});

test('computeEffectiveStatus: 1633 → draft', () => {
  const ev = statusEv({ kind: 1633, pubkey: ROOT_AUTHOR });
  assert.equal(computeEffectiveStatus(ROOT_ID, ROOT_AUTHOR, new Set(), [ev]).status, 'draft');
});

test('computeEffectiveStatus: 1631 with merge-commit tag → merged', () => {
  const ev = statusEv({
    kind: 1631, pubkey: ROOT_AUTHOR,
    tags: [['e', ROOT_ID], ['merge-commit', 'a'.repeat(40)]],
  });
  const r = computeEffectiveStatus(ROOT_ID, ROOT_AUTHOR, new Set(), [ev]);
  assert.equal(r.status, 'merged');
  assert.equal(r.mergeCommit, 'a'.repeat(40));
});

test('computeEffectiveStatus: 1631 with applied-as-commits → merged', () => {
  // Patches can be applied without a merge commit (squash / rebase /
  // cherry-pick) — the `applied-as-commits` tag flags this path.
  const ev = statusEv({
    kind: 1631, pubkey: ROOT_AUTHOR,
    tags: [['e', ROOT_ID], ['applied-as-commits', 'a'.repeat(40)]],
  });
  assert.equal(computeEffectiveStatus(ROOT_ID, ROOT_AUTHOR, new Set(), [ev]).status, 'merged');
});

test('computeEffectiveStatus: 1631 without merge/applied tags → resolved (issue path)', () => {
  // For issues, 1631 means "resolved" rather than "merged". Differs
  // by which patch-specific tags are present.
  const ev = statusEv({ kind: 1631, pubkey: ROOT_AUTHOR, tags: [['e', ROOT_ID]] });
  assert.equal(computeEffectiveStatus(ROOT_ID, ROOT_AUTHOR, new Set(), [ev]).status, 'resolved');
});

test('computeEffectiveStatus: 1631 with alt="PR merged" → merged (ngit 2.x pr merge)', () => {
  // ngit 2.x's `pr merge` publishes a kind-1631 with `alt: "PR merged"`
  // but no `merge-commit` / `applied-as-commits` tag. The pre-fix detector
  // missed this and fell through to 'resolved' — pinning here so the
  // alt-based fallback can't regress.
  const ev = statusEv({
    kind: 1631, pubkey: ROOT_AUTHOR,
    tags: [
      ['alt', 'PR merged'],
      ['e', ROOT_ID, 'wss://git.shakespeare.diy/', 'root'],
      ['a', '30617:' + ROOT_AUTHOR + ':blip'],
      ['r', ''],
    ],
  });
  assert.equal(computeEffectiveStatus(ROOT_ID, ROOT_AUTHOR, new Set(), [ev]).status, 'merged');
});

test('computeEffectiveStatus: 1631 with alt="Status change" + no merge tag → resolved', () => {
  // Pins the negative side of the alt heuristic: gitworkshop sometimes
  // publishes merge events with alt="Status change" (the merge signal
  // lives in merge-commit). Without merge-commit AND without "merge" in
  // alt, the event is an issue-style resolution.
  const ev = statusEv({
    kind: 1631, pubkey: ROOT_AUTHOR,
    tags: [['alt', 'Status change'], ['e', ROOT_ID]],
  });
  assert.equal(computeEffectiveStatus(ROOT_ID, ROOT_AUTHOR, new Set(), [ev]).status, 'resolved');
});

test('computeEffectiveStatus: latest-wins among multiple authorised events', () => {
  // Order: open (oldest) → closed → draft (newest). Final status
  // is draft because that's the most recent authorised event.
  const evs = [
    statusEv({ id: '1'.repeat(64), kind: 1630, created_at: 1000, pubkey: ROOT_AUTHOR }),
    statusEv({ id: '2'.repeat(64), kind: 1632, created_at: 2000, pubkey: ROOT_AUTHOR }),
    statusEv({ id: '3'.repeat(64), kind: 1633, created_at: 3000, pubkey: ROOT_AUTHOR }),
  ];
  const r = computeEffectiveStatus(ROOT_ID, ROOT_AUTHOR, new Set(), evs);
  assert.equal(r.status, 'draft');
  assert.equal(r.statusEventId, '3'.repeat(64));
});

test('computeEffectiveStatus: unauthorised events ignored entirely', () => {
  // Stranger publishes a 1632 (closed) — must not affect status.
  const evs = [
    statusEv({ id: '1'.repeat(64), kind: 1630, created_at: 1000, pubkey: ROOT_AUTHOR }),
    statusEv({ id: '2'.repeat(64), kind: 1632, created_at: 9999, pubkey: STRANGER }),
  ];
  const r = computeEffectiveStatus(ROOT_ID, ROOT_AUTHOR, new Set(), evs);
  assert.equal(r.status, 'open',  'stranger 1632 must not flip status');
  assert.equal(r.statusEventId, '1'.repeat(64));
});

test('computeEffectiveStatus: maintainer event accepted', () => {
  const evs = [
    statusEv({ kind: 1632, pubkey: MAINTAINER }),
  ];
  const r = computeEffectiveStatus(ROOT_ID, ROOT_AUTHOR, new Set([MAINTAINER]), evs);
  assert.equal(r.status, 'closed');
});

test('computeEffectiveStatus: ignores events that reference a different root', () => {
  // Event whose `e` tag points elsewhere should be skipped.
  const evs = [
    statusEv({ kind: 1632, pubkey: ROOT_AUTHOR, tags: [['e', 'different-root-id']] }),
  ];
  assert.equal(computeEffectiveStatus(ROOT_ID, ROOT_AUTHOR, new Set(), evs).status, 'open');
});

test('computeEffectiveStatus: out-of-range kind ignored', () => {
  // 1620 / 1634 must never be misread as status events.
  const stray = statusEv({ kind: 1620, pubkey: ROOT_AUTHOR });
  assert.equal(computeEffectiveStatus(ROOT_ID, ROOT_AUTHOR, new Set(), [stray]).status, 'open');
});

// ── parseStatusInput ────────────────────────────────────────────────────
//
// Replaced the old buildStatusArgs ngit-argv builder when status
// changes went native (src/lib/nip34-events.ts). The validation
// (rootId shape + kind/status allow-lists) is unchanged.

test('parseStatusInput: patch · open', () => {
  assert.deepEqual(
    parseStatusInput({ kind: 'patch', rootId: 'a'.repeat(64), status: 'open' }),
    { target: 'patch', rootId: 'a'.repeat(64), verb: 'open' },
  );
});

test('parseStatusInput: patch · draft', () => {
  assert.deepEqual(
    parseStatusInput({ kind: 'patch', rootId: 'a'.repeat(64), status: 'draft' }),
    { target: 'patch', rootId: 'a'.repeat(64), verb: 'draft' },
  );
});

test('parseStatusInput: patch · closed', () => {
  assert.deepEqual(
    parseStatusInput({ kind: 'patch', rootId: 'a'.repeat(64), status: 'closed' }),
    { target: 'patch', rootId: 'a'.repeat(64), verb: 'closed' },
  );
});

test('parseStatusInput: issue · resolved', () => {
  assert.deepEqual(
    parseStatusInput({ kind: 'issue', rootId: 'a'.repeat(64), status: 'resolved' }),
    { target: 'issue', rootId: 'a'.repeat(64), verb: 'resolved' },
  );
});

test('parseStatusInput: rejects mismatched kind/status pair', () => {
  // Patches don't get "resolved"; issues don't get "draft".
  assert.equal(parseStatusInput({ kind: 'patch', rootId: 'a'.repeat(64), status: 'resolved' }), null);
  assert.equal(parseStatusInput({ kind: 'issue', rootId: 'a'.repeat(64), status: 'draft' }),    null);
});

test('parseStatusInput: rejects invalid rootId / kind / status', () => {
  assert.equal(parseStatusInput({ kind: 'patch', rootId: 'not-hex', status: 'open' }),    null);
  assert.equal(parseStatusInput({ kind: 'other', rootId: 'a'.repeat(64), status: 'open' }), null);
  assert.equal(parseStatusInput({ kind: 'patch', rootId: 'a'.repeat(64), status: 'merged' }), null);
});

// ── buildStatusRelayFilters ─────────────────────────────────────────────
//
// Regression cover for the "merged PR shows as open" bug. The relay
// query MUST also filter by `#e: <rootIds>` — not just `#a: <repo>` —
// or we miss 1631 merge events that omit the repo a-tag (which is what
// ngit / gitworkshop have historically published).

const A_TAG = '30617:' + 'a'.repeat(64) + ':my-repo';

test('buildStatusRelayFilters: a-tag filter always present', () => {
  const filters = buildStatusRelayFilters(A_TAG, []);
  assert.equal(filters.length, 1);
  assert.deepEqual(filters[0].kinds, [1630, 1631, 1632, 1633]);
  assert.equal(filters[0].tags?.a, A_TAG);
});

test('buildStatusRelayFilters: e-tag filter appended when rootIds present', () => {
  const rootIds = ['r'.repeat(64), 's'.repeat(64)];
  const filters = buildStatusRelayFilters(A_TAG, rootIds);
  assert.equal(filters.length, 2, 'must issue both a-tag and e-tag filters');
  assert.equal(filters[0].tags?.a, A_TAG);
  // The e-tag filter is what rescues 1631 merge events that omit the
  // repo a-tag — the actual symptom the user hit on gitworkshop PRs.
  assert.deepEqual(filters[1].kinds, [1630, 1631, 1632, 1633]);
  assert.deepEqual(filters[1].tags?.e, rootIds);
});

test('buildStatusRelayFilters: empty rootIds → a-tag only (no useless e filter)', () => {
  const filters = buildStatusRelayFilters(A_TAG, []);
  assert.equal(filters.length, 1);
  assert.equal(filters[0].tags?.e, undefined);
});

test('computeEffectiveStatus: empty-string rootAuthor never accidentally matches a stranger', () => {
  // Defensive: when fetchRootAuthors fails to resolve a rootId we pass
  // '' as rootAuthor. That must NOT let a stranger publish status —
  // real pubkeys are 64-hex and never equal ''. Locks the fallback.
  const stranger = statusEv({ kind: 1632, created_at: 9999, pubkey: STRANGER });
  const r = computeEffectiveStatus(ROOT_ID, '', new Set(), [stranger]);
  assert.equal(r.status, 'open', 'stranger with empty-rootAuthor must not flip status');
  assert.equal(r.statusEventId, null);
});

test('computeEffectiveStatus: 1631 merge event without a-tag still resolves merged', () => {
  // Simulates the exact wire shape that broke the dashboard: a kind-
  // 1631 status event published with the root `e` reference and a
  // merge-commit tag, but NO repo `a` tag. computeEffectiveStatus must
  // pick it up — and (with the relay-query fix in buildStatusRelayFilters)
  // the upstream fetch now delivers it to this function in the first place.
  const ev = statusEv({
    kind: 1631,
    pubkey: ROOT_AUTHOR,
    tags: [['e', ROOT_ID], ['merge-commit', 'd'.repeat(40)]],
    // explicitly no `a` tag
  });
  const r = computeEffectiveStatus(ROOT_ID, ROOT_AUTHOR, new Set(), [ev]);
  assert.equal(r.status, 'merged');
  assert.equal(r.mergeCommit, 'd'.repeat(40));
});

// ── Regression: user-reported blip merge event ──────────────────────────
//
// Exact event JSON the user pulled from gitworkshop.dev for the Blip PR
// that displays as "Merged" on gitworkshop but stuck at "Open" on
// nostr-station. If THIS test passes the compute path is correct
// end-to-end and the bug is upstream (relay query not returning the
// event, or a stale cache shadowing it).

test('regression(blip): real 1631 merge event → status === merged', () => {
  const ANCHOR_PK = '291c75d937a45f66a1209f8ea6611df7448c59b3526520c66ca2cdcd37f1bfbe';
  const PATCH_ROOT_ID = 'a2f7d506ce65e8b736a3f6afe7a847bfe6de4370fa2de47dd6bfa70bb5c93e90';
  const mergeEvent = {
    id: '406dff306888f62bb47a9025b6deb312047b859d5471b47b2bec5304cf0fa11c',
    pubkey: ANCHOR_PK,
    kind: 1631,
    created_at: 1778209426,
    content: '',
    sig: 'a23db6f7be04b50dfba09d1613cbd844c394ed9db3bd1735a617221934c487fe22832c5e0d13b9aec9e8312f5daa9e9f58b7b79a6cfe4ee7656af3e930548f48',
    tags: [
      ['e', PATCH_ROOT_ID, '', 'root'],
      ['a', `30617:${ANCHOR_PK}:blip`],
      ['alt', 'Status change'],
      ['merge-commit', '6e0ba1372691ef3103b380c629a51aced16e9348'],
      ['r', '6e0ba1372691ef3103b380c629a51aced16e9348'],
      ['q', PATCH_ROOT_ID, '', ANCHOR_PK],
    ],
  };
  // Maintainer set in the form fetchMaintainerSet would build for blip
  // (no maintainers tag → just the trust anchor, permissive union).
  const maintainers = new Set([ANCHOR_PK]);
  // rootAuthor matches the trust anchor (self-merge).
  const r = computeEffectiveStatus(PATCH_ROOT_ID, ANCHOR_PK, maintainers, [mergeEvent as any]);
  assert.equal(r.status, 'merged', 'merge event from trust anchor must compute to merged');
  assert.equal(r.statusEventId, mergeEvent.id);
  assert.equal(r.mergeCommit, '6e0ba1372691ef3103b380c629a51aced16e9348');
});

test('regression(blip): empty rootAuthor still authorises trust-anchor merge via maintainer set', () => {
  // Same event, but simulate fetchRootAuthors returning nothing —
  // pubkey === '' (empty fallback). The permissive maintainer set
  // (which always includes the trust anchor) must still authorise.
  const ANCHOR_PK = '291c75d937a45f66a1209f8ea6611df7448c59b3526520c66ca2cdcd37f1bfbe';
  const PATCH_ROOT_ID = 'a2f7d506ce65e8b736a3f6afe7a847bfe6de4370fa2de47dd6bfa70bb5c93e90';
  const mergeEvent = {
    id: '406dff306888f62bb47a9025b6deb312047b859d5471b47b2bec5304cf0fa11c',
    pubkey: ANCHOR_PK,
    kind: 1631,
    created_at: 1778209426,
    content: '',
    sig: 'x',
    tags: [
      ['e', PATCH_ROOT_ID, '', 'root'],
      ['a', `30617:${ANCHOR_PK}:blip`],
      ['merge-commit', '6e0ba1372691ef3103b380c629a51aced16e9348'],
    ],
  };
  const r = computeEffectiveStatus(
    PATCH_ROOT_ID,
    '',                             // rootAuthor unresolved
    new Set([ANCHOR_PK]),           // permissive maintainer set
    [mergeEvent as any],
  );
  assert.equal(r.status, 'merged');
});
