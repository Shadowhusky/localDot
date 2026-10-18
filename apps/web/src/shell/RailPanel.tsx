import type { ReactNode } from "react";
import { SegmentedControl, type SegmentItem } from "../ui/SegmentedControl.tsx";
import "./rails.css";

export interface RailPanelProps {
  label: string;
  hidden?: boolean;
  // The views the panel switches between; the selected one is the panel's only title.
  views?: readonly SegmentItem[];
  view?: string;
  onView?(view: string): void;
  // At the header's trailing edge.
  end?: ReactNode;
  className?: string;
  children: ReactNode;
}

// The rail's console: a segmented header over one body, which holds a single scroller and the
// composer at its foot.
export function RailPanel({
  label,
  hidden,
  views,
  view,
  onView,
  end,
  className,
  children,
}: RailPanelProps) {
  const switching = !!views && views.length > 1 && view !== undefined && !!onView;
  return (
    <aside
      className={className ? `rail-panel ${className}` : "rail-panel"}
      aria-label={label}
      hidden={hidden}
      inert={hidden}
    >
      {(switching || end) && (
        <div className="rail-head">
          {switching ? (
            <SegmentedControl
              aria-label="Show"
              size={32}
              compact
              items={views}
              value={view}
              onValueChange={onView}
            />
          ) : (
            <span />
          )}
          {end}
        </div>
      )}
      {children}
    </aside>
  );
}
