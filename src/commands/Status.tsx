import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { P } from '../onboard/components/palette.js';
import { execSync } from 'child_process';

interface StatusProps { json: boolean; }

// Three-state status, plus a stable `id` for dashboard UI mapping.
// `ok` is retained for back-compat (status --json consumers); `state`
// distinguishes installed-but-down (warn) from not-installed (err).
export type ServiceState = 'ok' | 'warn' | 'err';

export interface ServiceStatus {
  id:    string;
  label: string;
  value: string;
  ok:    boolean;
  state: ServiceState;
}

function cmd(c: string): string | null {
  try { return execSync(c, { stdio: 'pipe' }).toString().trim(); }
  catch { return null; }
}

function has(bin: string): boolean {
  return cmd(`command -v ${bin}`) !== null;
}

// Exported so cli.tsx can call it directly for --json mode, bypassing Ink.
// Ink would otherwise write UI frames to stdout alongside the JSON payload,
// corrupting any programmatic consumer piping stdout into a parser.
export function gatherStatus(): ServiceStatus[] {
  const relayUp   = cmd('nc -z localhost 8080') !== null;
  const relayBin  = has('nostr-rs-relay');
  const relayV    = relayBin ? cmd('nostr-rs-relay --version 2>/dev/null') : null;

  const nvpnBin   = has('nvpn');
  const meshIp    = (() => {
    if (!nvpnBin) return null;
    try {
      const out = cmd('nvpn status --json');
      return out ? JSON.parse(out)?.tunnel_ip ?? null : null;
    } catch { return null; }
  })();

  const ngitBin   = has('ngit');
  const ngitAuth  = ngitBin ? cmd('ngit status 2>/dev/null | head -1') : null;

  const claudeBin = has('claude');
  const claudeV   = claudeBin ? cmd('claude --version 2>/dev/null') : null;

  const nakBin    = has('nak');
  const nakV      = nakBin ? cmd('nak --version 2>/dev/null') : null;

  // Three-state mapping:
  //   ok   — running + configured
  //   warn — installed but not running/configured
  //   err  — not installed
  const relayState: ServiceState = relayUp ? 'ok' : relayBin ? 'warn' : 'err';
  const vpnState:   ServiceState = meshIp  ? 'ok' : nvpnBin  ? 'warn' : 'err';
  const ngitState:  ServiceState = ngitAuth ? 'ok' : ngitBin ? 'warn' : 'err';
  const relayBinState: ServiceState = relayBin ? 'ok' : 'err';
  const claudeState:   ServiceState = claudeBin ? 'ok' : 'err';
  const nakState:      ServiceState = nakBin ? 'ok' : 'err';

  return [
    { id: 'relay',     label: 'Relay',       value: relayUp ? 'ws://localhost:8080 ✓' : relayBin ? 'installed (down)' : 'not installed', ok: relayUp,      state: relayState    },
    { id: 'vpn',       label: 'nostr-vpn',   value: meshIp  ?? (nvpnBin  ? 'not connected' : 'not installed'),                            ok: !!meshIp,     state: vpnState      },
    { id: 'ngit',      label: 'ngit',        value: ngitAuth ? 'authenticated' : ngitBin ? 'not configured' : 'not installed',            ok: !!ngitAuth,   state: ngitState     },
    { id: 'claude',    label: 'claude-code', value: claudeV  ?? 'not installed',                                                           ok: !!claudeV,    state: claudeState   },
    { id: 'nak',       label: 'nak',         value: nakV     ?? 'not installed',                                                           ok: !!nakV,       state: nakState      },
    { id: 'relay-bin', label: 'relay bin',   value: relayV   ?? 'not installed',                                                           ok: !!relayV,     state: relayBinState },
  ];
}

// Pure JSON serializer — also reused by cli.tsx for --json so Ink never mounts.
export function formatStatusJson(rows: ServiceStatus[]): string {
  return JSON.stringify(
    Object.fromEntries(rows.map(x => [x.label, { ok: x.ok, value: x.value }])),
    null, 2,
  );
}

export const Status: React.FC<StatusProps> = ({ json }) => {
  const [rows, setRows] = useState<ServiceStatus[]>([]);

  useEffect(() => {
    const r = gatherStatus();
    setRows(r);
    if (json) {
      console.log(formatStatusJson(r));
      process.exit(0);
    }
  }, []);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}>
        <Text color={P.accent} bold>nostr-station status</Text>
      </Box>
      <Text color={P.accentDim}>{'─────────────────────────────'}</Text>
      {rows.map((r, i) => (
        <Box key={i}>
          <Box width={14}><Text color={P.muted}>{r.label}</Text></Box>
          <Text color={r.ok ? P.success : P.error}>{r.value}</Text>
        </Box>
      ))}
      <Text color={P.accentDim}>{'─────────────────────────────'}</Text>
      <Box marginTop={1}>
        <Text color={P.muted}>relay logs: </Text>
        <Text>~/logs/nostr-rs-relay.log</Text>
      </Box>
    </Box>
  );
};
