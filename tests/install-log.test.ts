import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { useTempHome, resetTempHome } from './_home.js';

// openInstallLog reads os.homedir() at call time (not module load), so
// pinning HOME before the dynamic import is enough — nothing gets cached.
const HOME = useTempHome();

// @ts-expect-error — runtime import of .ts
const { openInstallLog } = await import('../src/lib/install-log.ts');

beforeEach(() => resetTempHome(HOME));

test('openInstallLog: returns a path under ~/logs', () => {
  const log = openInstallLog();
  assert.equal(log.path, path.join(HOME, 'logs', 'install.log'));
});

test('openInstallLog: respects custom filename', () => {
  const log = openInstallLog('custom-run.log');
  assert.equal(log.path, path.join(HOME, 'logs', 'custom-run.log'));
});

test('openInstallLog: creates ~/logs on first append (not at open time)', () => {
  // Opening the log doesn't touch the filesystem — the whole point of
  // best-effort logging is that a disk hiccup at phase start doesn't
  // take down the install. The directory is created lazily when we
  // actually write.
  const log = openInstallLog();
  assert.equal(fs.existsSync(path.join(HOME, 'logs')), false);

  log.append('first line');
  assert.equal(fs.existsSync(path.join(HOME, 'logs')), true);
  assert.equal(fs.existsSync(log.path), true);
});

test('openInstallLog: appends lines with ISO-8601 timestamp prefix', () => {
  const log = openInstallLog();
  log.append('hello');

  const contents = fs.readFileSync(log.path, 'utf8');
  // Format: `[<ISO>] hello\n`
  const match = contents.match(/^\[([^\]]+)\] hello\n$/);
  assert.ok(match, `expected timestamped line, got: ${JSON.stringify(contents)}`);
  // ISO-8601 shape: 2024-01-15T12:34:56.789Z
  assert.match(match![1], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test('openInstallLog: multiple appends accumulate, preserving order', () => {
  const log = openInstallLog();
  log.append('one');
  log.append('two');
  log.append('three');

  const lines = fs.readFileSync(log.path, 'utf8').trim().split('\n');
  assert.equal(lines.length, 3);
  // Strip the timestamp prefix to compare content.
  const content = lines.map(l => l.replace(/^\[[^\]]+\]\s/, ''));
  assert.deepEqual(content, ['one', 'two', 'three']);
});

test('openInstallLog: appending across multiple openInstallLog() calls is additive', () => {
  // Two separate Install phase runs (e.g. the user retried after a
  // failure) should append, not overwrite — the whole point is a
  // durable post-mortem across retries.
  const log1 = openInstallLog();
  log1.append('first run');
  const log2 = openInstallLog();
  log2.append('second run');

  const contents = fs.readFileSync(log2.path, 'utf8');
  assert.match(contents, /first run/);
  assert.match(contents, /second run/);
});

test('openInstallLog: append swallows write errors (best-effort)', () => {
  // If ~/logs is somehow unwritable — e.g. a user with a read-only
  // home directory — the install shouldn't crash. Simulate by pre-
  // creating `install.log` as a directory where a file is expected.
  const logDir = path.join(HOME, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  // Create a directory at the file path so appendFileSync throws EISDIR.
  fs.mkdirSync(path.join(logDir, 'install.log'));

  const log = openInstallLog();
  // Must not throw — the contract is "best-effort; log is diagnostic,
  // not load-bearing".
  assert.doesNotThrow(() => log.append('this write will fail'));
});

test('openInstallLog: handles newlines in the input line as-is', () => {
  // Multi-line payloads (e.g. full cargo stderr from installCargoBin's
  // failure path) are a common input. The current shape is one
  // timestamped "header" line + the raw payload inline. Pin this so
  // callers know what to expect in the file.
  const log = openInstallLog();
  log.append('cargo FAILED:\nerror[E0282]: type annotations\n  --> src/main.rs');

  const contents = fs.readFileSync(log.path, 'utf8');
  assert.match(contents, /cargo FAILED:/);
  assert.match(contents, /error\[E0282\]/);
  assert.match(contents, /src\/main\.rs/);
});
