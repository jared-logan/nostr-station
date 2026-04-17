import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { P } from '../onboard/components/palette.js';
import { execSync } from 'child_process';
import { readIdentity } from '../lib/identity.js';

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

// Every shellout here is on the hot path for /api/status. A single blocking
// call (notably `nvpn status --json` when its daemon socket is wedged)
// stalls the whole Node event loop and the dashboard sees a 10s+ hang.
// Default 2s ceiling, SIGKILL on expiry — we'd rather report "not running"
// than make the user wait.
function cmd(c: string, timeoutMs = 2000): string | null {
  try {
    return execSync(c, {
      stdio: 'pipe',
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
    }).toString().trim();
  } catch { return null; }
}

function has(bin: string): boolean {
  return cmd(`command -v ${bin}`) !== null;
}

// Exported so cli.tsx can call it directly for --json mode, bypassing Ink.
// Ink would otherwise write UI frames to stdout alongside the JSON payload,
// corrupting any programmatic consumer piping stdout into a parser.
export function gatherStatus(): ServiceStatus[] {
  // `-w 1` is a second belt-and-suspenders timeout — both BSD and GNU nc
  // respect it. Protects against nc variants that ignore our execSync
  // timeout (rare, but cheap insurance).
  const relayUp   = cmd('nc -z -w 1 localhost 8080', 1500) !== null;
  const relayBin  = has('nostr-rs-relay');
  const relayV    = relayBin ? cmd('nostr-rs-relay --version 2>/dev/null') : null;

  const nvpnBin   = has('nvpn');
  const meshIp    = (() => {
    if (!nvpnBin) return null;
    try {
      // Tighter 1s cap: `nvpn status --json` talks to the nvpn daemon over
      // IPC. On a fresh install the service may be installed but not yet
      // running, which blocks the socket connect indefinitely.
      const out = cmd('nvpn status --json', 1000);
      return out ? JSON.parse(out)?.tunnel_ip ?? null : null;
    } catch { return null; }
  })();

  const ngitBin   = has('ngit');
  // Station-level "configured" signal is the default nostr relay the user
  // saved in identity.json — set via Config → NGIT in the dashboard. This
  // matches what the dashboard can act on; project-specific ngit remotes
  // are surfaced inside the Projects panel instead.
  const ngitRelay = (() => {
    try { return readIdentity().ngitRelay || ''; }
    catch { return ''; }
  })();

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
  const ngitState:  ServiceState = ngitBin && ngitRelay ? 'ok' : ngitBin ? 'warn' : 'err';
  const relayBinState: ServiceState = relayBin ? 'ok' : 'err';
  const claudeState:   ServiceState = claudeBin ? 'ok' : 'err';
  const nakState:      ServiceState = nakBin ? 'ok' : 'err';

  return [
    { id: 'relay',     label: 'Relay',       value: relayUp ? 'ws://localhost:8080 ✓' : relayBin ? 'installed (down)' : 'not installed', ok: relayUp,      state: relayState    },
    { id: 'vpn',       label: 'nostr-vpn',   value: meshIp  ?? (nvpnBin  ? 'not connected' : 'not installed'),                            ok: !!meshIp,     state: vpnState      },
    { id: 'ngit',      label: 'ngit',        value: ngitBin && ngitRelay ? `relay: ${ngitRelay.replace(/^wss?:\/\//, '')}` : ngitBin ? 'not configured' : 'not installed', ok: ngitBin && !!ngitRelay, state: ngitState     },
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
