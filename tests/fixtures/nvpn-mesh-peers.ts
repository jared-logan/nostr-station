// Ground-truth `status.daemon.state.peers[]` — real nvpn 4.0.x detailed shape
// (sanitized from a live running-daemon capture), SYNTHETIC values only:
// dummy 64-hex pubkeys, TEST-NET / RFC1918 endpoints, no real npub. Covers the
// full reachability spectrum so #256–#258 can anchor on it.
//
// `participant_pubkey` is the stable pubkey here (always populated, unlike the
// top-level peers[] swap); `node_id` is "" — never source the pubkey from it.
// `fips_endpoint_npub` is intentionally omitted (PII-ish — don't bake a real
// one into a fixture).

export const daemonStatePeers = [
  // 1) reachable, DIRECT UDP
  {
    participant_pubkey: 'a'.repeat(64), node_id: '', tunnel_ip: '10.44.0.5/32', endpoint: 'fips',
    runtime_endpoint: '192.0.2.20:51820', fips_transport_addr: '192.0.2.20:51820', fips_transport_type: 'udp',
    fips_srtt_ms: 8, fips_packets_sent: 4020, fips_packets_recv: 4870, fips_bytes_sent: 927308, fips_bytes_recv: 2824709,
    tx_bytes: 5310842, rx_bytes: 15684156, public_key: '', advertised_routes: [],
    last_mesh_seen_at: 1700000400, last_fips_seen_at: 1700000400, reachable: true, last_handshake_at: 1700000400, error: null,
  },
  // 2) reachable, RELAYED (runtime_endpoint "fips", no transport addr, srtt 0)
  {
    participant_pubkey: 'b'.repeat(64), node_id: '', tunnel_ip: '10.44.0.6/32', endpoint: 'fips',
    runtime_endpoint: 'fips', fips_srtt_ms: 0, tx_bytes: 6443344, rx_bytes: 542324, public_key: '', advertised_routes: [],
    last_mesh_seen_at: 1700000390, last_fips_seen_at: 1700000390, reachable: true, last_handshake_at: 1700000390, error: null,
  },
  // 3) UNREACHABLE — "fips link pending", some activity + a stale handshake
  {
    participant_pubkey: 'c'.repeat(64), node_id: '', tunnel_ip: '10.44.0.7/32', endpoint: 'fips',
    fips_srtt_ms: 4, tx_bytes: 486421, rx_bytes: 10057, public_key: '', advertised_routes: [],
    last_mesh_seen_at: 1700000350, last_fips_seen_at: 1700000350, reachable: false, last_handshake_at: 1700000350, error: 'fips link pending',
  },
  // 4) UNREACHABLE — never established (no fips activity, null handshake)
  {
    participant_pubkey: 'd'.repeat(64), node_id: '', tunnel_ip: '10.44.0.8/32', endpoint: 'fips',
    tx_bytes: 312144, rx_bytes: 0, public_key: '', advertised_routes: [],
    last_mesh_seen_at: 0, last_fips_seen_at: null, reachable: false, last_handshake_at: null, error: 'fips link pending',
  },
] as const;
