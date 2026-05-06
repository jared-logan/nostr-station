import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// @ts-expect-error — runtime import of .ts; tsx handles resolution
const tools = await import('../src/lib/tools.ts');
const { TOOLS, getTool, listTools, detectTool, installTool } = tools;

test('registry: every tool has the required shape', () => {
  for (const t of listTools()) {
    assert.equal(typeof t.id, 'string', `${t.id ?? '?'}: id`);
    assert.equal(typeof t.name, 'string', `${t.id}: name`);
    assert.equal(typeof t.description, 'string', `${t.id}: description`);
    assert.equal(typeof t.binary, 'string', `${t.id}: binary`);
    assert.ok(Array.isArray(t.detect) && t.detect.length >= 1, `${t.id}: detect argv`);
    assert.equal(t.detect[0], t.binary, `${t.id}: detect[0] should be binary`);
    assert.ok(Array.isArray(t.installSteps) && t.installSteps.length >= 1, `${t.id}: installSteps`);
    for (const s of t.installSteps) {
      assert.ok(['cargo-install', 'npm-global', 'shell-script', 'manual'].includes(s.kind),
        `${t.id}: install step kind`);
      if (s.kind !== 'manual') {
        assert.ok(Array.isArray(s.argv) && s.argv.length >= 1, `${t.id}: automated step needs argv`);
      } else {
        assert.equal(s.argv, null, `${t.id}: manual step has no argv`);
      }
      assert.equal(typeof s.display, 'string', `${t.id}: step display string`);
    }
  }
});

test('registry: known tools are present', () => {
  // `nak` is intentionally NOT in this registry — it has its own
  // GitHub-release installer (src/lib/nak-installer.ts) because the
  // nak crate on crates.io is unrelated to fiatjaf's Go binary.
  for (const id of ['ngit', 'stacks', 'nsyte']) {
    assert.ok(getTool(id), `expected ${id} in TOOLS`);
  }
  assert.equal(getTool('nak'), null, 'nak must be served by the dedicated installer');
});

test('getTool: returns null for unknown id', () => {
  assert.equal(getTool('does-not-exist'), null);
});

test('detectTool: reports installed=false when binary not on PATH', async () => {
  // Use a synthetic tool whose binary definitely isn't anywhere on
  // PATH. detectTool relies on hasBin → findBin → fs.accessSync, so a
  // gibberish name with no executable in any pathDir gives the false branch.
  const fake = {
    id: 'fake-zzz', name: 'fake', description: '', binary: '__nostr_station_test_no_such_bin__',
    detect: ['__nostr_station_test_no_such_bin__', '--version'] as [string, string],
    installSteps: [{ kind: 'manual' as const, display: 'n/a', argv: null }],
  };
  const r = await detectTool(fake);
  assert.equal(r.installed, false);
  assert.equal(r.version, null);
});

test('detectTool: parses version when binary exists on PATH', async () => {
  // Plant a stub script that prints "fakebin 1.2.3" on stdout, put its
  // dir on PATH, run detectTool. Verifies the happy path end-to-end
  // without needing a real cargo crate installed.
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-tools-'));
  const binPath = path.join(tmpdir, 'fakebin');
  fs.writeFileSync(binPath, '#!/bin/sh\necho "fakebin 1.2.3"\n');
  fs.chmodSync(binPath, 0o755);
  const prevPath = process.env.PATH;
  process.env.PATH = `${tmpdir}:${prevPath}`;
  try {
    const fake = {
      id: 'fakebin', name: 'fake', description: '', binary: 'fakebin',
      detect: ['fakebin', '--version'] as [string, string],
      installSteps: [{ kind: 'manual' as const, display: 'n/a', argv: null }],
    };
    const r = await detectTool(fake);
    assert.equal(r.installed, true);
    assert.equal(r.version, 'fakebin 1.2.3');
  } finally {
    process.env.PATH = prevPath;
    fs.rmSync(tmpdir, { recursive: true, force: true });
  }
});

test('installTool: manual step short-circuits to ok=false with detail', async () => {
  const fake = {
    id: 'manual-only', name: 'manual', description: '', binary: 'whatever',
    detect: ['whatever', '--version'] as [string, string],
    installSteps: [
      { kind: 'manual' as const, display: 'Run the offline installer', argv: null },
    ],
  };
  const lines: string[] = [];
  const r = await installTool(fake, l => lines.push(l));
  assert.equal(r.ok, false);
  assert.equal(r.ranSteps, 0);
  assert.match(r.detail || '', /offline installer/);
});

test('installTool: streams progress + reports failure on non-zero exit', async () => {
  const fake = {
    id: 'always-fail', name: 'fail', description: '', binary: 'sh',
    detect: ['sh', '--version'] as [string, string],
    installSteps: [
      // Use `sh -c "exit 7"` — guaranteed to be on PATH and fail.
      { kind: 'shell-script' as const, display: 'sh -c "exit 7"',
        argv: ['sh', '-c', 'echo about-to-fail; exit 7'] as [string, string, string] },
    ],
  };
  const lines: string[] = [];
  const r = await installTool(fake, l => lines.push(l));
  assert.equal(r.ok, false);
  assert.match(r.detail || '', /exit 7/);
  // Step header + the script's stdout line should both have been streamed.
  assert.ok(lines.some(l => l.includes('about-to-fail')), 'progress should stream stdout');
});

test('installTool: surfaces declared prereqs before running steps', async () => {
  // Use a manual step so installTool short-circuits before the
  // missing-runner pre-flight could fire — we want to assert the
  // prereqs lines land in `lines` regardless.
  const fake = {
    id: 'with-prereqs', name: 'with-prereqs', description: '', binary: 'whatever',
    detect: ['whatever', '--version'] as [string, string],
    prereqs: ['Rust toolchain (rustup) — install at https://rustup.rs', 'gcc'],
    installSteps: [
      { kind: 'manual' as const, display: 'manual step', argv: null },
    ],
  };
  const lines: string[] = [];
  await installTool(fake, l => lines.push(l));
  assert.ok(lines.some(l => l === 'Prerequisites:'), 'should surface a prereqs header');
  assert.ok(lines.some(l => l.includes('rustup')), 'should list each prereq');
  assert.ok(lines.some(l => l.includes('gcc')),    'should list each prereq');
});

