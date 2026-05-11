import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  isAuthorisedToSetStatus,
  computeEffectiveStatus,
  buildStatusArgs,
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

// ── buildStatusArgs ─────────────────────────────────────────────────────

test('buildStatusArgs: patch · open', () => {
  assert.deepEqual(
    buildStatusArgs({ kind: 'patch', rootId: 'a'.repeat(64), status: 'open' }),
    ['pr_status', '--open', 'a'.repeat(64)],
  );
});

test('buildStatusArgs: patch · draft', () => {
  assert.deepEqual(
    buildStatusArgs({ kind: 'patch', rootId: 'a'.repeat(64), status: 'draft' }),
    ['pr_status', '--draft', 'a'.repeat(64)],
  );
});

test('buildStatusArgs: patch · closed', () => {
  assert.deepEqual(
    buildStatusArgs({ kind: 'patch', rootId: 'a'.repeat(64), status: 'closed' }),
    ['pr_status', '--closed', 'a'.repeat(64)],
  );
});

test('buildStatusArgs: issue · resolved', () => {
  assert.deepEqual(
    buildStatusArgs({ kind: 'issue', rootId: 'a'.repeat(64), status: 'resolved' }),
    ['issue_status', '--resolved', 'a'.repeat(64)],
  );
});

test('buildStatusArgs: rejects mismatched kind/status pair', () => {
  // Patches don't get "resolved"; issues don't get "draft".
  assert.equal(buildStatusArgs({ kind: 'patch', rootId: 'a'.repeat(64), status: 'resolved' }), null);
  assert.equal(buildStatusArgs({ kind: 'issue', rootId: 'a'.repeat(64), status: 'draft' }),    null);
});

test('buildStatusArgs: rejects invalid rootId / kind / status', () => {
  assert.equal(buildStatusArgs({ kind: 'patch', rootId: 'not-hex', status: 'open' }),    null);
  assert.equal(buildStatusArgs({ kind: 'other', rootId: 'a'.repeat(64), status: 'open' }), null);
  assert.equal(buildStatusArgs({ kind: 'patch', rootId: 'a'.repeat(64), status: 'merged' }), null);
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
