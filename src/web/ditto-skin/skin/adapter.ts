/*
 * ─────────────────────────────────────────────────────────────────────
 * nostr-station Ditto skin — upstream adapter
 *
 * This file is the ONLY seam between our skin components and Ditto's
 * internals. All skin components MUST import upstream hooks, utilities,
 * and types via `@/skin/adapter` (this file) — never directly from
 * `@/hooks/*`, `@/lib/*`, `@/contexts/*`, etc.
 *
 * Why: when we bump DITTO_REF upstream and a hook moves, gets renamed,
 * or changes signature, the fix lives in this single file. Vite/tsc
 * fails loudly during the staged Ditto build (see fetch-ditto.mjs
 * applySkin + currentBuildConfigHash) — a broken skin physically can't
 * ship.
 *
 * Layout: re-exports are grouped by upstream module path. When you add a
 * new dependency to a skin component, add the re-export here first.
 *
 * Path resolution: this file is copied to .ditto-src/src/skin/adapter.ts
 * by applySkin() in scripts/fetch-ditto.mjs. The @/ alias is Ditto's own
 * tsconfig path mapping (@/* → src/*), so `@/skin/adapter` resolves at
 * build time inside the clone.
 * ─────────────────────────────────────────────────────────────────────
 */

// ── Hooks ────────────────────────────────────────────────────────────
export { useAppContext }   from '@/hooks/useAppContext';
export { useCurrentUser }  from '@/hooks/useCurrentUser';

// ── Utilities ────────────────────────────────────────────────────────
export { cn } from '@/lib/utils';

// ── Skin-owned helpers ───────────────────────────────────────────────

/**
 * Display-name fallback. Upstream had `genUserName(pubkey)` in
 * `@/lib/genUserName` until v2.21.0, where it was deleted (commit
 * bcc318bc) and replaced with the literal `'Anonymous'` at all call
 * sites. We ship our own here so future skin components don't break on
 * the bump, and so we can swap in a station-flavored fallback (npub
 * prefix, deterministic adjective+noun, etc.) without touching every
 * caller.
 *
 * @param _pubkey reserved for a future deterministic name generator;
 *                currently unused.
 */
export function genUserName(_pubkey?: string): string {
  return 'Anonymous';
}
