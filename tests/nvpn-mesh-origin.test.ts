import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeHostAddr, meshHostMatches, meshUrlMatches, allowDashboardConnection,
} from '../src/lib/dashboard-binding.ts';

// Mesh Host/Origin gating. These run ONLY for connections already verified
// as a trusted mesh peer; the matchers pin the accepted Host/Origin to the
// request's real local interface address, so a trusted peer still can't
// inject a foreign Host (rebinding) or cross-origin Origin (CSRF).
// Synthetic mesh-like addresses only.

const PORT = 4500;
const LOCAL = '10.44.0.2';      // the tunnel IP the dashboard is reached on
const PEER  = '10.44.0.9';      // a trusted peer's address

test('normalizeHostAddr: strips brackets + IPv4-mapped IPv6, lowercases', () => {
  assert.equal(normalizeHostAddr('::ffff:10.44.0.2'), '10.44.0.2');
  assert.equal(normalizeHostAddr('[::1]'), '::1');
  assert.equal(normalizeHostAddr('10.44.0.2'), '10.44.0.2');
  assert.equal(normalizeHostAddr(null), '');
});

test('meshHostMatches: accepts the local-interface host:port, rejects foreign', () => {
  assert.equal(meshHostMatches(`${LOCAL}:${PORT}`, LOCAL, PORT), true);
  // dual-stack localAddress (IPv4-mapped) still matches the IPv4 Host header
  assert.equal(meshHostMatches(`${LOCAL}:${PORT}`, `::ffff:${LOCAL}`, PORT), true);
  // foreign host (DNS-rebinding) — refused even though the connection is trusted
  assert.equal(meshHostMatches(`evil.com:${PORT}`, LOCAL, PORT), false);
  // a different mesh IP than the interface we're actually on — refused
  assert.equal(meshHostMatches(`${PEER}:${PORT}`, LOCAL, PORT), false);
  // wrong port
  assert.equal(meshHostMatches(`${LOCAL}:1234`, LOCAL, PORT), false);
  // missing local address → fail closed
  assert.equal(meshHostMatches(`${LOCAL}:${PORT}`, undefined, PORT), false);
});

test('meshUrlMatches: accepts same-interface http/ws origin, rejects cross-origin (CSRF)', () => {
  assert.equal(meshUrlMatches(`http://${LOCAL}:${PORT}`, LOCAL, PORT), true);
  assert.equal(meshUrlMatches(`ws://${LOCAL}:${PORT}`, LOCAL, PORT), true);
  // cross-origin attacker page — refused even on a trusted connection
  assert.equal(meshUrlMatches(`http://evil.com:${PORT}`, LOCAL, PORT), false);
  // https / wrong port / junk
  assert.equal(meshUrlMatches(`https://${LOCAL}:${PORT}`, LOCAL, PORT), false);
  assert.equal(meshUrlMatches(`http://${LOCAL}:9999`, LOCAL, PORT), false);
  assert.equal(meshUrlMatches('not a url', LOCAL, PORT), false);
  assert.equal(meshUrlMatches('', LOCAL, PORT), false);
});

// The trust verdict (reused by the HTTP layer) — a request only gets the
// relaxation when its remote IP maps to a trusted device pubkey.
test('mesh trust: only a roster peer whose pubkey is trusted is allowed', () => {
  const peers = [{ tunnel_ip: PEER, pubkey: 'aa'.repeat(32) }];
  assert.equal(allowDashboardConnection({ remoteAddress: PEER, nvpnPeers: peers, trusted: new Set(['aa'.repeat(32)]) }).ok, true);
  // same peer, pubkey NOT in the trusted set → refused
  assert.equal(allowDashboardConnection({ remoteAddress: PEER, nvpnPeers: peers, trusted: new Set(['bb'.repeat(32)]) }).ok, false);
  // unknown IP (not in roster) → refused (fail closed)
  assert.equal(allowDashboardConnection({ remoteAddress: '10.44.0.99', nvpnPeers: peers, trusted: new Set(['aa'.repeat(32)]) }).ok, false);
});
