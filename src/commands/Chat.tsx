import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { execSync } from 'child_process';
import { P } from '../onboard/components/palette.js';
import { startWebServer, contextExists } from '../lib/web-server.js';

interface ChatProps {
  port?: number;
}

export const Chat: React.FC<ChatProps> = ({ port = 3000 }) => {
  const [status, setStatus]       = useState<'starting' | 'running' | 'error'>('starting');
  const [error, setError]         = useState('');
  const [browserOpened, setBrowserOpened] = useState(false);

  useEffect(() => {
    startWebServer(port)
      .then(() => {
        setStatus('running');
        try {
          const open = process.platform === 'darwin' ? 'open' : 'xdg-open';
          execSync(`${open} http://localhost:${port}`, { stdio: 'ignore', timeout: 3000 });
          setBrowserOpened(true);
        } catch {
          setBrowserOpened(false);
        }
      })
      .catch((e: Error) => {
        setError(e.message);
        setStatus('error');
      });
  }, []);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}>
        <Text color={P.accent} bold>nostr-station dashboard</Text>
      </Box>

      {status === 'starting' && (
        <Text color={P.muted}>Starting dashboard on port {port}…</Text>
      )}

      {status === 'running' && (
        <Box flexDirection="column">
          <Box>
            <Text color={P.success}>✓ </Text>
            <Text>Dashboard live at </Text>
            <Text color={P.accentBright}>http://localhost:{port}</Text>
          </Box>
          <Box marginTop={1} flexDirection="column">
            {!contextExists() && (
              <Box marginBottom={1}>
                <Text color={P.warn}>⚠  NOSTR_STATION.md not found at ~/projects — run onboard first for full chat context.</Text>
              </Box>
            )}
            <Text color={P.muted}>Panels: status · chat · relay · logs · config</Text>
            {browserOpened ? (
              <Text color={P.muted}>Browser opened. Press Ctrl+C to stop.</Text>
            ) : (
              <Text color={P.muted}>Open manually in a browser. Press Ctrl+C to stop.</Text>
            )}
          </Box>
        </Box>
      )}

      {status === 'error' && (
        <Box flexDirection="column">
          <Text color={P.error}>✗ {error}</Text>
        </Box>
      )}
    </Box>
  );
};
