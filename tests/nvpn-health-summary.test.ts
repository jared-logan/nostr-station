import { test } from 'node:test';
import assert from 'node:assert/strict';

import { nvpnHealthSummary } from '../src/lib/nvpn.js';

test('nvpnHealthSummary: not installed → down', () => {
  const s = nvpnHealthSummary({ installed: false, running: false, tunnelIp: null, raw: null });
  assert.equal(s.state, 'down');
  assert.deepEqual(s.issues, ['nvpn not installed']);
});

test('nvpnHealthSummary: not running → down', () => {
  const s = nvpnHealthSummary({ installed: true, running: false, tunnelIp: null, raw: null });
  assert.equal(s.state, 'down');
  assert.deepEqual(s.issues, ['daemon not running']);
});

test('nvpnHealthSummary: running with discovered public endpoint and no issues → ok', () => {
  const s = nvpnHealthSummary({
    installed: true, running: true, tunnelIp: '10.44.247.100/32',
    raw: { public_endpoint: '108.230.191.168:51820', health: [] },
  });
  assert.equal(s.state, 'ok');
  assert.equal(s.publicEndpoint, '108.230.191.168:51820');
  assert.deepEqual(s.issues, []);
});

test('nvpnHealthSummary: tries multiple endpoint field names', () => {
  // nat.public_endpoint
  let s = nvpnHealthSummary({
    installed: true, running: true, tunnelIp: '10.0.0.1', raw: { nat: { public_endpoint: '1.2.3.4:5678' } },
  });
  assert.equal(s.publicEndpoint, '1.2.3.4:5678');

  // external_endpoint
  s = nvpnHealthSummary({
    installed: true, running: true, tunnelIp: '10.0.0.1', raw: { external_endpoint: '9.8.7.6:9999' },
  });
  assert.equal(s.publicEndpoint, '9.8.7.6:9999');

  // top-level endpoint (legacy)
  s = nvpnHealthSummary({
    installed: true, running: true, tunnelIp: '10.0.0.1', raw: { endpoint: '5.5.5.5:51820' },
  });
  assert.equal(s.publicEndpoint, '5.5.5.5:51820');
});

test('nvpnHealthSummary: rejects endpoint without port', () => {
  const s = nvpnHealthSummary({
    installed: true, running: true, tunnelIp: '10.0.0.1',
    raw: { public_endpoint: 'not-an-endpoint' },
  });
  assert.equal(s.publicEndpoint, null);
  assert.ok(s.issues.some(i => i.includes('no public endpoint')));
});

test('nvpnHealthSummary: surfaces error-severity health entries as issues', () => {
  const s = nvpnHealthSummary({
    installed: true, running: true, tunnelIp: '10.0.0.1',
    raw: {
      public_endpoint: '1.2.3.4:51820',
      health: [
        { code: 'nat.no_public_mapping', severity: 'info', summary: 'no mapping' },
        { code: 'relay.publish_failing', severity: 'error', summary: 'damus rate-limit' },
      ],
    },
  });
  assert.equal(s.state, 'degraded');
  assert.ok(s.issues.some(i => i.includes('damus rate-limit')));
  // info-severity should not be surfaced
  assert.ok(!s.issues.some(i => i.includes('no mapping')));
});

test('nvpnHealthSummary: aggregator publish errors → degraded', () => {
  const s = nvpnHealthSummary({
    installed: true, running: true, tunnelIp: '10.0.0.1',
    raw: { public_endpoint: '1.2.3.4:51820', health: [] },
    publishErrors:   { count: 3, lastKind: 'rate_limited' },
    publishSuccesses: 0,
  });
  assert.equal(s.state, 'degraded');
  assert.ok(s.issues.some(i => i.includes('3 recent publish errors')));
  assert.ok(s.issues.some(i => i.includes('rate_limited')));
  assert.ok(s.issues.some(i => i.includes('daemon reports running but no successful publishes')));
});

test('nvpnHealthSummary: publish errors with some successes only show count', () => {
  const s = nvpnHealthSummary({
    installed: true, running: true, tunnelIp: '10.0.0.1',
    raw: { public_endpoint: '1.2.3.4:51820', health: [] },
    publishErrors:   { count: 1, lastKind: 'timeout' },
    publishSuccesses: 5,
  });
  assert.equal(s.state, 'degraded');
  // The "no successful publishes" line should NOT fire when there are
  // successes, even with some errors.
  assert.ok(!s.issues.some(i => i.includes('no successful publishes')));
});
