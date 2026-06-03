// Relay-target eligibility for the "relay via" action (#279). Pure ES module
// shared by app.js and the node tests (single source of truth, no drift —
// same pattern as connectivity-coverage.js).
//
// Why presence recency, not handshake history: pending vs never
// (last_handshake_at) can't separate "off" from "NAT-blocked" — an on-but-
// NAT-blocked peer has never handshaked yet a relay WOULD help it. The
// presence beacon (last_mesh_seen_at) is published while the peer is online,
// independent of the FIPS link, so:
//   recent last_mesh_seen_at + !reachable  ⇒ online but unreachable → relay helps
//   stale / 0 last_mesh_seen_at + !reachable ⇒ offline → relaying is a no-op
//
// Freshness window: mesh refresh is ~20s, so ~60s gives 2–3× headroom before
// we treat a peer as gone.

export const PRESENCE_FRESH_SECS = 60;

/**
 * @param {{reachable?: boolean, lastMeshSeenAt?: number|null}|null|undefined} peer
 *        a MeshPeerHealth entry from /api/nvpn/mesh-health.
 * @param {number} nowSecs current time in SECONDS (Date.now()/1000).
 * @returns {boolean} true when a relay-via action could plausibly help.
 */
export function isRelayTargetEligible(peer, nowSecs) {
  if (!peer || peer.reachable) return false;
  const seen = peer.lastMeshSeenAt;
  if (typeof seen !== 'number' || seen <= 0) return false;   // never/zero ⇒ offline
  return (nowSecs - seen) < PRESENCE_FRESH_SECS;             // recently present ⇒ eligible
}
