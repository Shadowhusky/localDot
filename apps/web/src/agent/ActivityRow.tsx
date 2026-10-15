import type { KeyboardEvent, ReactNode } from "react";
import { Collapse } from "../ui/Disclosure.tsx";
import { Icon } from "../ui/Icon.tsx";
import { pressHandlers } from "../ui/press.ts";
import { StatusGlyph } from "../ui/StatusGlyph.tsx";
import type { EntryView } from "./activity.ts";
import "./activity.css";

export interface ActivityRowProps {
  id: string;
  view: EntryView;
  current?: boolean;
  future?: boolean;
  open?: boolean;
  onToggle?(trigger: HTMLButtonElement): void;
  // A row that opens elsewhere, such as a chat row showing its step in Activity.
  onSelect?(): void;
  selectLabel?: string;
  children?: ReactNode;
}

// One flat row: a status (or a file's glyph), what happened over where and how, and its time.
export function ActivityRow({
  id,
  view,
  current = false,
  future = false,
  open = false,
  onToggle,
  onSelect,
  selectLabel,
  children,
}: ActivityRowProps) {
  const face = (
    <>
      {view.icon ? (
        <Icon name={view.icon} className="activity-row-glyph" />
      ) : (
        <StatusGlyph state={view.state} label={view.stateLabel} />
      )}
      <span className="activity-row-text">
        <span className="activity-row-title">{view.title}</span>{" "}
        {view.meta && <span className="activity-row-meta">{view.meta}</span>}
      </span>{" "}
      <span className="activity-row-trailing">
        <span className="activity-row-time num">{view.time}</span>
        {(onToggle || onSelect) && (
          <Icon name="chevron-right" size={12} className="activity-row-chevron" />
        )}
      </span>
    </>
  );
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Escape anywhere inside an unfolded step folds it; the head button is the control.
    <div
      className="activity-row"
      data-testid={view.testId}
      data-state={view.state}
      data-current={current || undefined}
      data-future={future || undefined}
      data-open={open || undefined}
      data-failed={view.failed || undefined}
      data-anchor=""
      onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key !== "Escape" || !open || !onToggle) return;
        const head = event.currentTarget.querySelector<HTMLButtonElement>(".activity-row-head");
        if (!head) return;
        event.stopPropagation();
        onToggle(head);
        head.focus();
      }}
    >
      {onToggle || onSelect ? (
        <button
          {...pressHandlers}
          type="button"
          className="activity-row-head"
          aria-expanded={onToggle ? open : undefined}
          aria-controls={onToggle ? `${id}-detail` : undefined}
          aria-description={onToggle ? undefined : selectLabel}
          aria-current={current ? "step" : undefined}
          onClick={(event) => (onToggle ? onToggle(event.currentTarget) : onSelect?.())}
        >
          {face}
        </button>
      ) : (
        <div className="activity-row-head" aria-current={current ? "step" : undefined}>
          {face}
        </div>
      )}
      {onToggle && (
        <Collapse id={`${id}-detail`} open={open} className="activity-row-detail">
          {children}
        </Collapse>
      )}
    </div>
  );
}
