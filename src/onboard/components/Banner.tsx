import React from 'react';
import { Box, Text } from 'ink';
import { P } from './palette.js';

// Version string — single source of truth for both wide and narrow banners
const VERSION = 'v0.0.3';

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

export const Banner: React.FC = () => {
  // The full wordmark needs ~100 columns (ostrich 22 + wordmark 58 + margin).
  // On narrow terminals (SSH default 80-col, Linux x86_64) the box-drawing
  // characters may also render as double-width, causing wrapping / duplication.
  // Fall back to a compact text banner on narrow terminals.
  const cols = process.stdout.columns ?? 120;
  const isNarrow = cols < 100;

  if (isNarrow) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text color={P.accent} bold>NOSTR STATION</Text>
        <Text color={P.muted}>Nostr-native dev environment  ·  {VERSION}</Text>
        <Text color={P.muted}>relay · vpn mesh · ngit · claude code · stacks</Text>
        <Text color={P.accentDim}>{'─────────────────────────────────────────'}</Text>
      </Box>
    );
  }

  return (
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
            <Text color={P.muted}>Nostr-native dev environment  ·  {VERSION}</Text>
          </Box>
          <Text color={P.muted}>relay · vpn mesh · ngit · claude code · stacks</Text>
        </Box>
      </Box>

      <Text color={P.accentDim}>{'─────────────────────────────────────────────────────────'}</Text>
    </Box>
  );
};
