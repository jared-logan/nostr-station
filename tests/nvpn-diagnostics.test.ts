import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeNvpnTunnelIp,
  canonicalNetworkId,
  diagnoseNvpnNetwork,
} from '../src/lib/nvpn-diagnostics.ts';

// All identifiers in this file are SYNTHETIC. The IP formula is pure
// SHA256 and doesn't validate its inputs, so fabricated network ids + hex
// exercise the exact same code path as real ones — with zero risk of
// pinning anyone's real mesh inventory into public git history.
const HEX = 'a'.repeat(64);

// ── computeNvpnTunnelIp ────────────────────────────────────────────────

test('computeNvpnTunnelIp: deterministic + well-formed 10.44.x.y', () => {
  const ip = computeNvpnTunnelIp('synthnet01', HEX);
  assert.ok(ip, 'expected an IP');
  assert.equal(ip, computeNvpnTunnelIp('synthnet01', HEX), 'must be deterministic');
  const m = /^10\.44\.(\d+)\.(\d+)$/.exec(ip);
  assert.ok(m, `unexpected shape: ${ip}`);
  for (const oct of [Number(m[1]), Number(m[2])]) {
    assert.ok(oct >= 1 && oct <= 254, `octet out of range: ${oct}`);
  }
});

test('computeNvpnTunnelIp: pinned synthetic vectors (formula regression guard)', () => {
  // Precomputed from SHA256(network_id + "\n" + pubkey_hex). Synthetic
  // inputs, real formula — if these drift, the derivation changed.
  assert.equal(computeNvpnTunnelIp('synthnet01', '11'.repeat(32)), '10.44.165.184');
  assert.equal(computeNvpnTunnelIp('synthnet01', '22'.repeat(32)), '10.44.249.127');
});

test('computeNvpnTunnelIp: different network id generally yields a different IP', () => {
  assert.notEqual(
    computeNvpnTunnelIp('networkone', HEX),
    computeNvpnTunnelIp('networktwo', HEX),
  );
});

test('computeNvpnTunnelIp: case-insensitive on pubkey hex', () => {
  assert.equal(
    computeNvpnTunnelIp('n', 'AB'.repeat(32)),
    computeNvpnTunnelIp('n', 'ab'.repeat(32)),
  );
});

test('computeNvpnTunnelIp: rejects malformed input', () => {
  assert.equal(computeNvpnTunnelIp('', HEX), null);
  assert.equal(computeNvpnTunnelIp('net', 'tooshort'), null);
  assert.equal(computeNvpnTunnelIp('net', 'g'.repeat(64)), null); // non-hex
  assert.equal(computeNvpnTunnelIp('net', ''), null);
});

// ── canonicalNetworkId ─────────────────────────────────────────────────

test('canonicalNetworkId: strips hyphens + whitespace, preserves case', () => {
  assert.equal(canonicalNetworkId('aabb-ccdd'), 'aabbccdd');
  assert.equal(canonicalNetworkId('aa bb cc'), 'aabbcc');
  assert.equal(canonicalNetworkId('AaBb-CcDd'), 'AaBbCcDd');
  assert.equal(canonicalNetworkId('aabbccdd'), 'aabbccdd');
});

test('canonicalNetworkId: a separator makes the daemon derive a different IP', () => {
  // The forked-network bug in one assertion: same canonical mesh, but the
  // hyphenated record hashes to a different (wrong) IP.
  const hex = '33'.repeat(32);
  assert.equal(computeNvpnTunnelIp('aabbccdd', hex), '10.44.68.227');
  assert.equal(computeNvpnTunnelIp('aabb-ccdd', hex), '10.44.154.218');
  assert.notEqual(
    computeNvpnTunnelIp('aabbccdd', hex),
    computeNvpnTunnelIp('aabb-ccdd', hex),
  );
});

// ── diagnoseNvpnNetwork ────────────────────────────────────────────────

function baseInput(over = {}) {
  return {
    running:                true,
    activeNetworkId:        'synthnet01',
    daemonNetworkId:        'synthnet01',
    pubkeyHex:              HEX,
    configuredNetworks:     [{ networkId: 'synthnet01', active: true }],
    liveTunnelIp:           computeNvpnTunnelIp('synthnet01', HEX),
    rosterParticipantCount: 5,
    rosterAdminCount:       1,
    onlineCount:            3,
    endpoint:               '203.0.113.7:51820',
    endpointIsPrivate:      false,
    fipsPeerEndpointCount:  0,
    pendingJoinAgeSecs:     null,
    containerKind:          null,
    managedNpub:            'npub1managed',
    daemonNpub:             'npub1managed',
    ...over,
  };
}

test('diagnose: not running → single info finding, no alarms', () => {
  const d = diagnoseNvpnNetwork(baseInput({ running: false }));
  assert.equal(d.overall, 'info');
  assert.deepEqual(d.findings.map(f => f.id), ['not-running']);
});

test('diagnose: healthy mesh → ok', () => {
  const d = diagnoseNvpnNetwork(baseInput());
  assert.equal(d.overall, 'ok');
  assert.equal(d.findings[0].id, 'healthy');
});

test('diagnose: daemon identity ≠ managed identity → identity-split, outranks network findings', () => {
  const d = diagnoseNvpnNetwork(baseInput({
    managedNpub:     'npub1managed',
    daemonNpub:      'npub1daemonothernode',
    // even with a network mismatch present, identity-split takes over
    daemonNetworkId: 'someothernet',
  }));
  assert.equal(d.identitySplit, true);
  assert.equal(d.overall, 'error');
  assert.equal(d.findings[0].id, 'identity-split');
  // The cross-identity network findings are suppressed (different node).
  assert.equal(d.findings.some(f => f.id === 'wrong-network'), false);
});

test('diagnose: same identity → no identity-split', () => {
  const d = diagnoseNvpnNetwork(baseInput({ managedNpub: 'npub1x', daemonNpub: 'npub1x' }));
  assert.equal(d.identitySplit, false);
});

test('diagnose: daemon identity unknown (null) → no false split', () => {
  // Can't read the daemon's identity (e.g. empty sudo cred cache) → never
  // claim a split we can't prove.
  const d = diagnoseNvpnNetwork(baseInput({ managedNpub: 'npub1x', daemonNpub: null }));
  assert.equal(d.identitySplit, false);
});

test('diagnose: daemon on a different network id → error wrong-network', () => {
  const d = diagnoseNvpnNetwork(baseInput({ daemonNetworkId: 'othernet99' }));
  assert.equal(d.overall, 'error');
  assert.ok(d.findings.some(f => f.id === 'wrong-network'));
});

test('diagnose: non-canonical (hyphenated) active id → error + correct IP shown', () => {
  const hex = '33'.repeat(32);
  const d = diagnoseNvpnNetwork(baseInput({
    activeNetworkId:    'aabb-ccdd',
    daemonNetworkId:    'aabb-ccdd',
    pubkeyHex:          hex,
    configuredNetworks: [{ networkId: 'aabb-ccdd', active: true }],
    liveTunnelIp:       computeNvpnTunnelIp('aabb-ccdd', hex), // wrong IP
  }));
  const f = d.findings.find(x => x.id === 'non-canonical-network');
  assert.ok(f, 'expected non-canonical-network finding');
  assert.equal(d.canonicalActiveNetworkId, 'aabbccdd');
  assert.equal(d.expectedTunnelIp, '10.44.68.227'); // canonical → correct IP
  assert.match(f.detail, /aabbccdd/);
  assert.match(f.detail, /10\.44\.68\.227/);
  assert.equal(d.overall, 'error');
});

test('diagnose: two records that canonicalize equal → forked-network', () => {
  const d = diagnoseNvpnNetwork(baseInput({
    activeNetworkId:    'aabbccdd',
    daemonNetworkId:    'aabbccdd',
    configuredNetworks: [
      { networkId: 'aabbccdd', active: true },
      { networkId: 'aabb-ccdd', active: false },
    ],
  }));
  assert.equal(d.forked.length, 1);
  assert.equal(d.forked[0].canonical, 'aabbccdd');
  assert.ok(d.findings.some(f => f.id === 'forked-network'));
  assert.equal(d.overall, 'error');
});

test('diagnose: live IP matches a different configured network → wrong-network-by-ip', () => {
  const liveTunnelIp = computeNvpnTunnelIp('synthnetb', HEX);
  const d = diagnoseNvpnNetwork(baseInput({
    daemonNetworkId:    null,
    liveTunnelIp,
    configuredNetworks: [
      { networkId: 'synthnet01', active: true },
      { networkId: 'synthnetb', active: false },
    ],
  }));
  assert.equal(d.liveMatchesNetworkId, 'synthnetb');
  assert.ok(d.findings.some(f => f.id === 'wrong-network-by-ip'));
  assert.equal(d.overall, 'error');
});

test('diagnose: live IP correlates to nothing → warn drift, never error', () => {
  const d = diagnoseNvpnNetwork(baseInput({
    daemonNetworkId: null,
    liveTunnelIp:    '10.44.1.1', // won't match synthnet01's computed IP
  }));
  assert.ok(d.findings.some(f => f.id === 'tunnel-ip-drift'));
  assert.notEqual(d.overall, 'error');
});

test('diagnose: solo roster → warn', () => {
  const d = diagnoseNvpnNetwork(baseInput({ rosterParticipantCount: 1, rosterAdminCount: 1, onlineCount: 0 }));
  assert.ok(d.findings.some(f => f.id === 'solo-roster'));
  assert.equal(d.overall, 'warn');
});

test('diagnose: pending join request surfaces an info finding', () => {
  const d = diagnoseNvpnNetwork(baseInput({ pendingJoinAgeSecs: 120 }));
  const f = d.findings.find(x => x.id === 'pending-join');
  assert.ok(f, 'expected pending-join finding');
  assert.equal(f.level, 'info');
});

test('diagnose: behind NAT, private endpoint, no relay peer → warn unreachable-no-relay', () => {
  const d = diagnoseNvpnNetwork(baseInput({
    onlineCount:           0,
    endpoint:              '192.168.50.50:51820',
    endpointIsPrivate:     true,
    fipsPeerEndpointCount: 0,
    containerKind:         'orbstack',
  }));
  const f = d.findings.find(x => x.id === 'unreachable-no-relay');
  assert.ok(f, 'expected unreachable-no-relay finding');
  assert.match(f.detail, /192\.168\.50\.50/);
  assert.match(f.summary, /orbstack/);
});

test('diagnose: configured relay peer suppresses the no-relay warning', () => {
  const d = diagnoseNvpnNetwork(baseInput({
    onlineCount:           0,
    endpoint:              '192.168.50.50:51820',
    endpointIsPrivate:     true,
    fipsPeerEndpointCount: 1,
  }));
  assert.equal(d.findings.some(x => x.id === 'unreachable-no-relay'), false);
});
