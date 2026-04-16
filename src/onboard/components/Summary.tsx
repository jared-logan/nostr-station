import React from 'react';
import { Box, Text } from 'ink';
import { P } from './palette.js';
import type { Config } from '../../lib/detect.js';
import { EDITOR_START_COMMANDS, EDITOR_FILENAMES } from '../../lib/services.js';

interface SummaryProps {
  config: Config;
  meshIp?: string;
  demoMode?: boolean;
}

export const Summary: React.FC<SummaryProps> = ({ config, meshIp, demoMode = false }) => (
  <Box flexDirection="column" marginTop={1}>
    <Text color={P.accentDim}>{'  ─────────────────────────────────────────────'}</Text>
    <Box marginTop={1} marginBottom={1}>
      <Text color={P.success} bold>  ✓ nostr-station ready</Text>
    </Box>

    <Box flexDirection="column" marginLeft={2}>
      <Row label="Relay"    value="ws://localhost:8080" />
      <Row label="Mesh IP"  value={meshIp ?? 'run: nvpn status --json'} />
      <Row label="npub"     value={config.npub || '(not set)'} />
      <Row label="Projects" value="~/projects" />
      <Row label="Logs"     value="~/logs" />
      <Row label="Config"   value="~/.config/nostr-rs-relay/config.toml" />
    </Box>

    <Box marginTop={1} flexDirection="column" marginLeft={2}>
      <Text bold>Start a dev session:</Text>
      {config.aiProvider !== 'anthropic' && (
        <Text dimColor>  source ~/.claude_env   # load AI provider config</Text>
      )}
      <Text dimColor>  cd ~/projects && {EDITOR_START_COMMANDS[config.editor] ?? 'claude'}</Text>
      {(config.editor === 'cursor' || config.editor === 'windsurf' || config.editor === 'copilot') && (
        <Text color={P.muted}>  Context already linked as {EDITOR_FILENAMES[config.editor]}</Text>
      )}
    </Box>

    <Box marginTop={1} flexDirection="column" marginLeft={2}>
      <Text bold>Or chat with your agent in the browser:</Text>
      <Text dimColor>  nostr-station chat</Text>
      <Text color={P.muted}>  Opens localhost:3000 — NOSTR_STATION.md loaded as context</Text>
    </Box>

    <Box marginTop={1} flexDirection="column" marginLeft={2}>
      <Text bold>Context file for your AI coding tool:</Text>
      <Text dimColor>  ~/projects/{EDITOR_FILENAMES[config.editor] ?? 'NOSTR_STATION.md'}</Text>
      <Text color={P.muted}>  (source: ~/projects/NOSTR_STATION.md)</Text>
      <Text color={P.muted}>  Switch tools any time: nostr-station editor</Text>
    </Box>

    <Box marginTop={1} flexDirection="column" marginLeft={2}>
      <Text bold>Clone a Nostr repo:</Text>
      <Text dimColor>  ngit clone {'<naddr>'}</Text>
    </Box>

    <Box marginTop={1} flexDirection="column" marginLeft={2}>
      <Text bold>Test the relay:</Text>
      <Text dimColor>  nak event -k 1 --sec {'<nsec>'} "hello" ws://localhost:8080</Text>
    </Box>

    {!config.bunker && (
      <Box marginTop={1} flexDirection="column" marginLeft={2}>
        <Text color={P.warn}>⚠  ngit signing not configured. When ready:</Text>
        <Text dimColor>   ngit login --bunker {'<your-bunker-string>'}</Text>
      </Box>
    )}

    {config.installStacks && (
      <Box marginTop={1} flexDirection="column" marginLeft={2}>
        <Text bold>Start a Nostr app with Stacks:</Text>
        <Text dimColor>  mkdir my-app && cd my-app</Text>
        <Text dimColor>  stacks mkstack</Text>
        <Text color={P.muted}>  getstacks.dev  ·  Nostr app scaffolding</Text>
      </Box>
    )}
    {config.installLlmWiki && (
      <Box marginTop={1} flexDirection="column" marginLeft={2}>
        <Text bold>llm-wiki (inside a Claude Code session):</Text>
        <Text dimColor>  /install-plugin github:nvk/llm-wiki</Text>
        <Text dimColor>  /wiki init nostr-protocol</Text>
        <Text dimColor>  /wiki init nostr-apps</Text>
        <Text dimColor>  /wiki init ux-patterns</Text>
        <Box marginTop={1}>
          <Text color={P.muted}>Then seed your knowledge base:</Text>
        </Box>
        <Text dimColor>  /wiki:research "nostr relay architecture NIP specifications" --wiki nostr-protocol</Text>
        <Text dimColor>  /wiki:research "nostr app development patterns" --wiki nostr-apps</Text>
        <Text dimColor>  /wiki:assess ./ --wiki nostr-apps</Text>
      </Box>
    )}

    {demoMode && (
      <Box marginTop={1} flexDirection="column" marginLeft={2}>
        <Text color={P.warn}>⚠  Demo mode — this install used a throwaway keypair.</Text>
        <Text color={P.warn}>   Your nsec is NOT in Amber. Do not use this for real development.</Text>
        <Box marginTop={1}>
          <Text color={P.muted}>   To set up with your real identity:</Text>
        </Box>
        <Text dimColor>     nostr-station uninstall</Text>
        <Text dimColor>     nostr-station onboard</Text>
      </Box>
    )}

    <Box marginTop={1}>
      <Text color={P.accentDim}>{'  ─────────────────────────────────────────────'}</Text>
    </Box>
  </Box>
);

const Row: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <Box>
    <Box width={12}><Text dimColor>{label}</Text></Box>
    <Text>{value}</Text>
  </Box>
);
