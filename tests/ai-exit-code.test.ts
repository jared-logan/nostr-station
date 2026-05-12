// Subprocess-level tests for the `nostr-station ai` exit codes.
//
// Pre-C11, AiAdd / AiRemove / AiDefault each did
//   setTimeout(() => process.exit(code), 100)
// which introduced a 100 ms window where the test runner couldn't tell
// the difference between "Ink is still rendering" and "Ink finished".
// Now the components set process.exitCode and call useApp().exit() —
// deterministic, no timer. This file pins exit-code behaviour for the
// branches that are easy to drive from the CLI (no interactive prompts).

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const ROOT = path.resolve(import.meta.dirname ?? '.', '..');
const CLI  = path.join(ROOT, 'src', 'cli.tsx');

function tempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-ai-exit-'));
  fs.writeFileSync(
    path.join(dir, '.gitconfig'),
    '[user]\n\tname = test\n\temail = t@t.local\n',
  );
  return dir;
}

test('ai list: exits 0', () => {
  const res = spawnSync('npx', ['tsx', CLI, 'ai', 'list'], {
    env: { ...process.env, HOME: tempHome() },
    timeout: 30_000,
    encoding: 'utf8',
  });
  assert.equal(
    res.status, 0,
    `expected 0, got ${res.status}; stderr: ${(res.stderr || '').slice(0, 400)}`,
  );
});

test('ai default <kind> <unknown-provider>: exits 1', () => {
  const res = spawnSync('npx', ['tsx', CLI, 'ai', 'default', 'chat', '__no_such_provider__'], {
    env: { ...process.env, HOME: tempHome() },
    timeout: 30_000,
    encoding: 'utf8',
  });
  assert.equal(
    res.status, 1,
    `expected 1, got ${res.status}; stderr: ${(res.stderr || '').slice(0, 400)}; stdout: ${(res.stdout || '').slice(0, 400)}`,
  );
});

test('ai remove <unknown-provider> --yes: exits 1', () => {
  const res = spawnSync('npx', ['tsx', CLI, 'ai', 'remove', '__no_such_provider__', '--yes'], {
    env: { ...process.env, HOME: tempHome() },
    timeout: 30_000,
    encoding: 'utf8',
  });
  assert.equal(
    res.status, 1,
    `expected 1, got ${res.status}; stderr: ${(res.stderr || '').slice(0, 400)}; stdout: ${(res.stdout || '').slice(0, 400)}`,
  );
});
