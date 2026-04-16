import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { spawn } from 'child_process';
import { P } from '../onboard/components/palette.js';
import { startWebServer, contextExists } from '../lib/web-server.js';

interface ChatProps {
  port?: number;
  // Optional path suffix to deep-link into a specific dashboard view.
  // Used by the no-args CLI entry to land users on /setup for the
  // first-run wizard instead of the default dashboard.
  path?: string;
}

// Fire-and-forget browser open. Deliberately does NOT block or throw:
//   - xdg-open on a headless Linux box may be absent (ENOENT), have a
//     broken MIME database, or exit with non-zero but still succeed. Any
//     of these used to deadlock the previous execSync+timeout path long
//     enough that the user assumed the server never started.
//   - spawn + detached + unref lets the child outlive us and decouples
//     Node's event loop from whatever xdg-open is doing.
//   - The 'error' listener is required because spawn on a missing binary
//     emits 'error' asynchronously; without a listener it crashes the
//     process via uncaughtException.
//
// Returns true if we handed the URL off to a launcher, false if no
// launcher was available. "Handed off" ≠ "browser actually opened" — the
// child may still exit 1, but we treat that as user's problem, not ours.
function tryOpenBrowser(url: string): boolean {
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
  try {
    const child = spawn(opener, [url], {
      stdio: 'ignore',
      detached: true,
    });
    child.on('error', () => { /* missing opener → silent */ });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export const Chat: React.FC<ChatProps> = ({ port = 3000, path = '' }) => {
  const [status, setStatus]       = useState<'starting' | 'running' | 'error'>('starting');
  const [error, setError]         = useState('');
  const [browserOpened, setBrowserOpened] = useState(false);
  const [reusedServer, setReusedServer]   = useState(false);

  useEffect(() => {
    const url = `http://localhost:${port}${path}`;
    const announce = (reused: boolean) => {
      // Durable stderr line — shows up even if Ink hasn't flushed its
      // re-render yet, so users watching the terminal always see the
      // URL before we hand off to the browser.
      process.stderr.write(
        `Dashboard ${reused ? 'already running' : 'running'} at ${url}\n`,
      );
      setBrowserOpened(tryOpenBrowser(url));
    };
    startWebServer(port)
      .then(() => {
        setStatus('running');
        announce(false);
      })
      .catch((e: Error) => {
        // If another process already holds the port, treat it as a
        // running server and just deep-link the browser to the path —
        // this is the `nostr-station chat` running in one terminal +
        // `nostr-station` (no args) in another case.
        if (/EADDRINUSE|already.*in use|listen EADDRINUSE/i.test(e.message)) {
          setReusedServer(true);
          setStatus('running');
          announce(true);
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
