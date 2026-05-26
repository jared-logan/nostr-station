// Targeted tests for the grain installer's public surface.
// Mirrors the slim scope of nvpn-installer.test.ts: we don't drive a
// real download here, we just assert the supporting pure functions
// (path resolution, pinned-checksum table shape) so a typo in the
// version/SHA wire-up surfaces before it hits anyone's machine.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  grainBinPath,
  grainVersionMarkerPath,
  readGrainInstalledVersion,
  writeGrainVersionMarker,
} from '../src/lib/grain-installer.ts';
import { COMPONENT_VERSIONS, BINARY_SHA256 } from '../src/lib/versions.ts';

test('grain-installer: grainBinPath lands under ~/.nostr-station/bin', () => {
  const p = grainBinPath();
  assert.equal(p, path.join(os.homedir(), '.nostr-station', 'bin', 'grain'));
});

test('grain-installer: pinned version is a non-empty semver-ish string', () => {
  const v = COMPONENT_VERSIONS['grain'];
  assert.ok(v, 'COMPONENT_VERSIONS.grain must be set');
  // Loose semver match — the installer prepends "v" before the tag.
  assert.match(v!, /^\d+\.\d+\.\d+/);
});

test('grain-installer: BINARY_SHA256.grain covers all four target keys', () => {
  const targets = BINARY_SHA256.grain;
  assert.ok(targets, 'BINARY_SHA256.grain must be present');
  for (const key of ['darwin-amd64', 'darwin-arm64', 'linux-amd64', 'linux-arm64']) {
    const sha = targets[key];
    assert.ok(sha, `missing sha256 for ${key}`);
    assert.match(sha, /^[0-9a-f]{64}$/, `sha256 for ${key} must be 64 hex chars`);
  }
});

test('grain-installer: BINARY_SHA256.grain has no extraneous keys (typo guard)', () => {
  // Any key that doesn't match {darwin|linux}-{amd64|arm64} is almost
  // certainly a typo — catching that here is much cheaper than
  // catching it when a user's install 404s on the asset URL.
  const allowed = new Set(['darwin-amd64', 'darwin-arm64', 'linux-amd64', 'linux-arm64']);
  for (const key of Object.keys(BINARY_SHA256.grain)) {
    assert.ok(allowed.has(key), `unexpected grain target key: ${key}`);
  }
});

// ── Version marker ───────────────────────────────────────────────────────
// grain has no `--version` flag, so the update-check flow in tool-updates.ts
// reads a sibling marker file we write at install time. These tests pin the
// marker file's location + content shape so a future refactor doesn't break
// the upgrade-detection contract silently.

test('grain-installer: grainVersionMarkerPath sits next to the binary', () => {
  // Lives next to the binary so a manual `rm ~/.nostr-station/bin/grain*`
  // wipes both, preserving the invariant "marker present ⇒ binary present".
  assert.equal(grainVersionMarkerPath(), `${grainBinPath()}.version`);
});

test('grain-installer: readGrainInstalledVersion returns null when marker is absent', () => {
  // Use the test override so we never touch a real user's install dir.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'grain-installer-test-'));
  const prevBin = process.env.NOSTR_STATION_GRAIN_BIN;
  process.env.NOSTR_STATION_GRAIN_BIN = path.join(tmp, 'grain');
  try {
    // No marker file → null. This is the v0.6.0 upgrade signal — the
    // binary may exist from a pre-0.7.0 install that didn't yet write
    // a marker; tool-updates treats null as "stale, offer upgrade".
    assert.equal(readGrainInstalledVersion(), null);
  } finally {
    if (prevBin === undefined) delete process.env.NOSTR_STATION_GRAIN_BIN;
    else process.env.NOSTR_STATION_GRAIN_BIN = prevBin;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('grain-installer: readGrainInstalledVersion parses a semver marker', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'grain-installer-test-'));
  const prevBin = process.env.NOSTR_STATION_GRAIN_BIN;
  process.env.NOSTR_STATION_GRAIN_BIN = path.join(tmp, 'grain');
  try {
    // Trailing newline is what installGrain writes; tolerated by the
    // reader's trim() so installations roundtrip cleanly.
    fs.writeFileSync(grainVersionMarkerPath(), '0.7.0\n');
    assert.equal(readGrainInstalledVersion(), '0.7.0');
  } finally {
    if (prevBin === undefined) delete process.env.NOSTR_STATION_GRAIN_BIN;
    else process.env.NOSTR_STATION_GRAIN_BIN = prevBin;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('grain-installer: writeGrainVersionMarker writes the version with trailing newline', () => {
  // Pins the file shape readGrainInstalledVersion expects to consume —
  // they're a matched pair, and a future refactor that drops the
  // newline (or pads the file with extra content) should break this
  // test, not silently change the marker contract.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'grain-installer-test-'));
  const prevBin = process.env.NOSTR_STATION_GRAIN_BIN;
  process.env.NOSTR_STATION_GRAIN_BIN = path.join(tmp, 'grain');
  try {
    const r = writeGrainVersionMarker('0.7.0');
    assert.equal(r.ok, true);
    const onDisk = fs.readFileSync(grainVersionMarkerPath(), 'utf8');
    assert.equal(onDisk, '0.7.0\n', 'marker file must end with a newline so a tail/cat looks tidy');
    assert.equal(readGrainInstalledVersion(), '0.7.0',
      'write then read must round-trip cleanly');
  } finally {
    if (prevBin === undefined) delete process.env.NOSTR_STATION_GRAIN_BIN;
    else process.env.NOSTR_STATION_GRAIN_BIN = prevBin;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('grain-installer: writeGrainVersionMarker returns ok:false with a capped detail on failure', () => {
  // Drives the path that produces installGrain's "binary installed
  // but marker write failed" warn-shaped result. We reproduce a
  // persistent failure (read-only parent dir) so the marker write
  // fails with EACCES. The Updates modal renders the detail string,
  // so it must be short, descriptive, and non-empty — bound it at
  // 160 chars to keep the SSE log line readable.
  //
  // Test honors POSIX permission semantics; skip on root (where chmod
  // 0o000 doesn't deny write) so CI environments running as root
  // don't see a misleading pass.
  if (process.getuid && process.getuid() === 0) {
    return;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'grain-installer-test-'));
  const prevBin = process.env.NOSTR_STATION_GRAIN_BIN;
  // Point the override at a path INSIDE a chmod-0 directory so the
  // marker write (a sibling of the binary path) hits EACCES.
  const readOnlyDir = path.join(tmp, 'locked');
  fs.mkdirSync(readOnlyDir);
  process.env.NOSTR_STATION_GRAIN_BIN = path.join(readOnlyDir, 'grain');
  fs.chmodSync(readOnlyDir, 0o500);  // read+exec, no write
  try {
    const r = writeGrainVersionMarker('0.7.0');
    assert.equal(r.ok, false);
    assert.ok(r.ok === false && r.detail.length > 0, 'failure must carry a detail');
    assert.ok(r.ok === false && r.detail.length <= 160, 'detail must be capped at 160 chars');
  } finally {
    // Restore writable mode so the rm cleanup can drop the dir.
    fs.chmodSync(readOnlyDir, 0o700);
    if (prevBin === undefined) delete process.env.NOSTR_STATION_GRAIN_BIN;
    else process.env.NOSTR_STATION_GRAIN_BIN = prevBin;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('grain-installer: readGrainInstalledVersion rejects non-semver garbage', () => {
  // Defensive: a corrupted marker (e.g. a partial write) must not be
  // misread as a "real" version that satisfies the update check. We
  // return null so the upgrade is offered again — same behavior as
  // the missing-marker case.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'grain-installer-test-'));
  const prevBin = process.env.NOSTR_STATION_GRAIN_BIN;
  process.env.NOSTR_STATION_GRAIN_BIN = path.join(tmp, 'grain');
  try {
    fs.writeFileSync(grainVersionMarkerPath(), 'not-a-version\n');
    assert.equal(readGrainInstalledVersion(), null);
  } finally {
    if (prevBin === undefined) delete process.env.NOSTR_STATION_GRAIN_BIN;
    else process.env.NOSTR_STATION_GRAIN_BIN = prevBin;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
