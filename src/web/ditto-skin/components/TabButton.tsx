/*
 * Skin replacement for src/components/TabButton.tsx.
 *
 * Same props ({ label, active, onClick, disabled, className, children })
 * and same scroll-into-view + scroll-to-top-on-active-click behavior as
 * upstream. Visual diff:
 *
 *  - Active state: `border-b-2 border-primary text-primary` instead of
 *    just `text-foreground` (upstream relies on SubHeaderBar's separate
 *    SVG arc indicator for the underline; the skin SubHeaderBar drops
 *    that, so each TabButton paints its own).
 *  - Inactive state: matches upstream's `text-muted-foreground`.
 *  - `border-b-2 border-transparent` on every tab so active/inactive
 *    have the same height — switching between them doesn't shift
 *    surrounding layout by 2px.
 *  - `-mb-px` pulls each tab's bottom border DOWN by 1px so the active
 *    primary underline visually overlaps SubHeaderBar's own bottom
 *    border (reads as one continuous line with a colored segment).
 *
 * Still imports useSubHeaderBarHover + useActiveTabIndicator and calls
 * them with the upstream lifecycle — even though the skin SubHeaderBar
 * ignores the reported slices, the hooks are harmless side-effect-only,
 * and keeping the calls means the upstream SubHeaderBar (if ever
 * rendered alongside a skin TabButton) still works.
 */

import { useRef, useLayoutEffect } from 'react';
import { cn, useSubHeaderBarHover, useActiveTabIndicator } from '@/skin/adapter';

interface TabButtonProps {
  /** Tab display label. */
  label: string;
  /** Whether this tab is currently selected. */
  active: boolean;
  /** Called when the tab is clicked. Scroll-to-top is handled internally. */
  onClick: () => void;
  /** Disable the button (e.g. when logged out). */
  disabled?: boolean;
  /** Extra classes forwarded to the `<button>`. */
  className?: string;
  /** Optional children rendered inside the button instead of the label text. */
  children?: React.ReactNode;
}

export function TabButton({ label, active, onClick, disabled, className, children }: TabButtonProps) {
  const ref = useRef<HTMLButtonElement>(null);
  const { onHover, scrollContainerRef } = useSubHeaderBarHover();
  const { reportSlice } = useActiveTabIndicator(active, ref);

  // Auto-scroll the active tab into view when the container overflows
  useLayoutEffect(() => {
    if (!active) return;
    const btn = ref.current;
    const container = scrollContainerRef.current;
    if (btn && container) {
      const btnLeft = btn.offsetLeft;
      const btnRight = btnLeft + btn.offsetWidth;
      const viewLeft = container.scrollLeft;
      const viewRight = viewLeft + container.clientWidth;
      if (btnLeft < viewLeft) {
        container.scrollTo({ left: btnLeft - 8, behavior: 'smooth' });
      } else if (btnRight > viewRight) {
        container.scrollTo({ left: btnRight - container.clientWidth + 8, behavior: 'smooth' });
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const handleMouseEnter = () => { const s = reportSlice(); if (s) onHover(s); };
  const handleMouseLeave = () => onHover(null);

  const handleClick = () => {
    // Clear hover highlight immediately — on mobile, mouseleave never fires
    // after a tap, so the hover arc would otherwise stay visible.
    onHover(null);

    if (active) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } else {
      window.scrollTo({ top: 0 });
      onClick();
    }
  };

  return (
    <button
      ref={ref}
      onClick={handleClick}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      disabled={disabled}
      className={cn(
        // Layout: same flex-1 + center + horizontal padding as upstream
        // so tab widths divide the bar evenly. Slightly tighter vertical
        // padding (py-2 vs upstream's py-1.5 — the larger touch target
        // accommodates losing the arc visual). px-4 unchanged.
        'flex-1 flex items-center justify-center py-2 px-4 text-sm font-medium whitespace-nowrap',
        'transition-colors relative',
        // Always reserve 2px of bottom border so layout doesn't jump
        // when switching tabs. -mb-px overlaps the bar's own
        // border-bottom for a continuous baseline.
        'border-b-2 -mb-px',
        active
          ? 'border-primary text-primary'
          : 'border-transparent text-muted-foreground hover:text-foreground',
        disabled && 'opacity-50 cursor-not-allowed',
        className,
      )}
    >
      {children ?? label}
    </button>
  );
}
