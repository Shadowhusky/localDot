import type { KeyboardEvent, ReactNode } from "react";
import { Badge } from "../ui/Badge.tsx";
import { Collapse } from "../ui/Disclosure.tsx";
import { Icon } from "../ui/Icon.tsx";
import { pressHandlers } from "../ui/press.ts";
import { StatusGlyph } from "../ui/StatusGlyph.tsx";
import type { EntryView } from "./activity.ts";

export interface ActivityRowProps {
  id: string;
  view: EntryView;
  current?: boolean;
  future?: boolean;
  open?: boolean;
  onToggle?(trigger: HTMLButtonElement): void;
  children?: ReactNode;
}

export function ActivityRow({
  id,
  view,
  current = false,
  future = false,
  open = false,
  onToggle,
  children,
}: ActivityRowProps) {
  const face = (
    <>
      <Icon name={view.icon} className="activity-row-icon" />
      <span className="activity-row-title">{view.title}</span>{" "}
      {view.metric && <span className="activity-row-metric num">{view.metric}</span>}{" "}
      <StatusGlyph state={view.state} label={view.stateLabel} />
      {view.reason && (
        <>
          {" "}
          <span className="activity-row-reason">
            {view.notSent && <Badge tone="danger">Not sent</Badge>}
            <span>{view.reason}</span>
          </span>
        </>
      )}
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
      data-danger={view.danger || undefined}
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
      {onToggle ? (
        <button
          {...pressHandlers}
          type="button"
          className="activity-row-head"
          aria-expanded={open}
          aria-controls={`${id}-detail`}
          aria-current={current ? "step" : undefined}
          onClick={(event) => onToggle(event.currentTarget)}
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
