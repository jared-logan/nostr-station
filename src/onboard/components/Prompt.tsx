import React from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import { P } from './palette.js';

interface PromptProps {
  label: string;
  placeholder?: string;
  value: string;
  onChange: (val: string) => void;
  onSubmit: (val: string) => void;
  mask?: boolean;
  dimLabel?: boolean;
}

export const Prompt: React.FC<PromptProps> = ({
  label,
  placeholder = '',
  value,
  onChange,
  onSubmit,
  mask = false,
  dimLabel = false,
}) => (
  <Box marginTop={1}>
    <Box width={2} />
    <Text color={P.accent}>{'› '}</Text>
    {dimLabel ? (
      <Text color={P.muted}>{label + '  '}</Text>
    ) : (
      <Text bold>{label + '  '}</Text>
    )}
    <TextInput
      value={value}
      placeholder={placeholder}
      onChange={onChange}
      onSubmit={onSubmit}
      mask={mask ? '*' : undefined}
    />
  </Box>
);
