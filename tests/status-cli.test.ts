/**
 * Tests for the `nostr-station status --json` shape with respect to
 * the new `communities` field added in this commit.
 *
 *   - When no communities exist, the key is absent (terse for the
 *     solo-dev common case)
 *   - When communities exist, the key is an array of summaries with
 *     the documented field set (id / name / port / status /
 *     privacyMode / memberCount)
 *
 * Drives gatherStatus + formatStatusJson against a tmp
 * NOSTR_STATION_HOME so we don't read or write the user's real dir.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gatherStatus, formatStatusJson } from '../src/commands/Status.tsx';
import { createCommunity } from '../src/lib/communities.ts';

const HEX_64 = 'cc'.repeat(32);

function useTempHome(): { restore: () => void } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-status-'));
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

test('formatStatusJson omits .communities when none exist', () => {
  const home = useTempHome();
  try {
    const json = JSON.parse(formatStatusJson(gatherStatus()));
    assert.equal(json.communities, undefined,
      '.communities key should be absent for the no-community common case');
  } finally {
    home.restore();
  }
});

test('formatStatusJson includes .communities[] with documented fields when present', async () => {
  const home = useTempHome();
  try {
    const m = await createCommunity({
      name: 'Test family', privacyMode: 'local', adminPubkey: HEX_64,
    });
    const json = JSON.parse(formatStatusJson(gatherStatus()));
    assert.ok(Array.isArray(json.communities), '.communities should be an array');
    assert.equal(json.communities.length, 1);
    const c = json.communities[0];
    assert.equal(c.id,          m.id);
    assert.equal(c.name,        'Test family');
    assert.equal(c.port,        m.port);
    assert.equal(c.status,      'stopped');
    assert.equal(c.privacyMode, 'local');
    assert.equal(c.memberCount, 1);  // admin auto-added
  } finally {
    home.restore();
  }
});

test('formatStatusJson is jq-pipeable (parses as standalone JSON)', () => {
  const home = useTempHome();
  try {
    // No assertion beyond "parses without throwing" — the contract is
    // that `nostr-station status --json | jq` works at the shell.
    const text = formatStatusJson(gatherStatus());
    JSON.parse(text);
    // Property names with dashes / spaces are quoted by JSON.stringify,
    // so this also exercises the safe handling of "claude-code" /
    // "nostr-vpn" / etc.
    assert.match(text, /^\{[\s\S]*\}$/);
  } finally {
    home.restore();
  }
});

// ── grain row value formatting ────────────────────────────────────────
// The homepage Status section renders s.value verbatim, so the format
// here is the contract the UI depends on. Grain ships without a
// `--version` flag — we surface the marker file (~/.nostr-station/bin/
// grain.version) instead. Three states the row must distinguish:
//   1. Binary present + marker matches  → "grain <version>"  (the
//      common steady state after this PR ships)
//   2. Binary present + marker absent   → "installed"        (pre-0.7.0
//      install — visible for one update cycle, clears after upgrade)
//   3. Binary absent                    → "not installed"    (no install)
//
// Two env-vars need overriding to drive this: HOME (so findBin's walk
// over ~/.nostr-station/bin lands in our tmp dir, not the real user's
// install) and PATH (so a system-wide `grain` on the dev host doesn't
// shadow the absent state in test #3). Restoring both is critical —
// node:test runs all tests in one process.

function withFakeHome(fn: (home: string) => void): void {
  const home   = fs.mkdtempSync(path.join(os.tmpdir(), 'grain-status-test-'));
  const prevH  = process.env.HOME;
  const prevP  = process.env.PATH;
  process.env.HOME = home;
  // Strip PATH so findBin's PATH walk can't find a system-wide grain
  // and produce a false-pass — the test is about our managed dir's
  // contribution to findBin via augmentedBinDirs(). Keep /usr/bin so
  // any incidental shell-outs in the gather (cmd() for ngit/claude
  // version probes) still resolve their binaries when present, even
  // if they themselves report "not installed" — that's fine, this
  // test only cares about the grain row.
  process.env.PATH = '/usr/bin:/bin';
  try { fn(home); }
  finally {
    if (prevH === undefined) delete process.env.HOME; else process.env.HOME = prevH;
    if (prevP === undefined) delete process.env.PATH; else process.env.PATH = prevP;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('gatherStatus: grain row reads "grain <version>" when marker is present', () => {
  const homeWrap = useTempHome();
  try {
    withFakeHome((home) => {
      const binDir = path.join(home, '.nostr-station', 'bin');
      fs.mkdirSync(binDir, { recursive: true });
      const binPath = path.join(binDir, 'grain');
      fs.writeFileSync(binPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      fs.writeFileSync(`${binPath}.version`, '0.7.0\n');

      const rows = gatherStatus();
      const grain = rows.find(r => r.id === 'grain');
      assert.ok(grain, 'grain row must be present');
      assert.equal(grain!.value, 'grain 0.7.0',
        'value must surface the marker version so the homepage card matches other binary rows');
      assert.equal(grain!.ok, true);
    });
  } finally {
    homeWrap.restore();
  }
});

test('gatherStatus: grain row falls back to "installed" when binary present but marker absent', () => {
  // The v0.6.0-upgrade scenario: marker file doesn't exist yet
  // because the user hasn't run the v0.7.0 installer. The row must
  // still render usefully — the Updates modal is what nudges them
  // forward (currentVersion:null there), the Status row just shows
  // a working state.
  const homeWrap = useTempHome();
  try {
    withFakeHome((home) => {
      const binDir = path.join(home, '.nostr-station', 'bin');
      fs.mkdirSync(binDir, { recursive: true });
      const binPath = path.join(binDir, 'grain');
      fs.writeFileSync(binPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      // Deliberately no marker file.

      const rows = gatherStatus();
      const grain = rows.find(r => r.id === 'grain');
      assert.ok(grain);
      assert.equal(grain!.value, 'installed',
        'pre-marker installs must fall back gracefully, not show empty/undefined');
      assert.equal(grain!.ok, true);
    });
  } finally {
    homeWrap.restore();
  }
});

test('gatherStatus: grain row is "not installed" when binary is absent', () => {
  const homeWrap = useTempHome();
  try {
    withFakeHome((_home) => {
      // No binary dropped anywhere findBin walks — and PATH is
      // stripped to /usr/bin:/bin which won't carry a grain.
      const rows = gatherStatus();
      const grain = rows.find(r => r.id === 'grain');
      assert.ok(grain);
      assert.equal(grain!.value, 'not installed');
      assert.equal(grain!.ok, false);
    });
  } finally {
    homeWrap.restore();
  }
});
