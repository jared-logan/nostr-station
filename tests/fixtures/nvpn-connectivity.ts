// Real nvpn 4.0.48 connectivity shapes (verified against a live box),
// with SYNTHETIC values only — TEST-NET IPs (192.0.2.0/24, 198.51.100.0/24,
// 2001:db8::/32), a placeholder network id, and dummy 64-hex pubkeys.
//
// This is the regression anchor for the Phase-2 Layer-1 analyzers
// (#250 and its followers #251–#254). It deliberately encodes the live
// incident slice: mesh up over LAN while the PUBLIC udp path is blocked,
// a stale `configured_endpoint` on a different subnet (multi-homing), and
// an nvpn-emitted `nat.no_public_mapping` health entry.
//
// ⚠️ Casing is intentionally faithful to nvpn: `doctor` is camelCase
// (`networkId`, `network.primaryIpv4`, `portMapping`, `netcheck`); `status`
// is snake_case (`network_id`, `mesh_ready`, `peer_count`, `tunnel_ip`).
// Do not "normalize" it — the point is to test reads against the real tree.

/** Parsed `nvpn doctor --json`, trimmed to connectivity-relevant fields. */
export const doctorRaw = {
  networkId: 'feedface',
  network: {
    defaultInterface: 'wlp3s0',
    primaryIpv4: '192.0.2.10',
    primaryIpv6: '2001:db8::f',
    gatewayIpv4: '192.0.2.1',
    changedAt: 1700000000,
    captivePortal: false,
  },
  portMapping: {
    upnp:   { state: 'unavailable', detail: 'No response within timeout' },
    natPmp: { state: 'error',       detail: 'socket error' },
    pcp:    { state: 'error',       detail: 'socket error' },
  },
  health: [
    {
      code: 'nat.no_public_mapping',
      severity: 'info',
      summary: 'No active port mapping',
      detail: 'No UPnP/NAT-PMP/PCP mapping is active; inbound public connections may require a relay.',
    },
  ],
  netcheck: {
    checkedAt: 1700000000,
    udp: false,
    ipv4: false,
    ipv6: true,
    captivePortal: false,
    portMapping: {
      upnp:   { state: 'unavailable', detail: 'No response within timeout' },
      natPmp: { state: 'unavailable', detail: 'No response within timeout' },
      pcp:    { state: 'unavailable', detail: 'No response within timeout' },
    },
  },
  bundlePath: null,
} as const;

/** Parsed `nvpn status --json`, trimmed. Note: top-level `node_id` is a
 *  UUID (the local node id), NOT a pubkey — whereas `peers[].node_id` IS a
 *  64-hex pubkey. Same field name, different meaning by location (#259). */
export const statusRaw = {
  status_source: 'daemon',
  network_id: 'feedface',
  node_id: '00000000-0000-4000-8000-000000000000',
  tunnel_ip: '10.44.0.1/32',
  endpoint: '192.0.2.10:51820',
  // Stale: points at a 198.51.100.x (dead) subnet, not the 192.0.2.x the
  // node actually routes through — the #253 multi-homing signal.
  configured_endpoint: '198.51.100.10:51820',
  mesh_ready: true,
  expected_peer_count: 2,
  peer_count: 1,
  peers: [
    { node_id: 'a'.repeat(64), public_key: '', endpoint: 'fips', tunnel_ip: '10.44.0.5/32', timestamp: 1700000000 },
    { node_id: 'b'.repeat(64), public_key: '', endpoint: 'fips', tunnel_ip: '10.44.0.6/32', timestamp: 0 },
  ],
} as const;
