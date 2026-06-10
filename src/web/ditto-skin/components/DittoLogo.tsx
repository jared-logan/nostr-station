/*
 * Skin replacement for src/components/DittoLogo.tsx.
 *
 * Upstream renders the logo as a `mask-image` over a flat
 * `background-color: hsl(var(--primary))` div — only the SVG's alpha
 * channel survives, every color in the file gets flattened to one tone
 * of the accent. Combined with an occasional canvas-rasterized pixel-art
 * variant for logged-in users (~1-in-20), the result is two Ditto-
 * flavored treatments that hide nori's real colors.
 *
 * We render the served logo (whatever applyBranding() copied to
 * /logo.svg — nori.svg in our build) as a plain <img>. The full SVG
 * color palette comes through and the easter-egg variant is dropped
 * intentionally (the panel should always read as ours, not occasionally
 * as Ditto's pixelated easter egg).
 *
 * ABI compatibility: keeps the original named export, the prop shape
 * `{ className?, size? }`, and `size = 40` default — every upstream
 * import site (MainLayout, LeftSidebar, MobileDrawer, MobileTopBar,
 * LandingHero, etc.) continues to work without changes.
 */

import { useAppContext, cn } from '@/skin/adapter';

interface DittoLogoProps {
  className?: string;
  size?: number;
}

export function DittoLogo({ className, size = 40 }: DittoLogoProps) {
  const { config } = useAppContext();

  return (
    <img
      src="/logo.svg"
      alt={config.appName}
      width={size}
      height={size}
      className={cn('block select-none', className)}
      style={{ width: size, height: size }}
      draggable={false}
    />
  );
}
