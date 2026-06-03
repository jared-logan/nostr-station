/**
 * Tests for the dashboard binding filter — the pubkey-level gate that
 * keeps non-trusted peers from reaching the dashboard's HTTP port when
 * it's bound to a non-loopback interface (i.e., once Mobile Access
 * lands and binds to the nvpn tunnel IP).
 *
 * Exercised at the pure-helper layer (no real socket, no real nvpn).
 * The attached `attachDashboardBindingFilter` middleware is covered
 * indirectly via the pure pieces — it's a thin shim over them.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isLoopbackAddress,
  peerPubkeyForIp,
  allowDashboardConnection,
} from '../src/lib/dashboard-binding.ts';
import { statusDownRaw } from './fixtures/nvpn-connectivity.ts';

// ---------------------------------------------------------------------
// isLoopbackAddress

test('isLoopbackAddress: IPv4 loopback', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true);
  assert.equal(isLoopbackAddress('127.1.2.3'), true);  // 127/8 is all loopback
});

test('isLoopbackAddress: IPv6 loopback + IPv4-mapped form', () => {
  assert.equal(isLoopbackAddress('::1'), true);
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
});

test('isLoopbackAddress: non-loopback IPs return false', () => {
  for (const ip of ['192.168.1.1', '10.0.0.1', '8.8.8.8', '::ffff:192.168.1.1', 'fe80::1']) {
    assert.equal(isLoopbackAddress(ip), false, `${ip} should not be loopback`);
  }
});

test('isLoopbackAddress: undefined / null / empty fail closed (not loopback)', () => {
  assert.equal(isLoopbackAddress(undefined), false);
  assert.equal(isLoopbackAddress(null), false);
  assert.equal(isLoopbackAddress(''), false);
});

// ---------------------------------------------------------------------
// peerPubkeyForIp — defensive over the unknown nvpn peer shape

test('peerPubkeyForIp: matches on tunnel_ip + pubkey fields', () => {
  const peers = [
    { tunnel_ip: '10.0.0.5', pubkey: 'a'.repeat(64) },
    { tunnel_ip: '10.0.0.6', pubkey: 'b'.repeat(64) },
  ];
  assert.equal(peerPubkeyForIp(peers, '10.0.0.5'), 'a'.repeat(64));
  assert.equal(peerPubkeyForIp(peers, '10.0.0.6'), 'b'.repeat(64));
  assert.equal(peerPubkeyForIp(peers, '10.0.0.7'), null);
});

// Regression for #259: the REAL nvpn 4.x peer shape — pubkey lives in
// `node_id`, `public_key` is empty for every peer, and `tunnel_ip` carries a
// /32. The pre-fix code compared tunnel_ip exactly (never matched the bare
// remoteAddress) AND read pubkey from `pubkey`/`hex` (always null), so the
// gate's positive path was dead on arrival and #248's allowlist unreachable.
// Synthetic keys only.
test('peerPubkeyForIp: real nvpn 4.x shape — node_id + /32 tunnel_ip + empty public_key (#259)', () => {
  const peers = [
    { node_id: 'a'.repeat(64), public_key: '', endpoint: '203.0.113.7:51820', tunnel_ip: '10.44.0.5/32', timestamp: 1 },
    { node_id: 'b'.repeat(64), public_key: '', endpoint: '198.51.100.9:51820', tunnel_ip: '10.44.0.6/32', timestamp: 2 },
  ];
  // bare remoteAddress matches the /32 tunnel_ip, and the pubkey comes from node_id
  assert.equal(peerPubkeyForIp(peers, '10.44.0.5'), 'a'.repeat(64));
  assert.equal(peerPubkeyForIp(peers, '10.44.0.6'), 'b'.repeat(64));
  assert.equal(peerPubkeyForIp(peers, '10.44.0.7'), null);
  // an empty public_key must NOT shadow node_id (would yield a bogus '' pubkey)
  assert.notEqual(peerPubkeyForIp(peers, '10.44.0.5'), '');
});

// Regression for #266: the daemon-vs-config peers[] SWAP. In the "config"
// (daemon-down) shape `node_id` is a magic-DNS name and the 64-hex pubkey
// lives in `public_key` — the inverse of the daemon-up shape. peerPubkeyForIp
// must prefer the field that's actually a 64-hex pubkey so it's robust to the
// swap and to a daemon-flap race. Synthetic keys.
test('peerPubkeyForIp: config-down swap — pubkey in public_key, name in node_id (#266)', () => {
  const peers = [
    { node_id: 'mint.nvpn', public_key: 'a'.repeat(64), tunnel_ip: '10.44.0.5/32' },
  ];
  assert.equal(peerPubkeyForIp(peers, '10.44.0.5'), 'a'.repeat(64));
});

test('peerPubkeyForIp: prefers the 64-hex field even when a name sits in node_id', () => {
  // node_id non-hex, pubkey present elsewhere → return the hex, not the name.
  const peers = [{ node_id: 'box-7.nvpn', pubkey: 'c'.repeat(64), tunnel_ip: '10.44.0.5/32' }];
  assert.equal(peerPubkeyForIp(peers, '10.44.0.5'), 'c'.repeat(64));
});

test('peerPubkeyForIp: resolves against the HW-verified down-shape fixture (#266/#267)', () => {
  // Cross-check with the same fixture the connectivity daemon-down test uses,
  // so the two shape consumers can't drift apart.
  assert.equal(peerPubkeyForIp(statusDownRaw.peers, '10.44.0.5'), 'a'.repeat(64));
});

test('peerPubkeyForIp: accepts the `ip` field variant', () => {
  const peers = [{ ip: '10.0.0.5', pubkey: 'c'.repeat(64) }];
  assert.equal(peerPubkeyForIp(peers, '10.0.0.5'), 'c'.repeat(64));
});

test('peerPubkeyForIp: accepts the `address` field variant', () => {
  const peers = [{ address: '10.0.0.5', pubkey: 'd'.repeat(64) }];
  assert.equal(peerPubkeyForIp(peers, '10.0.0.5'), 'd'.repeat(64));
});

test('peerPubkeyForIp: accepts the `npub_hex` and `hex` pubkey variants', () => {
  assert.equal(
    peerPubkeyForIp([{ tunnel_ip: '10.0.0.5', npub_hex: 'e'.repeat(64) }], '10.0.0.5'),
    'e'.repeat(64),
  );
  assert.equal(
    peerPubkeyForIp([{ tunnel_ip: '10.0.0.5', hex: 'f'.repeat(64) }], '10.0.0.5'),
    'f'.repeat(64),
  );
});

test('peerPubkeyForIp: normalizes pubkey to lowercase', () => {
  const peers = [{ tunnel_ip: '10.0.0.5', pubkey: 'AB'.repeat(32) }];
  assert.equal(peerPubkeyForIp(peers, '10.0.0.5'), 'ab'.repeat(32));
});

test('peerPubkeyForIp: returns null for non-array peers (defensive)', () => {
  assert.equal(peerPubkeyForIp(null,      '10.0.0.5'), null);
  assert.equal(peerPubkeyForIp(undefined, '10.0.0.5'), null);
  assert.equal(peerPubkeyForIp({},        '10.0.0.5'), null);
  assert.equal(peerPubkeyForIp('peers',   '10.0.0.5'), null);
});

test('peerPubkeyForIp: returns null when matched peer has no pubkey field', () => {
  const peers = [{ tunnel_ip: '10.0.0.5' }];
  assert.equal(peerPubkeyForIp(peers, '10.0.0.5'), null);
});

// ---------------------------------------------------------------------
// allowDashboardConnection — the gate

const TRUSTED = new Set(['a'.repeat(64), 'b'.repeat(64)]);
const PEERS = [
  { tunnel_ip: '10.0.0.5', pubkey: 'a'.repeat(64) },
  { tunnel_ip: '10.0.0.6', pubkey: 'c'.repeat(64) },  // not trusted
];

test('allowDashboardConnection: loopback always allowed (no peer probe)', () => {
  for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    const r = allowDashboardConnection({ remoteAddress: ip, nvpnPeers: null, trusted: new Set() });
    assert.equal(r.ok, true);
    assert.match(r.reason, /loopback/);
  }
});

test('allowDashboardConnection: trusted peer passes', () => {
  const r = allowDashboardConnection({
    remoteAddress: '10.0.0.5', nvpnPeers: PEERS, trusted: TRUSTED,
  });
  assert.equal(r.ok, true);
});

test('allowDashboardConnection: untrusted peer is refused with a reason', () => {
  const r = allowDashboardConnection({
    remoteAddress: '10.0.0.6', nvpnPeers: PEERS, trusted: TRUSTED,
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /not in trusted/);
});

test('allowDashboardConnection: unknown peer (not in roster) is refused', () => {
  const r = allowDashboardConnection({
    remoteAddress: '10.0.0.99', nvpnPeers: PEERS, trusted: TRUSTED,
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /no nvpn peer mapped/);
});

test('allowDashboardConnection: empty peers (nvpn down) refuses non-loopback (fail closed)', () => {
  const r = allowDashboardConnection({
    remoteAddress: '10.0.0.5', nvpnPeers: null, trusted: TRUSTED,
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /no nvpn peer mapped/);
});

test('allowDashboardConnection: missing remote address fails closed', () => {
  const r = allowDashboardConnection({
    remoteAddress: undefined, nvpnPeers: PEERS, trusted: TRUSTED,
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /no remote address/);
});

test('allowDashboardConnection: empty trusted set refuses every non-loopback peer', () => {
  // Sanity guard: never silently auto-trust if the allowlist is empty.
  const r = allowDashboardConnection({
    remoteAddress: '10.0.0.5', nvpnPeers: PEERS, trusted: new Set(),
  });
  assert.equal(r.ok, false);
});
