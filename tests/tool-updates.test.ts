import { useTempHome } from './_home.js';
const HOME = useTempHome();

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { compareSemver, gatherToolUpdates } from '../src/lib/tool-updates.ts';
import { grainBinPath, grainVersionMarkerPath } from '../src/lib/grain-installer.ts';
import { COMPONENT_VERSIONS } from '../src/lib/versions.ts';

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
  // We pin four: nak, ngit, nvpn, grain. Order isn't part of the
  // contract, but the set is. grain was added when we wired its
  // upgrade path on the 0.6.0 → 0.7.0 bump — it ships without a
  // `--version` flag, so the gather code reads the install marker
  // instead of running the binary (see gatherGrainUpdate).
  const ids = new Set(tools.map(t => t.id));
  assert.deepEqual([...ids].sort(), ['grain', 'nak', 'ngit', 'nvpn']);
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

// ── Regression: shell-PATH lookup wins over augmented-dir shadow ──────────
// The friend-tester loop went: install ngit → "Worked" → "Lol, it came
// back as an available update". Root cause: gatherToolUpdates probed via
// findBin (augmentedBinDirs-first walk, ~/.cargo/bin before /usr/local/bin)
// while the installer's verifyVersionOnPath probed via shell PATH (which).
// After the user removed the obvious shadow at ~/.cargo/bin, verify saw
// /usr/local/bin/ngit at 2.4.3 and reported clean — but findBin then
// returned an OLDER ngit at ~/.local/bin (or any other curated dir that
// happened to have a stale binary), so the pill flickered back the moment
// the modal closed. Fix: probe by bin name first; PATH lookup matches
// what the user's shell would actually run.

function writeFakeBin(filePath: string, version: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `#!/bin/sh\necho "ngit ${version}"\n`, { mode: 0o755 });
}

test('gatherToolUpdates: shell-PATH ngit wins over older shadow in ~/.cargo/bin', async () => {
  // Stage the disagreement that hit production:
  //   - ~/.cargo/bin/ngit at an OLD version (findBin's first hit because
  //     augmentedBinDirs lists ~/.cargo/bin before /usr/local/bin).
  //   - A "current" ngit on a PATH dir at the pinned version (what the
  //     user's actual `ngit` command runs).
  // After the fix, gatherToolUpdates should report the pinned version
  // (no false "update available" pill).
  const shadowPath = path.join(HOME, '.cargo', 'bin', 'ngit');
  writeFakeBin(shadowPath, '2.4.0');

  // Real install simulation — outside augmentedBinDirs, on PATH so the
  // bare-name spawn resolves it via PATH lookup.
  const installDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-updates-test-'));
  const installPath = path.join(installDir, 'ngit');
  writeFakeBin(installPath, '2.4.3');

  const origPath = process.env.PATH;
  process.env.PATH = `${installDir}${path.delimiter}${origPath || ''}`;
  try {
    const tools = await gatherToolUpdates();
    const ngit = tools.find(t => t.id === 'ngit');
    assert.ok(ngit, 'ngit record should exist');
    // Pre-fix: this asserted 2.4.0 because findBin's curated walk hit
    // the shadow first. Post-fix: the bare-name probe wins via PATH
    // lookup and we see the install at 2.4.3.
    assert.equal(ngit!.currentVersion, '2.4.3',
      'should reflect what the user\'s shell would run, not findBin\'s curated first hit');
    assert.equal(ngit!.updateAvailable, false,
      'pill must NOT fire when shell PATH already resolves the pinned version');
  } finally {
    process.env.PATH = origPath;
    fs.rmSync(installDir, { recursive: true, force: true });
    fs.rmSync(shadowPath, { force: true });
  }
});

// ── grain: marker-file probing (no --version flag) ───────────────────────
// Grain ships without a `--version` flag, so the gather code can't reuse
// the shell-probe pattern. Instead it checks the binary at the managed
// path (~/.nostr-station/bin/grain) and reads a sibling marker file
// written by installGrain. Three contract points worth pinning:
//
//   1. No binary at all      → installed=false, no update offered.
//   2. Binary present, no marker → "stale unknown" — update OFFERED.
//      This is the v0.6.0 → v0.7.0 upgrade signal: pre-marker installs
//      look like "version unknown" and the modal pulls them forward.
//   3. Binary + marker == pinned → installed, no update.

function setGrainBinOverride(p: string | null): string | undefined {
  const prev = process.env.NOSTR_STATION_GRAIN_BIN;
  if (p === null) delete process.env.NOSTR_STATION_GRAIN_BIN;
  else process.env.NOSTR_STATION_GRAIN_BIN = p;
  return prev;
}
function restoreGrainBinOverride(prev: string | undefined): void {
  if (prev === undefined) delete process.env.NOSTR_STATION_GRAIN_BIN;
  else process.env.NOSTR_STATION_GRAIN_BIN = prev;
}

test('gatherToolUpdates: grain absent → installed=false, no update', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'grain-updates-test-'));
  const prev = setGrainBinOverride(path.join(tmp, 'grain'));
  try {
    const tools = await gatherToolUpdates();
    const grain = tools.find(t => t.id === 'grain');
    assert.ok(grain);
    assert.equal(grain!.installed, false);
    assert.equal(grain!.currentVersion, null);
    assert.equal(grain!.updateAvailable, false);
    assert.equal(grain!.pinnedVersion, COMPONENT_VERSIONS['grain']);
    assert.equal(grain!.installEndpoint, '/api/exec/install/grain');
  } finally {
    restoreGrainBinOverride(prev);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('gatherToolUpdates: grain binary without marker → flags update (v0.6.0 upgrade signal)', async () => {
  // Reproduce the existing-v0.6.0-user scenario: the binary is on disk
  // from a pre-0.7.0 install that didn't yet write a marker. We MUST
  // surface this as an available update so the user's dashboard pulls
  // them forward on the first poll after they bump nostr-station.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'grain-updates-test-'));
  const binPath = path.join(tmp, 'grain');
  fs.writeFileSync(binPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const prev = setGrainBinOverride(binPath);
  try {
    const tools = await gatherToolUpdates();
    const grain = tools.find(t => t.id === 'grain');
    assert.ok(grain);
    assert.equal(grain!.installed, true);
    assert.equal(grain!.currentVersion, null);
    assert.equal(grain!.updateAvailable, true,
      'binary present + marker absent must offer the upgrade (pre-0.7.0 install)');
  } finally {
    restoreGrainBinOverride(prev);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('gatherToolUpdates: grain binary + matching marker → no update offered', async () => {
  // The steady state after a clean v0.7.0 install. Binary present,
  // marker file present and matches the pinned version → no pill.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'grain-updates-test-'));
  const binPath = path.join(tmp, 'grain');
  fs.writeFileSync(binPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const prev = setGrainBinOverride(binPath);
  try {
    fs.writeFileSync(grainVersionMarkerPath(), `${COMPONENT_VERSIONS['grain']}\n`);
    const tools = await gatherToolUpdates();
    const grain = tools.find(t => t.id === 'grain');
    assert.ok(grain);
    assert.equal(grain!.installed, true);
    assert.equal(grain!.currentVersion, COMPONENT_VERSIONS['grain']);
    assert.equal(grain!.updateAvailable, false);
  } finally {
    restoreGrainBinOverride(prev);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('gatherToolUpdates: grain binary + older marker → flags update', async () => {
  // Future-proofing: when we bump grain to 0.8.0, existing 0.7.0
  // installs will read marker=0.7.0, compareSemver against pinned
  // gives -1, and the pill fires. This guards against a regression
  // where we accidentally short-circuit on "marker present" alone.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'grain-updates-test-'));
  const binPath = path.join(tmp, 'grain');
  fs.writeFileSync(binPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const prev = setGrainBinOverride(binPath);
  try {
    fs.writeFileSync(grainVersionMarkerPath(), '0.6.0\n');
    const tools = await gatherToolUpdates();
    const grain = tools.find(t => t.id === 'grain');
    assert.ok(grain);
    assert.equal(grain!.installed, true);
    assert.equal(grain!.currentVersion, '0.6.0');
    assert.equal(grain!.updateAvailable, true);
  } finally {
    restoreGrainBinOverride(prev);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('gatherToolUpdates: falls back to findBin when shell PATH is restricted', async () => {
  // Original detect.ts use case: Node inherits a restricted PATH that
  // doesn't include ~/.cargo/bin, so a cargo-installed ngit isn't on
  // PATH from Node's perspective. findBin's augmentedBinDirs walk
  // catches it. After the fix we must still detect that install via
  // the fallback path — otherwise legitimate cargo-installed binaries
  // would silently read as "not installed".
  const shadowPath = path.join(HOME, '.cargo', 'bin', 'ngit');
  writeFakeBin(shadowPath, '2.4.0');

  const origPath = process.env.PATH;
  // Strip everything except a minimal system dir so the bare-name probe
  // fails — forces the fallback to findBin's absolute path.
  process.env.PATH = '/usr/bin:/bin';
  try {
    const tools = await gatherToolUpdates();
    const ngit = tools.find(t => t.id === 'ngit');
    assert.ok(ngit, 'ngit record should exist');
    assert.equal(ngit!.installed, true, 'cargo-installed binary should still register as installed');
    assert.equal(ngit!.currentVersion, '2.4.0',
      'fallback probe must read the binary findBin pointed at');
    // 2.4.0 < pinned (2.4.3) so the pill SHOULD fire here — this is a
    // genuinely stale install.
    assert.equal(ngit!.updateAvailable, true);
  } finally {
    process.env.PATH = origPath;
    fs.rmSync(shadowPath, { force: true });
  }
});
