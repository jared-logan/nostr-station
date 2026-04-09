import React from 'react';
import { Box, Text } from 'ink';
import SelectInput from 'ink-select-input';
import { P } from './palette.js';

export interface SelectOption {
  label: string;
  value: string;
  hint?: string;
}

interface SelectProps {
  label: string;
  options: SelectOption[];
  onSelect: (item: SelectOption) => void;
}

export const Select: React.FC<SelectProps> = ({ label, options, onSelect }) => (
  <Box flexDirection="column" marginTop={1}>
    <Box>
      <Box width={2} />
      <Text color={P.accent}>{'› '}</Text>
      <Text bold>{label}</Text>
    </Box>
    <Box marginLeft={4}>
      <SelectInput
        items={options}
        onSelect={onSelect}
        itemComponent={({ isSelected, label }) => (
          <Text color={isSelected ? P.accentBright : 'white'}>
            {isSelected ? '▸ ' : '  '}{label}
          </Text>
        )}
      />
    </Box>
  </Box>
);
