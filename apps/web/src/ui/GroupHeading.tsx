import type { ReactNode } from "react";
import { Icon } from "./Icon.tsx";
import { pressHandlers } from "./press.ts";

// A disclosure heading for a flat, windowed list whose children are measured independently. Its
// leading mark takes the column the rows' status glyphs use, so the group lines up with them.
export function GroupHeading({
  title,
  meta,
  count,
  open,
  leading,
  className,
  onToggle,
}: {
  title: ReactNode;
  meta: string;
  count: number;
  open: boolean;
  leading?: ReactNode;
  className?: string;
  onToggle(trigger: HTMLButtonElement): void;
}) {
  return (
    <button
      {...pressHandlers}
      type="button"
      className={className}
      aria-expanded={open}
      aria-description={meta}
      onClick={(event) => onToggle(event.currentTarget)}
    >
      {leading ?? <span aria-hidden="true" />}
      <span className="ui-group-heading-title">{title}</span>
      <span className="ui-group-heading-trail">
        <span className="ui-group-heading-count num">{count}</span>
        <Icon name="chevron-right" size={12} className="ui-group-heading-chevron" />
      </span>
    </button>
  );
}
