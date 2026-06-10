/*
 * Skin replacement for src/components/WidgetCard.tsx.
 *
 * Same API and behavior as upstream v2.21.0 — height resize with
 * pointer drag (live local height, committed to config on pointer
 * up), fillHeight vs ScrollArea content modes, remove + drag-handle
 * buttons, optional title link. The resize logic is a straight port.
 *
 * Visual diff — the widget reads as a dashboard panel instead of a
 * Ditto card (compare nostr-station's right-rail Status / Music /
 * AI Chat widgets in src/web/app.css):
 *
 *  - Wrapper: `border border-border rounded-md` added (upstream is a
 *    borderless rounded-xl blob on the background). The border is
 *    what makes it a *panel*.
 *  - Header: dedicated bar with `border-b border-border` separating
 *    it from content — upstream's header floats inside the card.
 *  - Title: 11px semibold uppercase tracking-wide muted (dashboard
 *    panel-label convention) — upstream uses text-xl font-semibold,
 *    which reads as a content heading rather than chrome.
 *  - Icon: size-3.5 muted to match the smaller title scale.
 *  - Content padding: p-2 kept (widgets manage their own interior).
 *  - Resize handle: kept, with a subtle hover affordance.
 */

import { useState, useCallback, useEffect, useRef, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { GripVertical, X } from 'lucide-react';
import {
  cn,
  ScrollArea,
  type WidgetDefinition,
  type WidgetConfig,
} from '@/skin/adapter';

interface WidgetCardProps {
  definition: WidgetDefinition;
  config: WidgetConfig;
  onRemove: () => void;
  onHeightChange: (height: number) => void;
  isDragging?: boolean;
  dragHandleProps?: Record<string, unknown>;
  children: ReactNode;
}

/** Wrapper for each widget in the sidebar — header, height control. */
export function WidgetCard({
  definition,
  config,
  onRemove,
  onHeightChange,
  isDragging,
  dragHandleProps,
  children,
}: WidgetCardProps) {
  const configHeight = config.height ?? definition.defaultHeight;
  const Icon = definition.icon;

  // Local height for smooth resize — only commits to config on pointer up.
  const [liveHeight, setLiveHeight] = useState(configHeight);
  const [resizing, setResizing] = useState(false);
  const liveHeightRef = useRef(liveHeight);

  // Sync local height when config changes externally (e.g. cross-device sync).
  useEffect(() => {
    if (!resizing) {
      setLiveHeight(configHeight);
    }
  }, [configHeight, resizing]);

  const handleResizeStart = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    setResizing(true);
    const startY = e.clientY;
    const startHeight = liveHeightRef.current;

    const onMove = (ev: PointerEvent) => {
      const newHeight = Math.max(
        definition.minHeight,
        Math.min(definition.maxHeight, startHeight + (ev.clientY - startY)),
      );
      liveHeightRef.current = newHeight;
      setLiveHeight(newHeight);
    };

    const onUp = () => {
      setResizing(false);
      onHeightChange(liveHeightRef.current);
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    };

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  }, [definition.minHeight, definition.maxHeight, onHeightChange]);

  return (
    <div
      className={cn(
        'bg-background/85 border border-border rounded-md overflow-hidden transition-shadow',
        isDragging && 'shadow-lg ring-1 ring-primary/20',
        resizing && 'select-none',
      )}
    >
      {/* Header — dashboard panel-label bar */}
      <div className="flex items-center gap-1.5 px-3 py-2 border-b border-border">
        {/* Icon + label */}
        {definition.href ? (
          <Link to={definition.href} className="flex items-center gap-1.5 flex-1 min-w-0 text-muted-foreground hover:text-primary transition-colors">
            <Icon className="size-3.5 shrink-0" />
            <span className="text-[11px] font-semibold uppercase tracking-[0.12em] truncate">{definition.label}</span>
          </Link>
        ) : (
          <>
            <Icon className="size-3.5 text-muted-foreground shrink-0" />
            <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground flex-1 truncate">{definition.label}</span>
          </>
        )}

        {/* Remove */}
        <button
          onClick={onRemove}
          className="p-0.5 rounded text-muted-foreground hover:text-destructive transition-colors"
          aria-label="Remove widget"
        >
          <X className="size-3.5" />
        </button>

        {/* Drag handle */}
        <button
          className="p-0.5 rounded text-muted-foreground/50 hover:text-muted-foreground cursor-grab active:cursor-grabbing transition-colors"
          {...dragHandleProps}
          tabIndex={-1}
        >
          <GripVertical className="size-3.5" />
        </button>
      </div>

      {/* Content */}
      {definition.fillHeight ? (
        <div style={{ height: liveHeight }} className={cn('p-2', !resizing && 'transition-[height] duration-200')}>
          {children}
        </div>
      ) : (
        <ScrollArea style={{ maxHeight: liveHeight }} className={cn(!resizing && 'transition-[max-height] duration-200')}>
          <div className="p-2">
            {children}
          </div>
        </ScrollArea>
      )}

      {/* Resize handle */}
      <div
        onPointerDown={handleResizeStart}
        className="h-1.5 cursor-ns-resize flex items-center justify-center hover:bg-secondary/60 transition-colors"
      />
    </div>
  );
}
