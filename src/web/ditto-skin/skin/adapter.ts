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
export { getAvatarShape } from '@/lib/avatarShape';
export { isItemActive } from '@/lib/sidebarItems';

// ── Additional hooks ────────────────────────────────────────────────
// Drives the LeftSidebar shell (account switching, feed settings,
// unread indicator, NIP-38 status editor, login flows, toast). When
// adding a new skin component that uses one of these hooks directly,
// re-export it here rather than importing from @/hooks/* in the
// component — single seam to absorb upstream churn.
export { useOnboarding }              from '@/hooks/useOnboarding';
export { useLoggedInAccounts }        from '@/hooks/useLoggedInAccounts';
export type { Account }               from '@/hooks/useLoggedInAccounts';
export { useLoginActions }            from '@/hooks/useLoginActions';
export { useFeedSettings }            from '@/hooks/useFeedSettings';
export { useHasUnreadNotifications }  from '@/hooks/useHasUnreadNotifications';
export { useProfileUrl }              from '@/hooks/useProfileUrl';
export { useUserStatus }              from '@/hooks/useUserStatus';
export { usePublishStatus }           from '@/hooks/usePublishStatus';
export { useToast }                   from '@/hooks/useToast';

// ── UI primitives (shadcn) ──────────────────────────────────────────
// These are the most stable surface in the upstream codebase — shadcn
// primitives barely change across releases. Re-exported through the
// adapter anyway for consistency: skin components never reach into
// @/components/ui/* directly, so a future upstream restructure of the
// UI library is a single-file fix.
export { Skeleton } from '@/components/ui/skeleton';
export { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';
export { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
export { Input } from '@/components/ui/input';

// ── Upstream feature components consumed by the skin ─────────────────
// EmojifiedText / VerifiedNip05Text / ProfileSearchDropdown /
// SidebarMoreMenu / LoginDialog / FollowQRDialog: not (yet) replaced
// by the skin, but consumed by skin shell components. The CSS overlay
// continues to style them. LoginDialog uses a default export upstream;
// re-export it as a named export here so skin components can import
// it consistently via `import { LoginDialog }`.
export { EmojifiedText }          from '@/components/CustomEmoji';
export { VerifiedNip05Text }      from '@/components/Nip05Badge';
export { ProfileSearchDropdown }  from '@/components/ProfileSearchDropdown';
export { SidebarMoreMenu }        from '@/components/SidebarMoreMenu';
export { FollowQRDialog }         from '@/components/FollowQRDialog';
export { default as LoginDialog } from '@/components/auth/LoginDialog';

// ── Skin-replaced components, re-exported for symmetry ──────────────
// DittoLogo and SidebarNavList are replaced by the skin layer
// (applySkin overwrites the upstream paths before vite resolves these
// modules). Re-exported here so other skin components import via the
// adapter — anyone reading the adapter sees the full surface in one
// place, and the import path doesn't change if a component leaves or
// joins the skin set later.
export { DittoLogo }                       from '@/components/DittoLogo';
export { SidebarNavList }                  from '@/components/SidebarNavItem';
export type { SidebarNavListProps, SidebarNavItemProps } from '@/components/SidebarNavItem';

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
