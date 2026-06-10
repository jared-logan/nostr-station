/*
 * Skin replacement for src/components/SidebarNavItem.tsx.
 *
 * Exports the same SidebarNavItem (single row) + SidebarNavList
 * (DnD-aware list of rows) API as upstream — same prop shapes, same
 * delegation to NostrEventSidebarItem / NsiteSidebarItem /
 * ExternalContentSidebarItem for non-standard item types. Replaces
 * ONLY the visual treatment of the standard SidebarNavItem + the
 * internal SidebarDividerItem; data + DnD + sortable behavior is a
 * straight port from upstream so we preserve drag-to-reorder, edit
 * mode, remove handles, etc. exactly.
 *
 * Visual diff from upstream (at DITTO_REF v2.21.0):
 *
 *  - Outer wrapper: drop `rounded-full bg-background/85` — resting
 *    items have no background pill; the row is just text + icon
 *    sitting on the sidebar's own surface (matches the dashboard's
 *    .nav a pattern at src/web/app.css:381-399).
 *  - Inner link: drop `rounded-full py-3 text-lg`; use `rounded-sm
 *    py-2 text-sm` for the tighter station rhythm. Active state gets
 *    `bg-primary/10` (accent-soft surface — Tailwind's `primary/10`
 *    matches color-mix(in srgb, var(--primary) 10%, transparent),
 *    close to the dashboard's --accent-soft 12%).
 *  - Active text: `font-semibold text-primary` instead of upstream's
 *    `font-bold text-primary` — the dashboard uses semibold (600) for
 *    active nav items, not bold (700).
 *  - Edit handles / remove buttons: kept rounded-full because they're
 *    icon-only square targets, and a circular hit-state reads better
 *    at that size.
 *  - Divider: keep the thin border-line look; just drop the wrapper
 *    pill.
 *
 * Behavior preserved 1:1: DnD sensors, sortable IDs, divider/Nostr/
 * nsite/external delegation in the list, the show-indicator dot, the
 * --title-font-family inheritance on the label span.
 */

import { Link } from 'react-router-dom';
import { GripVertical, X } from 'lucide-react';
import {
  DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext, verticalListSortingStrategy, useSortable, arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useCallback } from 'react';
import {
  cn,
  sidebarItemIcon, itemLabel, itemPath,
  isSidebarDivider, isNostrUri, isExternalUri, isNsiteUri,
  NostrEventSidebarItem, NsiteSidebarItem, ExternalContentSidebarItem,
} from '@/skin/adapter';

// ── Sortable item ─────────────────────────────────────────────────────────────

export interface SidebarNavItemProps {
  id: string;
  active: boolean;
  editing: boolean;
  onRemove: (id: string, index?: number) => void;
  onClick?: (e: React.MouseEvent) => void;
  profilePath?: string;
  showIndicator?: boolean;
  /** Extra classes on the link. */
  linkClassName?: string;
  /** Sidebar item ID configured as the homepage. */
  homePage?: string;
}

export function SidebarNavItem({
  id, active, editing, onRemove, onClick, profilePath, showIndicator, linkClassName, homePage,
}: SidebarNavItemProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id, disabled: !editing });
  const style = { transform: CSS.Transform.toString(transform), transition };
  const icon = sidebarItemIcon(id);
  const label = itemLabel(id);
  const path = itemPath(id, profilePath, homePage);

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        'flex items-center transition-colors relative',
        isDragging && 'z-10 opacity-80 shadow-lg bg-background/85 rounded-sm',
      )}
    >
      {editing && (
        <button
          className="flex items-center justify-center w-8 shrink-0 cursor-grab active:cursor-grabbing text-muted-foreground hover:text-foreground transition-colors"
          {...attributes}
          {...listeners}
        >
          <GripVertical className="size-4" />
        </button>
      )}

      <Link
        to={path}
        onClick={onClick}
        className={cn(
          'flex items-center gap-3 py-2 rounded-sm transition-colors flex-1 min-w-0',
          editing ? 'px-2' : 'px-3',
          'hover:bg-secondary/60',
          active
            ? 'font-semibold text-primary bg-primary/10'
            : 'font-normal text-foreground',
          linkClassName ?? 'text-sm',
        )}
      >
        <span className="shrink-0 relative">
          {icon}
          {showIndicator && (
            <span className="absolute -top-1 right-0 size-2.5 bg-primary rounded-full" />
          )}
        </span>
        {/* No --title-font-family here (upstream had it): Ditto's theme
            engine sets that var per-context, which made nav labels swap
            typefaces while navigating between sections. Station nav is
            unconditionally the app font (mono). */}
        <span className="truncate">{label}</span>
      </Link>

      {editing && (
        <button
          onClick={(e) => { e.stopPropagation(); onRemove(id); }}
          className="flex items-center justify-center size-8 shrink-0 rounded-full transition-all text-muted-foreground hover:text-destructive hover:bg-destructive/10"
          title={`Remove ${label}`}
        >
          <X className="size-4" />
        </button>
      )}
    </div>
  );
}

// ── Divider item ──────────────────────────────────────────────────────────────

interface SidebarDividerItemProps {
  sortableId: string;
  editing: boolean;
  onRemove: () => void;
}

function SidebarDividerItem({ sortableId, editing, onRemove }: SidebarDividerItemProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: sortableId, disabled: !editing });
  const style = { transform: CSS.Transform.toString(transform), transition };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        'flex items-center transition-colors relative',
        editing && 'bg-background/85 rounded-sm',
        isDragging && 'z-10 opacity-80 shadow-lg',
      )}
    >
      {editing && (
        <button
          className="flex items-center justify-center w-8 shrink-0 cursor-grab active:cursor-grabbing text-muted-foreground hover:text-foreground transition-colors"
          {...attributes}
          {...listeners}
        >
          <GripVertical className="size-4" />
        </button>
      )}
      <div className={cn('flex-1 flex items-center py-3', editing ? 'px-2' : 'px-3')}>
        <div className="h-px w-full bg-border" />
      </div>
      {editing && (
        <button
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          className="flex items-center justify-center size-8 shrink-0 rounded-full transition-all text-muted-foreground hover:text-destructive hover:bg-destructive/10"
          title="Remove divider"
        >
          <X className="size-4" />
        </button>
      )}
    </div>
  );
}

// ── DnD-aware nav list ────────────────────────────────────────────────────────

export interface SidebarNavListProps {
  items: string[];
  editing: boolean;
  onRemove: (id: string, index?: number) => void;
  onReorder: (newOrder: string[]) => void;
  isActive: (id: string) => boolean;
  getOnClick?: (id: string) => ((e: React.MouseEvent) => void) | undefined;
  getProfilePath?: (id: string) => string | undefined;
  getShowIndicator?: (id: string) => boolean | undefined;
  linkClassName?: string;
  /** Sidebar item ID configured as the homepage. */
  homePage?: string;
}

export function SidebarNavList({
  items, editing, onRemove, onReorder, isActive, getOnClick, getProfilePath, getShowIndicator, linkClassName, homePage,
}: SidebarNavListProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
  );

  // Assign unique sortable IDs: regular items use their id, dividers get "divider-{index}"
  const sortableIds = items.map((id, i) => isSidebarDivider(id) ? `divider-${i}` : id);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = sortableIds.indexOf(active.id as string);
    const newIndex = sortableIds.indexOf(over.id as string);
    if (oldIndex === -1 || newIndex === -1) return;
    onReorder(arrayMove(items, oldIndex, newIndex));
  }, [sortableIds, items, onReorder]);

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
        {items.map((id, i) => {
          const sortableId = sortableIds[i];
          if (isSidebarDivider(id)) {
            return (
              <SidebarDividerItem
                key={sortableId}
                sortableId={sortableId}
                editing={editing}
                onRemove={() => onRemove(id, i)}
              />
            );
          }
          if (isNostrUri(id)) {
            return (
              <NostrEventSidebarItem
                key={id}
                id={id}
                active={isActive(id)}
                editing={editing}
                onRemove={(removeId) => onRemove(removeId, i)}
                onClick={getOnClick?.(id)}
                linkClassName={linkClassName}
              />
            );
          }
          if (isNsiteUri(id)) {
            return (
              <NsiteSidebarItem
                key={id}
                id={id}
                active={isActive(id)}
                editing={editing}
                onRemove={(removeId) => onRemove(removeId, i)}
                onClick={getOnClick?.(id)}
                linkClassName={linkClassName}
              />
            );
          }
          if (isExternalUri(id)) {
            return (
              <ExternalContentSidebarItem
                key={id}
                id={id}
                active={isActive(id)}
                editing={editing}
                onRemove={(removeId) => onRemove(removeId, i)}
                onClick={getOnClick?.(id)}
                linkClassName={linkClassName}
              />
            );
          }
          return (
            <SidebarNavItem
              key={id}
              id={id}
              active={isActive(id)}
              editing={editing}
              onRemove={(removeId) => onRemove(removeId, i)}
              onClick={getOnClick?.(id)}
              profilePath={getProfilePath?.(id)}
              showIndicator={getShowIndicator?.(id)}
              linkClassName={linkClassName}
              homePage={homePage}
            />
          );
        })}
      </SortableContext>
    </DndContext>
  );
}
