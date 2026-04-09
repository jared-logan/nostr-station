import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { P } from '../onboard/components/palette.js';
import { spawn } from 'child_process';
import os from 'os';
import fs from 'fs';

interface LogsProps {
  follow: boolean;
  service: 'relay' | 'watchdog' | 'all';
}

const LOG_DIR = `${os.homedir()}/logs`;

const LOG_FILES: Record<string, string> = {
  relay:    `${LOG_DIR}/nostr-rs-relay.log`,
  watchdog: `${LOG_DIR}/watchdog.log`,
};

function colorLine(line: string): string {
  // Very light semantic coloring — errors red, ok green
  if (/error|ERR|WARN|down/i.test(line)) return P.error;
  if (/OK|✓|started|listening/i.test(line)) return P.success;
  return 'white';
}

export const Logs: React.FC<LogsProps> = ({ follow, service }) => {
  const [lines, setLines] = useState<{ text: string; color: string }[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const files = service === 'all'
      ? Object.values(LOG_FILES)
      : [LOG_FILES[service]];

    for (const file of files) {
      if (!fs.existsSync(file)) {
        setError(`Log file not found: ${file}`);
        return;
      }
    }

    const args = follow ? ['-f', '-n', '50', ...files] : ['-n', '100', ...files];
    const tail = spawn('tail', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    tail.stdout.on('data', (data: Buffer) => {
      const newLines = data.toString().split('\n').filter(Boolean).map(text => ({
        text,
        color: colorLine(text),
      }));
      setLines(prev => [...prev.slice(-500), ...newLines]);
    });

    tail.stderr.on('data', (data: Buffer) => {
      setError(data.toString().trim());
    });

    return () => { tail.kill(); };
  }, []);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}>
        <Text color={P.accent} bold>nostr-station logs</Text>
        <Text color={P.muted}> --service {service}</Text>
        {follow && <Text color={P.muted}> --follow</Text>}
      </Box>
      <Text color={P.accentDim}>{'─────────────────────────────'}</Text>

      {error && <Text color={P.error}>{error}</Text>}

      {lines.map((l, i) => (
        <Text key={i} color={l.color}>{l.text}</Text>
      ))}

      {follow && !error && (
        <Text color={P.muted}>— following, ctrl-c to stop —</Text>
      )}
    </Box>
  );
};
