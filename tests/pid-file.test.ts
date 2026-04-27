import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { useTempHome, resetTempHome } from './_home.js';

const HOME = useTempHome();

const {
  writePidFile,
  removePidFile,
  probePidFile,
  pidFilePath,
  // @ts-expect-error — runtime import of .ts
} = await import('../src/lib/pid-file.ts');

beforeEach(() => resetTempHome(HOME));

// ── writePidFile / removePidFile round-trip ──────────────────────────────

test('writePidFile: creates ~/.config/nostr-station/chat.pid with current PID', () => {
  writePidFile();
  const p = pidFilePath();
  assert.equal(p, path.join(HOME, '.config', 'nostr-station', 'chat.pid'));
  const raw = fs.readFileSync(p, 'utf8').trim();
  assert.equal(raw, String(process.pid));
});

test('writePidFile: creates parent directory if missing', () => {
  // resetTempHome already wiped ~/.config; make sure we lazy-create.
  writePidFile();
  assert.equal(fs.existsSync(path.dirname(pidFilePath())), true);
});

test('writePidFile: file mode is 0o600 (no group/world read)', () => {
  writePidFile();
  const mode = fs.statSync(pidFilePath()).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('removePidFile: deletes the file when present', () => {
  writePidFile();
  assert.equal(fs.existsSync(pidFilePath()), true);
  removePidFile();
  assert.equal(fs.existsSync(pidFilePath()), false);
});

test('removePidFile: silently no-ops when the file is absent', () => {
  // No write before — must not throw.
  assert.doesNotThrow(() => removePidFile());
});

// ── probePidFile branches ────────────────────────────────────────────────

test('probePidFile: absent → state="absent"', () => {
  const r = probePidFile();
  assert.equal(r.state, 'absent');
});

test('probePidFile: file holds current PID → state="alive"', () => {
  writePidFile();
  const r = probePidFile();
  assert.equal(r.state, 'alive');
  assert.equal(r.pid, process.pid);
});

test('probePidFile: file holds PID of a definitely-dead process → state="stale"', () => {
  // Spawn a trivial child, wait for it to exit, capture its PID. After
  // exit, the kernel reaps it (the parent is us, and spawnSync awaits)
  // so `kill -0 <pid>` must fail with ESRCH. This is the canonical
  // "uninstall after a crashed dashboard" case the user flagged.
  const child = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  assert.equal(child.status, 0);
  const deadPid = child.pid!;
  fs.mkdirSync(path.dirname(pidFilePath()), { recursive: true });
  fs.writeFileSync(pidFilePath(), `${deadPid}\n`);

  const r = probePidFile();
  // PID reuse on busy systems could in theory flip 'stale' → 'alive', but
  // not within milliseconds of spawn+exit on the test runner — and even
  // when it does, the *contract* under test (return state, never throw)
  // still holds. Pin the realistic outcome.
  assert.equal(r.state, 'stale', `expected stale, got ${JSON.stringify(r)}`);
  if (r.state === 'stale') assert.equal(r.pid, deadPid);
});

test('probePidFile: garbage in file → state="unreadable"', () => {
  fs.mkdirSync(path.dirname(pidFilePath()), { recursive: true });
  fs.writeFileSync(pidFilePath(), 'not-a-pid');
  const r = probePidFile();
  assert.equal(r.state, 'unreadable');
});

test('probePidFile: negative number → state="unreadable"', () => {
  // process.kill rejects negative integers with EINVAL; treat them as
  // garbage rather than passing them through to a meaningful syscall.
  fs.mkdirSync(path.dirname(pidFilePath()), { recursive: true });
  fs.writeFileSync(pidFilePath(), '-42');
  const r = probePidFile();
  assert.equal(r.state, 'unreadable');
});

test('probePidFile: zero → state="unreadable"', () => {
  // pid 0 has special semantics in process.kill (signal the entire
  // process group). Refuse it as a valid recorded pid.
  fs.mkdirSync(path.dirname(pidFilePath()), { recursive: true });
  fs.writeFileSync(pidFilePath(), '0');
  const r = probePidFile();
  assert.equal(r.state, 'unreadable');
});

test('probePidFile: trims trailing whitespace before parsing', () => {
  // The writer appends `\n` for shell-friendliness; the reader must
  // tolerate that without falling into the unreadable branch.
  fs.mkdirSync(path.dirname(pidFilePath()), { recursive: true });
  fs.writeFileSync(pidFilePath(), `${process.pid}\n\n  `);
  const r = probePidFile();
  assert.equal(r.state, 'alive');
});

// ── End-to-end: write → probe(alive) → remove → probe(absent) ────────────

test('lifecycle: write → probe alive → remove → probe absent', () => {
  writePidFile();
  let r = probePidFile();
  assert.equal(r.state, 'alive');
  removePidFile();
  r = probePidFile();
  assert.equal(r.state, 'absent');
});

// ── Detached child as a "live" probe target ───────────────────────────────

test('probePidFile: detached child PID reads as alive while it sleeps', async () => {
  // Spawn a child that lingers, write its PID, probe → expect alive.
  // Cleans up by killing the child afterwards.
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], {
    stdio: 'ignore',
    detached: true,
  });
  child.unref();
  try {
    fs.mkdirSync(path.dirname(pidFilePath()), { recursive: true });
    fs.writeFileSync(pidFilePath(), `${child.pid}\n`);
    const r = probePidFile();
    assert.equal(r.state, 'alive');
    if (r.state === 'alive') assert.equal(r.pid, child.pid);
  } finally {
    try { child.kill('SIGKILL'); } catch {}
  }
});
