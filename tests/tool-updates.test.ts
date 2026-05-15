import test from 'node:test';
import assert from 'node:assert/strict';
import { compareSemver, gatherToolUpdates } from '../src/lib/tool-updates.ts';

// ── compareSemver ────────────────────────────────────────────────────────
// This drives the "should we offer an update?" decision in the modal:
// only `currentVersion < pinnedVersion` flags an update. A user who
// installed something newer than what we ship must NOT be offered a
// downgrade by the Install button.

test('compareSemver: equal versions return 0', () => {
  assert.equal(compareSemver('1.0.0', '1.0.0'), 0);
  assert.equal(compareSemver('2.4.3', '2.4.3'), 0);
});

test('compareSemver: lower version returns -1 ("update available")', () => {
  assert.equal(compareSemver('0.19.6', '0.19.7'), -1);
  assert.equal(compareSemver('2.4.2', '2.4.3'),   -1);
  assert.equal(compareSemver('1.9.9', '2.0.0'),   -1);
  assert.equal(compareSemver('0.0.1', '1.0.0'),   -1);
});

test('compareSemver: higher version returns 1 (no downgrade offer)', () => {
  assert.equal(compareSemver('0.19.8', '0.19.7'), 1);
  assert.equal(compareSemver('2.5.0',  '2.4.3'),  1);
  assert.equal(compareSemver('10.0.0', '9.99.99'), 1);
});

test('compareSemver: pre-release suffix is ignored', () => {
  // We treat `2.5.0-rc.1` as `2.5.0` for the update-check decision.
  // The user being on an rc of the version we ship is "up to date";
  // promoting them to the same-numbered final release isn't worth a
  // forced reinstall.
  assert.equal(compareSemver('2.5.0-rc.1', '2.5.0'), 0);
  assert.equal(compareSemver('2.5.0', '2.5.0-beta'),  0);
});

test('compareSemver: unparseable input fails closed at 0', () => {
  // The point: we won't claim an update is needed unless we can prove
  // current < pinned. Garbage in → no "update available" surfaced.
  assert.equal(compareSemver('', '1.0.0'),         0);
  assert.equal(compareSemver('1.0.0', 'unknown'),  0);
  assert.equal(compareSemver('abc', 'xyz'),        0);
});

// ── gatherToolUpdates ─────────────────────────────────────────────────────
// Runs against the live binaries on PATH — on the CI box none of the
// pinned tools are installed, so we expect a clean "not installed"
// list. Asserts the shape contract the client modal depends on.

test('gatherToolUpdates: returns one record per pinned tool', async () => {
  const tools = await gatherToolUpdates();
  // We pin three: nak, ngit, nvpn. Order isn't part of the contract,
  // but the set is.
  const ids = new Set(tools.map(t => t.id));
  assert.deepEqual([...ids].sort(), ['nak', 'ngit', 'nvpn']);
});

test('gatherToolUpdates: every record has pinnedVersion + installEndpoint', async () => {
  const tools = await gatherToolUpdates();
  for (const t of tools) {
    assert.ok(t.pinnedVersion, `${t.id} missing pinnedVersion`);
    assert.match(t.pinnedVersion, /^\d+\.\d+\.\d+/, `${t.id} pinned not semver-shaped`);
    assert.ok(t.installEndpoint.startsWith('/api/'), `${t.id} installEndpoint not an API path`);
    // updateAvailable can only be true when installed AND current parsed
    // AND current < pinned. Sanity-check the implication.
    if (t.updateAvailable) {
      assert.equal(t.installed, true);
      assert.ok(t.currentVersion, `${t.id} flagged update but no currentVersion`);
    }
  }
});
