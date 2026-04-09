import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { P } from '../onboard/components/palette.js';
import { execSync } from 'child_process';

interface RelayProps {
  action: 'start' | 'stop' | 'restart' | 'status';
}

function isUp(): boolean {
  try { execSync('nc -z localhost 8080', { stdio: 'pipe' }); return true; }
  catch { return false; }
}

function serviceCmd(action: 'start' | 'stop'): string {
  const isMac = process.platform === 'darwin';
  const label = 'com.nostr-station.relay';
  if (isMac) return `launchctl ${action} ${label}`;
  const svcAction = action === 'start' ? 'start' : 'stop';
  return `systemctl --user ${svcAction} nostr-relay.service`;
}

export const Relay: React.FC<RelayProps> = ({ action }) => {
  const [result, setResult] = useState<string | null>(null);
  const [ok, setOk] = useState(true);

  useEffect(() => {
    try {
      switch (action) {
        case 'status': {
          const up = isUp();
          setOk(up);
          setResult(up ? 'relay up · ws://localhost:8080' : 'relay down');
          break;
        }
        case 'start': {
          execSync(serviceCmd('start'), { stdio: 'pipe' });
          // Brief wait then check
          setTimeout(() => {
            const up = isUp();
            setOk(up);
            setResult(up ? 'relay started · ws://localhost:8080' : 'start issued but relay not responding yet');
          }, 1500);
          break;
        }
        case 'stop': {
          execSync(serviceCmd('stop'), { stdio: 'pipe' });
          const up = isUp();
          setOk(!up);
          setResult(!up ? 'relay stopped' : 'stop issued but relay still responding');
          break;
        }
        case 'restart': {
          execSync(serviceCmd('stop'), { stdio: 'pipe' });
          setTimeout(() => {
            execSync(serviceCmd('start'), { stdio: 'pipe' });
            setTimeout(() => {
              const up = isUp();
              setOk(up);
              setResult(up ? 'relay restarted · ws://localhost:8080' : 'restart issued but relay not responding yet');
            }, 1500);
          }, 500);
          break;
        }
      }
    } catch (e: any) {
      setOk(false);
      setResult(e.message?.slice(0, 120) ?? 'command failed');
    }
  }, []);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}>
        <Text color={P.accent} bold>nostr-station relay </Text>
        <Text bold>{action}</Text>
      </Box>

      {result === null ? (
        <Text color={P.muted}>working…</Text>
      ) : (
        <Text color={ok ? P.success : P.error}>
          {ok ? '✓ ' : '✗ '}{result}
        </Text>
      )}

      {result !== null && action === 'status' && (
        <Box marginTop={1} flexDirection="column">
          <Text color={P.muted}>
            Logs: ~/logs/nostr-rs-relay.log
          </Text>
          <Text color={P.muted}>
            Config: ~/.config/nostr-rs-relay/config.toml
          </Text>
        </Box>
      )}
    </Box>
  );
};
