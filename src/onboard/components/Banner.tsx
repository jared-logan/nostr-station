import React from 'react';
import { Box, Text } from 'ink';
import { P } from './palette.js';

// Version string — single source of truth for both wide and narrow banners
const VERSION = 'v0.0.3';

// ─────────────────────────────────────────────────────────────────────────
// Tier-based banner rendering — polish over spectacle.
//
// Terminals vary wildly in what they can render without falling apart:
//   - iTerm2 / WezTerm / Kitty: full UTF-8, truecolor, no double-width issues
//   - Linux framebuffer console (TERM=linux): can't render box-drawing chars
//     or emoji at all — they come out as garbage
//   - SSH to a headless server: usually fine but assume conservative
//   - CI log viewers: no TTY, NO_COLOR expected, plain text is a feature
//
// The previous banner hardcoded a 16-row ostrich + ANSI block wordmark and
// tried to "fall back" at cols<100, but the box-drawing characters (╔ ╗ ║ ═)
// still rendered as double-width on some Linux terminals, wrapping and
// duplicating. The fix isn't "narrow vs wide" — it's "can this terminal
// handle box-drawing chars at all."
//
// Three tiers, from most conservative to most decorative:
//
//   Tier 0 (plain)  Single-line ASCII text. Works anywhere, including dumb
//                   terminals, non-TTY pipes, NO_COLOR envs, and frame-
//                   buffer consoles. No color, no box chars, no risk.
//
//   Tier 1 (safe)   Plain-text wordmark + colored horizontal rule. Uses
//                   UTF-8 `─` (safe across all UTF-8 terminals) but NO box-
//                   drawing blocks or double-width chars. This is the
//                   default for any unknown terminal — safe middle ground.
//
//   Tier 2 (full)   The Nori ostrich + ANSI block wordmark. Only rendered
//                   on whitelisted terminals we've actually verified.
//
// Escape hatch: `NOSTR_STATION_BANNER=plain|safe|full` overrides detection.
// ─────────────────────────────────────────────────────────────────────────

type Tier = 'plain' | 'safe' | 'full';

function detectTier(): Tier {
  // Explicit override always wins — useful for demos, bug reports, CI pins.
  const override = process.env.NOSTR_STATION_BANNER?.toLowerCase();
  if (override === 'plain' || override === 'safe' || override === 'full') {
    return override;
  }

  // Hard downgrades: anything that indicates we can't trust the terminal.
  if (process.env.NO_COLOR) return 'plain';
  if (!process.stdout.isTTY) return 'plain';
  const term = process.env.TERM ?? '';
  if (term === 'dumb' || term === 'linux') return 'plain';
  const cols = process.stdout.columns ?? 80;
  if (cols < 80) return 'plain';

  // Tier 2 whitelist — only terminals we have actually verified render the
  // full Nori banner without distortion. Anything not on this list gets the
  // Tier 1 safe rendering. This is intentional — adding a terminal here
  // should require eyeballing a screenshot first.
  const isKnownGood =
    // iTerm2
    process.env.TERM_PROGRAM === 'iTerm.app' ||
    // macOS Terminal.app
    process.env.TERM_PROGRAM === 'Apple_Terminal' ||
    // VS Code integrated terminal
    process.env.TERM_PROGRAM === 'vscode' ||
    // WezTerm
    process.env.TERM_PROGRAM === 'WezTerm' ||
    // Hyper
    process.env.TERM_PROGRAM === 'Hyper' ||
    // Kitty (sets KITTY_WINDOW_ID)
    !!process.env.KITTY_WINDOW_ID ||
    // Windows Terminal
    !!process.env.WT_SESSION ||
    // Alacritty (sets ALACRITTY_*)
    !!process.env.ALACRITTY_WINDOW_ID ||
    term.startsWith('alacritty');

  // Full banner also needs the horizontal real estate for ostrich + wordmark.
  if (isKnownGood && cols >= 100) return 'full';

  return 'safe';
}

// ─────────────────────────────────────────────────────────────────────────
// Tier 2: Nori ostrich — 16×16 block art. Only used on whitelisted terms.
// ─────────────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────
// Tier 0: single line. Nothing that can wrap, nothing that can double-width.
// ─────────────────────────────────────────────────────────────────────────
const PlainBanner: React.FC = () => (
  <Box flexDirection="column" marginBottom={1}>
    <Text>NOSTR STATION {VERSION} — Nostr-native dev environment</Text>
  </Box>
);

// ─────────────────────────────────────────────────────────────────────────
// Tier 1: color wordmark + subtitle + rule. No block chars, no ANSI art.
// The `─` (U+2500) is the ONE decorative UTF-8 char we allow at this tier —
// it's single-width everywhere we've tested, including over SSH.
// ─────────────────────────────────────────────────────────────────────────
const SafeBanner: React.FC = () => {
  const cols = process.stdout.columns ?? 80;
  const ruleWidth = Math.min(cols - 2, 60);
  const rule = '─'.repeat(ruleWidth);

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color={P.accent} bold>NOSTR STATION</Text>
        <Text color={P.muted}>{'  '}{VERSION}</Text>
      </Box>
      <Text color={P.muted}>Nostr-native dev environment</Text>
      <Text color={P.muted}>relay · vpn mesh · ngit · claude code · stacks</Text>
      <Text color={P.accentDim}>{rule}</Text>
    </Box>
  );
};

// ─────────────────────────────────────────────────────────────────────────
// Tier 2: the full Nori banner. The box-drawing characters here render as
// double-width on some Linux terminals — that's why this tier is gated on
// the whitelist above.
// ─────────────────────────────────────────────────────────────────────────
const FullBanner: React.FC = () => (
  <Box flexDirection="column" marginBottom={1}>
    <Box flexDirection="row" marginBottom={1}>
      <Box marginRight={2} marginTop={1}>
        <Ostrich />
      </Box>

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

export const Banner: React.FC = () => {
  const tier = detectTier();
  if (tier === 'full')  return <FullBanner />;
  if (tier === 'safe')  return <SafeBanner />;
  return <PlainBanner />;
};
