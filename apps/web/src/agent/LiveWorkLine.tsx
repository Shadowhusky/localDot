import "../ui/work-layout.css";
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { count } from "../copy/format.ts";
import type { TaskRow } from "../session/status.ts";
import { Collapse, Disclosure } from "../ui/Disclosure.tsx";
import { GroupHeading } from "../ui/GroupHeading.tsx";
import { ScrollArea } from "../ui/ScrollArea.tsx";
import { StatusGlyph } from "../ui/StatusGlyph.tsx";
import { useVirtualRows } from "../ui/useVirtualRows.ts";
import { ActivityDetail } from "./ActivityDetails.tsx";
import { ActivityRow, RunningTime, revealOpened } from "./ActivityRow.tsx";
import { clock, groupReadSteps, hasDetails } from "./activity.ts";
import { useStepPreviewEnvironment } from "./StepPreview.tsx";
import type { WorkStep } from "./thread.ts";
import { useFollowScroll } from "./useFollowScroll.ts";
import { WorkPictures } from "./WorkPictures.tsx";

export interface LiveWork {
  phase: "running" | "waiting" | "finished";
  // The status row, which says what the task waits on.
  row?: TaskRow;
  // What dot is doing now, as the HUD says it.
  label: string;
  // Session ms, when the line is not to keep its own time while the task runs.
  nowMs?: number;
}

const PAUSED = new Set<TaskRow | undefined>(["pausing", "paused", "resuming", "recovery"]);

// Each line stays at least this long, so quick steps never flicker past unread.
export const HOLD_MS = 1000;
// An open run's list keeps at least this much room: about three steps.
const MIN_ROOM = 120;

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

interface LiveWorkLineProps {
  steps: readonly WorkStep[];
  startMs: number | null;
  // What the turn cost, said once its work is over.
  spend?: { usd: number; estimated: boolean };
  // Given for the latest turn while its task has not ended.
  live: LiveWork | null;
  ended?: "done" | "stopped" | "interrupted" | "error";
  // The task an earlier turn's steps were recorded in; otherwise the task the thread shows.
  sessionId?: string;
}

// A turn's steps are rebuilt with every event; they draw the same while what the line shows of
// them is the same.
export function sameSteps(was: readonly WorkStep[], now: readonly WorkStep[]): boolean {
  return (
    was === now ||
    (was.length === now.length &&
      was.every((step, index) => {
        const other = now[index];
        return (
          step === other ||
          (!!other &&
            step.key === other.key &&
            step.readGroup === other.readGroup &&
            step.entry === other.entry &&
            step.changes === other.changes &&
            step.state === other.state &&
            step.title === other.title &&
            step.meta === other.meta &&
            step.time === other.time &&
            step.startT === other.startT &&
            step.endT === other.endT)
        );
      }))
  );
}

// What the line shows of the task's work now; the same while it says the same.
export const sameLive = (was: LiveWork | null, now: LiveWork | null) =>
  was?.phase === now?.phase &&
  was?.row === now?.row &&
  was?.label === now?.label &&
  was?.nowMs === now?.nowMs;

const sameLine = (was: LiveWorkLineProps, now: LiveWorkLineProps) =>
  sameSteps(was.steps, now.steps) &&
  was.startMs === now.startMs &&
  was.spend?.usd === now.spend?.usd &&
  was.spend?.estimated === now.spend?.estimated &&
  sameLive(was.live, now.live) &&
  was.ended === now.ended &&
  was.sessionId === now.sessionId;

// A run of steps between what dot said. The run dot is at stays open while it works, so its steps
// stream in; the others fold to their summary unless the reader opened them. A single finished step
// is its own row.
export const LiveWorkLine = memo(function LiveWorkLine({
  steps,
  startMs,
  live,
  ended,
  sessionId,
}: LiveWorkLineProps) {
  const [chosen, setChosen] = useState<boolean | null>(null);
  const open = chosen ?? !!live;
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = root.current;
    const viewport = node?.closest<HTMLElement>(".thread-scroll");
    if (!open || !node || !viewport) return;
    const trigger = node.querySelector<HTMLElement>(".ui-disclosure-trigger");
    let frame = 0;
    // The run's head stays in view with its list, which keeps room for a few steps however short
    // the thread.
    const measure = () => {
      const available = viewport.clientHeight - (trigger?.offsetHeight ?? 0) - 24;
      node.style.setProperty("--work-history-room", `${Math.max(MIN_ROOM, available)}px`);
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    for (const element of [viewport, trigger]) if (element) observer?.observe(element);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      node.style.removeProperty("--work-history-room");
    };
  }, [open]);
  const running = live?.phase === "running";
  const waiting = live?.phase === "waiting";
  const lastEnd = steps.reduce<number | null>(
    (end, step) => Math.max(end ?? 0, step.endT ?? step.startT),
    null,
  );
  // Only a running task's clock ticks (RunningTime); a wait or an end shows the time its steps took.
  const elapsed = startMs !== null && lastEnd !== null ? Math.max(0, lastEnd - startMs) : null;
  const took = (verb: string, joiner: string) =>
    elapsed === null ? verb : `${verb} ${joiner} ${clock(elapsed)}`;
  const failed = steps.filter((step) => step.state === "failed").length;
  // The narration line shows only while dot works; at a wait or the end the summary says it all,
  // and the line keeps what dot last did, so it never speaks a wait's words when it opens again.
  const said = useRef(live?.label ?? "");
  if (running && live) said.current = live.label;
  const { lines, retire } = useHeldLines(said.current);
  if (steps.length === 1 && !live && (!ended || ended === "done"))
    return <OneStep step={steps[0] as WorkStep} sessionId={sessionId} />;
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
  const counting = running && startMs !== null;
  const face = (
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
        {(steps.length > 0 || counting) && (
          <span className="thread-work-meta num">
            {steps.length > 0 && ` · ${count(steps.length, "step", "steps")}`}
            {failed > 0 && (
              <>
                {" · "}
                <span className="thread-work-failed">{failed} failed</span>
              </>
            )}
            {counting && <RunningTime from={startMs} nowMs={live?.nowMs} lead=" · " />}
          </span>
        )}
      </span>
    </>
  );
  return (
    <div
      ref={root}
      className="thread-work"
      data-live={!!live || undefined}
      data-running={running || undefined}
    >
      {steps.length ? (
        <Disclosure
          className="thread-work-steps"
          summary={face}
          open={open}
          onOpenChange={setChosen}
        >
          <WorkHistory steps={steps} startMs={startMs} sessionId={sessionId} />
        </Disclosure>
      ) : (
        <p className="thread-work-status">{face}</p>
      )}
      {/* What dot is doing now, while its steps are folded away; an open list ends on it. */}
      <Collapse open={running && steps.length > 0 && !open} className="thread-work-now">
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
              <span className="thread-work-glint" data-text={line.text} aria-hidden="true" />
            </span>
          ))}
        </p>
      </Collapse>
      {/* An open list unfolds each step's own pictures; a folded run shows them under its head. */}
      {!open && <WorkPictures steps={steps} sessionId={sessionId} onMore={() => setChosen(true)} />}
    </div>
  );
}, sameLine);

// A step with the details it unfolds in place, where there is a task to read them from. A step that
// has not changed is not drawn again as the steps after it arrive.
const StepRow = memo(function StepRow({
  id,
  step,
  sessionId,
  open,
  onToggle,
}: {
  id: string;
  step: WorkStep;
  sessionId?: string;
  open: boolean;
  onToggle(key: string, trigger: HTMLButtonElement): void;
}) {
  const preview = useStepPreviewEnvironment();
  const detail = !!preview && hasDetails(step.entry, step.changes);
  return (
    <ActivityRow
      id={id}
      view={step.meta === step.title ? { ...step, meta: "" } : step}
      open={open}
      onToggle={detail ? (trigger) => onToggle(step.key, trigger) : undefined}
    >
      {detail && preview && (
        <ActivityDetail
          entry={step.entry}
          changes={step.changes}
          api={preview.api}
          sessionId={sessionId ?? preview.sessionId}
          scale={preview.scale}
          replay={false}
        />
      )}
    </ActivityRow>
  );
});

function OneStep({ step, sessionId }: { step: WorkStep; sessionId?: string }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const show = (_key: string, trigger: HTMLButtonElement) => {
    setOpen(!open);
    if (!open) revealOpened(trigger.closest(".activity-row"));
  };
  return (
    <div className="thread-work" data-single="">
      <StepRow id={id} step={step} sessionId={sessionId} open={open} onToggle={show} />
      <WorkPictures steps={[step]} sessionId={sessionId} onMore={() => setOpen(true)} />
    </div>
  );
}

const estimateWorkStep = () => 56;
const readGroupOf = (step: WorkStep) => step.readGroup;
// Drawn again only when its steps are, not as the run's clock ticks.
const WorkHistory = memo(function WorkHistory({
  steps,
  startMs,
  sessionId,
}: {
  steps: readonly WorkStep[];
  startMs: number | null;
  sessionId?: string;
}) {
  const id = useId();
  const [opened, setOpened] = useState<string | null>(null);
  const follow = useFollowScroll(String(startMs), true);
  const now = useRef({ follow, opened });
  now.current = { follow, opened };
  const toggle = useCallback((key: string, trigger: HTMLButtonElement) => {
    now.current.follow.anchorTo(trigger);
    const opening = now.current.opened !== key;
    setOpened(opening ? key : null);
    if (opening) revealOpened(trigger.closest(".activity-row"));
  }, []);
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
  const virtual = useVirtualRows(list, keys, estimateWorkStep, { anchored: true });
  return (
    <ScrollArea
      className="thread-work-scroll"
      ref={follow.ref}
      tabIndex={0}
      role="region"
      aria-label="Work history"
      onScroll={follow.onScroll}
      {...follow.gestures()}
    >
      <ol ref={list} className="thread-work-list" aria-label="Steps">
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
                <StepRow
                  id={`${id}-${step.key}`}
                  step={step}
                  sessionId={sessionId}
                  open={opened === step.key}
                  onToggle={toggle}
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
});
