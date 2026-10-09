import { clsx } from "clsx";
import type { ReactNode } from "react";

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
  className,
}: ListRowProps) {
  const heading = <span className="ui-list-row-title">{title}</span>;
  return (
    <div
      className={clsx("ui-list-row", className)}
      data-selected={selected ? "" : undefined}
      data-thumbnail={thumbnail ? "" : undefined}
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
}
