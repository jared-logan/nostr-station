import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { Select } from '../cli-ui/Select.js';
import { P } from '../cli-ui/palette.js';
import { symlinkEditorFile, EDITOR_FILENAMES } from '../lib/editor.js';

interface EditorProps {}

export const Editor: React.FC<EditorProps> = () => {
  const [done, setDone] = useState(false);
  const [result, setResult] = useState<{ editor: string; linked: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const options = Object.entries(EDITOR_FILENAMES).map(([value, filename]) => ({
    label: `${value.padEnd(14)} → ${filename}`,
    value,
  }));

  const handleSelect = (item: { value: string }) => {
    try {
      const linkPath = symlinkEditorFile(item.value);
      const filename = EDITOR_FILENAMES[item.value] ?? 'AGENTS.md';
      setResult({ editor: item.value, linked: filename });
      setDone(true);
    } catch (e: any) {
      setError(e.message);
      setDone(true);
    }
  };

  // Propagate symlink failure as non-zero exit — so a shell pipeline
  // that runs `editor && doctor` doesn't continue on a broken link.
  useEffect(() => {
    if (error) process.exitCode = 1;
  }, [error]);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}>
        <Text color={P.accent} bold>nostr-station editor</Text>
      </Box>
      <Text color={P.accentDim}>{'─────────────────────────────'}</Text>

      {!done && (
        <Box flexDirection="column">
          <Box marginBottom={1} flexDirection="column">
            <Text color={P.muted}>
              {'NOSTR_STATION.md will be symlinked to your tool\'s convention.\n  Switch any time by running this command again.'}
            </Text>
            <Box marginTop={1}>
              <Text color={P.muted}>
                {'  AGENTS.md is the target for Codex and Stacks Dork — it gives those\n'
                + '  tools environmental awareness (relay URL, signer status, NIPs available)\n'
                + '  without touching their identity. Pick `codex` for Codex; `other` is the\n'
                + '  generic fallback that any AGENTS.md-aware agent will read.'}
              </Text>
            </Box>
          </Box>
          <Select
            label="AI coding tool"
            options={options}
            onSelect={handleSelect}
          />
        </Box>
      )}

      {done && result && (
        <Box flexDirection="column">
          <Text color={P.success}>
            {`✓ ${result.linked} → NOSTR_STATION.md`}
          </Text>
          <Box marginTop={1}>
            <Text color={P.muted}>
              {`~/projects/${result.linked} now points to your context file.`}
            </Text>
          </Box>
        </Box>
      )}

      {done && error && (
        <Text color={P.error}>✗ {error}</Text>
      )}
    </Box>
  );
};
