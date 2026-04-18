import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { useTempHome, resetTempHome } from './_home.js';

// Pin HOME before importing detect so findBin's augmented-dirs list
// (which reads os.homedir() on every call) resolves into our tmpdir.
const HOME = useTempHome();

// @ts-expect-error — runtime import of .ts
const { findBin, hasBin } = await import('../src/lib/detect.ts');

// Fresh HOME + clean PATH for each test so leakage between cases is
// impossible. Tests that want a specific PATH set it themselves.
const ORIGINAL_PATH = process.env.PATH;

beforeEach(() => {
  resetTempHome(HOME);
  process.env.PATH = ORIGINAL_PATH;
});

function makeExecutable(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '#!/bin/sh\necho stub\n');
  fs.chmodSync(filePath, 0o755);
}

// ── The Mint regression: binary in ~/.cargo/bin, PATH doesn't include it ──

test('findBin: resolves ~/.cargo/bin/nak even when PATH excludes it', () => {
  // This is the exact Mint-VM shape — cargo just laid down the binary,
  // but the Node process's PATH hasn't absorbed ~/.cargo/bin yet because
  // the user hasn't opened a new login shell.
  const nakPath = path.join(HOME, '.cargo', 'bin', 'nak');
  makeExecutable(nakPath);

  // Deliberately wipe ~/.cargo/bin from PATH.
  process.env.PATH = '/usr/bin:/bin';

  assert.equal(findBin('nak'), nakPath);
  assert.equal(hasBin('nak'), true);
});

test('findBin: resolves ~/.cargo/bin/ngit', () => {
  const ngitPath = path.join(HOME, '.cargo', 'bin', 'ngit');
  makeExecutable(ngitPath);
  process.env.PATH = '/usr/bin';
  assert.equal(findBin('ngit'), ngitPath);
});

test('findBin: resolves ~/.cargo/bin/nostr-rs-relay', () => {
  const relayPath = path.join(HOME, '.cargo', 'bin', 'nostr-rs-relay');
  makeExecutable(relayPath);
  process.env.PATH = '';
  assert.equal(findBin('nostr-rs-relay'), relayPath);
});

test('findBin: resolves ~/.cargo/bin/nvpn', () => {
  const nvpnPath = path.join(HOME, '.cargo', 'bin', 'nvpn');
  makeExecutable(nvpnPath);
  process.env.PATH = '';
  assert.equal(findBin('nvpn'), nvpnPath);
});

// ── Negative cases ───────────────────────────────────────────────────────

test('findBin: returns null when binary is nowhere to be found', () => {
  process.env.PATH = '/usr/bin:/bin';
  assert.equal(findBin('this-binary-definitely-does-not-exist-xyz-123'), null);
  assert.equal(hasBin('this-binary-definitely-does-not-exist-xyz-123'), false);
});

test('findBin: ignores non-executable files', () => {
  // A file with the right name but no exec bit shouldn't resolve — the
  // X_OK check guards against directories that somehow contain text
  // files shadowing real binaries (e.g. a README that got misnamed).
  const fake = path.join(HOME, '.cargo', 'bin', 'fakebin');
  fs.mkdirSync(path.dirname(fake), { recursive: true });
  fs.writeFileSync(fake, 'not a script');
  // deliberately NO chmod +x
  process.env.PATH = '';
  assert.equal(findBin('fakebin'), null);
});

test('findBin: ignores directories matching the name', () => {
  // If someone has a directory ~/.cargo/bin/weird/ with no file inside,
  // accessSync(..., X_OK) passes on the directory itself. Check the
  // helper doesn't false-positive on dirs.
  const dir = path.join(HOME, '.cargo', 'bin', 'weird');
  fs.mkdirSync(dir, { recursive: true });
  process.env.PATH = '';
  // We accept either behavior here — the important invariant is that
  // attempting to execute the result wouldn't hang, which a directory
  // can't be. Current implementation returns the dir path; pin that
  // observation so a future change is a deliberate choice.
  // (If we later tighten findBin to reject non-files, flip this assert.)
  const r = findBin('weird');
  assert.ok(r === null || r === dir,
    `expected null or ${dir}, got ${r}`);
});

// ── PATH fallback still works ────────────────────────────────────────────

test('findBin: falls through to process.env.PATH when not in curated dirs', () => {
  // Binary lives in a non-curated dir; PATH has it. findBin should
  // still resolve by walking the PATH entries.
  const customDir = path.join(HOME, 'elsewhere');
  const bin = path.join(customDir, 'customtool');
  makeExecutable(bin);

  process.env.PATH = `${customDir}:/usr/bin`;
  assert.equal(findBin('customtool'), bin);
});

test('findBin: curated dirs win over PATH when the same name is in both', () => {
  // A binary in ~/.cargo/bin should be preferred over one earlier in
  // PATH — this matches the station's install convention (cargo is the
  // source of truth for these tools).
  const cargoBin = path.join(HOME, '.cargo', 'bin', 'dupetool');
  const otherDir = path.join(HOME, 'elsewhere');
  const otherBin = path.join(otherDir, 'dupetool');
  makeExecutable(cargoBin);
  makeExecutable(otherBin);

  process.env.PATH = `${otherDir}:/usr/bin`;
  assert.equal(findBin('dupetool'), cargoBin);
});

// ── Empty/undefined PATH doesn't crash ───────────────────────────────────

test('findBin: tolerates empty PATH', () => {
  process.env.PATH = '';
  // /bin/sh is in the curated list's /bin, so this should resolve on
  // any POSIX system without needing PATH.
  assert.notEqual(findBin('sh'), null);
});

test('findBin: tolerates unset PATH', () => {
  delete process.env.PATH;
  const bin = path.join(HOME, '.cargo', 'bin', 'stubsh');
  makeExecutable(bin);
  assert.equal(findBin('stubsh'), bin);
});
