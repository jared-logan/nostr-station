/*
 * Skin replacement for src/components/SubHeaderBar.tsx.
 *
 * Same API — same children/className/innerClassName/noArc/pinned
 * props, same context provided to descendants via SubHeaderBarContext,
 * same sticky/scroll/safe-area/overflow-arrow behavior. The only diff
 * is the visual treatment of the bar's background and active/hover
 * indicators:
 *
 *  - Upstream paints the bar as an `<ArcBackground variant="down">`
 *    SVG with a curved bottom edge, plus two per-tab SVG overlays
 *    (filled curve under hovered tab + stroked curve under active
 *    tab). The three-SVG stack creates the iconic Ditto tab arc.
 *  - Skin renders the bar as a flat `bg-background/85` div with a
 *    1px `border-b border-border` bottom edge — matches the
 *    dashboard's section-header rhythm at src/web/app.css. Drops the
 *    ArcBackground import entirely.
 *  - Hover state is now handled by TabButton itself (CSS `:hover`),
 *    not by reporting offsets back here. We still provide the
 *    SubHeaderBarContext with `onHover`/`onActive` no-op-ish so
 *    TabButton's useActiveTabIndicator hook keeps reporting (it
 *    drives nothing visual on our side, but the hook's lifecycle
 *    is benign — it just calls our callbacks, which we ignore).
 *  - The active-tab underline is drawn by TabButton via a
 *    `border-b-2 border-primary` class. No SVG, no clip-path, no
 *    horizontal-offset math required.
 *
 * `noArc` prop accepted for ABI compat — ignored (the skin bar is
 * always "no arc"). `pinned`, `className`, `innerClassName` all
 * carry through with their upstream semantics.
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn, useNavHidden, SubHeaderBarContext } from '@/skin/adapter';

interface HoverSlice {
  left: number;
  width: number;
}

interface SubHeaderBarProps {
  children: React.ReactNode;
  /** Extra classes on the outer wrapper (e.g. shrink-0). */
  className?: string;
  /** Extra classes on the inner flex container holding the tabs. */
  innerClassName?: string;
  /** Accepted for ABI compat with upstream; ignored — the skin bar is
   *  always flat. */
  noArc?: boolean;
  /** Keep the bar visible when the mobile top bar hides (slides to
   *  top-0 instead of off-screen). */
  pinned?: boolean;
}

export function SubHeaderBar({ children, className, innerClassName, pinned }: SubHeaderBarProps) {
  // Hover/active slice state is still tracked + provided in context so
  // descendants' useActiveTabIndicator hook doesn't throw — but the
  // values aren't used to paint anything; TabButton handles its own
  // active/hover styling natively.
  const [, setHover] = useState<HoverSlice | null>(null);
  const [, setActive] = useState<HoverSlice | null>(null);
  const navHidden = useNavHidden();

  const barRef = useRef<HTMLDivElement>(null);
  const [atTop, setAtTop] = useState(false);

  // Horizontal overflow scroll arrows (desktop only)
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const checkOverflow = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const tolerance = 2;
    setCanScrollLeft(el.scrollLeft > tolerance);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - tolerance);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    checkOverflow();
    el.addEventListener('scroll', checkOverflow, { passive: true });
    const ro = new ResizeObserver(checkOverflow);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', checkOverflow);
      ro.disconnect();
    };
  }, [checkOverflow]);

  useEffect(() => {
    checkOverflow();
  }, [children, checkOverflow]);

  const scrollBy = (direction: 'left' | 'right') => {
    const el = scrollRef.current;
    if (!el) return;
    const amount = el.clientWidth * 0.6;
    el.scrollBy({ left: direction === 'left' ? -amount : amount, behavior: 'smooth' });
  };

  // Safe-area handling for the mobile pinned case — see upstream comment.
  useEffect(() => {
    if (!pinned) return;
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;top:var(--safe-area-inset-top,env(safe-area-inset-top,0px));left:0;width:0;height:0;visibility:hidden;pointer-events:none';
    document.body.appendChild(probe);
    const safeAreaTop = probe.getBoundingClientRect().top;
    document.body.removeChild(probe);

    const check = () => {
      const bar = barRef.current;
      if (!bar) return;
      setAtTop(bar.getBoundingClientRect().top <= safeAreaTop);
    };
    window.addEventListener('scroll', check, { passive: true });
    check();
    return () => window.removeEventListener('scroll', check);
  }, [pinned]);

  const showSafeAreaPadding = pinned && navHidden && atTop;

  return (
    <SubHeaderBarContext.Provider value={{ onHover: setHover, onActive: setActive, scrollContainerRef: scrollRef }}>
      <div
        ref={barRef}
        className={cn(
          'relative sticky top-mobile-bar sidebar:top-0 z-10',
          pinned
            ? 'max-sidebar:transition-[top,padding-top] max-sidebar:duration-300 max-sidebar:ease-in-out'
            : 'max-sidebar:transition-transform max-sidebar:duration-300 max-sidebar:ease-in-out',
          navHidden && (pinned ? 'max-sidebar:!top-0' : 'nav-hidden-slide'),
          showSafeAreaPadding && 'max-sidebar:safe-area-top',
          // Flat surface + bottom border replaces ArcBackground + curved
          // stroke. bg-background/85 matches upstream's translucency so
          // user-set background images still bleed through; the border
          // gives a clean visual seam against the feed below.
          'bg-background/85 border-b border-border',
          className,
        )}
      >
        {showSafeAreaPadding && (
          <div
            className="absolute top-0 left-0 right-0 bg-background/85 sidebar:hidden"
            style={{ height: 'var(--safe-area-inset-top, env(safe-area-inset-top, 0px))' }}
          />
        )}
        <div className="relative sidebar:pt-2">
          {/* Tab content. No SVG arcs — the bar's own bg + border
              draws the surface, and TabButton handles its own active
              underline via border-b-2. */}
          <div className="relative">
            {canScrollLeft && (
              <button
                type="button"
                aria-label="Scroll tabs left"
                onClick={() => scrollBy('left')}
                className="hidden sidebar:flex absolute left-0 top-0 bottom-0 z-10 items-center pl-0.5 pr-1 bg-gradient-to-r from-background via-background to-transparent cursor-pointer"
              >
                <ChevronLeft className="size-4 text-foreground/60 drop-shadow-md" strokeWidth={4} />
              </button>
            )}
            <div
              ref={scrollRef}
              className={cn('relative flex overflow-x-auto scrollbar-none', innerClassName)}
            >
              {children}
            </div>
            {canScrollRight && (
              <button
                type="button"
                aria-label="Scroll tabs right"
                onClick={() => scrollBy('right')}
                className="hidden sidebar:flex absolute right-0 top-0 bottom-0 z-10 items-center pr-0.5 pl-1 bg-gradient-to-l from-background via-background to-transparent cursor-pointer"
              >
                <ChevronRight className="size-4 text-foreground/60 drop-shadow-md" strokeWidth={4} />
              </button>
            )}
          </div>
        </div>
      </div>
    </SubHeaderBarContext.Provider>
  );
}
