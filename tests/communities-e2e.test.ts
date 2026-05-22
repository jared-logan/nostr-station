/**
 * End-to-end lifecycle test for the Communities feature.
 *
 * Drives the full happy path through the public module API:
 *   1. createCommunity()              — manifest + YAML stack on disk
 *   2. startCommunity()                — supervisor spawns the stub
 *   3. getCommunityRuntimeStatus()     — reflects 'running'
 *   4. addCommunityMember()            — allowlist hot-update
 *   5. listCommunityMembers()          — reflects the add
 *   6. stopCommunity()                 — clean exit, status 'stopped'
 *   7. updateCommunityManifest()       — rename
 *   8. deleteCommunityDir()            — manifest gone, dir gone
 *
 * Uses a shell-script GRAIN stub that traps SIGTERM and idles, so
 * the supervisor exercises real subprocess management without
 * needing a real GRAIN install.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createCommunity, listCommunities, readCommunityManifest,
  updateCommunityManifest, deleteCommunityDir,
  addCommunityMember, listCommunityMembers,
  communityDir,
} from '../src/lib/communities.ts';
import {
  startCommunity, stopCommunity,
  getCommunityRuntimeStatus,
  _resetSupervisorForTests,
} from '../src/lib/community-process.ts';

const HEX_64 = 'ee'.repeat(32);

function useTempHome(): { restore: () => void } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-e2e-'));
  const prev = process.env.NOSTR_STATION_HOME;
  process.env.NOSTR_STATION_HOME = home;
  return {
    restore: () => {
      if (prev === undefined) delete process.env.NOSTR_STATION_HOME;
      else process.env.NOSTR_STATION_HOME = prev;
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

function useGrainStub(body: string): { restore: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-grain-'));
  const bin = path.join(dir, 'grain');
  fs.writeFileSync(bin, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  const prev = process.env.NOSTR_STATION_GRAIN_BIN;
  process.env.NOSTR_STATION_GRAIN_BIN = bin;
  return {
    restore: () => {
      if (prev === undefined) delete process.env.NOSTR_STATION_GRAIN_BIN;
      else process.env.NOSTR_STATION_GRAIN_BIN = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('communities e2e: create → start → mutate → stop → delete', async () => {
  const home = useTempHome();
  const stub = useGrainStub([
    `trap 'exit 0' TERM`,
    `while true; do sleep 1; done`,
  ].join('\n'));
  try {
    _resetSupervisorForTests();

    // 1. Create a fresh community. Allocates a port ≥ 7778, writes
    //    manifest + config.yml + whitelist.yml, creates data/ dir.
    const created = await createCommunity({
      name: 'Lifecycle test community',
      privacyMode: 'local',
      adminPubkey: HEX_64,
      description: 'Spawned by the e2e harness.',
    });
    assert.ok(created.id);
    assert.ok(created.port >= 7778);
    assert.equal(readCommunityManifest(created.id)!.name, 'Lifecycle test community');
    assert.deepEqual(listCommunities().map((c) => c.id), [created.id]);

    // 2. Start the supervisor. Stub binary sleeps + traps SIGTERM
    //    so the runtime stays 'running' until we explicitly stop.
    const r1 = await startCommunity(created.id);
    assert.equal(r1.status, 'running');
    assert.ok(r1.pid && r1.pid > 0);

    // 3. Runtime status reflects the supervisor's view.
    const rt = getCommunityRuntimeStatus(created.id);
    assert.equal(rt.status, 'running');
    assert.equal(rt.pid, r1.pid);
    assert.ok(rt.uptimeMs !== null && rt.uptimeMs >= 0);
    // Disk manifest tracks runtime — supervisor writes 'running' after spawn.
    assert.equal(readCommunityManifest(created.id)!.status, 'running');

    // 4 + 5. Allowlist mutations are idempotent and atomic — YAML
    //    written by community-yaml's atomic-rename, no torn file.
    const extra = 'aa'.repeat(32);
    addCommunityMember(created.id, extra);
    addCommunityMember(created.id, extra);  // idempotent
    const members = listCommunityMembers(created.id);
    assert.equal(members.length, 2, 'expected admin + extra');
    assert.ok(members.includes(HEX_64));
    assert.ok(members.includes(extra));

    // 6. Clean stop. intendedRunning flips false → exit handler does
    //    NOT trigger the backoff loop. Status reflects.
    await stopCommunity(created.id);
    const rt2 = getCommunityRuntimeStatus(created.id);
    assert.equal(rt2.status, 'stopped');
    assert.equal(rt2.pid, null);
    assert.equal(readCommunityManifest(created.id)!.status, 'stopped');

    // 7. Rename via updateCommunityManifest. Immutables (id,
    //    createdAt) must survive a patch round-trip.
    const before = readCommunityManifest(created.id)!;
    updateCommunityManifest(created.id, { name: 'Renamed', description: 'New' });
    const after = readCommunityManifest(created.id)!;
    assert.equal(after.name, 'Renamed');
    assert.equal(after.description, 'New');
    assert.equal(after.id, before.id);
    assert.equal(after.createdAt, before.createdAt);

    // 8. Delete. Dir + every YAML + data dir wiped.
    deleteCommunityDir(created.id);
    assert.equal(fs.existsSync(communityDir(created.id)), false);
    assert.equal(listCommunities().length, 0);
  } finally {
    _resetSupervisorForTests();
    stub.restore();
    home.restore();
  }
});
