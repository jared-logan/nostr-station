import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { execSync } from 'child_process';
import { P } from '../onboard/components/palette.js';
import { startWebServer, contextExists } from '../lib/web-server.js';

interface ChatProps {
  port?: number;
  // Optional path suffix to deep-link into a specific dashboard view.
  // Used by the no-args CLI entry to land users on /setup for the
  // first-run wizard instead of the default dashboard.
  path?: string;
}

export const Chat: React.FC<ChatProps> = ({ port = 3000, path = '' }) => {
  const [status, setStatus]       = useState<'starting' | 'running' | 'error'>('starting');
  const [error, setError]         = useState('');
  const [browserOpened, setBrowserOpened] = useState(false);
  const [reusedServer, setReusedServer]   = useState(false);

  useEffect(() => {
    const url = `http://localhost:${port}${path}`;
    const openBrowser = () => {
      try {
        const open = process.platform === 'darwin' ? 'open' : 'xdg-open';
        execSync(`${open} ${url}`, { stdio: 'ignore', timeout: 3000 });
        setBrowserOpened(true);
      } catch {
        setBrowserOpened(false);
      }
    };
    startWebServer(port)
      .then(() => {
        setStatus('running');
        openBrowser();
      })
      .catch((e: Error) => {
        // If another process already holds the port, treat it as a
        // running server and just deep-link the browser to the path —
        // this is the `nostr-station chat` running in one terminal +
        // `nostr-station` (no args) in another case.
        if (/EADDRINUSE|already.*in use|listen EADDRINUSE/i.test(e.message)) {
          setReusedServer(true);
          setStatus('running');
          openBrowser();
          return;
        }
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
            <Text>Dashboard {reusedServer ? 'already' : ''} live at </Text>
            <Text color={P.accentBright}>http://localhost:{port}{path}</Text>
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
