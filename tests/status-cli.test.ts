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
