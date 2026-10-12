import type { ReactNode } from "react";
import { SegmentTrack, type SegmentTrackProps } from "./SegmentedControl.tsx";

function part(tabsId: string, value: string, kind: "tab" | "panel"): string {
  return `${tabsId}-${kind}-${value.replace(/[^\w-]/g, "_")}`;
}

export interface TabsProps extends SegmentTrackProps {
  // Shared with each TabPanel, which it names and controls.
  id: string;
}

// Looks like a segmented control; selecting a tab shows its panel.
export function Tabs({ id, ...props }: TabsProps) {
  return (
    <SegmentTrack
      {...props}
      parts={{
        role: "tablist",
        segment: (item, selected) => ({
          role: "tab",
          id: part(id, item.value, "tab"),
          "aria-selected": selected,
          "aria-controls": part(id, item.value, "panel"),
        }),
      }}
    />
  );
}

export interface TabPanelProps {
  tabsId: string;
  value: string;
  selected: string;
  swipe?: boolean;
  className?: string;
  children: ReactNode;
}

// A hidden panel stays mounted, so switching tabs never rebuilds what it holds.
export function TabPanel({
  tabsId,
  value,
  selected,
  className,
  children,
  swipe = false,
}: TabPanelProps) {
  return (
    <div
      role="tabpanel"
      id={part(tabsId, value, "panel")}
      aria-labelledby={part(tabsId, value, "tab")}
      className={className}
      hidden={!swipe && value !== selected}
      inert={value !== selected}
      aria-hidden={value !== selected || undefined}
    >
      {children}
    </div>
  );
}
