import React, { useState } from 'react';
import { Box, Text } from 'ink';
import { Select } from '../onboard/components/Select.js';
import { P } from '../onboard/components/palette.js';
import { detectPlatform } from '../lib/detect.js';
import { symlinkEditorFile, EDITOR_FILENAMES } from '../lib/services.js';

interface SetupEditorProps {}

export const SetupEditor: React.FC<SetupEditorProps> = () => {
  const [done, setDone] = useState(false);
  const [result, setResult] = useState<{ editor: string; linked: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const platform = detectPlatform();

  const options = Object.entries(EDITOR_FILENAMES).map(([value, filename]) => ({
    label: `${value.padEnd(14)} → ${filename}`,
    value,
  }));

  const handleSelect = (item: { value: string }) => {
    try {
      const linkPath = symlinkEditorFile(platform, item.value);
      const filename = EDITOR_FILENAMES[item.value] ?? 'AGENTS.md';
      setResult({ editor: item.value, linked: filename });
      setDone(true);
    } catch (e: any) {
      setError(e.message);
      setDone(true);
    }
  };

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}>
        <Text color={P.accent} bold>nostr-station setup-editor</Text>
      </Box>
      <Text color={P.accentDim}>{'─────────────────────────────'}</Text>

      {!done && (
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <Text color={P.muted}>
              {'NOSTR_STATION.md will be symlinked to your tool\'s convention.\n  Switch any time by running this command again.'}
            </Text>
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
