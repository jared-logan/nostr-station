/**
 * Tests for the supervisor's dependency layer:
 *   - preflightDependencies() classifies missing GRAIN / private-network
 *     preconditions into specific failures
 *   - reconcileOrphanedCommunities() correctly distinguishes our orphans
 *     (cmdline fingerprint matches) from PID-reuse cases (mismatch),
 *     and NEVER SIGTERMs a PID that isn't ours
 *   - grain.pid management round-trips through spawn/stop
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  createCommunity, readCommunityManifest,
  communityDir, updateCommunityManifest,
} from '../src/lib/communities.ts';
import {
  startCommunity, stopCommunity,
  preflightDependencies, reconcileOrphanedCommunities,
  isGrainProcessForCommunity,
  _resetSupervisorForTests,
} from '../src/lib/community-process.ts';

const HEX_64 = 'ab'.repeat(32);

function useTempHome(): { restore: () => void; home: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-deps-'));
  const prev = process.env.NOSTR_STATION_HOME;
  process.env.NOSTR_STATION_HOME = home;
  return {
    home,
    restore: () => {
      if (prev === undefined) delete process.env.NOSTR_STATION_HOME;
      else process.env.NOSTR_STATION_HOME = prev;
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

function useGrainStub(body: string): { restore: () => void; binPath: string; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-grain-bin-'));
  const binPath = path.join(dir, 'grain');
  fs.writeFileSync(binPath, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  const prev = process.env.NOSTR_STATION_GRAIN_BIN;
  process.env.NOSTR_STATION_GRAIN_BIN = binPath;
  return {
    binPath, dir,
    restore: () => {
      if (prev === undefined) delete process.env.NOSTR_STATION_GRAIN_BIN;
      else process.env.NOSTR_STATION_GRAIN_BIN = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------
// Preflight

test('preflightDependencies returns grain-missing when the binary is absent', async () => {
  const home = useTempHome();
  const stub = useGrainStub('exit 0');
  fs.rmSync(stub.binPath);
  try {
    const m = await createCommunity({ name: 'x', privacyMode: 'local', adminPubkey: HEX_64 });
    const pre = await preflightDependencies(readCommunityManifest(m.id)!);
    assert.equal(pre.ok, false);
    assert.equal(pre.failure, 'grain-missing');
  } finally {
    stub.restore();
    home.restore();
  }
});

test('preflightDependencies passes a local community with the binary present', async () => {
  const home = useTempHome();
  const stub = useGrainStub('exit 0');
  try {
    const m = await createCommunity({ name: 'x', privacyMode: 'local', adminPubkey: HEX_64 });
    const pre = await preflightDependencies(readCommunityManifest(m.id)!);
    assert.equal(pre.ok, true);
    assert.equal(pre.failure, undefined);
  } finally {
    stub.restore();
    home.restore();
  }
});

// Private-network preflight depends on nvpn being absent OR not running
// OR the network not in the roster. The simplest case we can drive
// deterministically here is "nvpn binary is not on PATH" — which is the
// default on the test machine (no nvpn install). If a developer has
// nvpn installed locally the test skips itself rather than producing
// a false failure on their machine.
test('preflightDependencies returns nvpn-required when nvpn binary is absent', async () => {
  // Skip on machines that actually have nvpn installed — the preflight
  // would advance past the "binary missing" branch and the assertion
  // below would no longer hold.
  const { findBin } = await import('../src/lib/detect.ts');
  if (findBin('nvpn')) {
    return;  // node:test treats a clean return as pass; intentional skip.
  }
  const home = useTempHome();
  const stub = useGrainStub('exit 0');
  try {
    const m = await createCommunity({
      name:           'pv',
      privacyMode:    'private-network',
      adminPubkey:    HEX_64,
      nvpnNetworkId:  'net-abcdef',
    });
    const pre = await preflightDependencies(readCommunityManifest(m.id)!);
    assert.equal(pre.ok, false);
    assert.equal(pre.failure, 'nvpn-required');
  } finally {
    stub.restore();
    home.restore();
  }
});

// ---------------------------------------------------------------------
// grain.pid management

test('startCommunity writes grain.pid; stopCommunity removes it', async () => {
  const home = useTempHome();
  const stub = useGrainStub([
    `trap 'exit 0' TERM`,
    `while true; do sleep 1; done`,
  ].join('\n'));
  try {
    _resetSupervisorForTests();
    const m = await createCommunity({ name: 'pid-test', privacyMode: 'local', adminPubkey: HEX_64 });
    await startCommunity(m.id);
    const pidFile = path.join(communityDir(m.id), 'grain.pid');
    assert.ok(fs.existsSync(pidFile), 'grain.pid should exist while child is running');
    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    assert.ok(pid > 0);

    await stopCommunity(m.id);
    // Brief wait for the exit handler to remove the file:
    for (let i = 0; i < 50 && fs.existsSync(pidFile); i++) await sleep(20);
    assert.equal(fs.existsSync(pidFile), false, 'grain.pid should be removed after stop');
  } finally {
    _resetSupervisorForTests();
    stub.restore();
    home.restore();
  }
});

// ---------------------------------------------------------------------
// Orphan reconciliation

test('reconcileOrphanedCommunities: no-pid-file when there was no prior spawn', async () => {
  const home = useTempHome();
  const stub = useGrainStub('exit 0');
  try {
    _resetSupervisorForTests();
    const m = await createCommunity({ name: 'A', privacyMode: 'local', adminPubkey: HEX_64 });
    const results = await reconcileOrphanedCommunities();
    assert.equal(results.length, 1);
    assert.equal(results[0].id, m.id);
    assert.equal(results[0].outcome, 'no-pid-file');
  } finally {
    _resetSupervisorForTests();
    stub.restore();
    home.restore();
  }
});

test('reconcileOrphanedCommunities clears a "running" status when no PID is recorded', async () => {
  const home = useTempHome();
  const stub = useGrainStub('exit 0');
  try {
    _resetSupervisorForTests();
    const m = await createCommunity({ name: 'A', privacyMode: 'local', adminPubkey: HEX_64 });
    updateCommunityManifest(m.id, { status: 'running' });  // simulate hard-kill mid-flight
    await reconcileOrphanedCommunities();
    assert.equal(readCommunityManifest(m.id)!.status, 'stopped');
  } finally {
    _resetSupervisorForTests();
    stub.restore();
    home.restore();
  }
});

test('reconcileOrphanedCommunities: pid-not-ours when cmdline fingerprint mismatches', async () => {
  const home = useTempHome();
  const stub = useGrainStub('exit 0');
  try {
    _resetSupervisorForTests();
    const m = await createCommunity({ name: 'A', privacyMode: 'local', adminPubkey: HEX_64 });

    // Spawn an UNRELATED long-running process (not GRAIN, no community
    // dir in cmdline) and forge a grain.pid pointing at it. Reconcile
    // must NOT SIGTERM this process — that's the whole safety promise.
    const sleeper = spawn('sleep', ['30'], { stdio: 'ignore' });
    try {
      assert.ok(sleeper.pid !== undefined);
      const pidFile = path.join(communityDir(m.id), 'grain.pid');
      fs.writeFileSync(pidFile, String(sleeper.pid) + '\n');

      const results = await reconcileOrphanedCommunities();
      assert.equal(results.length, 1);
      assert.equal(results[0].outcome, 'pid-not-ours');
      // The unrelated process MUST still be alive.
      let stillAlive = true;
      try { process.kill(sleeper.pid!, 0); } catch { stillAlive = false; }
      assert.equal(stillAlive, true, 'reconcile must not SIGTERM a non-matching PID');
      // Stale pid file should have been cleared so the next pass doesn't
      // re-probe an unrelated process.
      assert.equal(fs.existsSync(pidFile), false, 'stale pid file should be removed');
    } finally {
      try { sleeper.kill('SIGKILL'); } catch {}
    }
  } finally {
    _resetSupervisorForTests();
    stub.restore();
    home.restore();
  }
});

test('reconcileOrphanedCommunities: pid-dead when the recorded PID is gone', async () => {
  const home = useTempHome();
  const stub = useGrainStub('exit 0');
  try {
    _resetSupervisorForTests();
    const m = await createCommunity({ name: 'A', privacyMode: 'local', adminPubkey: HEX_64 });

    // Use a PID that's certainly dead — node's own PID + a large
    // offset. Even if it happens to be alive, the cmdline won't
    // match our grain pattern, so the outcome will be one of
    // pid-not-ours or pid-dead. We assert it's NOT 'respawned'.
    const pidFile = path.join(communityDir(m.id), 'grain.pid');
    fs.writeFileSync(pidFile, String(process.pid + 99999) + '\n');

    const results = await reconcileOrphanedCommunities();
    assert.equal(results.length, 1);
    assert.notEqual(results[0].outcome, 'respawned');
    assert.equal(fs.existsSync(pidFile), false);
  } finally {
    _resetSupervisorForTests();
    stub.restore();
    home.restore();
  }
});

test('isGrainProcessForCommunity returns false for a dead PID', () => {
  // Use a PID that's almost certainly not in use. process.kill(pid, 0)
  // throws ESRCH on dead PIDs; the function returns false fast.
  assert.equal(isGrainProcessForCommunity(process.pid + 99999, 'some-id'), false);
});

test('isGrainProcessForCommunity returns false for our own PID (not running grain)', () => {
  // Our own node process is alive but obviously not a grain child.
  // Tests the cmdline-check arm, not the liveness arm.
  assert.equal(isGrainProcessForCommunity(process.pid, 'some-id'), false);
});
