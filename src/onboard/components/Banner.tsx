import React from 'react';
import { Box, Text } from 'ink';
import { P } from './palette.js';

// Pixel ostrich — 16×16 block art, nostr purple + white + black
// Each row is a string of characters: █ = body, ░ = light, space = bg
const OSTRICH = [
  '        ██          ',
  '       █░░█         ',
  '       █░░█         ',
  '      ██░░██        ',
  '    ██████████      ',
  '   █░░░░░░░░░░█     ',
  '   █░░░██░░░░░█     ',
  '   █░░░░░░░░░░█     ',
  '    ██░░░░░░██      ',
  '      ██████        ',
  '      █░░░░█        ',
  '     ██░░░░██       ',
  '     █░░░░░░█       ',
  '     █░  ░░░█       ',
  '    ███  ████       ',
  '   █  █  █  █       ',
];

const Ostrich: React.FC = () => (
  <Box flexDirection="column">
    {OSTRICH.map((row, i) => (
      <Text key={i} color={P.accent}>{row}</Text>
    ))}
  </Box>
);

export const Banner: React.FC = () => (
  <Box flexDirection="column" marginBottom={1}>
    <Box flexDirection="row" marginBottom={1}>
      {/* Pixel ostrich on the left */}
      <Box marginRight={2} marginTop={1}>
        <Ostrich />
      </Box>

      {/* Wordmark on the right */}
      <Box flexDirection="column" justifyContent="center">
        <Text color={P.accent} bold>{'███╗   ██╗ ██████╗ ███████╗████████╗██████╗ '}</Text>
        <Text color={P.accent} bold>{'████╗  ██║██╔═══██╗██╔════╝╚══██╔══╝██╔══██╗'}</Text>
        <Text color={P.accent} bold>{'██╔██╗ ██║██║   ██║███████╗   ██║   ██████╔╝'}</Text>
        <Text color={P.accent} bold>{'██║╚██╗██║██║   ██║╚════██║   ██║   ██╔══██╗'}</Text>
        <Text color={P.accent} bold>{'██║ ╚████║╚██████╔╝███████║   ██║   ██║  ██║'}</Text>
        <Text color={P.accent} bold>{'╚═╝  ╚═══╝ ╚═════╝ ╚══════╝   ╚═╝   ╚═╝  ╚═╝'}</Text>
        <Box marginTop={1}>
          <Text color={P.accentBright} bold>{'███████╗████████╗ █████╗ ████████╗██╗ ██████╗ ███╗   ██╗'}</Text>
        </Box>
        <Text color={P.accentBright} bold>{'██╔════╝╚══██╔══╝██╔══██╗╚══██╔══╝██║██╔═══██╗████╗  ██║'}</Text>
        <Text color={P.accentBright} bold>{'███████╗   ██║   ███████║   ██║   ██║██║   ██║██╔██╗ ██║'}</Text>
        <Text color={P.accentBright} bold>{'╚════██║   ██║   ██╔══██║   ██║   ██║██║   ██║██║╚██╗██║'}</Text>
        <Text color={P.accentBright} bold>{'███████║   ██║   ██║  ██║   ██║   ██║╚██████╔╝██║ ╚████║'}</Text>
        <Text color={P.accentBright} bold>{'╚══════╝   ╚═╝   ╚═╝  ╚═╝   ╚═╝   ╚═╝ ╚═════╝ ╚═╝  ╚═══╝'}</Text>
        <Box marginTop={1}>
          <Text color={P.muted}>Nostr-native dev environment  ·  v0.1.0</Text>
        </Box>
        <Text color={P.muted}>relay · vpn mesh · ngit · claude code · stacks</Text>
      </Box>
    </Box>

    <Text color={P.accentDim}>{'─────────────────────────────────────────────────────────'}</Text>
  </Box>
);
