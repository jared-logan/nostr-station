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
