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
  kind:  'start-daemon';
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
