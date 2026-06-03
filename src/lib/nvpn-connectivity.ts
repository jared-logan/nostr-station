// =====================================================================
// Connectivity roll-up — issue #250 (Phase-2 Layer 1, item 1.1)
//
// `analyzeConnectivity()` is a PURE function over the two raw nvpn JSON
// trees (`doctor --json` and `status --json`). It produces a single
// typed report the dashboard can render directly, replacing the one-line
// natWarningFor() banner (#249).
//
// Design note (verified against nvpn 4.0.48 on a live box):
//   • nvpn ALREADY emits structured findings in `doctor.health[]` as
//     { code, severity, summary, detail }. We surface those directly
//     rather than re-deriving them — cheaper, and it avoids guessing.
//   • The two JSON trees use INCONSISTENT casing. `doctor` is camelCase
//     (`networkId`, `network.primaryIpv4`, `portMapping`, `netcheck`);
//     `status` is snake_case (`network_id`, `mesh_ready`, `peer_count`,
//     `tunnel_ip`). Each field below is pinned to its exact home and we
//     never cross them — this is the #259-class trap (assuming a shape
//     nvpn never emits) that we are explicitly guarding against.
//   • `status --json` has NO `netcheck`; udp/ipv4/ipv6 come ONLY from
//     `doctor.netcheck`.
//
// The bespoke, actionable verdicts layer onto this foundation in their
// own PRs and push ADDITIONAL signals into the same `signals` array:
//   1.2 daemon stopped (#251), 1.3 public-UDP nuance (#252),
//   1.4 advertised/primary mismatch (#253), 1.5 port-mapping cause (#254).
// =====================================================================

export type ConnectivityLevel = 'ok' | 'info' | 'warn' | 'error';

export type ConnectivityVerdict =
  | 'reachable'
  | 'reachable_with_caveats'
  | 'unreachable'
  | 'unknown';

/**
 * An inline action the UI can offer alongside a signal. `kind` is a stable
 * machine token the dashboard maps to a button/handler; later Layer-1 items
 * extend the union (e.g. relay guidance in #252/#254).
 */
export interface ConnectivityAction {
  kind:  'start-daemon' | 'setup-relay';
  label: string;
}

export interface ConnectivitySignal {
  /** Stable id, e.g. `health:nat.no_public_mapping` or `daemon.stopped`. */
  id:      string;
  level:   ConnectivityLevel;
  /** Short one-line summary suitable for a card title. */
  title:   string;
  /** Longer explanation, when available. */
  detail?: string;
  /** Provenance — `nvpn-health` = passed through from doctor.health[]. */
  source:  'nvpn-health' | 'analyzer';
  /** Optional inline remediation (e.g. Start the daemon). */
  action?: ConnectivityAction;
}

export interface ConnectivityAnalyzeOpts {
  /**
   * The reconciled daemon-running truth — pass `NvpnStatus.running`, which
   * already folds in the systemctl service state and the 4.x config-snapshot
   * force-flip. `false` ⇒ the daemon isn't running and nothing can connect.
   * Leave `null`/undefined when nvpn isn't installed (so we don't mislabel a
   * not-installed box as "daemon stopped").
   */
  daemonRunning?: boolean | null;
}

export interface ConnectivityContext {
  statusSource:      string | null;
  meshReady:         boolean | null;
  peerCount:         number | null;
  expectedPeerCount: number | null;
  netcheck: {
    udp:           boolean | null;
    ipv4:          boolean | null;
    ipv6:          boolean | null;
    captivePortal: boolean | null;
  } | null;
  primaryIpv4:        string | null;
  defaultInterface:   string | null;
  endpoint:           string | null;
  configuredEndpoint: string | null;
}

export interface ConnectivityReport {
  verdict: ConnectivityVerdict;
  signals: ConnectivitySignal[];
  context: ConnectivityContext;
}

// ── tiny typed accessors (no throw, ever) ────────────────────────────
function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}
function str(v: unknown): string | null { return typeof v === 'string' ? v : null; }
function bool(v: unknown): boolean | null { return typeof v === 'boolean' ? v : null; }
function num(v: unknown): number | null { return typeof v === 'number' ? v : null; }

/**
 * Extract the bare IPv4 host from an `endpoint` string. Handles `ip:port`
 * and a bare `ip`; returns null for IPv6 (`[..]:port`), hostnames, or
 * anything that isn't four dotted octets — we only do the v24 compare for
 * IPv4, where "different /24" is a strong multi-homing signal.
 */
function ipv4Host(endpoint: string | null): string | null {
  if (!endpoint) return null;
  if (endpoint.startsWith('[')) return null;            // IPv6 literal — skip
  const host = endpoint.split(':')[0];                  // strip :port if present
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(host) ? host : null;
}

/** True when two IPv4 addresses share a /24 (first three octets). */
function sameV24(a: string, b: string): boolean {
  const pa = a.split('.').slice(0, 3).join('.');
  const pb = b.split('.').slice(0, 3).join('.');
  return pa === pb;
}

/**
 * True for RFC1918 private IPv4 (10/8, 172.16/12, 192.168/16). Used to gate
 * the endpoint-mismatch warning (#268): a node with a deliberately PUBLIC
 * configured endpoint (VPS / port-forwarded) legitimately differs from its
 * private routing interface — that's not a misconfiguration, so we only flag
 * the mismatch when BOTH addresses are private.
 */
function isRfc1918(ip: string): boolean {
  const o = ip.split('.').map(n => parseInt(n, 10));
  if (o.length !== 4 || o.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  if (o[0] === 10) return true;
  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;
  if (o[0] === 192 && o[1] === 168) return true;
  return false;
}

/**
 * Summarize doctor.portMapping ({ upnp, natPmp, pcp: { state, detail } }).
 * Returns whether ANY protocol secured a mapping plus a human one-liner of
 * the per-protocol results. Null when no protocols are present.
 */
function summarizePortMapping(
  pm: Record<string, unknown> | null,
): { anyActive: boolean; detail: string } | null {
  if (!pm) return null;
  const protos: Array<[string, string]> = [
    ['upnp', 'UPnP'], ['natPmp', 'NAT-PMP'], ['pcp', 'PCP'],
  ];
  let anyActive = false;
  let seen = 0;
  const parts: string[] = [];
  for (const [key, label] of protos) {
    const e = asObj(pm[key]);
    if (!e) continue;
    seen++;
    const state  = str(e.state) || 'unknown';
    const detail = str(e.detail);
    if (/^(active|mapped|ok|success|available|enabled)$/i.test(state)) anyActive = true;
    parts.push(`${label}: ${state}${detail ? ` (${detail})` : ''}`);
  }
  return seen === 0 ? null : { anyActive, detail: parts.join('; ') };
}

/** Map nvpn's `severity` string to our level. nvpn uses "info" today. */
function mapSeverity(sev: string | null): ConnectivityLevel {
  switch ((sev || '').toLowerCase()) {
    case 'error': case 'critical': case 'fatal': return 'error';
    case 'warn':  case 'warning':                return 'warn';
    case 'ok':    case 'good':                   return 'ok';
    default:                                     return 'info';
  }
}

/**
 * Analyze the two raw nvpn JSON trees into one connectivity report.
 *
 * @param doctorRaw `DoctorResult.raw` — the parsed `doctor --json`, or null.
 * @param statusRaw `NvpnStatus.raw`  — the parsed `status --json`, or null.
 */
export function analyzeConnectivity(
  doctorRaw: unknown,
  statusRaw: unknown,
  opts: ConnectivityAnalyzeOpts = {},
): ConnectivityReport {
  const doctor = asObj(doctorRaw);
  const status = asObj(statusRaw);

  const signals: ConnectivitySignal[] = [];

  // (1.2 / #251) Daemon stopped or unreachable — the single most prominent
  // failure, and the one the live incident showed the dashboard hiding
  // (it painted a "joined on its IP" row while the daemon was stopped).
  // Grounded in two confirmed-real signals, no guessing at a daemon.state
  // shape: (a) the reconciled `running` flag the caller passes in, and (b)
  // the documented 4.x config-snapshot fallback — when the CLI can't reach
  // the daemon it returns status_source !== "daemon" with live fields nulled.
  // Either ⇒ nothing is connecting; emit a blocking signal with a Start
  // action and short-circuit the mesh-based verdict to "unreachable". This
  // leads the list so the UI can't render it as a joined row (cf. #255).
  const statusSource = str(status?.status_source);
  const daemonSnapshotFallback = statusSource !== null && statusSource !== 'daemon';
  const daemonDown = opts.daemonRunning === false || daemonSnapshotFallback;
  if (daemonDown) {
    signals.push({
      id:     'daemon.stopped',
      level:  'error',
      title:  'The nvpn daemon is not running — nothing is connecting',
      detail: daemonSnapshotFallback
        ? `nvpn returned a "${statusSource}" snapshot because the daemon is stopped or unreachable from the dashboard process. Start the daemon, then refresh. (If it is running, this is usually a $HOME / --config mismatch between the dashboard user and the daemon.)`
        : 'The nvpn daemon is stopped. Start it, then refresh.',
      source: 'analyzer',
      action: { kind: 'start-daemon', label: 'Start nvpn' },
    });
  }

  // (1.1) Surface nvpn's OWN structured health[] directly. Pinned to
  // doctor.health[] (the camelCase tree); status has no health array.
  const health = doctor?.health;
  if (Array.isArray(health)) {
    for (const raw of health) {
      const e = asObj(raw);
      if (!e) continue;
      const code = str(e.code);
      const summary = str(e.summary);
      signals.push({
        id:     code ? `health:${code}` : 'health:unknown',
        level:  mapSeverity(str(e.severity)),
        title:  summary || code || 'nvpn health signal',
        detail: str(e.detail) || undefined,
        source: 'nvpn-health',
      });
    }
  }

  // Pinned context — read each field from its exact home (see casing note
  // up top). `netcheck`/`network` are doctor-only (camelCase); mesh/peer
  // liveness and endpoints are status-only (snake_case).
  const network  = asObj(doctor?.network);
  const netcheck = asObj(doctor?.netcheck);
  const context: ConnectivityContext = {
    statusSource:      str(status?.status_source),
    meshReady:         bool(status?.mesh_ready),
    peerCount:         num(status?.peer_count),
    expectedPeerCount: num(status?.expected_peer_count),
    netcheck: netcheck
      ? {
          udp:           bool(netcheck.udp),
          ipv4:          bool(netcheck.ipv4),
          ipv6:          bool(netcheck.ipv6),
          captivePortal: bool(netcheck.captivePortal),
        }
      : null,
    primaryIpv4:        str(network?.primaryIpv4),
    defaultInterface:   str(network?.defaultInterface),
    endpoint:           str(status?.endpoint),
    configuredEndpoint: str(status?.configured_endpoint),
  };

  // (1.3 / #252) Public-UDP nuance — the wording the live-box capture
  // corrected. `netcheck.udp === false` means "no public/STUN UDP path got
  // out", NOT "this network blocks WireGuard": a LAN/direct mesh can be fully
  // up alongside it (the fixture proves it — mesh_ready:true + a connected
  // peer with udp:false). So this is an EXPLANATION + relay pointer, never a
  // failure. The roll-up verdict already classifies it as a caveat (1.1);
  // here we just say why and point at Layer 2. Suppressed when the daemon is
  // down — that case has exactly one action (start it), and netcheck may be
  // stale anyway.
  const nc = context.netcheck;
  if (!daemonDown && nc && nc.udp === false) {
    signals.push({
      id:     'net.no_public_udp',
      level:  'warn',
      title:  'No public UDP path — internet peers need a relay',
      detail: 'STUN/UDP to the open internet did not get through on this network, '
            + 'so peers out on the public internet can’t reach this node directly here. '
            + 'A relay (Layer 2) bridges them. Peers on your LAN / this same network still '
            + 'connect directly over UDP — this does not block your local mesh.',
      source: 'analyzer',
      action: { kind: 'setup-relay', label: 'Set up a relay' },
    });
    // IPv6-only is the exact incident state — call it out explicitly so the
    // "udp blocked" reading isn't mistaken for a hard network failure.
    if (nc.ipv4 === false && nc.ipv6 === true) {
      signals.push({
        id:     'net.ipv6_only',
        level:  'info',
        title:  'Only IPv6 reached the internet (IPv4 UDP didn’t get out)',
        detail: 'This network gave us an IPv6 path but no public IPv4 UDP path. Many peers and '
              + 'relays are IPv4-only, which is usually why the public UDP path looks blocked. '
              + 'A relay bridges IPv4-only peers to you.',
        source: 'analyzer',
      });
    }
  }

  // (1.4 / #253) Multi-homing — the net-new detection. On the live box the
  // configured endpoint pointed at a different (dead) subnet than the
  // interface nvpn was actually routing through; peers dialing the advertised
  // address never found the node. Detect subnet(configured_endpoint) ≠
  // subnet(primaryIpv4) on a /24 and word it concretely ("advertising X but
  // routing via Y"), NOT as a generic NAT line. IPv4-only and daemon-up only.
  const cfgHost = ipv4Host(context.configuredEndpoint);
  const primary = context.primaryIpv4;
  if (!daemonDown && cfgHost && primary && ipv4Host(primary)
      && isRfc1918(cfgHost) && isRfc1918(primary)   // #268: skip public endpoints
      && !sameV24(cfgHost, primary)) {
    const iface = context.defaultInterface ? ` (interface ${context.defaultInterface})` : '';
    signals.push({
      id:     'net.endpoint_subnet_mismatch',
      level:  'warn',
      title:  'Advertising an endpoint on a different network than you’re routing through',
      detail: `nvpn’s configured endpoint ${cfgHost} is on a different subnet than the interface this node is actually routing through, ${primary}${iface}. `
            + `Peers dialing the advertised ${cfgHost} won’t find you — it’s likely a stale or disconnected interface. `
            + `Clear or update the configured endpoint so it matches ${primary}.`,
      source: 'analyzer',
    });
  }

  // (1.5 / #254) Turn the vague "STUN may not have succeeded" banner into
  // the actual CAUSE. Two distinct, actionable causes the old one-liner hid:
  //   • captive portal — sign into the network;
  //   • no automatic port forward — the router-side reason there's no public
  //     endpoint, which is why internet peers need the relay #252 points at.
  // Pinned to the camelCase doctor tree (top-level portMapping, netcheck /
  // network captivePortal). Daemon-up only.
  if (!daemonDown) {
    const captive = context.netcheck?.captivePortal === true
      || bool(network?.captivePortal) === true;
    if (captive) {
      signals.push({
        id:     'net.captive_portal',
        level:  'warn',
        title:  'This network requires sign-in (captive portal)',
        detail: 'A captive portal is intercepting traffic on this network. Open a browser, '
              + 'complete the sign-in, then refresh — until then nvpn can’t reach the internet '
              + 'to establish public connectivity.',
        source: 'analyzer',
      });
    }
    // Only meaningful when the public UDP path is actually blocked — when UDP
    // works, hole-punching can succeed without an explicit port mapping, so a
    // missing mapping isn't a problem worth flagging.
    const pm = summarizePortMapping(asObj(doctor?.portMapping));
    if (context.netcheck?.udp === false && pm && !pm.anyActive) {
      signals.push({
        id:     'net.no_port_mapping',
        level:  'info',
        title:  'No automatic port forward — that’s why there’s no public endpoint',
        detail: `Your router granted no UPnP/NAT-PMP/PCP port mapping, so nvpn couldn’t open a `
              + `public inbound port (${pm.detail}). That’s the reason internet peers can’t reach `
              + `you directly here — a relay bridges them.`,
        source: 'analyzer',
      });
    }
  }

  // A down daemon dominates everything else — nothing connects, regardless
  // of stale mesh fields in a config snapshot.
  const verdict = daemonDown ? 'unreachable' : overallVerdict(context, signals);
  return { verdict, signals, context };
}

/**
 * Foundation reachability verdict, derived from the mesh-liveness fields
 * nvpn already exposes plus the severity of surfaced health signals.
 *
 * Key nuance (confirmed on the live box): `netcheck.udp === false` is a
 * PUBLIC-path result only — it coexists with a healthy LAN mesh
 * (`mesh_ready: true` + UDP-reachable peers). So a blocked public UDP path
 * is a *caveat*, never "unreachable". The dedicated #252 verdict explains
 * the public-vs-mesh distinction in words; here it only softens the roll-up.
 */
function overallVerdict(
  ctx: ConnectivityContext,
  signals: ConnectivitySignal[],
): ConnectivityVerdict {
  // No status at all → we genuinely don't know.
  if (ctx.meshReady === null && ctx.statusSource === null) return 'unknown';
  if (ctx.meshReady === false) return 'unreachable';
  if (ctx.meshReady === true) {
    const hasErrorOrWarn = signals.some(s => s.level === 'error' || s.level === 'warn');
    const noPeers    = ctx.peerCount !== null && ctx.peerCount === 0;
    const udpBlocked = ctx.netcheck?.udp === false;
    return (hasErrorOrWarn || noPeers || udpBlocked)
      ? 'reachable_with_caveats'
      : 'reachable';
  }
  return 'unknown';
}
