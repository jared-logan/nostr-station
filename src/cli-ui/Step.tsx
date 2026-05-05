import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { P } from './palette.js';

export type StepStatus = 'pending' | 'running' | 'done' | 'warn' | 'error' | 'skip';

interface StepProps {
  label: string;
  status: StepStatus;
  detail?: string;
}

const icons: Record<StepStatus, string> = {
  pending: '○',
  running: '◉',
  done:    '✓',
  warn:    '⚠',
  error:   '✗',
  skip:    '–',
};

const colors: Record<StepStatus, string> = {
  pending: P.muted,
  running: P.accentBright,
  done:    P.success,
  warn:    P.warn,
  error:   P.error,
  skip:    P.muted,
};

export const Step: React.FC<StepProps> = ({ label, status, detail }) => (
  <Box marginLeft={2}>
    <Box width={4}>
      {status === 'running' ? (
        <Text color={P.accentBright}><Spinner type="dots" /></Text>
      ) : (
        <Text color={colors[status]}>{icons[status]}</Text>
      )}
    </Box>
    <Text
      color={status === 'pending' ? P.muted : status === 'skip' ? P.muted : 'white'}
      bold={status === 'running'}
      dimColor={status === 'skip'}
    >
      {label}
    </Text>
    {detail && (
      <Text color={P.muted}>{'  ' + detail}</Text>
    )}
  </Box>
);

// TOTAL_PHASES — update if phases change
const TOTAL = 5;

interface PhaseHeaderProps {
  number: number;
  title: string;
  done?: boolean;
}

export const PhaseHeader: React.FC<PhaseHeaderProps> = ({ number, title, done = false }) => (
  <Box marginTop={1} marginBottom={0}>
    {/* Phase pill */}
    <Text color={done ? P.success : P.accent} bold>
      {done ? '✓' : `${number}/${TOTAL}`}
    </Text>
    <Text color={P.accentDim}>{' ─ '}</Text>
    <Text color={done ? P.muted : 'white'} bold={!done}>{title}</Text>
  </Box>
);
