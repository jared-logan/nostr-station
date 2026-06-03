// Container / VM runtime detection.
//
// nvpn assumes it's a first-class citizen of the host's network stack.
// When that's not true — Docker, LXC, OrbStack Linux Machine, Kubernetes
// pod — the published endpoint may be a private/container-internal
// address that peers can't reach, even after STUN discovery succeeds.
// We can't fix the topology for the user, but we can surface "you're
// inside a container; expect to set up port-forwarding" guidance instead
// of letting them discover that the hard way.
//
// Detection is best-effort + Linux-only (no procfs on macOS/Windows;
// macOS detection of OrbStack would require different signals and
// nostr-station-on-macOS-in-OrbStack is rare). Return null when nothing
// is detected — the caller treats absence as "bare-metal-ish, proceed."

import fs from 'fs';

export type ContainerKind = 'docker' | 'lxc' | 'kubernetes' | 'orbstack' | 'unknown-container';

export interface ContainerDetection {
  kind:      ContainerKind;
  evidence:  string;     // human-readable: which file / which marker matched
}

// Marker files / cgroup substrings to probe. Order matters: more specific
// runtimes first so we report the most informative kind when several
// match (e.g., kubernetes pods almost always also look like docker).
const CGROUP_MARKERS: Array<{ kind: ContainerKind; needle: string }> = [
  { kind: 'kubernetes',         needle: 'kubepods' },
  { kind: 'docker',             needle: 'docker' },
  { kind: 'lxc',                needle: 'lxc' },
  { kind: 'unknown-container',  needle: 'containerd' },
];

// Quick check for OrbStack-specific artifacts. OrbStack VMs report
// "OrbStack" in /sys/class/dmi/id/product_name or /sys/class/dmi/id/sys_vendor
// on Linux machines. There's also a `zzz-lxc-service.conf` drop-in at
// /run/systemd/system/service.d/ for every service inside an OrbStack
// Linux Machine — a fingerprint the upstream LXC detection misses.
const ORBSTACK_DMI_PATHS = [
  '/sys/class/dmi/id/product_name',
  '/sys/class/dmi/id/sys_vendor',
];

const ORBSTACK_DROPIN = '/run/systemd/system/service.d/zzz-lxc-service.conf';

function readSafe(p: string): string | null {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

export function detectContainer(): ContainerDetection | null {
  // OrbStack first — it sits inside LXC, so the LXC detection below
  // would otherwise mask it. The DMI marker is the most reliable.
  for (const p of ORBSTACK_DMI_PATHS) {
    const txt = readSafe(p);
    if (txt && /orbstack/i.test(txt)) {
      return { kind: 'orbstack', evidence: `${p} contains "OrbStack"` };
    }
  }
  if (readSafe(ORBSTACK_DROPIN) !== null) {
    return { kind: 'orbstack', evidence: `${ORBSTACK_DROPIN} exists (OrbStack systemd drop-in)` };
  }

  const cgroup = readSafe('/proc/1/cgroup');
  if (cgroup) {
    for (const m of CGROUP_MARKERS) {
      if (cgroup.includes(m.needle)) {
        return { kind: m.kind, evidence: `/proc/1/cgroup contains "${m.needle}"` };
      }
    }
  }

  // .dockerenv is the docker-specific marker; presence implies we're
  // inside a container even if the cgroup parse missed (some hardened
  // setups strip cgroup hints).
  if (readSafe('/.dockerenv') !== null) {
    return { kind: 'docker', evidence: '/.dockerenv exists' };
  }

  return null;
}

// Decide whether to surface a NAT/reachability warning given a detection
// + the daemon-discovered public endpoint. Logic:
//
//   * No container detected AND endpoint looks public → no warning.
//   * Container detected → always warn (port-forwarding chain may or may
//     not exist; user needs to verify).
//   * No endpoint discovered → warn ("STUN may not have completed").
//   * Endpoint is RFC1918 / link-local → strong warning (definitely
//     not internet-reachable from that IP).
//
// Pure + exported for tests.

export interface NatWarningInput {
  container:       ContainerDetection | null;
  publicEndpoint:  string | null;
}

export interface NatWarning {
  level:    'info' | 'warn' | 'error';
  summary:  string;
  detail:   string;
}

const PRIVATE_RE = /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[0-1])\.|169\.254\.|127\.)/;

// Is this address (or `ip:port` endpoint) an RFC1918 / link-local /
// loopback address — i.e. not reachable from the public internet?
// Exported so the diagnostics layer can flag a node that's advertising a
// private WireGuard endpoint. Accepts bare IPs or `host:port`.
export function isPrivateEndpoint(endpoint: string | null | undefined): boolean {
  if (!endpoint) return false;
  const ip = String(endpoint).split(':')[0];
  return PRIVATE_RE.test(ip);
}

export function natWarningFor(in_: NatWarningInput): NatWarning | null {
  const ipOnly = in_.publicEndpoint ? in_.publicEndpoint.split(':')[0] : null;

  // Definitely-broken: published endpoint is private. Strong warning,
  // worth surfacing even when no container was detected (could be a
  // misconfigured cloud VM with only an internal IP).
  if (ipOnly && PRIVATE_RE.test(ipOnly)) {
    return {
      level:   'error',
      summary: `Published endpoint ${in_.publicEndpoint} is a private address`,
      detail:  'Peers on the public internet cannot reach this address. STUN probably could not learn a public IP — check the host\'s network configuration or set up an external port-forward chain.',
    };
  }

  if (in_.container) {
    // No public endpoint at all — likely a container behind layers of
    // NAT, and STUN never landed. Worth the loudest non-error level.
    if (!in_.publicEndpoint) {
      return {
        level:   'warn',
        summary: `Running inside ${describeKind(in_.container.kind)} but no public endpoint discovered yet`,
        detail:  'STUN may not have completed, or the container\'s outbound NAT may be blocking UDP. See https://github.com/jared-logan/nostr-station/blob/main/docs/nvpn-deployment.md for the port-forward chain you need to set up.',
      };
    }
    // Have an endpoint, but we're in a container so its reachability
    // through the runtime / host port-forward chain isn't guaranteed.
    return {
      level:   'info',
      summary: `Running inside ${describeKind(in_.container.kind)} — peer reachability depends on your port-forward chain`,
      detail:  `Public endpoint discovered (${in_.publicEndpoint}). Make sure UDP is forwarded from your router → host → container. See https://github.com/jared-logan/nostr-station/blob/main/docs/nvpn-deployment.md for the specifics on ${describeKind(in_.container.kind)}.`,
    };
  }

  return null;
}

function describeKind(k: ContainerKind): string {
  switch (k) {
    case 'docker':            return 'Docker';
    case 'lxc':               return 'LXC';
    case 'kubernetes':        return 'Kubernetes';
    case 'orbstack':          return 'OrbStack';
    case 'unknown-container': return 'a container';
  }
}
