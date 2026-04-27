import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { useTempHome, resetTempHome } from './_home.js';

// Pin HOME before importing — `verifyCargoBinaryLanded` calls findBin,
// which reads os.homedir() on every invocation to walk the curated dirs.
// Without this we'd be probing the user's real ~/.cargo/bin during tests.
const HOME = useTempHome();

// @ts-expect-error — runtime import of .ts
const { verifyCargoBinaryLanded } = await import('../src/lib/install.ts');

const ORIGINAL_PATH = process.env.PATH;

beforeEach(() => {
  resetTempHome(HOME);
  // Empty PATH — strip system bins so unique-name fixtures aren't shadowed
  // by anything in /opt/homebrew/bin or /usr/local/bin on the test host.
  process.env.PATH = '';
});

function makeExecutable(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '#!/bin/sh\necho stub\n');
  fs.chmodSync(filePath, 0o755);
}

// Use a name that nothing on a real test runner would have on PATH so
// the only way the helper finds it is via our fixture. Mirrors the
// findBin test convention.
const TEST_BIN = 'a12-test-fakecrate-xyz';

// ── Cargo exited 0 + binary present → success ────────────────────────────

test('verifyCargoBinaryLanded: returns null when binary is present in ~/.cargo/bin', () => {
  makeExecutable(path.join(HOME, '.cargo', 'bin', TEST_BIN));
  const r = verifyCargoBinaryLanded(TEST_BIN);
  assert.equal(r, null);
});

test('verifyCargoBinaryLanded: returns null when binary is present via PATH (non-curated dir)', () => {
  // Cargo conventionally installs to ~/.cargo/bin, but a forked rustup
  // setup or CARGO_INSTALL_ROOT override can land it elsewhere. As long
  // as Status's findBin would resolve it, the verify step must agree.
  const customDir = path.join(HOME, 'elsewhere');
  makeExecutable(path.join(customDir, TEST_BIN));
  process.env.PATH = customDir;

  const r = verifyCargoBinaryLanded(TEST_BIN);
  assert.equal(r, null);
});

test('verifyCargoBinaryLanded: success path appends a "verified at" log line', () => {
  const installed = path.join(HOME, '.cargo', 'bin', TEST_BIN);
  makeExecutable(installed);
  const lines: string[] = [];
  const r = verifyCargoBinaryLanded(TEST_BIN, l => lines.push(l));
  assert.equal(r, null);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /verified at/);
  assert.match(lines[0], new RegExp(TEST_BIN));
  assert.match(lines[0], /\.cargo\/bin/);
});

// ── Cargo exited 0 + binary missing → failure ────────────────────────────

test('verifyCargoBinaryLanded: returns actionable error when binary is missing', () => {
  // Don't seed any fixture. findBin walks curated dirs + PATH, finds nothing,
  // returns null → helper must surface the canonical "cargo says ok but
  // binary missing" failure with a recovery hint.
  const r = verifyCargoBinaryLanded(TEST_BIN);
  assert.notEqual(r, null);
  assert.match(r as string, /missing/i);
  // Recovery hint mentions --force, the canonical fix for the
  // crates2.json-lies-and-binary-is-gone case.
  assert.match(r as string, /--force/);
  // Includes the package name so a copy-paste from the TUI lands the user
  // on the right command.
  assert.match(r as string, new RegExp(TEST_BIN));
});

test('verifyCargoBinaryLanded: failure path logs a FAILED line to the durable sink', () => {
  const lines: string[] = [];
  const r = verifyCargoBinaryLanded(TEST_BIN, l => lines.push(l));
  assert.notEqual(r, null);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /FAILED/);
  assert.match(lines[0], /not found on disk/i);
  assert.match(lines[0], new RegExp(TEST_BIN));
});

test('verifyCargoBinaryLanded: ignores non-executable file at the install path (matches findBin)', () => {
  // Write the file without chmod +x — findBin's X_OK check will skip it,
  // and verify must agree (otherwise install + Status disagree, the
  // exact bug A12 closes).
  const noExec = path.join(HOME, '.cargo', 'bin', TEST_BIN);
  fs.mkdirSync(path.dirname(noExec), { recursive: true });
  fs.writeFileSync(noExec, '#!/bin/sh\necho oops\n');
  // intentionally NO chmod 0o755

  const r = verifyCargoBinaryLanded(TEST_BIN);
  assert.notEqual(r, null);
  assert.match(r as string, /missing/i);
});

// ── No-arg branch (no log sink supplied) doesn't throw ───────────────────

test('verifyCargoBinaryLanded: tolerates missing appendLog argument', () => {
  // The TUI install flow does pass a log sink, but the test here pins
  // that callers without one don't trip a TypeError.
  assert.doesNotThrow(() => verifyCargoBinaryLanded(TEST_BIN));
  makeExecutable(path.join(HOME, '.cargo', 'bin', TEST_BIN));
  assert.doesNotThrow(() => verifyCargoBinaryLanded(TEST_BIN));
});
