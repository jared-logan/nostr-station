import { execSync } from 'child_process';

export interface CheckResult {
  label: string;
  ok: boolean;
  detail?: string;
}

function cmd(c: string): boolean {
  try { execSync(c, { stdio: 'pipe' }); return true; }
  catch { return false; }
}

export function runChecks(): CheckResult[] {
  return [
    {
      label: 'Relay (localhost:8080)',
      ok: cmd('nc -z localhost 8080'),
    },
    {
      label: 'nostr-rs-relay binary',
      ok: cmd('command -v nostr-rs-relay'),
    },
    {
      label: 'nostr-vpn daemon',
      ok: cmd('nvpn status --json 2>/dev/null | grep -q connected'),
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
