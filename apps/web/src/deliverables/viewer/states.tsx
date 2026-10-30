import type { ReactNode } from "react";
import { Progress } from "../../ui/Progress.tsx";
import { SegmentedControl } from "../../ui/SegmentedControl.tsx";
import type { ViewChoice, ViewName } from "./views.ts";

function extension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1, dot + 5).toUpperCase() : "FILE";
}

// While a file loads: the shape of what is coming, no words that flash past. A wait long enough to
// wonder about says what it is waiting for.
export function ViewerLoading({ label, note }: { label: string; note?: string }) {
  return (
    <div className="viewer-center" aria-busy="true">
      <Progress label={label} className="viewer-progress" />
      {note && <p className="viewer-loading-note">{note}</p>}
    </div>
  );
}

// A calm stop in the stage: the file's tile, what happened, and what to do instead.
export function ViewerMessage({
  name,
  title,
  children,
  action,
}: {
  name: string;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="viewer-center">
      <div className="viewer-message">
        <span className="viewer-tile" aria-hidden="true">
          {extension(name)}
        </span>
        <p className="viewer-message-title">{title}</p>
        {children && <div className="viewer-message-detail">{children}</div>}
        {action}
      </div>
    </div>
  );
}

// A row of controls above the file: what it can do at the start, more controls or a quiet fact
// about it at the end; nothing when it has none.
export function ViewerBar({
  children,
  note,
  end,
}: {
  children?: ReactNode;
  note?: ReactNode;
  end?: ReactNode;
}) {
  if (!children && !note && !end) return null;
  return (
    <div className="viewer-bar">
      <div className="viewer-bar-controls">{children}</div>
      {end && <div className="viewer-bar-controls viewer-bar-end">{end}</div>}
      {note && <div className="viewer-bar-note">{note}</div>}
    </div>
  );
}

// The ways the file can be shown, at the start of its bar; nothing when there is only one.
export function ViewSwitch({ choice, without }: { choice?: ViewChoice; without?: ViewName }) {
  const items = choice?.items.filter((item) => item.value !== without) ?? [];
  if (!choice || items.length < 2) return null;
  return (
    <SegmentedControl
      size={28}
      aria-label="Show"
      value={choice.value}
      items={items}
      onValueChange={choice.choose}
    />
  );
}
