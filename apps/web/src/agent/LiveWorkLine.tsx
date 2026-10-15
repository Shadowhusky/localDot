import { useEffect, useId, useMemo, useRef, useState } from "react";
import { count } from "../copy/format.ts";
import type { TaskRow } from "../session/status.ts";
import { Collapse, Disclosure } from "../ui/Disclosure.tsx";
import { GroupHeading } from "../ui/GroupHeading.tsx";
import { ScrollArea } from "../ui/ScrollArea.tsx";
import { StatusGlyph } from "../ui/StatusGlyph.tsx";
import { useVirtualRows } from "../ui/useVirtualRows.ts";
import { ActivityRow } from "./ActivityRow.tsx";
import { clock, groupReadSteps } from "./activity.ts";
import type { WorkStep } from "./thread.ts";
import { useFollowScroll } from "./useFollowScroll.ts";

export interface LiveWork {
  phase: "running" | "waiting" | "finished";
  // The status row, which says what the task waits on.
  row?: TaskRow;
  // What dot is doing now, as the HUD says it.
  label: string;
  // Session ms, ticking while the task runs.
  nowMs: number;
}

const PAUSED = new Set<TaskRow | undefined>(["pausing", "paused", "resuming", "recovery"]);

// Each line stays at least this long, so quick steps never flicker past unread.
export const HOLD_MS = 1000;

interface Line {
  id: number;
  text: string;
  leaving?: true;
}

// The newest line slides in while the one before slides out; leaving lines are dropped once their
// exit ends, or at the next change at the latest.
function useHeldLines(text: string) {
  const [lines, setLines] = useState<Line[]>([{ id: 0, text }]);
  const since = useRef(0);
  const current = lines.findLast((line) => !line.leaving);
  useEffect(() => {
    if (current?.text === text) return;
    const wait = Math.max(0, HOLD_MS - (performance.now() - since.current));
    const timer = setTimeout(() => {
      since.current = performance.now();
      setLines((old) => [
        ...old.filter((line) => !line.leaving).map((line) => ({ ...line, leaving: true as const })),
        { id: (old.at(-1)?.id ?? 0) + 1, text },
      ]);
    }, wait);
    return () => clearTimeout(timer);
  }, [text, current?.text]);
  const retire = (id: number) => setLines((old) => old.filter((line) => line.id !== id));
  return { lines, retire };
}

export function LiveWorkLine({
  steps,
  startMs,
  live,
  ended,
  onOpenStep,
}: {
  steps: readonly WorkStep[];
  startMs: number | null;
  // What the turn cost, said once its work is over.
  spend?: { usd: number; estimated: boolean };
  // Given for the latest turn while its task has not ended.
  live: LiveWork | null;
  ended?: "done" | "stopped" | "interrupted" | "error";
  // Shows a step in Activity with its details; only for the task Activity is showing.
  onOpenStep?(key: string): void;
}) {
  const [open, setOpen] = useState(false);
  const running = live?.phase === "running";
  const waiting = live?.phase === "waiting";
  const lastEnd = steps.reduce<number | null>(
    (end, step) => Math.max(end ?? 0, step.endT ?? step.startT),
    null,
  );
  // Only a running task's clock ticks; a wait or an end shows the time its steps took.
  const endMs = running ? (live?.nowMs ?? null) : lastEnd;
  const elapsed = startMs !== null && endMs !== null ? Math.max(0, endMs - startMs) : null;
  const took = (verb: string, joiner: string) =>
    elapsed === null ? verb : `${verb} ${joiner} ${clock(elapsed)}`;
  const failed = steps.filter((step) => step.state === "failed").length;
  // The narration line shows only while dot works; at a wait or the end the summary says it all,
  // and the line keeps what dot last did, so it never speaks a wait's words when it opens again.
  const said = useRef(live?.label ?? "");
  if (running && live) said.current = live.label;
  const { lines, retire } = useHeldLines(said.current);
  const summary = running
    ? "Working"
    : waiting
      ? PAUSED.has(live?.row)
        ? "Paused"
        : "Waiting for you"
      : ended === "stopped"
        ? took("Stopped", "after")
        : ended === "interrupted"
          ? took("Interrupted", "after")
          : ended === "error"
            ? took("Ended", "after")
            : took("Worked", "for");
  const meta = [
    count(steps.length, "step", "steps"),
    failed ? `${failed} failed` : "",
    running && elapsed !== null ? clock(elapsed) : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="thread-work" data-running={running || undefined}>
      <Collapse open={running} className="thread-work-now">
        <p className="thread-work-line">
          {lines.map((line) => (
            <span
              key={line.id}
              className="thread-work-text"
              data-leaving={line.leaving}
              aria-hidden={line.leaving}
              onAnimationEnd={(event) => {
                if (line.leaving && event.target === event.currentTarget) retire(line.id);
              }}
            >
              {line.text}
            </span>
          ))}
        </p>
      </Collapse>
      <Disclosure
        className="thread-work-steps"
        summary={
          <>
            <StatusGlyph
              className="thread-work-glyph"
              state={
                running
                  ? "doing"
                  : waiting
                    ? PAUSED.has(live?.row)
                      ? "skipped"
                      : "ask"
                    : ended === "stopped"
                      ? "skipped"
                      : ended === "error" || ended === "interrupted"
                        ? "failed"
                        : "done"
              }
            />
            <span>
              {summary}
              {meta && <span className="thread-work-meta num"> · {meta}</span>}
            </span>
          </>
        }
        open={open}
        onOpenChange={setOpen}
      >
        {steps.length ? (
          <WorkHistory steps={steps} startMs={startMs} onOpenStep={onOpenStep} />
        ) : (
          <p className="thread-note">No steps yet.</p>
        )}
      </Disclosure>
    </div>
  );
}

const estimateWorkStep = () => 56;
const readGroupOf = (step: WorkStep) => step.readGroup;
function WorkHistory({
  steps,
  startMs,
  onOpenStep,
}: {
  steps: readonly WorkStep[];
  startMs: number | null;
  onOpenStep?(key: string): void;
}) {
  const id = useId();
  const follow = useFollowScroll(String(startMs), true, { glide: false });
  const list = useRef<HTMLOListElement>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const groups = useMemo(() => groupReadSteps(steps, readGroupOf), [steps]);
  const display = useMemo(
    () =>
      groups.flatMap<{
        key: string;
        step?: WorkStep;
        child?: boolean;
        group?: (typeof groups)[number];
      }>((group) => {
        if (group.entries.length === 1) return [{ key: group.key, step: group.entries[0] }];
        const header = { key: `group-${group.key}`, group };
        return expanded.has(group.key)
          ? [header, ...group.entries.map((step) => ({ key: step.key, step, child: true }))]
          : [header];
      }),
    [groups, expanded],
  );
  const keys = useMemo(() => display.map((row) => row.key), [display]);
  const virtual = useVirtualRows(list, keys, estimateWorkStep);
  return (
    <ScrollArea
      className="thread-work-scroll"
      ref={follow.ref}
      tabIndex={0}
      role="region"
      aria-label="Work history"
      onScroll={follow.onScroll}
      onWheel={follow.interrupt}
      onTouchStart={follow.interrupt}
      onPointerDown={follow.interrupt}
      onKeyDown={follow.interrupt}
    >
      <ol ref={list} className="thread-work-list" aria-label="Steps in this turn">
        <li role="presentation" aria-hidden="true" style={{ height: virtual.before }} />
        {virtual.indexes.map((index) => {
          const item = display[index];
          if (!item) return null;
          const { step, group } = item;
          const open = !!group && expanded.has(group.key);
          return (
            <li
              key={item.key}
              ref={virtual.measure}
              data-index={index}
              data-last={index === display.length - 1 || undefined}
              data-anchor
              className="thread-work-window-row"
              data-group-child={item.child || undefined}
            >
              {step ? (
                <ActivityRow
                  id={`${id}-${step.key}`}
                  view={step.meta === step.title ? { ...step, meta: "" } : step}
                  onSelect={onOpenStep && (() => onOpenStep(step.key))}
                  selectLabel="Show in Activity"
                />
              ) : (
                group && (
                  <GroupHeading
                    className="activity-read-group"
                    leading={<StatusGlyph state="done" />}
                    title={group.label}
                    meta={`${group.entries.length} read-only steps · ${open ? "Hide" : "Show"} details`}
                    count={group.entries.length}
                    open={open}
                    onToggle={(trigger) => {
                      follow.anchorTo(trigger);
                      setExpanded((previous) => {
                        const next = new Set(previous);
                        if (next.has(group.key)) next.delete(group.key);
                        else next.add(group.key);
                        return next;
                      });
                    }}
                  />
                )
              )}
            </li>
          );
        })}
        <li role="presentation" aria-hidden="true" style={{ height: virtual.after }} />
      </ol>
    </ScrollArea>
  );
}
