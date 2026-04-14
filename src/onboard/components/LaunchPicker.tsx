import React from 'react';
import { Box, Text, useApp } from 'ink';
import { Select } from './Select.js';
import { P } from './palette.js';

const OPTIONS = [
  { label: 'Terminal dashboard  —  nostr-station tui',              value: 'tui'  },
  { label: 'Web chat            —  nostr-station chat  (localhost:3000)', value: 'chat' },
  { label: "Exit — I'll start manually",                             value: 'exit' },
];

interface LaunchPickerProps {
  onLaunch: (intent: string) => void;
}

export const LaunchPicker: React.FC<LaunchPickerProps> = ({ onLaunch }) => {
  const { exit } = useApp();

  const handleSelect = (item: { value: string }) => {
    onLaunch(item.value === 'exit' ? '' : item.value);
    exit();
  };

  return (
    <Box flexDirection="column" marginLeft={2} marginTop={1} marginBottom={1}>
      <Text color={P.muted} dimColor>{'  ─────────────────────────────────────────────'}</Text>
      <Select
        label="Ready to start?"
        options={OPTIONS}
        onSelect={handleSelect}
      />
    </Box>
  );
};
