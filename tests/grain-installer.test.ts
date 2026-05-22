// Targeted tests for the grain installer's public surface.
// Mirrors the slim scope of nvpn-installer.test.ts: we don't drive a
// real download here, we just assert the supporting pure functions
// (path resolution, pinned-checksum table shape) so a typo in the
// version/SHA wire-up surfaces before it hits anyone's machine.

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { grainBinPath } from '../src/lib/grain-installer.ts';
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
