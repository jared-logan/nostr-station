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

// Is the nvpn service installed + running? This is deliberately distinct
// from "is the mesh tunnel connected" — a daemon can be up and idle with no
// peers, and we don't want doctor to flag that as a failure. The old check
// (`nvpn status --json | grep -q connected`) conflated the two, which
// surfaced false-negatives on freshly-installed boxes whose daemon is
// running but whose mesh hasn't been joined yet.
function isNvpnDaemonActive(): boolean {
  if (process.platform === 'linux') {
    // `is-active` exits 0 for "active", non-zero otherwise — no sudo needed
    // for read. --quiet suppresses the word on stdout.
    return cmd('systemctl is-active --quiet nvpn');
  }
  if (process.platform === 'darwin') {
    // launchd doesn't have a friendly `is-active` equivalent; `launchctl list`
    // prints the label when loaded. nvpn's service-install uses a
    // com.nostr-vpn.* label — match loosely so a rename upstream doesn't
    // break the check silently.
    return cmd('launchctl list | grep -q nostr-vpn');
  }
  return false;
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
