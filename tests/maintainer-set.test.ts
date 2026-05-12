import { test } from 'node:test';
import assert from 'node:assert/strict';

const { buildMaintainerSet } = await import('../src/lib/maintainer-set.ts');

const ANCHOR  = 'a'.repeat(64);
const CO_A    = 'b'.repeat(64);
const CO_B    = 'c'.repeat(64);
const STRANGER = 'd'.repeat(64);

function ev(over: any): any {
  return {
    id:         'x'.repeat(64),
    pubkey:     ANCHOR,
    kind:       30617,
    created_at: 1_700_000_000,
    tags:       [],
    content:    '',
    sig:        's'.repeat(128),
    ...over,
  };
}

// ── Verification graph walks ─────────────────────────────────────────────

test('buildMaintainerSet: trust anchor alone with no maintainers tag', () => {
  // The simplest case — single-maintainer repo. Verified = {anchor}.
  const ix = new Map([
    [ANCHOR, ev({ pubkey: ANCHOR, tags: [['d', 'r'], ['name', 'Repo']] })],
  ]);
  const r = buildMaintainerSet(ANCHOR, 'r', ix);
  assert.deepEqual([...r.verified], [ANCHOR]);
  assert.equal(r.candidatesOnly.size, 0);
  // events: surfaces the anchor's raw 30617 for the inspector modal.
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].pubkey, ANCHOR);
});

test('buildMaintainerSet: events are anchor-first then verified by descending created_at', () => {
  // Mirrors gitworkshop's "Announcement events" ordering — anchor row
  // first regardless of timestamp, then everyone else freshest-first
  // so the most-recent event (which drives the display fields) sits
  // visually near the top with the "selected" badge. The id-uniqueness
  // here also guards the dedup-by-id step inside buildMaintainerSet
  // (events helper would otherwise smear shared default ids).
  const ix = new Map([
    [ANCHOR, ev({ id: '1'.repeat(64), pubkey: ANCHOR, created_at: 1000, tags: [['d', 'r'], ['maintainers', CO_A, CO_B]] })],
    [CO_A,   ev({ id: '2'.repeat(64), pubkey: CO_A,   created_at: 3000, tags: [['d', 'r']] })],
    [CO_B,   ev({ id: '3'.repeat(64), pubkey: CO_B,   created_at: 2000, tags: [['d', 'r']] })],
  ]);
  const r = buildMaintainerSet(ANCHOR, 'r', ix);
  assert.equal(r.events.length, 3);
  assert.equal(r.events[0].pubkey, ANCHOR, 'anchor must be first row');
  assert.equal(r.events[1].pubkey, CO_A,   'next: freshest verified (created_at 3000)');
  assert.equal(r.events[2].pubkey, CO_B,   'then: older verified (created_at 2000)');
});

test('buildMaintainerSet: co-maintainer who published their own 30617 → verified', () => {
  // Anchor lists CO_A; CO_A also has a 30617 under the same identifier.
  // CO_A should be verified, not candidate-only.
  const ix = new Map([
    [ANCHOR, ev({ pubkey: ANCHOR, tags: [['d', 'r'], ['maintainers', CO_A]] })],
    [CO_A,   ev({ pubkey: CO_A,   tags: [['d', 'r']] })],
  ]);
  const r = buildMaintainerSet(ANCHOR, 'r', ix);
  assert.deepEqual([...r.verified].sort(), [ANCHOR, CO_A].sort());
  assert.equal(r.candidatesOnly.size, 0);
});

test('buildMaintainerSet: claimed maintainer WITHOUT their own 30617 → candidate-only', () => {
  // Anchor lists CO_A; CO_A has not published a 30617. This is the
  // anti-scam case — must NOT be verified.
  const ix = new Map([
    [ANCHOR, ev({ pubkey: ANCHOR, tags: [['d', 'r'], ['maintainers', CO_A]] })],
  ]);
  const r = buildMaintainerSet(ANCHOR, 'r', ix);
  assert.deepEqual([...r.verified], [ANCHOR]);
  assert.deepEqual([...r.candidatesOnly], [CO_A]);
});

test('buildMaintainerSet: mix of verified and candidate-only co-maintainers', () => {
  // Anchor lists CO_A (verified) and CO_B (candidate-only).
  const ix = new Map([
    [ANCHOR, ev({ pubkey: ANCHOR, tags: [['d', 'r'], ['maintainers', CO_A, CO_B]] })],
    [CO_A,   ev({ pubkey: CO_A,   tags: [['d', 'r']] })],
    // CO_B absent from index
  ]);
  const r = buildMaintainerSet(ANCHOR, 'r', ix);
  assert.ok(r.verified.has(ANCHOR));
  assert.ok(r.verified.has(CO_A));
  assert.ok(!r.verified.has(CO_B));
  assert.ok(r.candidatesOnly.has(CO_B));
});

test('buildMaintainerSet: nested verification (anchor → CO_A → CO_B)', () => {
  // Anchor lists CO_A; CO_A lists CO_B (and has its own 30617);
  // CO_B has its own 30617. All three should be verified.
  const ix = new Map([
    [ANCHOR, ev({ pubkey: ANCHOR, tags: [['d', 'r'], ['maintainers', CO_A]] })],
    [CO_A,   ev({ pubkey: CO_A,   tags: [['d', 'r'], ['maintainers', CO_B]] })],
    [CO_B,   ev({ pubkey: CO_B,   tags: [['d', 'r']] })],
  ]);
  const r = buildMaintainerSet(ANCHOR, 'r', ix);
  assert.equal(r.verified.size, 3);
  assert.ok(r.verified.has(ANCHOR));
  assert.ok(r.verified.has(CO_A));
  assert.ok(r.verified.has(CO_B));
});

test('buildMaintainerSet: cycle in maintainers graph terminates cleanly', () => {
  // Pathological: A → B → A. Both should be verified (each has
  // their own 30617) and the loop must terminate.
  const ix = new Map([
    [ANCHOR, ev({ pubkey: ANCHOR, tags: [['d', 'r'], ['maintainers', CO_A]] })],
    [CO_A,   ev({ pubkey: CO_A,   tags: [['d', 'r'], ['maintainers', ANCHOR]] })],
  ]);
  const r = buildMaintainerSet(ANCHOR, 'r', ix);
  assert.equal(r.verified.size, 2);
});

test('buildMaintainerSet: ignores non-hex / self-listing in maintainers tag', () => {
  // Self-listing the anchor is a no-op (already verified); non-hex
  // entries are dropped before BFS.
  const ix = new Map([
    [ANCHOR, ev({ pubkey: ANCHOR, tags: [
      ['d', 'r'],
      ['maintainers', ANCHOR, 'not-hex', CO_A, ''],
    ] })],
    [CO_A, ev({ pubkey: CO_A, tags: [['d', 'r']] })],
  ]);
  const r = buildMaintainerSet(ANCHOR, 'r', ix);
  assert.equal(r.verified.size, 2);
  assert.equal(r.candidatesOnly.size, 0);
});

// ── Union semantics (per maintainer-model doc) ──────────────────────────

test('buildMaintainerSet: relays + clone unioned across verified 30617s', () => {
  // Anchor declares one relay + one clone; CO_A declares different
  // ones. The maintainer set should expose the UNION.
  const ix = new Map([
    [ANCHOR, ev({ pubkey: ANCHOR, tags: [
      ['d', 'r'],
      ['maintainers', CO_A],
      ['relays', 'wss://a.example'],
      ['clone',  'https://a.example/x.git'],
    ] })],
    [CO_A, ev({ pubkey: CO_A, tags: [
      ['d', 'r'],
      ['relays', 'wss://b.example'],
      ['clone',  'https://b.example/x.git'],
    ] })],
  ]);
  const r = buildMaintainerSet(ANCHOR, 'r', ix);
  assert.deepEqual(r.relays.sort(), ['wss://a.example', 'wss://b.example']);
  assert.deepEqual(r.clone.sort(),  ['https://a.example/x.git', 'https://b.example/x.git']);
});

test('buildMaintainerSet: candidate-only events are NOT unioned in', () => {
  // CO_A is candidate-only (no own 30617). Anything CO_A might
  // have claimed is moot — we never see it.
  const ix = new Map([
    [ANCHOR, ev({ pubkey: ANCHOR, tags: [
      ['d', 'r'],
      ['maintainers', CO_A],
      ['relays', 'wss://a.example'],
    ] })],
  ]);
  const r = buildMaintainerSet(ANCHOR, 'r', ix);
  assert.deepEqual(r.relays, ['wss://a.example']);
});

test('buildMaintainerSet: hashtags unioned and length-capped', () => {
  const ix = new Map([
    [ANCHOR, ev({ pubkey: ANCHOR, tags: [
      ['d', 'r'],
      ['maintainers', CO_A],
      ['t', 'nostr'],
      ['t', 'a'.repeat(65)],     // over cap → dropped
    ] })],
    [CO_A, ev({ pubkey: CO_A, tags: [
      ['d', 'r'],
      ['t', 'rust'],
    ] })],
  ]);
  const r = buildMaintainerSet(ANCHOR, 'r', ix);
  assert.deepEqual(r.hashtags.sort(), ['nostr', 'rust']);
});

// ── Display metadata ────────────────────────────────────────────────────

test('buildMaintainerSet: display picks the freshest verified 30617', () => {
  // CO_A has the newer event — its name/desc should win even though
  // anchor is the trust root.
  const ix = new Map([
    [ANCHOR, ev({
      pubkey: ANCHOR, created_at: 1000,
      tags: [['d', 'r'], ['name', 'Old Name'], ['description', 'old'], ['maintainers', CO_A]],
    })],
    [CO_A, ev({
      pubkey: CO_A, created_at: 2000,
      tags: [['d', 'r'], ['name', 'New Name'], ['description', 'fresh'], ['web', 'https://new.example']],
    })],
  ]);
  const r = buildMaintainerSet(ANCHOR, 'r', ix);
  assert.ok(r.display);
  assert.equal(r.display!.name,        'New Name');
  assert.equal(r.display!.description, 'fresh');
  assert.equal(r.display!.pubkey,      CO_A);
  assert.deepEqual(r.display!.web,     ['https://new.example']);
});

test('buildMaintainerSet: display falls back to identifier when no name tag', () => {
  const ix = new Map([
    [ANCHOR, ev({ pubkey: ANCHOR, tags: [['d', 'my-repo']] })],
  ]);
  const r = buildMaintainerSet(ANCHOR, 'my-repo', ix);
  assert.equal(r.display!.name, 'my-repo');
  assert.equal(r.display!.description, '');
});

test('buildMaintainerSet: display is null when no 30617 anywhere', () => {
  // Empty index — caller's relay query found nothing. Verified set
  // is still empty; display is null so the UI can render a graceful
  // "not announced" state.
  const r = buildMaintainerSet(ANCHOR, 'r', new Map());
  assert.equal(r.display, null);
  assert.equal(r.verified.size, 0);
});

// ── Anti-scam scenario (the headline case) ──────────────────────────────

test('buildMaintainerSet: scam scenario — reputable pubkey listed without consent', () => {
  // Attacker publishes a 30617 at coord (ANCHOR, 'r') listing a
  // reputable STRANGER as a co-maintainer. STRANGER has never
  // signed a 30617 at this coordinate. The verifier MUST surface
  // STRANGER as candidate-only, NEVER verified — otherwise STRANGER's
  // public-key would silently grant authority to close issues / merge
  // patches on this repo.
  const ix = new Map([
    [ANCHOR, ev({ pubkey: ANCHOR, tags: [['d', 'r'], ['maintainers', STRANGER]] })],
  ]);
  const r = buildMaintainerSet(ANCHOR, 'r', ix);
  assert.ok(!r.verified.has(STRANGER), 'stranger must NOT be verified');
  assert.ok(r.candidatesOnly.has(STRANGER));
});
