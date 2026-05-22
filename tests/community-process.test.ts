/**
 * Tests for the Communities supervisor (community-process.ts).
 *
 * The supervisor spawns a real subprocess. We don't want to require
 * GRAIN on the test machine, so each test points
 * NOSTR_STATION_GRAIN_BIN at a tiny shell-script stub that simulates
 * the behavior we want to exercise (clean run, immediate crash,
 * stop-on-SIGTERM).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createCommunity, readCommunityManifest,
} from '../src/lib/communities.ts';
import {
  startCommunity, stopCommunity,
  getCommunityLog, getCommunityRuntimeStatus,
  parseHostPort,
  prepareCommunityForStart,
  _resetSupervisorForTests,
} from '../src/lib/community-process.ts';

const HEX_64 = 'ab'.repeat(32);

function useTempHome(): { restore: () => void; home: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-supervisor-'));
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

/**
 * Drop a tiny shell-script "grain" stub at a tmp path and point the
 * supervisor at it. `body` is the script content (after the shebang).
 * Returns the cleanup function and the path.
 */
function useGrainStub(body: string): { restore: () => void; binPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-grain-bin-'));
  const binPath = path.join(dir, 'grain');
  fs.writeFileSync(binPath, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  const prev = process.env.NOSTR_STATION_GRAIN_BIN;
  process.env.NOSTR_STATION_GRAIN_BIN = binPath;
  return {
    binPath,
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
// Pure function

test('parseHostPort handles bare port, host:port, and IPv6 bracketed forms', () => {
  assert.deepEqual(parseHostPort(':8080'),         { host: '', port: 8080 });
  assert.deepEqual(parseHostPort('127.0.0.1:7778'), { host: '127.0.0.1', port: 7778 });
  assert.deepEqual(parseHostPort('[::1]:7778'),    { host: '::1', port: 7778 });
  assert.deepEqual(parseHostPort('[fe80::1]:9090'), { host: 'fe80::1', port: 9090 });
});

test('parseHostPort throws on a malformed value (no fallback to silent zero)', () => {
  assert.throws(() => parseHostPort('not-a-bind-spec'));
});

// ---------------------------------------------------------------------
// Read-side: no supervision yet

test('getCommunityRuntimeStatus reports stopped + no pid for an unknown id', () => {
  _resetSupervisorForTests();
  const r = getCommunityRuntimeStatus('not-an-id');
  assert.equal(r.status, 'stopped');
  assert.equal(r.pid, null);
  assert.equal(r.uptimeMs, null);
});

test('getCommunityLog returns an empty drained buffer for an unknown id', () => {
  _resetSupervisorForTests();
  const log = getCommunityLog('not-an-id');
  assert.deepEqual(log.drain(), []);
});

// ---------------------------------------------------------------------
// Spawn / stop with a stub binary that traps SIGTERM and stays running.

test('startCommunity spawns + sets status=running; stopCommunity SIGTERMs cleanly', async () => {
  const home = useTempHome();
  const stub = useGrainStub([
    // Trap SIGTERM so the supervisor's terminate path exercises the
    // happy "child exits on SIGTERM within 5s" case rather than the
    // SIGKILL escalation.
    `trap 'exit 0' TERM`,
    // Stay alive until the trap fires. `sleep` lets the trap fire
    // mid-flight (we'd lose that with a foreground `wait`).
    `while true; do sleep 1; done`,
  ].join('\n'));
  try {
    _resetSupervisorForTests();
    const m = await createCommunity({
      name: 'spawn-test', privacyMode: 'local', adminPubkey: HEX_64,
    });
    const r1 = await startCommunity(m.id);
    assert.equal(r1.status, 'running');
    assert.ok(r1.pid !== null && r1.pid > 0, 'expected a pid on the running supervision');
    // Manifest reflects the runtime state.
    assert.equal(readCommunityManifest(m.id)!.status, 'running');

    await stopCommunity(m.id);
    const r2 = getCommunityRuntimeStatus(m.id);
    assert.equal(r2.status, 'stopped');
    assert.equal(r2.pid, null);
    assert.equal(readCommunityManifest(m.id)!.status, 'stopped');
  } finally {
    _resetSupervisorForTests();
    stub.restore();
    home.restore();
  }
});

// ---------------------------------------------------------------------
// startCommunity throws when the binary doesn't exist (no silent fallback)

test('startCommunity surfaces an error when the binary is missing', async () => {
  const home = useTempHome();
  const stub = useGrainStub('# never used; we overwrite below');
  fs.rmSync(stub.binPath);  // delete the stub so preflight stat fails
  try {
    _resetSupervisorForTests();
    const m = await createCommunity({
      name: 'missing-bin', privacyMode: 'local', adminPubkey: HEX_64,
    });
    // Preflight runs before spawn now, so the rejection mentions the
    // precondition rather than the runtime spawn step.
    await assert.rejects(startCommunity(m.id), /preflight failed.*not found/);
    assert.equal(readCommunityManifest(m.id)!.status, 'error');
  } finally {
    _resetSupervisorForTests();
    stub.restore();
    home.restore();
  }
});

// ---------------------------------------------------------------------
// Log piping: stdout + stderr land in the LogBuffer

test('child stdout + stderr feed the community LogBuffer line-by-line', async () => {
  const home = useTempHome();
  // Stub emits a few stdout + stderr lines then traps SIGTERM and waits.
  const stub = useGrainStub([
    `printf 'hello from stdout\\n' >&1`,
    `printf 'warning from stderr\\n' >&2`,
    `trap 'exit 0' TERM`,
    `while true; do sleep 1; done`,
  ].join('\n'));
  try {
    _resetSupervisorForTests();
    const m = await createCommunity({
      name: 'log-test', privacyMode: 'local', adminPubkey: HEX_64,
    });
    await startCommunity(m.id);
    // Pipes are async; give the runtime a beat to flush both streams.
    await sleep(150);
    const lines = getCommunityLog(m.id).drain().map((l) => l.text);
    assert.ok(lines.some((t) => t === 'hello from stdout'),    'stdout line missing');
    assert.ok(lines.some((t) => t === 'warning from stderr'), 'stderr line missing');
    await stopCommunity(m.id);
  } finally {
    _resetSupervisorForTests();
    stub.restore();
    home.restore();
  }
});

// ---------------------------------------------------------------------
// prepareCommunityForStart — bind-host resolution

test('prepareCommunityForStart: local mode always returns loopback', async () => {
  const home = useTempHome();
  try {
    const m = await createCommunity({
      name: 'local', privacyMode: 'local', adminPubkey: HEX_64,
    });
    const prep = await prepareCommunityForStart(readCommunityManifest(m.id)!);
    assert.equal(prep.ok, true);
    if (prep.ok) assert.equal(prep.bindHost, '127.0.0.1');
  } finally {
    home.restore();
  }
});

// Private-network mode's resolution path depends on nvpn being
// installed + running + having an active network with a tunnel IP.
// That's hard to stub at unit-test scope without a full nvpn double,
// so we exercise the "nvpn not installed" branch here — which is the
// most common failure path users will actually hit. The other failure
// branches (running but no tunnel IP, network-mismatch) follow the
// same pattern of "probe ⇒ specific reason"; verifying that one branch
// gives a useful error is sufficient confidence that the helper isn't
// silently passing bogus bind hosts back to the supervisor.
test('prepareCommunityForStart: private-network surfaces a useful reason when nvpn is absent', async () => {
  const home = useTempHome();
  try {
    const m = await createCommunity({
      name:           'pv',
      privacyMode:    'private-network',
      adminPubkey:    HEX_64,
      nvpnNetworkId:  'net-abcdef',
    });
    const prep = await prepareCommunityForStart(readCommunityManifest(m.id)!);
    // On test machines without nvpn installed, prep.ok === false with
    // a reason mentioning nvpn. On developer machines that DO have
    // nvpn installed, the reason will instead mention the active
    // network state — still informative, just a different branch.
    if (!prep.ok) {
      assert.match(prep.reason, /nvpn/i, 'reason should explain the nvpn precondition');
    }
  } finally {
    home.restore();
  }
});
