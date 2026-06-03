/**
 * Dashboard binding policy + peer-pubkey filter.
 *
 * Encodes the security rules the plan documented for dashboard
 * reachability:
 *
 *   1. Loopback connections (127.0.0.1 / ::1) are ALWAYS allowed.
 *      The dashboard owner's own browser, the `nostr-station status`
 *      CLI, and tests all reach the server via loopback. Filtering
 *      loopback would brick everything.
 *
 *   2. Non-loopback connections are gated by an application-layer
 *      pubkey filter. The source IP is mapped to a pubkey via the
 *      live nvpn peer roster; only pubkeys in the trusted-devices
 *      allowlist proceed. Everyone else: socket destroyed pre-HTTP
 *      so no response is leaked.
 *
 *   3. The trusted-devices allowlist defaults to JUST the dashboard
 *      owner's pubkey. The user's phone + laptop both pair with the
 *      same NIP-46 bunker (existing nostr-station pattern), so they
 *      share that pubkey and both get through. The Mobile Access UI
 *      (separate commit) can expand the allowlist later.
 *
 *   4. The filter is HARMLESS when the dashboard is bound to
 *      loopback only — loopback connections always pass, and there
 *      are no non-loopback connections to filter. Activating Mobile
 *      Access (which binds to the nvpn tunnel IP) is what makes
 *      the filter functionally relevant.
 *
 * Defense in depth: the NIP-98 owner-auth gate still runs after this
 * filter. Even if a bug let an unauthorized peer past the connection
 * filter, they still couldn't authenticate. Two independent checks.
 */

import type { Socket } from 'node:net';
import { probeNvpnStatus } from './nvpn.js';
import { readIdentity, npubToHex } from './identity.js';
import { readTrustedDevices } from './trusted-devices.js';

// =====================================================================
// Loopback classification

/**
 * Cheap, allocation-free loopback check. Handles every form Node's
 * `socket.remoteAddress` reports:
 *   - IPv4:        '127.x.x.x'
 *   - IPv6:        '::1'
 *   - IPv6-mapped: '::ffff:127.x.x.x'  (dual-stack listeners)
 *   - undefined:   torn-down socket; treat as not-loopback (fail closed)
 */
export function isLoopbackAddress(ip: string | undefined | null): boolean {
  if (!ip) return false;
  if (ip === '::1') return true;
  if (ip.startsWith('::ffff:127.')) return true;
  if (ip.startsWith('127.')) return true;
  return false;
}

// Normalize an address for comparison: lowercase, strip IPv6 brackets, and
// collapse an IPv4-mapped IPv6 form (`::ffff:10.44.x.y`) to plain IPv4 so a
// dual-stack `socket.localAddress` compares equal to the IPv4 Host header.
export function normalizeHostAddr(a: string | undefined | null): string {
  if (!a) return '';
  return String(a).toLowerCase().trim().replace(/^\[|\]$/g, '').replace(/^::ffff:/, '');
}

// Mesh Host/Origin gating (used ONLY for connections already verified as a
// trusted mesh peer). The accepted Host/Origin is pinned to the request's
// actual local interface address (the tunnel IP the connection arrived on)
// + the bound port — so even a trusted peer can't inject a foreign Host
// (DNS-rebinding) or a cross-origin Origin (CSRF); both must equal the real
// interface the dashboard is being reached on. Pure — unit-tested.
export function meshHostMatches(
  hostHeader: string | undefined | null,
  localAddress: string | undefined | null,
  port: number,
): boolean {
  const want = normalizeHostAddr(localAddress);
  if (!want) return false;
  return normalizeHostAddr(hostHeader) === `${want}:${port}`;
}

export function meshUrlMatches(
  urlStr: string | undefined | null,
  localAddress: string | undefined | null,
  port: number,
): boolean {
  if (!urlStr) return false;
  const want = normalizeHostAddr(localAddress);
  if (!want) return false;
  try {
    const u = new URL(urlStr);
    if (u.protocol !== 'http:' && u.protocol !== 'ws:') return false;
    if (u.port !== String(port)) return false;
    return normalizeHostAddr(u.hostname) === want;
  } catch { return false; }
}

// =====================================================================
// Peer-IP → pubkey lookup

/**
 * Lookup table of "the IPs that map to a known nvpn peer pubkey".
 * Built from `nvpn status --json`'s `peers` array. The real nvpn 4.x peer
 * shape is:
 *   { node_id: "<64-hex pubkey>", public_key: "" (empty for ALL peers),
 *     endpoint, tunnel_ip: "10.44.x.y/32", timestamp }
 * so two things bite: (1) `tunnel_ip` carries a `/32` and won't equal a bare
 * remoteAddress, and (2) the pubkey is in `node_id`, NOT `public_key`. We read
 * `node_id` first and strip the CIDR before comparing, keeping older field
 * names as fallbacks for forward/backward compat. Returns `null` for IPs we
 * can't resolve; the gate treats `null` as "not trusted" (fail closed).
 *
 * Exported as a pure function over the raw nvpn JSON so tests can
 * drive it without spawning nvpn — see tests/dashboard-binding.test.ts.
 */
export function peerPubkeyForIp(
  peers: unknown,
  ip: string,
): string | null {
  if (!Array.isArray(peers)) return null;
  for (const raw of peers) {
    if (!raw || typeof raw !== 'object') continue;
    const p = raw as Record<string, unknown>;
    // Address field — nvpn variants seen: `tunnel_ip`, `ip`, `address`.
    const peerIp = (
      (typeof p.tunnel_ip === 'string' && p.tunnel_ip) ||
      (typeof p.ip        === 'string' && p.ip) ||
      (typeof p.address   === 'string' && p.address) ||
      null
    );
    if (!peerIp) continue;
    // tunnel_ip carries a CIDR suffix in nvpn 4.x (e.g. "10.44.0.5/32");
    // compare the bare address against the socket remoteAddress.
    if (peerIp.split('/')[0] !== ip) continue;
    // Pubkey field — nvpn 4.x puts the 64-hex pubkey in `node_id` (and leaves
    // `public_key` EMPTY for every peer). Older variants: `pubkey`/`npub_hex`/
    // `hex`. Empty strings are falsy here, so an empty `public_key` is skipped.
    const pubkey = (
      (typeof p.node_id    === 'string' && p.node_id)    ||
      (typeof p.pubkey     === 'string' && p.pubkey)     ||
      (typeof p.public_key === 'string' && p.public_key) ||
      (typeof p.npub_hex   === 'string' && p.npub_hex)   ||
      (typeof p.hex        === 'string' && p.hex)        ||
      null
    );
    return pubkey ? pubkey.toLowerCase() : null;
  }
  return null;
}

// =====================================================================
// Trusted-devices allowlist
//
// v1 contains exactly one pubkey: the dashboard owner's. The user's
// phone + laptop share that pubkey via NIP-46. A future commit can
// extend this to a configurable list (e.g. for households where a
// spouse needs dashboard access).

let cachedOwnerHex: string | null = null;
let cachedOwnerAt: number = 0;
const OWNER_CACHE_TTL_MS = 30_000;

function ownerPubkeyHex(): string | null {
  // Light-touch cache — identity.json rarely changes at runtime, and
  // we'd rather not re-read it per incoming connection on a burst.
  const now = Date.now();
  if (cachedOwnerHex !== null && (now - cachedOwnerAt) < OWNER_CACHE_TTL_MS) {
    return cachedOwnerHex;
  }
  const ident = readIdentity();
  const raw = (ident?.npub || '').toString().trim();
  if (!raw) { cachedOwnerHex = null; cachedOwnerAt = now; return null; }
  if (/^[0-9a-f]{64}$/i.test(raw)) {
    cachedOwnerHex = raw.toLowerCase();
  } else if (raw.startsWith('npub1')) {
    try { cachedOwnerHex = npubToHex(raw).toLowerCase(); }
    catch { cachedOwnerHex = null; }
  } else {
    cachedOwnerHex = null;
  }
  cachedOwnerAt = now;
  return cachedOwnerHex;
}

/**
 * Set of pubkeys (hex, lowercase) that are allowed to reach the
 * dashboard via non-loopback interfaces. v1: just the owner.
 * Exported so the Mobile Access route can extend the set without
 * reaching into module-private state when it lands.
 */
export function trustedDevicePubkeys(): Set<string> {
  const out = new Set<string>();
  const owner = ownerPubkeyHex();
  if (owner) out.add(owner);
  // Plus any device the owner has explicitly added to the allowlist (already
  // validated + canonical hex). The owner is always trusted regardless, so
  // the user can never lock their own devices out by editing the list.
  for (const pk of readTrustedDevices().pubkeys) out.add(pk);
  return out;
}

// Test-only: bust the owner cache between assertions.
export function _resetDashboardBindingCacheForTests(): void {
  cachedOwnerHex = null;
  cachedOwnerAt  = 0;
}

// =====================================================================
// The gate

export interface AllowResult {
  ok:     boolean;
  /** Brief reason — surfaced to a debug log when DEBUG=dashboard-binding
   *  is set. Never sent to the rejected client. */
  reason: string;
}

/**
 * Decide whether to allow an inbound dashboard connection. Pure over
 * its inputs so tests can drive every branch without a real socket.
 * `nvpnPeers` is the raw `peers` field from `nvpn status --json`
 * (defensively shaped — `peerPubkeyForIp` handles unknown layouts).
 */
export function allowDashboardConnection(opts: {
  remoteAddress: string | undefined;
  nvpnPeers:     unknown;
  trusted:       Set<string>;
}): AllowResult {
  const { remoteAddress, nvpnPeers, trusted } = opts;

  if (isLoopbackAddress(remoteAddress)) {
    return { ok: true, reason: 'loopback' };
  }
  if (!remoteAddress) {
    // No remote address: socket is mid-teardown or we got an unusual
    // event. Fail closed.
    return { ok: false, reason: 'no remote address' };
  }
  const pubkey = peerPubkeyForIp(nvpnPeers, remoteAddress);
  if (!pubkey) {
    return { ok: false, reason: `no nvpn peer mapped to ${remoteAddress}` };
  }
  if (!trusted.has(pubkey)) {
    return { ok: false, reason: `peer ${pubkey.slice(0, 8)}… not in trusted devices` };
  }
  return { ok: true, reason: `peer ${pubkey.slice(0, 8)}…` };
}

/**
 * Attach the connection filter to an `http.Server`. Hooks the
 * underlying `net.Server`'s 'connection' event so a refused socket
 * is destroyed BEFORE the HTTP parser sees a byte — the rejected
 * peer gets a TCP-level close with no HTTP response surface.
 *
 * Lazy peer-lookup: probeNvpnStatus() is async + cached (SWR), so
 * the per-connection cost is one cache hit in the common case.
 * Loopback connections short-circuit without touching nvpn.
 */
export function attachDashboardBindingFilter(
  server: { on(event: 'connection', handler: (socket: Socket) => void): unknown },
): void {
  server.on('connection', async (socket: Socket) => {
    const remote = socket.remoteAddress;

    // Loopback short-circuit: zero-cost, runs before any nvpn probe.
    if (isLoopbackAddress(remote)) return;

    // Non-loopback: resolve peer pubkey + check allowlist. Any error
    // (nvpn down, probe timeout) falls through to a `null` peers
    // array via the empty-status path — which causes the gate to
    // refuse (fail closed). That's the correct behavior: if we
    // can't verify a peer, we don't trust them.
    let peers: unknown = null;
    try {
      const st = await probeNvpnStatus();
      peers = (st.raw as Record<string, unknown> | null)?.peers ?? null;
    } catch { /* peers stays null → fail closed */ }

    const trusted = trustedDevicePubkeys();
    const verdict = allowDashboardConnection({
      remoteAddress: remote,
      nvpnPeers:     peers,
      trusted,
    });
    if (!verdict.ok) {
      if (process.env.DEBUG === 'dashboard-binding') {
        // eslint-disable-next-line no-console
        console.warn(`[dashboard-binding] refused ${remote}: ${verdict.reason}`);
      }
      try { socket.destroy(); } catch { /* already dead */ }
    }
  });
}
