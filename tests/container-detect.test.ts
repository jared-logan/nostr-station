import { test } from 'node:test';
import assert from 'node:assert/strict';

import { natWarningFor } from '../src/lib/container-detect.js';

// ── natWarningFor ─────────────────────────────────────────────────────

test('natWarningFor: no container + public endpoint → null', () => {
  const w = natWarningFor({ container: null, publicEndpoint: '108.230.191.168:51820' });
  assert.equal(w, null);
});

test('natWarningFor: no container + no endpoint → null', () => {
  // We don't warn purely on missing endpoint when nothing about the
  // host suggests it should be there. The status surface handles
  // "STUN never landed" via nvpnHealthSummary instead.
  const w = natWarningFor({ container: null, publicEndpoint: null });
  assert.equal(w, null);
});

test('natWarningFor: RFC1918 endpoint (10.x) → error', () => {
  const w = natWarningFor({ container: null, publicEndpoint: '10.0.0.5:51820' });
  assert.ok(w);
  assert.equal(w!.level, 'error');
  assert.ok(w!.summary.includes('10.0.0.5'));
});

test('natWarningFor: 192.168.x endpoint → error', () => {
  const w = natWarningFor({ container: null, publicEndpoint: '192.168.1.10:51820' });
  assert.ok(w);
  assert.equal(w!.level, 'error');
});

test('natWarningFor: 172.16-31.x endpoint → error', () => {
  const w = natWarningFor({ container: null, publicEndpoint: '172.20.5.5:51820' });
  assert.ok(w);
  assert.equal(w!.level, 'error');
});

test('natWarningFor: 172.x outside private range is public', () => {
  // 172.32.0.1 is OUTSIDE the private 172.16-31 range, so it's public.
  const w = natWarningFor({ container: null, publicEndpoint: '172.32.0.1:51820' });
  assert.equal(w, null);
});

test('natWarningFor: 127.x loopback → error', () => {
  const w = natWarningFor({ container: null, publicEndpoint: '127.0.0.1:51820' });
  assert.ok(w);
  assert.equal(w!.level, 'error');
});

test('natWarningFor: container detected with public endpoint → info', () => {
  const w = natWarningFor({
    container:      { kind: 'orbstack', evidence: '/run/...' },
    publicEndpoint: '108.230.191.168:51820',
  });
  assert.ok(w);
  assert.equal(w!.level, 'info');
  assert.ok(w!.summary.includes('OrbStack'));
});

test('natWarningFor: container detected with no public endpoint → warn', () => {
  const w = natWarningFor({
    container:      { kind: 'docker', evidence: '/.dockerenv exists' },
    publicEndpoint: null,
  });
  assert.ok(w);
  assert.equal(w!.level, 'warn');
  assert.ok(w!.summary.includes('Docker'));
});

test('natWarningFor: private endpoint inside container → still error (private wins)', () => {
  // Private endpoint is a stronger signal than container detection.
  // The wording should reflect the address, not "you're in a container."
  const w = natWarningFor({
    container:      { kind: 'docker', evidence: '/.dockerenv exists' },
    publicEndpoint: '10.0.0.5:51820',
  });
  assert.ok(w);
  assert.equal(w!.level, 'error');
  assert.ok(w!.summary.includes('10.0.0.5'));
});

test('natWarningFor: unknown-container kind formats reasonably', () => {
  const w = natWarningFor({
    container:      { kind: 'unknown-container', evidence: 'cgroup' },
    publicEndpoint: '1.2.3.4:51820',
  });
  assert.ok(w);
  assert.ok(w!.summary.toLowerCase().includes('container'));
});
