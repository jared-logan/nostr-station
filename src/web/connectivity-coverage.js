// Pure banner-coverage logic for the Connectivity panel (#255 / #272).
// Extracted from app.js so it can be unit-tested in node (app.js itself is
// DOM-coupled). app.js imports this — single source of truth, no drift.
//
// "Coverage" = which legacy one-liner banner the Connectivity panel is already
// surfacing, so that banner can step aside (#255 option 3). Each hide is gated
// on the panel ACTUALLY showing that banner's concern; a missing/unknown
// report covers nothing, so the banners fall back.

// Signal ids that cover the natWarning/STUN one-liner's concern.
export const CONN_NAT_IDS = [
  'net.no_public_udp',
  'net.no_port_mapping',
  'net.endpoint_subnet_mismatch',
];

/**
 * @param {{verdict?: string, signals?: Array<{id?: string}>, doctorOk?: boolean}|null|undefined} report
 *        the /api/nvpn/connectivity report.
 * @returns {{hidesNat: boolean, hidesStale: boolean}}
 */
export function connectivityBannerCoverage(report) {
  const verdict = report && typeof report.verdict === 'string' ? report.verdict : 'unknown';
  // No report / nothing to say → cover nothing (banners fall back).
  if (!report || verdict === 'unknown') return { hidesNat: false, hidesStale: false };

  const signals = Array.isArray(report.signals) ? report.signals : [];
  const ids = new Set(signals.map(s => s && s.id));

  const hidesNat = CONN_NAT_IDS.some(id => ids.has(id));
  const hidesStale = ids.has('daemon.stopped')
    || (!!report.doctorOk && (verdict === 'reachable' || verdict === 'reachable_with_caveats'));

  return { hidesNat, hidesStale };
}
