/**
 * Tests for the Communities experimental feature gate.
 *
 * The gate is the difference between "code present in the bundle"
 * and "user can actually create a community" — without it, the
 * disable-by-default UX promise from the resurrection plan falls
 * over. Tests pin the default state, the enable + acknowledge two-
 * step flow, and the isUsable() composition rule.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readCommunitiesFeatureConfig,
  writeCommunitiesFeatureConfig,
  isCommunitiesUsable,
} from '../src/lib/communities-feature.ts';

function useTempHome(): { restore: () => void; home: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-cmty-feature-'));
  const prev = process.env.HOME;
  process.env.HOME = home;
  return {
    home,
    restore: () => {
      if (prev === undefined) delete process.env.HOME;
      else process.env.HOME = prev;
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

test('default state is disabled + not-acknowledged', () => {
  const home = useTempHome();
  try {
    const cfg = readCommunitiesFeatureConfig();
    assert.equal(cfg.enabled, false);
    assert.equal(cfg.acknowledgedAt, null);
    assert.equal(isCommunitiesUsable(), false);
  } finally {
    home.restore();
  }
});

test('enabling alone is NOT enough to be usable (acknowledge still required)', () => {
  const home = useTempHome();
  try {
    writeCommunitiesFeatureConfig({ enabled: true });
    assert.equal(readCommunitiesFeatureConfig().enabled, true);
    assert.equal(readCommunitiesFeatureConfig().acknowledgedAt, null);
    // The two-flag composition rule is the whole point — enable
    // without acknowledge must not unlock the feature.
    assert.equal(isCommunitiesUsable(), false);
  } finally {
    home.restore();
  }
});

test('acknowledge alone (without enable) does NOT make usable', () => {
  const home = useTempHome();
  try {
    // Forge an acknowledgement without enabling first. The gate
    // requires BOTH flags; one without the other is a no-op.
    writeCommunitiesFeatureConfig({ acknowledgedAt: Date.now() });
    assert.equal(readCommunitiesFeatureConfig().enabled, false);
    assert.equal(isCommunitiesUsable(), false);
  } finally {
    home.restore();
  }
});

test('enable + acknowledge → usable', () => {
  const home = useTempHome();
  try {
    writeCommunitiesFeatureConfig({ enabled: true });
    writeCommunitiesFeatureConfig({ acknowledgedAt: Date.now() });
    assert.equal(isCommunitiesUsable(), true);
  } finally {
    home.restore();
  }
});

test('disable after acknowledge → not usable, acknowledge preserved', () => {
  const home = useTempHome();
  try {
    writeCommunitiesFeatureConfig({ enabled: true });
    writeCommunitiesFeatureConfig({ acknowledgedAt: Date.now() });
    assert.equal(isCommunitiesUsable(), true);
    writeCommunitiesFeatureConfig({ enabled: false });
    assert.equal(isCommunitiesUsable(), false);
    // The acknowledgement timestamp is sticky — re-enabling later
    // should NOT re-prompt the modal (user already read it once).
    assert.ok(readCommunitiesFeatureConfig().acknowledgedAt !== null);
    writeCommunitiesFeatureConfig({ enabled: true });
    assert.equal(isCommunitiesUsable(), true);
  } finally {
    home.restore();
  }
});

test('malformed JSON → safe defaults (no throw, returns disabled)', () => {
  const home = useTempHome();
  try {
    fs.mkdirSync(path.join(home.home, '.nostr-station'), { recursive: true });
    fs.writeFileSync(
      path.join(home.home, '.nostr-station', 'communities-feature.json'),
      '{not json',
    );
    const cfg = readCommunitiesFeatureConfig();
    assert.deepEqual(cfg, { enabled: false, acknowledgedAt: null });
  } finally {
    home.restore();
  }
});

test('writeCommunitiesFeatureConfig coerces non-boolean enabled defensively', () => {
  const home = useTempHome();
  try {
    // Existing state: disabled. Pass garbage; should stay disabled.
    const saved = writeCommunitiesFeatureConfig({ enabled: 'yes' as any });
    assert.equal(saved.enabled, false);
  } finally {
    home.restore();
  }
});

test('updatedAt is bumped on every write (diagnostic field)', async () => {
  const home = useTempHome();
  try {
    const first  = writeCommunitiesFeatureConfig({ enabled: true });
    await new Promise((r) => setTimeout(r, 2));
    const second = writeCommunitiesFeatureConfig({ enabled: true });
    assert.ok((second.updatedAt ?? 0) >= (first.updatedAt ?? 0));
  } finally {
    home.restore();
  }
});
