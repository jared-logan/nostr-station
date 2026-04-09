import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { Select } from '../onboard/components/Select.js';
import { P } from '../onboard/components/palette.js';
import { generateCompletion, installCompletion } from '../lib/completion.js';

interface CompletionProps {
  shell?: string;
  install: boolean;
  print: boolean;
}

export const Completion: React.FC<CompletionProps> = ({ shell, install, print }) => {
  const [result, setResult] = useState<{ ok: boolean; path: string; instructions: string } | null>(null);
  const [selectedShell, setSelectedShell] = useState<'zsh' | 'bash' | null>(
    shell === 'zsh' || shell === 'bash' ? shell : null,
  );

  useEffect(() => {
    if (!selectedShell) return;

    if (print) {
      process.stdout.write(generateCompletion(selectedShell));
      process.exit(0);
    }

    if (install) {
      const r = installCompletion(selectedShell);
      setResult(r);
    }
  }, [selectedShell]);

  if (!selectedShell) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Box marginBottom={1}>
          <Text color={P.accent} bold>nostr-station completion</Text>
        </Box>
        <Select
          label="Shell"
          options={[
            { label: 'zsh  (recommended on macOS)', value: 'zsh' },
            { label: 'bash', value: 'bash' },
          ]}
          onSelect={item => setSelectedShell(item.value as 'zsh' | 'bash')}
        />
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}>
        <Text color={P.accent} bold>nostr-station completion</Text>
        <Text color={P.muted}> --shell {selectedShell}</Text>
      </Box>

      {result && result.ok && (
        <Box flexDirection="column">
          <Text color={P.success}>✓ Completion installed → {result.path}</Text>
          <Box marginTop={1}>
            <Text color={P.muted}>{result.instructions}</Text>
          </Box>
        </Box>
      )}

      {!install && !print && (
        <Box flexDirection="column">
          <Text color={P.muted}>Usage:</Text>
          <Text>  nostr-station completion --shell {selectedShell} --install</Text>
          <Text color={P.muted}>  or print to stdout:</Text>
          <Text>  nostr-station completion --shell {selectedShell} --print</Text>
        </Box>
      )}
    </Box>
  );
};
