import { useRef } from "react";
export type TheatrePane = "conversation" | "computer" | "activity";
const PANES = ["conversation", "computer", "activity"] as const;
const LABELS = { conversation: "Conversation", computer: "Computer", activity: "Activity" };
export function PaneTabs({
  selected,
  onSelect,
  waiting,
}: {
  selected: TheatrePane;
  onSelect(pane: TheatrePane): void;
  waiting?: boolean;
}) {
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  return (
    <div className="pane-tabs" role="tablist" aria-label="Workspace panes">
      {PANES.map((pane, index) => (
        <button
          key={pane}
          type="button"
          role="tab"
          aria-label={`${LABELS[pane]}${pane === "conversation" && waiting ? ", needs your attention" : ""}`}
          id={`tab-${pane}`}
          aria-controls={`pane-${pane}`}
          aria-selected={selected === pane}
          tabIndex={selected === pane ? 0 : -1}
          ref={(element) => {
            tabs.current[index] = element;
          }}
          onClick={() => onSelect(pane)}
          onKeyDown={(event) => {
            let next = index;
            if (event.key === "ArrowRight") next = (index + 1) % PANES.length;
            else if (event.key === "ArrowLeft") next = (index + PANES.length - 1) % PANES.length;
            else if (event.key === "Home") next = 0;
            else if (event.key === "End") next = PANES.length - 1;
            else return;
            event.preventDefault();
            const target = PANES[next];
            if (target) {
              onSelect(target);
              tabs.current[next]?.focus();
            }
          }}
        >
          {LABELS[pane]}
          {pane === "conversation" && waiting && (
            <span className="pane-waiting" aria-hidden="true">
              •
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
