import { execSync } from 'child_process';
import fs from 'fs';
import { hasBin } from './detect.js';

export interface CheckResult {
  label: string;
  ok: boolean;
  detail?: string;
}

function cmd(c: string, timeoutMs = 2000): boolean {
  try { execSync(c, { stdio: 'pipe', timeout: timeoutMs, killSignal: 'SIGKILL' }); return true; }
  catch { return false; }
}

function cmdOut(c: string, timeoutMs = 2000): string | null {
  try {
    return execSync(c, {
      stdio: 'pipe', timeout: timeoutMs, killSignal: 'SIGKILL',
    }).toString().trim();
  } catch { return null; }
}

// Is the nvpn daemon running? Distinct from "is the mesh tunnel connected"
// (see getMeshIp) — a daemon can be up and idle with no peers, and we don't
// want doctor to flag that as a failure.
//
// The probe is nvpn's own `status --json`, which reports `daemon.running`
// regardless of install style. Earlier platform-specific checks
// (`systemctl is-active nvpn`, `launchctl list | grep nostr-vpn`) assumed
// nvpn was always managed by the init system's service supervisor, but
// homebrew installs and `nvpn start --daemon` both run outside those
// frameworks — producing a false ✗ for every user who didn't run
// `sudo nvpn service install`. `nvpn status --json` is cross-platform and
// authoritative.
function isNvpnDaemonActive(): boolean {
  try {
    const out = execSync('nvpn status --json', {
      stdio: 'pipe', timeout: 2000, killSignal: 'SIGKILL',
    }).toString();
    return Boolean(JSON.parse(out)?.daemon?.running);
  } catch {
    return false;
  }
}

// Inputs for the pure container-mode check function. Tests inject these
// directly so we don't spawn anything; gathering happens in the I/O wrapper
// (runChecks below). Mirrors the shape of ContainerStatusInputs in Status.tsx
// so the two surfaces stay aligned.
export interface ContainerCheckInputs {
  relayUp:        boolean;
  nip11Ok:        boolean;
  heartbeatMtime: number | null;  // ms epoch, null if file missing
  now:            number;          // ms epoch, injected for testability
  relayHost:      string;
  relayPort:      number;
  binaries: {
    ngit:   string | null;
    claude: string | null;
    nak:    string | null;
    stacks: string | null;
  };
}

const HEARTBEAT_FRESH_MS = 10 * 60 * 1000;

// Pure function — no I/O, fully testable. The host-mode runChecks() does
// its own probes inline (mirrors what was there before container-mode was
// introduced); container mode goes through this so we can pin every branch
// in tests without spawning anything.
export function runChecksContainer(p: ContainerCheckInputs): CheckResult[] {
  const watchdogOk = p.heartbeatMtime !== null
    && (p.now - p.heartbeatMtime) <= HEARTBEAT_FRESH_MS;

  const present = (s: string | null) => !!s && s.trim().length > 0;

  return [
    { label: `Relay (${p.relayHost}:${p.relayPort})`, ok: p.relayUp },
    { label: 'Watchdog heartbeat',                    ok: watchdogOk },
    { label: 'ngit binary',                           ok: present(p.binaries.ngit) },
    { label: 'claude-code binary',                    ok: present(p.binaries.claude) },
    { label: 'nak binary',                            ok: present(p.binaries.nak) },
    { label: 'stacks binary',                         ok: present(p.binaries.stacks) },
    { label: 'Relay NIP-11 response',                 ok: p.nip11Ok },
  ];
}

export function runChecks(): CheckResult[] {
  // Container mode: the relay binary lives in a sibling container and nvpn
  // isn't supportable inside an unprivileged container, so the host-OS
  // probes below would produce false failures. Mirror what gatherStatus()
  // does in Status.tsx — env-driven probes against the compose-managed
  // services and `<tool> --version` for the dev tools baked into the image.
  if (process.env.STATION_MODE === 'container') {
    const relayHost = process.env.RELAY_HOST || 'localhost';
    const relayPort = Number(process.env.RELAY_PORT || '8080');
    const heartbeatPath = process.env.WATCHDOG_HEARTBEAT
      || '/var/run/nostr-station/watchdog.heartbeat';
    let heartbeatMtime: number | null = null;
    try { heartbeatMtime = fs.statSync(heartbeatPath).mtimeMs; } catch {}

    return runChecksContainer({
      relayUp: cmd(`nc -z -w 1 ${relayHost} ${relayPort}`, 1500),
      nip11Ok: cmd(
        `curl -sf -H 'Accept: application/nostr+json' http://${relayHost}:${relayPort} | grep -q supported_nips`,
        2000,
      ),
      heartbeatMtime,
      now: Date.now(),
      relayHost, relayPort,
      binaries: {
        ngit:   cmdOut('ngit --version',   1500),
        claude: cmdOut('claude --version', 1500),
        nak:    cmdOut('nak --version',    1500),
        stacks: cmdOut('stacks --version', 1500),
      },
    });
  }

  // Binary presence goes through hasBin (absolute-path walk) rather than
  // `command -v`, which relies on the Node process's PATH. On fresh Linux
  // installs, ~/.cargo/bin isn't on that PATH yet — `command -v ngit`
  // returns non-zero even though cargo just laid it down there.
  return [
    {
      label: 'Relay (localhost:8080)',
      ok: cmd('nc -z -w 1 localhost 8080'),
    },
    {
      label: 'nostr-rs-relay binary',
      ok: hasBin('nostr-rs-relay'),
    },
    {
      label: 'nostr-vpn daemon',
      ok: isNvpnDaemonActive(),
    },
    {
      label: 'ngit binary',
      ok: hasBin('ngit'),
    },
    {
      label: 'nak binary',
      ok: hasBin('nak'),
    },
    {
      label: 'claude-code binary',
      ok: hasBin('claude'),
    },
    {
      label: 'Relay NIP-11 response',
      ok: cmd(`curl -sf -H 'Accept: application/nostr+json' http://localhost:8080 | grep -q supported_nips`),
    },
  ];
}

export function getMeshIp(): string | undefined {
  try {
    const out = execSync('nvpn status --json', { stdio: 'pipe' }).toString();
    return JSON.parse(out)?.tunnel_ip ?? undefined;
  } catch {
    return undefined;
  }
}
