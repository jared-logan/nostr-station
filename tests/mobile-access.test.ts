/**
 * Tests for the Mobile Access toggle persistence + bind-host derivation.
 *
 * Uses a temporary HOME for each test so the real ~/.nostr-station/
 * mobile-access.json is never touched. The bind host derivation is
 * trivial but worth pinning because a regression there flips the
 * dashboard's exposure surface — exactly the kind of thing a security
 * test should catch.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readMobileAccessConfig, writeMobileAccessConfig, dashboardBindHost,
} from '../src/lib/mobile-access.ts';

function useTempHome(): { restore: () => void; home: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-mobile-'));
  const prevHome = process.env.HOME;
  const prevDev  = process.env.DEV_HOST;
  process.env.HOME = home;
  delete process.env.DEV_HOST;
  return {
    home,
    restore: () => {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevDev !== undefined) process.env.DEV_HOST = prevDev;
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

test('readMobileAccessConfig defaults to disabled when the file is absent', () => {
  const home = useTempHome();
  try {
    assert.deepEqual(readMobileAccessConfig(), { enabled: false });
  } finally {
    home.restore();
  }
});

test('readMobileAccessConfig defaults to disabled on malformed JSON', () => {
  const home = useTempHome();
  try {
    fs.mkdirSync(path.join(home.home, '.nostr-station'), { recursive: true });
    fs.writeFileSync(path.join(home.home, '.nostr-station', 'mobile-access.json'), '{not json');
    assert.deepEqual(readMobileAccessConfig(), { enabled: false });
  } finally {
    home.restore();
  }
});

test('writeMobileAccessConfig persists + stamps updatedAt', () => {
  const home = useTempHome();
  try {
    const before = Date.now() - 1;
    const saved = writeMobileAccessConfig({ enabled: true });
    assert.equal(saved.enabled, true);
    assert.ok(typeof saved.updatedAt === 'number');
    assert.ok(saved.updatedAt! >= before);
    // Round-trip via read.
    assert.equal(readMobileAccessConfig().enabled, true);
  } finally {
    home.restore();
  }
});

test('writeMobileAccessConfig coerces non-boolean enabled to false (defensive)', () => {
  const home = useTempHome();
  try {
    const saved = writeMobileAccessConfig({ enabled: 'yes' as any });
    assert.equal(saved.enabled, false);
  } finally {
    home.restore();
  }
});

test('dashboardBindHost: defaults to loopback when toggle is off', () => {
  const home = useTempHome();
  try {
    assert.equal(dashboardBindHost(), '127.0.0.1');
  } finally {
    home.restore();
  }
});

test('dashboardBindHost: returns 0.0.0.0 when toggle is on', () => {
  const home = useTempHome();
  try {
    writeMobileAccessConfig({ enabled: true });
    assert.equal(dashboardBindHost(), '0.0.0.0');
  } finally {
    home.restore();
  }
});

test('dashboardBindHost: DEV_HOST env var wins over the toggle (existing override preserved)', () => {
  const home = useTempHome();
  try {
    writeMobileAccessConfig({ enabled: true });
    process.env.DEV_HOST = '10.42.0.5';
    assert.equal(dashboardBindHost(), '10.42.0.5',
      'DEV_HOST should win — this is the existing dev override, must not be regressed');
  } finally {
    home.restore();
  }
});

test('dashboardBindHost: toggling back to off restores loopback', () => {
  const home = useTempHome();
  try {
    writeMobileAccessConfig({ enabled: true });
    assert.equal(dashboardBindHost(), '0.0.0.0');
    writeMobileAccessConfig({ enabled: false });
    assert.equal(dashboardBindHost(), '127.0.0.1');
  } finally {
    home.restore();
  }
});
