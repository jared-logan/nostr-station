import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { P } from '../onboard/components/palette.js';
import { execSync } from 'child_process';

interface StatusProps { json: boolean; }

interface ServiceStatus {
  label: string;
  value: string;
  ok: boolean;
}

function cmd(c: string): string | null {
  try { return execSync(c, { stdio: 'pipe' }).toString().trim(); }
  catch { return null; }
}

function gather(): ServiceStatus[] {
  const relayUp  = cmd('nc -z localhost 8080') !== null;
  const meshIp   = (() => {
    try {
      const out = cmd('nvpn status --json');
      return out ? JSON.parse(out)?.tunnel_ip ?? null : null;
    } catch { return null; }
  })();
  const ngitAuth = cmd('ngit status 2>/dev/null | head -1') ?? null;
  const claudeV  = cmd('claude --version 2>/dev/null') ?? null;
  const nakV     = cmd('nak --version 2>/dev/null') ?? null;
  const relayV   = cmd('nostr-rs-relay --version 2>/dev/null') ?? null;

  return [
    { label: 'Relay',       value: relayUp ? 'ws://localhost:8080 ✓' : 'down ✗',  ok: relayUp },
    { label: 'nostr-vpn',   value: meshIp  ?? 'not connected',                     ok: !!meshIp },
    { label: 'ngit',        value: ngitAuth ? 'authenticated' : 'not configured',  ok: !!ngitAuth },
    { label: 'claude-code', value: claudeV  ?? 'not found',                        ok: !!claudeV },
    { label: 'nak',         value: nakV     ?? 'not found',                        ok: !!nakV },
    { label: 'relay bin',   value: relayV   ?? 'not found',                        ok: !!relayV },
  ];
}

export const Status: React.FC<StatusProps> = ({ json }) => {
  const [rows, setRows] = useState<ServiceStatus[]>([]);

  useEffect(() => {
    const r = gather();
    setRows(r);
    if (json) {
      console.log(JSON.stringify(
        Object.fromEntries(r.map(x => [x.label, { ok: x.ok, value: x.value }])),
        null, 2,
      ));
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
