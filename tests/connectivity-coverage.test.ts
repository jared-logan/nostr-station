/**
 * Tests for connectivityBannerCoverage() (#272) — the pure banner-suppression
 * logic behind the Connectivity panel's hide-when-covered behavior (#255).
 * Shared with app.js (src/web/connectivity-coverage.js) so this is the single
 * source of truth, not a mirror.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { connectivityBannerCoverage, CONN_NAT_IDS } from '../src/web/connectivity-coverage.js';

const sig = (id: string) => ({ id });

test('missing / unknown report covers nothing (banners fall back)', () => {
  for (const bad of [null, undefined, {}, { verdict: 'unknown', signals: [sig('net.no_public_udp')] }]) {
    assert.deepEqual(connectivityBannerCoverage(bad as any), { hidesNat: false, hidesStale: false });
  }
});

test('each public-path signal id hides the natWarning banner', () => {
  for (const id of CONN_NAT_IDS) {
    const r = connectivityBannerCoverage({ verdict: 'reachable_with_caveats', signals: [sig(id)] });
    assert.equal(r.hidesNat, true, `${id} should hide nat`);
  }
});

test('a non-cause signal does NOT hide the natWarning banner', () => {
  const r = connectivityBannerCoverage({ verdict: 'reachable_with_caveats', signals: [sig('net.ipv6_only'), sig('health:x')] });
  assert.equal(r.hidesNat, false);
});

test('daemon.stopped hides the stale/daemon banner', () => {
  const r = connectivityBannerCoverage({ verdict: 'unreachable', signals: [sig('daemon.stopped')] });
  assert.equal(r.hidesStale, true);
  assert.equal(r.hidesNat, false);
});

test('doctorOk + a clean verdict hides the stale banner (contradicts it)', () => {
  for (const verdict of ['reachable', 'reachable_with_caveats']) {
    const r = connectivityBannerCoverage({ verdict, doctorOk: true, signals: [] });
    assert.equal(r.hidesStale, true, `${verdict} + doctorOk should hide stale`);
  }
});

test('a clean verdict WITHOUT doctorOk does not hide the stale banner', () => {
  assert.equal(connectivityBannerCoverage({ verdict: 'reachable', signals: [] }).hidesStale, false);
  assert.equal(connectivityBannerCoverage({ verdict: 'reachable', doctorOk: false, signals: [] }).hidesStale, false);
});

test('unreachable without daemon.stopped does not hide the stale banner', () => {
  // e.g. mesh down but daemon up — the stale banner isn't this concern.
  const r = connectivityBannerCoverage({ verdict: 'unreachable', doctorOk: true, signals: [sig('net.no_public_udp')] });
  assert.equal(r.hidesStale, false);
  assert.equal(r.hidesNat, true);
});

test('the incident slice hides nat (cause shown) but keeps stale unless covered', () => {
  // daemon-down incident: daemon.stopped present ⇒ hides stale; no net cause ⇒ keeps nat.
  const down = connectivityBannerCoverage({ verdict: 'unreachable', signals: [sig('daemon.stopped')] });
  assert.deepEqual(down, { hidesNat: false, hidesStale: true });
});
