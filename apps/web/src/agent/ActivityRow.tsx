import type { KeyboardEvent, ReactNode } from "react";
import { useSessionNow } from "../session/useNowMs.ts";
import { Collapse } from "../ui/Disclosure.tsx";
import { Icon } from "../ui/Icon.tsx";
import { pressHandlers } from "../ui/press.ts";
import { StatusGlyph } from "../ui/StatusGlyph.tsx";
import { clock, type EntryView } from "./activity.ts";
import { reducedMotion } from "./useFollowScroll.ts";
import "./activity.css";

// Long enough for a row's detail to finish opening before it is brought into view.
const REVEAL_AFTER = 300;

export function reveal(element: Element | null) {
  element?.scrollIntoView?.({ block: "nearest", behavior: reducedMotion() ? "auto" : "smooth" });
}

// Brings a row that has just been opened into view once its detail has unfolded.
export function revealOpened(row: Element | null) {
  window.setTimeout(() => reveal(row), REVEAL_AFTER);
}

export interface ActivityRowProps {
  id: string;
  view: EntryView;
  current?: boolean;
  future?: boolean;
  open?: boolean;
  onToggle?(trigger: HTMLButtonElement): void;
  // The step under way, whose time counts by itself from here (session ms), at `nowMs` when given.
  runningFrom?: number;
  nowMs?: number;
  children?: ReactNode;
}

// A step or a turn under way: its time counts by itself, or reads `nowMs` when given. `lead` goes
// before it once there is a time to show.
export function RunningTime({
  from,
  nowMs,
  lead = "",
}: {
  from: number;
  nowMs?: number;
  lead?: string;
}) {
  const counted = useSessionNow(nowMs === undefined, from);
  const at = nowMs ?? counted;
  return at === null ? null : `${lead}${clock(Math.max(0, at - from))}`;
}

// One flat row: a status (or a file's glyph), what happened over where and how, and its time.
export function ActivityRow({
  id,
  view,
  current = false,
  future = false,
  open = false,
  onToggle,
  runningFrom,
  nowMs,
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
        <span className="activity-row-time num">
          {runningFrom === undefined ? view.time : <RunningTime from={runningFrom} nowMs={nowMs} />}
        </span>
        {onToggle && <Icon name="chevron-right" size={12} className="activity-row-chevron" />}
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
