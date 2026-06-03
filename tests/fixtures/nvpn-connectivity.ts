// Real nvpn 4.0.48 connectivity shapes (verified against a live box),
// with SYNTHETIC values only — RFC1918 private ranges for the routing
// interface / endpoints (10.8.0.0/24 routing, 192.168.50.0/24 stale
// advertised — faithful to the incident, which was private↔private), plus
// doc ranges elsewhere (2001:db8::/32), a placeholder network id, and dummy
// 64-hex pubkeys.
//
// This is the regression anchor for the Phase-2 Layer-1 analyzers
// (#250 and its followers #251–#254, #267, #268). It deliberately encodes
// the live incident slice: mesh up over LAN while the PUBLIC udp path is
// blocked, a stale `configured_endpoint` on a different PRIVATE subnet than
// the routing interface (multi-homing — #268 only flags private↔private),
// and an nvpn-emitted `nat.no_public_mapping` health entry.
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
    primaryIpv4: '10.8.0.5',
    primaryIpv6: '2001:db8::f',
    gatewayIpv4: '10.8.0.1',
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
  endpoint: '10.8.0.5:51820',
  // Stale: points at a 192.168.50.x (dead) subnet, not the 10.8.0.x the node
  // actually routes through — the #253 multi-homing signal. Both private, so
  // #268's RFC1918 gate still flags it.
  configured_endpoint: '192.168.50.10:51820',
  mesh_ready: true,
  expected_peer_count: 2,
  peer_count: 1,
  peers: [
    { node_id: 'a'.repeat(64), public_key: '', endpoint: 'fips', tunnel_ip: '10.44.0.5/32', timestamp: 1700000000 },
    { node_id: 'b'.repeat(64), public_key: '', endpoint: 'fips', tunnel_ip: '10.44.0.6/32', timestamp: 0 },
  ],
} as const;

/**
 * Parsed `nvpn status --json` with the daemon DOWN — HW-verified shape (#267).
 * Note two #259-class twists: status_source flips to "config", `daemon.state`
 * is null, and the top-level peers[] SWAPS — `node_id` becomes a magic-DNS
 * name and the 64-hex pubkey moves to `public_key` (the inverse of the
 * daemon-up shape above). Drives the #251 daemon-down regression and the
 * #266 peerPubkeyForIp swap-hardening.
 */
export const statusDownRaw = {
  status_source: 'config',
  network_id: 'feedface',
  node_id: '00000000-0000-4000-8000-000000000000',
  tunnel_ip: '10.44.0.1/32',
  endpoint: '10.8.0.5:51820',
  daemon: { running: false, pid: null, state: null },
  expected_peer_count: 5,
  peer_count: 0,
  mesh_ready: false,
  peers: [
    { node_id: 'peer-a.nvpn', public_key: 'a'.repeat(64), endpoint: 'fips', tunnel_ip: '10.44.0.5/32', timestamp: 0 },
  ],
} as const;
