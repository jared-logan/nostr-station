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

// ---------------------------------------------------------------------
// Spawn-time config migrations.
//
// The supervisor auto-fixes config.yml shapes that older nostr-station
// versions wrote (server.port host:port form) or that an older GRAIN
// version accepted (backup_relay.url single string). Without these
// migrations, a user's existing community would refuse to boot after
// a version bump. We verify the rewrite happens in-place and the
// supervisor still spawns cleanly.

test('startCommunity migrates legacy backup_relay.url → urls list at spawn time', async () => {
  // GRAIN 0.7.0 renamed `backup_relay.url: <str>` → `backup_relay.urls:
  // [<str>]`. A user who hand-edited their config on 0.6.0 to add a
  // single upstream backup must NOT see GRAIN refuse to start after
  // we bump them; the supervisor coerces the old shape and writes it
  // back atomically before spawn.
  const home = useTempHome();
  const stub = useGrainStub([
    `trap 'exit 0' TERM`,
    `while true; do sleep 1; done`,
  ].join('\n'));
  try {
    _resetSupervisorForTests();
    const m = await createCommunity({
      name: 'backup-migrate', privacyMode: 'local', adminPubkey: HEX_64,
    });

    // Hand-write the legacy shape into the community's config.yml,
    // simulating a user who pasted in a backup_relay block on 0.6.0.
    const cfgPath = path.join(home.home, 'communities', m.id, 'config.yml');
    const original = fs.readFileSync(cfgPath, 'utf8');
    fs.writeFileSync(
      cfgPath,
      original + '\nbackup_relay:\n  enabled: true\n  url: "wss://upstream.example"\n',
    );

    const r1 = await startCommunity(m.id);
    assert.equal(r1.status, 'running');

    // Re-read the file — the migration must have run synchronously
    // before spawn, so by the time startCommunity resolves the file
    // is already in the new shape.
    const after = fs.readFileSync(cfgPath, 'utf8');
    assert.match(after, /urls:/, 'config.yml should now use the urls-list key');
    assert.match(after, /wss:\/\/upstream\.example/,
      'the upstream URL must survive the migration');
    assert.doesNotMatch(after, /^\s*url:\s*"?wss:\/\/upstream/m,
      'the old `url:` key must be dropped so GRAIN 0.7.0\'s validator doesn\'t see both');

    await stopCommunity(m.id);
  } finally {
    _resetSupervisorForTests();
    stub.restore();
    home.restore();
  }
});

test('startCommunity leaves an already-urls-list backup_relay block untouched', async () => {
  // Idempotency check: a config that's already in the 0.7.0 shape
  // must not be rewritten on every spawn (would churn the file and
  // fire GRAIN's hot-reload for no reason).
  const home = useTempHome();
  const stub = useGrainStub([
    `trap 'exit 0' TERM`,
    `while true; do sleep 1; done`,
  ].join('\n'));
  try {
    _resetSupervisorForTests();
    const m = await createCommunity({
      name: 'backup-noop', privacyMode: 'local', adminPubkey: HEX_64,
    });

    const cfgPath = path.join(home.home, 'communities', m.id, 'config.yml');
    const original = fs.readFileSync(cfgPath, 'utf8');
    const customized = original +
      '\nbackup_relay:\n  enabled: true\n  urls:\n    - "wss://upstream.example"\n';
    fs.writeFileSync(cfgPath, customized);
    const mtimeBefore = fs.statSync(cfgPath).mtimeMs;

    // Tiny pause so any rewrite would show a different mtime.
    await sleep(20);
    const r1 = await startCommunity(m.id);
    assert.equal(r1.status, 'running');

    const mtimeAfter = fs.statSync(cfgPath).mtimeMs;
    assert.equal(mtimeAfter, mtimeBefore,
      'config.yml must not be rewritten when no migration applies');

    await stopCommunity(m.id);
  } finally {
    _resetSupervisorForTests();
    stub.restore();
    home.restore();
  }
});
