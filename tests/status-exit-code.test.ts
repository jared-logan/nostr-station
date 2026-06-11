// Subprocess-level test for the `nostr-station status` exit code.
//
// Contract:
//   - `status --json`  → always exit 0, payload is the schema (CI smoke).
//   - `status` (human) → exit 1 if any non-`off` row's ok=false, else
//     exit 0. (`off` = optional tool not installed — a normal state
//     that must NOT flip the exit code.)
//
// The test runner's environment has no relay running and no nvpn binary
// → the relay/vpn/watchdog service probes return failure (warn states,
// ok=false) → the human invocation MUST exit 1. Missing optional tools
// (ngit/nak) alone would no longer trigger that.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const ROOT = path.resolve(import.meta.dirname ?? '.', '..');
const CLI  = path.join(ROOT, 'src', 'cli.tsx');

// Isolate HOME so the probes don't read a real ~/.nostr-station and
// don't accidentally write anything if a probe is more curious than
// the comment suggests.
function makeTempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-status-exit-'));
  fs.writeFileSync(
    path.join(dir, '.gitconfig'),
    '[user]\n\tname = test\n\temail = t@t.local\n',
  );
  return dir;
}

// Force the relay probe to fail deterministically by pointing it at a
// port nothing listens on. This makes the test pass even on a dev
// machine that has a real station running on 7777 with ngit/nak/nvpn
// fully installed — the relay row alone is guaranteed to flip to err.
const FAILING_RELAY_ENV = { RELAY_HOST: '127.0.0.1', RELAY_PORT: '1' };

test('status (human): exits 1 when at least one probe fails', () => {
  const HOME = makeTempHome();
  const res = spawnSync('npx', ['tsx', CLI, 'status'], {
    env: { ...process.env, ...FAILING_RELAY_ENV, HOME },
    timeout: 30_000,
    encoding: 'utf8',
  });
  assert.equal(
    res.status, 1,
    `expected exit 1, got ${res.status}; stderr: ${(res.stderr || '').slice(0, 400)}; stdout: ${(res.stdout || '').slice(0, 400)}`,
  );
});

test('status --json: stays at exit 0 regardless of probe state', () => {
  const HOME = makeTempHome();
  const res = spawnSync('npx', ['tsx', CLI, 'status', '--json'], {
    env: { ...process.env, ...FAILING_RELAY_ENV, HOME },
    timeout: 30_000,
    encoding: 'utf8',
  });
  assert.equal(
    res.status, 0,
    `expected exit 0, got ${res.status}; stderr: ${(res.stderr || '').slice(0, 400)}; stdout: ${(res.stdout || '').slice(0, 400)}`,
  );
  const parsed = JSON.parse(res.stdout);
  // Schema unchanged: payload is keyed by label with { ok, value }.
  assert.equal(typeof parsed, 'object');
  const first = Object.values(parsed)[0] as any;
  assert.equal(typeof first.ok,    'boolean');
  assert.equal(typeof first.value, 'string');
});
