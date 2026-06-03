/**
 * Tests for analyzeConnectivity() — the pure connectivity roll-up (#250,
 * Phase-2 Layer-1 item 1.1). Driven entirely by raw nvpn JSON shapes; no
 * daemon, no network. Fixtures are real nvpn 4.0.48 shapes with synthetic
 * values (see tests/fixtures/nvpn-connectivity.ts).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeConnectivity } from '../src/lib/nvpn-connectivity.ts';
import { doctorRaw, statusRaw } from './fixtures/nvpn-connectivity.ts';

// ---------------------------------------------------------------------
// health[] passthrough — the cheap win: surface nvpn's own findings

test('surfaces nvpn doctor.health[] entries directly as signals', () => {
  const { signals } = analyzeConnectivity(doctorRaw, statusRaw);
  const nat = signals.find(s => s.id === 'health:nat.no_public_mapping');
  assert.ok(nat, 'expected the nat.no_public_mapping health entry to be surfaced');
  assert.equal(nat!.source, 'nvpn-health');
  assert.equal(nat!.level, 'info');                  // severity "info" → level "info"
  assert.equal(nat!.title, 'No active port mapping'); // title comes from summary
  assert.match(nat!.detail || '', /relay/);
});

test('maps severities: error/warn/ok/unknown → level', () => {
  const doc = { health: [
    { code: 'a', severity: 'error',   summary: 'A' },
    { code: 'b', severity: 'warning', summary: 'B' },
    { code: 'c', severity: 'ok',      summary: 'C' },
    { code: 'd', severity: 'mystery', summary: 'D' },
    { code: 'e', summary: 'E' },                       // missing severity
  ] };
  const { signals } = analyzeConnectivity(doc, { mesh_ready: true, peer_count: 1 });
  const lvl = (id: string) => signals.find(s => s.id === `health:${id}`)!.level;
  assert.equal(lvl('a'), 'error');
  assert.equal(lvl('b'), 'warn');
  assert.equal(lvl('c'), 'ok');
  assert.equal(lvl('d'), 'info');
  assert.equal(lvl('e'), 'info');
});

// ---------------------------------------------------------------------
// pinned context — each field read from its exact (camel vs snake) home

test('reads context fields from their exact casing locations', () => {
  const { context } = analyzeConnectivity(doctorRaw, statusRaw);
  // doctor (camelCase) tree
  assert.equal(context.netcheck?.udp, false);
  assert.equal(context.netcheck?.ipv4, false);
  assert.equal(context.netcheck?.ipv6, true);
  assert.equal(context.primaryIpv4, '192.0.2.10');
  assert.equal(context.defaultInterface, 'wlp3s0');
  // status (snake_case) tree
  assert.equal(context.meshReady, true);
  assert.equal(context.peerCount, 1);
  assert.equal(context.expectedPeerCount, 2);
  assert.equal(context.statusSource, 'daemon');
  assert.equal(context.endpoint, '192.0.2.10:51820');
  assert.equal(context.configuredEndpoint, '198.51.100.10:51820');
});

test('does not cross casing — udp lives ONLY at doctor.netcheck.udp (#259 guard)', () => {
  // A snake_case `udp` at the doctor root, or a `netcheck` on the status
  // tree, must be ignored — netcheck is doctor-only and camelCase-nested.
  const doctor = { udp: true, netcheck: { udp: false, ipv4: false, ipv6: true } };
  const status = { mesh_ready: true, peer_count: 1, netcheck: { udp: true } };
  const { context } = analyzeConnectivity(doctor, status);
  assert.equal(context.netcheck?.udp, false); // from doctor.netcheck, not the decoys
});

// ---------------------------------------------------------------------
// overall verdict

test('fixture verdict is reachable_with_caveats (mesh up, public UDP blocked)', () => {
  // The live incident slice: mesh_ready + a connected peer, but udp=false.
  // Mesh works over LAN; the blocked public path is a caveat, not failure.
  assert.equal(analyzeConnectivity(doctorRaw, statusRaw).verdict, 'reachable_with_caveats');
});

test('mesh_ready:false → unreachable', () => {
  const { verdict } = analyzeConnectivity(doctorRaw, { ...statusRaw, mesh_ready: false });
  assert.equal(verdict, 'unreachable');
});

test('fully healthy mesh (udp ok, peers, only info health) → reachable', () => {
  const doctor = { health: [{ code: 'x', severity: 'info', summary: 'fyi' }],
                   netcheck: { udp: true, ipv4: true, ipv6: true } };
  const status = { status_source: 'daemon', mesh_ready: true, peer_count: 2 };
  assert.equal(analyzeConnectivity(doctor, status).verdict, 'reachable');
});

test('an error-level health downgrades an otherwise-reachable mesh to caveats', () => {
  const doctor = { health: [{ code: 'boom', severity: 'error', summary: 'bad' }],
                   netcheck: { udp: true, ipv4: true, ipv6: true } };
  const status = { status_source: 'daemon', mesh_ready: true, peer_count: 2 };
  assert.equal(analyzeConnectivity(doctor, status).verdict, 'reachable_with_caveats');
});

test('mesh up but zero peers → caveats even with a clean public path', () => {
  const doctor = { netcheck: { udp: true, ipv4: true, ipv6: true } };
  const status = { status_source: 'daemon', mesh_ready: true, peer_count: 0 };
  assert.equal(analyzeConnectivity(doctor, status).verdict, 'reachable_with_caveats');
});

// ---------------------------------------------------------------------
// (#251) daemon stopped / unreachable — the most prominent failure

test('daemonRunning:false → leading blocking daemon.stopped signal + unreachable', () => {
  const r = analyzeConnectivity(doctorRaw, statusRaw, { daemonRunning: false });
  assert.equal(r.verdict, 'unreachable');
  const d = r.signals[0]; // leads the list so the UI can't paint a joined row
  assert.equal(d.id, 'daemon.stopped');
  assert.equal(d.level, 'error');
  assert.deepEqual(d.action, { kind: 'start-daemon', label: 'Start nvpn' });
  assert.match(d.detail || '', /stopped/);
});

test('config-snapshot fallback (status_source !== "daemon") ⇒ daemon down', () => {
  // The documented 4.x behaviour: CLI can't reach the daemon, returns a
  // "config" snapshot with live fields nulled. No daemonRunning hint needed.
  const r = analyzeConnectivity(null, { status_source: 'config', mesh_ready: null });
  assert.equal(r.verdict, 'unreachable');
  assert.equal(r.signals[0].id, 'daemon.stopped');
  assert.match(r.signals[0].detail || '', /config/);
});

test('daemon up (running true, status_source "daemon") → no daemon.stopped signal', () => {
  const r = analyzeConnectivity(doctorRaw, statusRaw, { daemonRunning: true });
  assert.equal(r.signals.find(s => s.id === 'daemon.stopped'), undefined);
  assert.equal(r.verdict, 'reachable_with_caveats'); // unchanged from 1.1
});

test('not installed (daemonRunning null, no status_source) → not mislabelled as daemon down', () => {
  const r = analyzeConnectivity(null, { mesh_ready: false }, { daemonRunning: null });
  assert.equal(r.signals.find(s => s.id === 'daemon.stopped'), undefined);
});

test('daemon-down dominates a stale mesh_ready:true snapshot', () => {
  // A config snapshot can carry stale mesh_ready:true; daemon-down must win.
  const r = analyzeConnectivity(null, { status_source: 'config', mesh_ready: true, peer_count: 3 });
  assert.equal(r.verdict, 'unreachable');
});

// ---------------------------------------------------------------------
// (#252) public-UDP nuance — the wording IS the deliverable

test('udp:false emits an explanatory no-public-udp signal with a relay pointer', () => {
  const r = analyzeConnectivity(doctorRaw, statusRaw); // fixture: mesh_ready + udp:false
  const s = r.signals.find(x => x.id === 'net.no_public_udp');
  assert.ok(s, 'expected a net.no_public_udp signal');
  assert.deepEqual(s!.action, { kind: 'setup-relay', label: 'Set up a relay' });
  // It must explain (relay bridges; LAN still works), and must NOT frame it
  // as WireGuard/network being blocked or a hard failure.
  assert.match(s!.detail || '', /relay/i);
  assert.match(s!.detail || '', /LAN|local mesh/i);
  assert.doesNotMatch((s!.title + ' ' + s!.detail), /blocks WireGuard|fail|can’t connect|cannot connect/i);
  // Verdict stays a caveat (mesh is up), never unreachable.
  assert.equal(r.verdict, 'reachable_with_caveats');
});

test('ipv4:false ipv6:true is called out explicitly as IPv6-only', () => {
  const r = analyzeConnectivity(doctorRaw, statusRaw); // fixture is ipv4:false ipv6:true
  const s = r.signals.find(x => x.id === 'net.ipv6_only');
  assert.ok(s, 'expected an explicit IPv6-only signal');
  assert.equal(s!.level, 'info');
  assert.match(s!.detail || '', /IPv4-only/i);
});

test('udp:true → no public-udp signals at all', () => {
  const doctor = { netcheck: { udp: true, ipv4: true, ipv6: true } };
  const status = { status_source: 'daemon', mesh_ready: true, peer_count: 1 };
  const ids = analyzeConnectivity(doctor, status).signals.map(s => s.id);
  assert.ok(!ids.includes('net.no_public_udp'));
  assert.ok(!ids.includes('net.ipv6_only'));
});

test('udp:false with IPv4 present → no-public-udp but NOT ipv6-only', () => {
  const doctor = { netcheck: { udp: false, ipv4: true, ipv6: true } };
  const status = { status_source: 'daemon', mesh_ready: true, peer_count: 1 };
  const ids = analyzeConnectivity(doctor, status).signals.map(s => s.id);
  assert.ok(ids.includes('net.no_public_udp'));
  assert.ok(!ids.includes('net.ipv6_only'));
});

test('daemon down suppresses the public-udp signal (one action: start it)', () => {
  const r = analyzeConnectivity(doctorRaw, statusRaw, { daemonRunning: false });
  assert.equal(r.signals.find(s => s.id === 'net.no_public_udp'), undefined);
  assert.equal(r.signals[0].id, 'daemon.stopped');
});

// ---------------------------------------------------------------------
// (#253) multi-homing — configured endpoint on a different network

test('configured_endpoint on a different /24 than primaryIpv4 → mismatch signal', () => {
  // Fixture: configured_endpoint 198.51.100.10 vs primaryIpv4 192.0.2.10.
  const r = analyzeConnectivity(doctorRaw, statusRaw);
  const s = r.signals.find(x => x.id === 'net.endpoint_subnet_mismatch');
  assert.ok(s, 'expected a multi-homing mismatch signal');
  assert.equal(s!.level, 'warn');
  // Concrete "advertising X but routing via Y", with both IPs + the interface.
  assert.match(s!.detail || '', /198\.51\.100\.10/);
  assert.match(s!.detail || '', /192\.0\.2\.10/);
  assert.match(s!.detail || '', /wlp3s0/);
  // Not a generic NAT line.
  assert.doesNotMatch(s!.title + ' ' + s!.detail, /\bNAT\b/);
});

test('configured_endpoint on the SAME /24 as primaryIpv4 → no mismatch', () => {
  const doctor = { network: { primaryIpv4: '192.0.2.10', defaultInterface: 'eth0' } };
  const status = { status_source: 'daemon', mesh_ready: true, peer_count: 1,
                   configured_endpoint: '192.0.2.99:51820' };
  const ids = analyzeConnectivity(doctor, status).signals.map(s => s.id);
  assert.ok(!ids.includes('net.endpoint_subnet_mismatch'));
});

test('IPv6 configured_endpoint is skipped (v24 compare is IPv4-only)', () => {
  const doctor = { network: { primaryIpv4: '192.0.2.10' } };
  const status = { status_source: 'daemon', mesh_ready: true, peer_count: 1,
                   configured_endpoint: '[2001:db8::9]:51820' };
  const ids = analyzeConnectivity(doctor, status).signals.map(s => s.id);
  assert.ok(!ids.includes('net.endpoint_subnet_mismatch'));
});

test('no mismatch when configured_endpoint or primaryIpv4 is absent', () => {
  const onlyPrimary = analyzeConnectivity({ network: { primaryIpv4: '192.0.2.10' } },
    { status_source: 'daemon', mesh_ready: true, peer_count: 1 });
  assert.ok(!onlyPrimary.signals.some(s => s.id === 'net.endpoint_subnet_mismatch'));
  const onlyCfg = analyzeConnectivity(null,
    { status_source: 'daemon', mesh_ready: true, peer_count: 1, configured_endpoint: '198.51.100.10:51820' });
  assert.ok(!onlyCfg.signals.some(s => s.id === 'net.endpoint_subnet_mismatch'));
});

test('daemon down suppresses the mismatch signal too', () => {
  const r = analyzeConnectivity(doctorRaw, statusRaw, { daemonRunning: false });
  assert.ok(!r.signals.some(s => s.id === 'net.endpoint_subnet_mismatch'));
});

// ---------------------------------------------------------------------
// (#254) "STUN failed" → the actual cause (port-mapping / captive portal)

test('fixture (udp:false, no mapping) → net.no_port_mapping enumerating protocols', () => {
  const r = analyzeConnectivity(doctorRaw, statusRaw);
  const s = r.signals.find(x => x.id === 'net.no_port_mapping');
  assert.ok(s, 'expected a no-port-mapping cause signal');
  assert.equal(s!.level, 'info');
  assert.match(s!.detail || '', /UPnP/);
  assert.match(s!.detail || '', /NAT-PMP/);
  assert.match(s!.detail || '', /PCP/);
  // No captive portal in the fixture.
  assert.ok(!r.signals.some(x => x.id === 'net.captive_portal'));
});

test('captivePortal (netcheck) → distinct sign-in signal', () => {
  const doctor = { netcheck: { udp: false, ipv4: false, ipv6: true, captivePortal: true } };
  const status = { status_source: 'daemon', mesh_ready: true, peer_count: 1 };
  const s = analyzeConnectivity(doctor, status).signals.find(x => x.id === 'net.captive_portal');
  assert.ok(s);
  assert.equal(s!.level, 'warn');
  assert.match(s!.detail || '', /sign-in|sign in/i);
});

test('captivePortal can also come from doctor.network', () => {
  const doctor = { network: { captivePortal: true }, netcheck: { udp: true } };
  const status = { status_source: 'daemon', mesh_ready: true, peer_count: 1 };
  assert.ok(analyzeConnectivity(doctor, status).signals.some(x => x.id === 'net.captive_portal'));
});

test('an ACTIVE port mapping suppresses net.no_port_mapping even with udp:false', () => {
  const doctor = { netcheck: { udp: false }, portMapping: { upnp: { state: 'active' }, natPmp: { state: 'error' } } };
  const status = { status_source: 'daemon', mesh_ready: true, peer_count: 1 };
  assert.ok(!analyzeConnectivity(doctor, status).signals.some(x => x.id === 'net.no_port_mapping'));
});

test('no port-mapping signal when udp works (hole-punching is fine without a mapping)', () => {
  const doctor = { netcheck: { udp: true }, portMapping: { upnp: { state: 'error' }, natPmp: { state: 'error' }, pcp: { state: 'error' } } };
  const status = { status_source: 'daemon', mesh_ready: true, peer_count: 1 };
  assert.ok(!analyzeConnectivity(doctor, status).signals.some(x => x.id === 'net.no_port_mapping'));
});

test('daemon down suppresses both 1.5 signals', () => {
  const doctor = { netcheck: { udp: false, captivePortal: true }, portMapping: { upnp: { state: 'error' } } };
  const r = analyzeConnectivity(doctor, { status_source: 'config', mesh_ready: false }, { daemonRunning: false });
  assert.ok(!r.signals.some(x => x.id === 'net.captive_portal'));
  assert.ok(!r.signals.some(x => x.id === 'net.no_port_mapping'));
});

// ---------------------------------------------------------------------
// defensive — never throw on junk / partial input

test('garbage and empty input → unknown, no throw, empty signals', () => {
  for (const bad of [null, undefined, 42, 'nope', [], {}]) {
    const r = analyzeConnectivity(bad, bad);
    assert.equal(r.verdict, 'unknown');
    assert.deepEqual(r.signals, []);
  }
});

test('status present but doctor missing → still classifies from mesh fields', () => {
  assert.equal(analyzeConnectivity(null, { status_source: 'daemon', mesh_ready: true, peer_count: 1 }).verdict, 'reachable');
  assert.equal(analyzeConnectivity(null, { status_source: 'daemon', mesh_ready: false }).verdict, 'unreachable');
});

test('non-array health is ignored rather than throwing', () => {
  const r = analyzeConnectivity({ health: 'not-an-array' }, { mesh_ready: true, peer_count: 1 });
  assert.deepEqual(r.signals, []);
});
