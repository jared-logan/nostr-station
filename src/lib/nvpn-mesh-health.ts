// =====================================================================
// Mesh-peer reachability — issue #256 (Phase-2 Layer-2, item 2.1)
//
// Pure analyzer over `status.daemon.state.peers[]` — the DETAILED per-peer
// shape (verified against nvpn 4.0.x on a live box). Unlike the simplified
// top-level `peers[]` (whose pubkey field SWAPS by status_source, see #266),
// the detailed shape always carries the stable pubkey in `participant_pubkey`
// and the FIPS reachability fields, so it's the right source for "is this
// peer reachable, and is it pathing direct or relayed?".
//
// Field semantics (from the live capture):
//   • participant_pubkey — the stable 64-hex pubkey. `node_id` is "" here;
//     never source the pubkey from it.
//   • reachable          — the headline boolean.
//   • runtime_endpoint   — an ip:port ⇒ DIRECT path; "fips" ⇒ RELAYED;
//                          absent ⇒ no path established yet.
//   • fips_srtt_ms       — round-trip latency (only meaningful when > 0).
//   • last_handshake_at  — null ⇒ never handshook.
//   • error "fips link pending" ⇒ link not up.
//   • fips_transport_type/_addr — present only on a direct path.
//   • fips_endpoint_npub — a per-peer npub; we deliberately do NOT surface it
//     (PII-ish) and never pull a real one into fixtures.
// =====================================================================

export type RelayPath  = 'direct' | 'relayed' | 'none';
export type PeerState  = 'up' | 'pending' | 'never';

export interface MeshPeerHealth {
  /** participant_pubkey, lowercased. Empty string if the daemon omitted it. */
  pubkey:          string;
  /** Bare tunnel IP (CIDR stripped). */
  tunnelIp:        string | null;
  reachable:       boolean;
  /** direct (ip:port runtime endpoint) / relayed ("fips") / none (no path). */
  path:            RelayPath;
  /** fips_srtt_ms when it's a positive measurement, else null. */
  latencyMs:       number | null;
  /** null ⇒ never handshook. */
  lastHandshakeAt: number | null;
  /** up = reachable; pending = down but handshook before; never = no handshake. */
  state:           PeerState;
  /** fips_transport_type — only set on a direct path. */
  transportType:   string | null;
  /** Daemon-reported error (e.g. "fips link pending"), or null. */
  detail:          string | null;
}

export interface MeshHealthReport {
  peers: MeshPeerHealth[];
  counts: {
    total:       number;
    reachable:   number;
    direct:      number;
    relayed:     number;
    unreachable: number;
  };
}

function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function str(v: unknown): string | null { return typeof v === 'string' ? v : null; }
function num(v: unknown): number | null { return typeof v === 'number' ? v : null; }

/** Pick the 64-hex pubkey, preferring participant_pubkey (stable in this
 *  detailed shape); never node_id, which is "" here. */
function peerPubkey(p: Record<string, unknown>): string {
  for (const c of [p.participant_pubkey, p.public_key]) {
    if (typeof c === 'string' && /^[0-9a-f]{64}$/i.test(c)) return c.toLowerCase();
  }
  const pk = str(p.participant_pubkey);
  return pk ? pk.toLowerCase() : '';
}

function pathOf(runtimeEndpoint: string | null): RelayPath {
  if (!runtimeEndpoint) return 'none';      // no path established yet
  if (runtimeEndpoint === 'fips') return 'relayed';
  return 'direct';                          // an ip:port runtime endpoint
}

/**
 * Analyze `status.daemon.state.peers[]` into a per-peer reachability report.
 * @param peersRaw the detailed peers array (or anything — guarded).
 */
export function analyzeMeshPeers(peersRaw: unknown): MeshHealthReport {
  const list = Array.isArray(peersRaw) ? peersRaw : [];
  const peers: MeshPeerHealth[] = [];
  for (const raw of list) {
    const p = asObj(raw);
    if (!p) continue;
    const reachable = p.reachable === true;
    const lastHandshakeAt = num(p.last_handshake_at);
    const srtt = num(p.fips_srtt_ms);
    const tunnelRaw = str(p.tunnel_ip);
    const path = pathOf(str(p.runtime_endpoint));
    const state: PeerState = reachable ? 'up' : (lastHandshakeAt == null ? 'never' : 'pending');
    peers.push({
      pubkey:          peerPubkey(p),
      tunnelIp:        tunnelRaw ? tunnelRaw.split('/')[0] : null,
      reachable,
      path,
      latencyMs:       srtt != null && srtt > 0 ? srtt : null,
      lastHandshakeAt,
      state,
      transportType:   path === 'direct' ? str(p.fips_transport_type) : null,
      detail:          str(p.error),
    });
  }
  const counts = {
    total:       peers.length,
    reachable:   peers.filter(p => p.reachable).length,
    direct:      peers.filter(p => p.path === 'direct').length,
    relayed:     peers.filter(p => p.path === 'relayed').length,
    unreachable: peers.filter(p => !p.reachable).length,
  };
  return { peers, counts };
}
