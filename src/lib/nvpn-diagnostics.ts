// nvpn connectivity diagnostics.
//
// Turns "0 online" into a specific, actionable reason. nvpn fails quietly:
// a node on the wrong network, a node with a forked/non-canonical network
// id, a node behind NAT with no relay neighbour, and a healthy-but-lonely
// node all read identically as "0 peers online." This module computes the
// signals that tell those apart — entirely from data we already have
// (status JSON + config.toml + identity), no extra daemon calls — so it's
// safe to run on every panel refresh.
//
// The headline signal is the deterministic tunnel IP. Per nvpn's protocol
// doc — and verified against four live nodes on a real mesh — a node's mesh
// IP is a pure function of (network_id, pubkey):
//
//   digest = SHA256(network_id + "\n" + pubkey_hex)   // pubkey_hex = x-only
//   ip     = 10.44.(digest[0] % 254 + 1).(digest[1] % 254 + 1)
//
// There is no admin-assigned IPAM — every member computes its own IP the
// same way. Two consequences this module leans on:
//
//   1. If a node's live tunnel IP doesn't match the IP computed for its
//      active network, it's running a *different* network than its config
//      claims (the "separate network instead of joining" failure).
//
//   2. The daemon hashes the stored id *literally*. So a non-canonical id
//      that picked up a separator ("abcd-1234" vs "abcd1234") derives a
//      different — wrong — IP and never converges, and two records that
//      canonicalize to the same id are a forked duplicate of one mesh.

import crypto from 'crypto';

// Compute the deterministic mesh IP for (networkId, pubkeyHex), hashing the
// id *literally* (the daemon does the same). Returns null on malformed
// input. Pure. Callers pass the canonical id when they want the *correct*
// IP, or the raw stored id when they want what the daemon actually derived.
export function computeNvpnTunnelIp(networkId: string, pubkeyHex: string): string | null {
  if (!networkId || typeof networkId !== 'string') return null;
  if (!/^[0-9a-fA-F]{64}$/.test(pubkeyHex)) return null;
  const digest = crypto
    .createHash('sha256')
    .update(`${networkId}\n${pubkeyHex.toLowerCase()}`, 'utf8')
    .digest();
  const a = (digest[0] % 254) + 1;
  const b = (digest[1] % 254) + 1;
  return `10.44.${a}.${b}`;
}

// Canonical form of a network id: the separator-free string the daemon
// actually means. Stored ids sometimes carry a hyphen/space ("abcd-1234")
// which the daemon hashes literally, silently yielding the wrong IP. The
// working mesh's ids are bare ("abcd1234"), so stripping hyphens +
// whitespace recovers the canonical form. Case is preserved (ids are
// case-sensitive to the hash).
export function canonicalNetworkId(id: string | null | undefined): string {
  return String(id ?? '').replace(/[\s-]/g, '');
}

export type NvpnDiagLevel = 'ok' | 'info' | 'warn' | 'error';

export interface NvpnFinding {
  id:      string;        // stable key for the UI (dedupe / styling)
  level:   NvpnDiagLevel;
  summary: string;        // one line
  detail:  string;        // the "what do I do" sentence
}

export interface NvpnDiagnosisInput {
  running:                boolean;
  /** network_id of the active (first) [[networks]] block in config.toml. */
  activeNetworkId:        string | null;
  /** network_id the running daemon reports via `status --json` (may be null). */
  daemonNetworkId:        string | null;
  /** Our node's pubkey as 64-char x-only hex (decoded from the identity npub). */
  pubkeyHex:              string | null;
  /** Every configured network, with which one is active. */
  configuredNetworks:     Array<{ networkId: string | null; active: boolean }>;
  /** Live tunnel IP from `status --json` (the interface's actual IP). */
  liveTunnelIp:           string | null;
  rosterParticipantCount: number;
  rosterAdminCount:       number;
  onlineCount:            number;
  /** Advertised WireGuard endpoint (may be an unreachable private address). */
  endpoint:               string | null;
  endpointIsPrivate:      boolean;
  /** How many `[fips_peer_endpoints]` relay peers are statically configured. */
  fipsPeerEndpointCount:  number;
  /** Age (seconds) of an unaccepted outbound join request, when known. */
  pendingJoinAgeSecs:     number | null;
  /** Container/VM runtime, when detected (Docker / OrbStack / LXC / …). */
  containerKind:          string | null;
}

export interface NvpnDiagnosis {
  findings:               NvpnFinding[];
  /** Canonical (separator-free) form of the active network id. */
  canonicalActiveNetworkId: string | null;
  /** Expected mesh IP for the active network (from the canonical id). */
  expectedTunnelIp:       string | null;
  /** Which configured network's *literal* expected IP the live IP matches. */
  liveMatchesNetworkId:   string | null;
  /** Forked duplicates: same canonical id stored under >1 raw id. */
  forked:                 Array<{ canonical: string; ids: string[] }>;
  /** Highest finding level — drives the summary pill. */
  overall:                NvpnDiagLevel;
}

const LEVEL_RANK: Record<NvpnDiagLevel, number> = { ok: 0, info: 1, warn: 2, error: 3 };

function shortId(id: string | null): string {
  if (!id) return '(none)';
  return id.length > 20 ? `${id.slice(0, 10)}…${id.slice(-6)}` : id;
}

function humanAge(secs: number): string {
  if (secs < 90) return `${Math.round(secs)}s`;
  if (secs < 5400) return `${Math.round(secs / 60)}m`;
  return `${Math.round(secs / 3600)}h`;
}

// Pure analyzer. Deterministic given its input so it's fully unit-testable
// without a daemon or config on disk.
export function diagnoseNvpnNetwork(in_: NvpnDiagnosisInput): NvpnDiagnosis {
  const findings: NvpnFinding[] = [];

  const canonActive = in_.activeNetworkId ? canonicalNetworkId(in_.activeNetworkId) : null;
  const expectedTunnelIp =
    canonActive && in_.pubkeyHex ? computeNvpnTunnelIp(canonActive, in_.pubkeyHex) : null;

  // Which configured network does the live IP belong to? Match against each
  // network's *raw* id — that's the string the daemon hashed to produce the
  // live IP, so a hyphenated record is identified correctly.
  let liveMatchesNetworkId: string | null = null;
  if (in_.liveTunnelIp && in_.pubkeyHex) {
    for (const net of in_.configuredNetworks) {
      if (!net.networkId) continue;
      if (computeNvpnTunnelIp(net.networkId, in_.pubkeyHex) === in_.liveTunnelIp) {
        liveMatchesNetworkId = net.networkId;
        break;
      }
    }
  }

  // Forked duplicates: group configured ids by canonical form.
  const byCanon = new Map<string, string[]>();
  for (const net of in_.configuredNetworks) {
    if (!net.networkId) continue;
    const c = canonicalNetworkId(net.networkId);
    if (!byCanon.has(c)) byCanon.set(c, []);
    byCanon.get(c)!.push(net.networkId);
  }
  const forked = [...byCanon.entries()]
    .map(([canonical, ids]) => ({ canonical, ids: [...new Set(ids)] }))
    .filter(g => g.ids.length > 1);

  if (!in_.running) {
    findings.push({
      id:      'not-running',
      level:   'info',
      summary: 'nvpn daemon is not running',
      detail:  'Start the daemon from the status strip above; diagnostics need it live to read the mesh state.',
    });
    return { findings, canonicalActiveNetworkId: canonActive, expectedTunnelIp, liveMatchesNetworkId, forked, overall: 'info' };
  }

  // ── Forked / duplicate network (independent finding) ──────────────
  for (const g of forked) {
    findings.push({
      id:      'forked-network',
      level:   'error',
      summary: `Duplicate copies of one network configured: ${g.ids.map(shortId).join(' + ')}`,
      detail:  `These are the same mesh (canonical "${g.canonical}") stored under different ids — nvpn hashes each literally, so the copies get different mesh IPs and never converge. Keep the canonical (separator-free) id, remove the other [[networks]] block, and restart nvpn.`,
    });
  }

  // ── Network-identity problems (one of these, by priority) ─────────
  if (in_.daemonNetworkId && canonActive && canonicalNetworkId(in_.daemonNetworkId) !== canonActive) {
    findings.push({
      id:      'wrong-network',
      level:   'error',
      summary: `Daemon is on network ${shortId(in_.daemonNetworkId)}, but your active config is ${shortId(in_.activeNetworkId)}`,
      detail:  'The running daemon and your config disagree on which mesh is active. Restart nvpn to pick up the active network, or re-join the intended one with Join by ID using its exact network id.',
    });
  } else if (in_.activeNetworkId && canonActive && in_.activeNetworkId !== canonActive) {
    findings.push({
      id:      'non-canonical-network',
      level:   'error',
      summary: `Active network_id "${in_.activeNetworkId}" contains separators`,
      detail:  `nvpn hashes the id literally, so the separator makes this node derive the wrong mesh IP and never converge. The canonical id is "${canonActive}"${expectedTunnelIp ? ` (correct IP ${expectedTunnelIp})` : ''}. Re-join with the canonical id (Join by ID) or fix the [[networks]] block, then restart nvpn.`,
    });
  } else if (liveMatchesNetworkId && canonActive && canonicalNetworkId(liveMatchesNetworkId) !== canonActive) {
    findings.push({
      id:      'wrong-network-by-ip',
      level:   'error',
      summary: `Your tunnel IP ${in_.liveTunnelIp} belongs to network ${shortId(liveMatchesNetworkId)}, not the active ${shortId(in_.activeNetworkId)}`,
      detail:  'nvpn derives each node\'s mesh IP from its network id, and yours matches a different configured network. You\'re effectively on the wrong mesh — re-join the intended network with Join by ID, then restart nvpn.',
    });
  } else if (in_.liveTunnelIp && expectedTunnelIp && in_.liveTunnelIp !== expectedTunnelIp) {
    findings.push({
      id:      'tunnel-ip-drift',
      level:   'warn',
      summary: `Live tunnel IP ${in_.liveTunnelIp} ≠ the deterministic IP ${expectedTunnelIp} for your active network`,
      detail:  'The interface IP doesn\'t match what your active network id derives to. Restart nvpn so the interface re-derives; if it persists, your stored network_id likely differs from the mesh\'s — re-join with the exact id.',
    });
  }

  // ── Pending join not yet accepted ─────────────────────────────────
  if (in_.pendingJoinAgeSecs != null && in_.pendingJoinAgeSecs >= 0) {
    findings.push({
      id:      'pending-join',
      level:   'info',
      summary: `Outbound join request pending (${humanAge(in_.pendingJoinAgeSecs)})`,
      detail:  'You\'ve asked to join but an admin of that network hasn\'t accepted yet. Until they approve, you won\'t appear in the roster or converge.',
    });
  }

  // ── Lonely / never-joined ─────────────────────────────────────────
  if (in_.rosterParticipantCount <= 1) {
    findings.push({
      id:      'solo-roster',
      level:   'warn',
      summary: 'This mesh has only your node in its roster',
      detail:  'You\'re the sole participant (and admin), so there\'s no one to connect to. If you meant to join an existing network, re-join with its exact id (Join by ID); if you\'re hosting your own mesh, add peers / share an invite.',
    });
  }

  // ── Unreachable behind NAT, no relay neighbour ────────────────────
  if (in_.onlineCount === 0 && (in_.endpointIsPrivate || !in_.endpoint) && in_.fipsPeerEndpointCount === 0) {
    const where = in_.containerKind ? ` (running inside ${in_.containerKind})` : '';
    findings.push({
      id:      'unreachable-no-relay',
      level:   'warn',
      summary: `No reachable endpoint and no relay peer configured${where}`,
      detail:  in_.endpointIsPrivate
        ? `This node advertises a private endpoint (${in_.endpoint}) that peers can't reach, and no FIPS relay peer is configured to bootstrap through. nvpn can relay through any reachable mesh node — point at one of your working machines with a fips peer endpoint, or run a node with a public/forwarded endpoint.`
        : 'No public endpoint was discovered (expected behind NAT) and no FIPS relay peer is configured. nvpn can relay through a reachable mesh node — add one of your working machines as a fips peer endpoint, or run a node with a reachable endpoint.',
    });
  }

  // ── All clear ─────────────────────────────────────────────────────
  if (findings.length === 0) {
    findings.push({
      id:      'healthy',
      level:   'ok',
      summary: in_.onlineCount > 0
        ? `Connected — ${in_.onlineCount} peer${in_.onlineCount === 1 ? '' : 's'} online`
        : 'No connectivity problems detected',
      detail:  'Network id, tunnel IP, roster, and reachability all look consistent.',
    });
  }

  const overall = findings.reduce<NvpnDiagLevel>(
    (acc, f) => (LEVEL_RANK[f.level] > LEVEL_RANK[acc] ? f.level : acc),
    'ok',
  );
  return { findings, canonicalActiveNetworkId: canonActive, expectedTunnelIp, liveMatchesNetworkId, forked, overall };
}
