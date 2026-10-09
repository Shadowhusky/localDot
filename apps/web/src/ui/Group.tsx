import { clsx } from "clsx";
import type { ComponentProps, ReactNode } from "react";
import { Icon } from "./Icon.tsx";
import type { IconName } from "./icons.ts";

// A grouped list: rows on one raised surface, a separator between each, as in a settings pane. A
// Switch or an inline Field takes the row's place when given the ui-group-row class. Roomy rows sit
// further in, for a group that stands on its own on a page.
export function Group({
  className,
  roomy = false,
  ...props
}: ComponentProps<"div"> & { roomy?: boolean }) {
  return (
    <div {...props} className={clsx("ui-group", className)} data-roomy={roomy ? "" : undefined} />
  );
}

export interface GroupRowProps {
  label: ReactNode;
  // A second line under the label.
  detail?: ReactNode;
  // A 28 px tile at the row's start: IconTile or Monogram.
  leading?: ReactNode;
  // The row's value or control at its end.
  trailing?: ReactNode;
  // A row that opens something: the whole row is the button, with a chevron after its value.
  onSelect?(trigger: HTMLButtonElement): void;
  className?: string;
  // What opens under the row, inside the same group cell.
  children?: ReactNode;
}

export function GroupRow({
  label,
  detail,
  leading,
  trailing,
  onSelect,
  className,
  children,
}: GroupRowProps) {
  const body = (
    <>
      {leading}
      <span className="ui-group-row-text">
        <span className="ui-group-row-label">{label}</span>
        {detail && <span className="ui-group-row-detail">{detail}</span>}
      </span>
      {(trailing || onSelect) && (
        <span className="ui-group-row-trailing">
          {trailing}
          {onSelect && <Icon name="chevron-right" size={16} className="ui-group-row-chevron" />}
        </span>
      )}
    </>
  );
  if (onSelect)
    return (
      <button
        type="button"
        className={clsx("ui-group-row", className)}
        data-leading={leading ? "" : undefined}
        data-link=""
        onClick={(event) => onSelect(event.currentTarget)}
      >
        {body}
      </button>
    );
  return (
    <div className={clsx("ui-group-row", className)} data-leading={leading ? "" : undefined}>
      <div className="ui-group-row-line">{body}</div>
      {children}
    </div>
  );
}

export function IconTile({ icon }: { icon: IconName }) {
  return (
    <span className="ui-tile" aria-hidden="true">
      <Icon name={icon} size={16} />
    </span>
  );
}

export function Monogram({ children }: { children: ReactNode }) {
  return (
    <span className="ui-tile" data-monogram="" aria-hidden="true">
      {children}
    </span>
  );
}

// A group's heading, with an aside at its end: a note or one action.
export function GroupHead({
  title,
  aside,
  id,
}: {
  title: ReactNode;
  aside?: ReactNode;
  id?: string;
}) {
  return (
    <div className="ui-group-head">
      <h4 id={id} className="ui-group-title">
        {title}
      </h4>
      {aside && <span className="ui-group-aside">{aside}</span>}
    </div>
  );
}

export function GroupNote({ className, ...props }: ComponentProps<"p">) {
  return <p {...props} className={clsx("ui-group-note", className)} />;
}
