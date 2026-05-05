// palette.ts — nostr-station "ostrich palette"
// Single source of truth for all terminal colors.
// Nostr purple is the canonical accent: #7B68EE (medium slate)

export const P = {
  // Primary — nostr purple
  accent:      '#7B68EE',   // headings, labels, primary highlights
  accentBright:'#9B8FFF',   // command names, emphasis, active steps
  accentDim:   '#5A4FBF',   // dividers, secondary highlights

  // Semantic
  info:    '#A89FFF',   // informational values, hints
  success: '#3DDC84',   // success states, done steps
  warn:    '#FFB020',   // warnings, skipped steps
  error:   '#FF5A5A',   // errors, failures
  muted:   '#6B6B8B',   // de-emphasis, metadata, placeholders

  // Ostrich pixel art
  body:    '#7B68EE',   // ostrich body fill
  light:   '#C4BBFF',   // ostrich highlight
} as const;

export type PaletteKey = keyof typeof P;
