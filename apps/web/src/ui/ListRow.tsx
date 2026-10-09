import { clsx } from "clsx";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { REDUCED_MOTION } from "./media.ts";
import { attachRowSwipe } from "./row-swipe.ts";

export interface RowSwipeAction {
  // The face's word, such as Delete.
  label: string;
  // What a screen reader or a keyboard hears for it, such as "Delete Tidy my Downloads".
  accessibleLabel: string;
  onAction(trigger: HTMLElement): void;
}

export interface ListRowProps {
  title: ReactNode;
  meta?: ReactNode;
  thumbnail?: ReactNode;
  // A short tabular value before the actions, such as a duration.
  trailing?: ReactNode;
  // Shown on hover, focus and selection; their cell keeps its width either way, so nothing moves.
  actions?: ReactNode;
  selected?: boolean;
  // Makes the whole row choose this item. The actions stay their own buttons above it.
  onSelect?(): void;
  // On a touch screen the row slides left to show this action's face behind it.
  swipe?: RowSwipeAction;
  // A narrower list's row: shorter, with a smaller thumbnail, as on a phone.
  compact?: boolean;
  className?: string;
}

// A grid row, never absolute positioning, so its actions cannot overlap a neighbour.
export function ListRow({
  title,
  meta,
  thumbnail,
  trailing,
  actions,
  selected = false,
  onSelect,
  swipe,
  compact = false,
  className,
}: ListRowProps) {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const heading = <span className="ui-list-row-title">{title}</span>;
  const row = (
    <div
      ref={setElement}
      className={clsx("ui-list-row", className)}
      data-selected={selected ? "" : undefined}
      data-thumbnail={thumbnail ? "" : undefined}
      data-compact={compact ? "" : undefined}
    >
      {thumbnail && (
        <span className="ui-list-row-thumbnail" aria-hidden="true">
          {thumbnail}
        </span>
      )}
      <span className="ui-list-row-text">
        {onSelect ? (
          <button
            type="button"
            className="ui-list-row-select"
            aria-pressed={selected}
            onClick={onSelect}
          >
            {heading}
          </button>
        ) : (
          heading
        )}
        {meta && <span className="ui-list-row-meta">{meta}</span>}
      </span>
      <span className="ui-list-row-trailing">{trailing}</span>
      <span className="ui-list-row-actions">{actions}</span>
    </div>
  );
  return swipe ? (
    <SwipeFace row={element} action={swipe}>
      {row}
    </SwipeFace>
  ) : (
    row
  );
}

// The face behind a swiping row. It stays a button a keyboard or a screen reader can reach, and
// focusing it slides the row aside so what has focus can be seen.
function SwipeFace({
  row,
  action,
  children,
}: {
  row: HTMLElement | null;
  action: RowSwipeAction;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const control = useRef<{ open(): void; close(): void } | null>(null);
  useEffect(() => {
    if (!row) return;
    const attached = attachRowSwipe(row, {
      rest: setOpen,
      reducedMotion: () => window.matchMedia?.(REDUCED_MOTION).matches ?? false,
    });
    control.current = attached;
    return () => {
      control.current = null;
      attached.detach();
    };
  }, [row]);
  return (
    <div className="ui-list-row-swipe" data-open={open ? "" : undefined}>
      {children}
      <button
        type="button"
        className="ui-list-row-face"
        aria-label={action.accessibleLabel}
        onFocus={() => control.current?.open()}
        onBlur={() => control.current?.close()}
        onClick={(event) => action.onAction(event.currentTarget)}
      >
        {action.label}
      </button>
    </div>
  );
}
