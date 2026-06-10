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

// ── Contexts ─────────────────────────────────────────────────────────
// Layout context: provided by upstream MainLayout, consumed by shell
// components (SubHeaderBar checks useNavHidden to slide the bar in
// sync with the mobile nav). When Phase 3 replaces MainLayout, our
// replacement must re-provide identical context values — these hooks
// stay stable through that transition.
export { useNavHidden } from '@/contexts/LayoutContext';

// SubHeaderBar context: TabButton's useActiveTabIndicator reports
// the active tab's offset/width to whichever ancestor provided this
// context, so the bar (skin or upstream) can paint an indicator at the
// right horizontal position. Skin TabButton uses these to drive its
// own underline; we re-export them so we don't fork the contract.
export {
  SubHeaderBarContext,
  useSubHeaderBarHover,
  useActiveTabIndicator,
} from '@/components/SubHeaderBarContext';

// ── Sidebar item helpers ─────────────────────────────────────────────
// Pure functions over sidebar item IDs (path resolution, icon lookup,
// type discrimination). Stable surface — no breaking changes between
// the pin and v2.21.0.
export {
  sidebarItemIcon,
  itemLabel,
  itemPath,
  isSidebarDivider,
  isNostrUri,
  isExternalUri,
  isNsiteUri,
} from '@/lib/sidebarItems';

// ── Specialized sidebar item components ──────────────────────────────
// SidebarNavList delegates rendering to these for non-standard item
// types (Nostr event refs, nsite links, external URLs). Skin
// SidebarNavList preserves the delegation; if upstream renames one,
// the fix lives here. The CSS overlay's "outer nav-item wrapper" rule
// in src/web/ditto-overrides.css squares their wrappers as long as
// they keep the rounded-full + bg-background/85 signature.
export { NostrEventSidebarItem }     from '@/components/NostrEventSidebarItem';
export { NsiteSidebarItem }          from '@/components/NsiteSidebarItem';
export { ExternalContentSidebarItem } from '@/components/ExternalContentSidebarItem';

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
