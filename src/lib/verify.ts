import { execSync } from 'child_process';

export interface CheckResult {
  label: string;
  ok: boolean;
  detail?: string;
}

function cmd(c: string): boolean {
  try { execSync(c, { stdio: 'pipe', timeout: 2000, killSignal: 'SIGKILL' }); return true; }
  catch { return false; }
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

export function runChecks(): CheckResult[] {
  return [
    {
      label: 'Relay (localhost:8080)',
      ok: cmd('nc -z -w 1 localhost 8080'),
    },
    {
      label: 'nostr-rs-relay binary',
      ok: cmd('command -v nostr-rs-relay'),
    },
    {
      label: 'nostr-vpn daemon',
      ok: isNvpnDaemonActive(),
    },
    {
      label: 'ngit binary',
      ok: cmd('command -v ngit'),
    },
    {
      label: 'nak binary',
      ok: cmd('command -v nak'),
    },
    {
      label: 'claude-code binary',
      ok: cmd('command -v claude'),
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
