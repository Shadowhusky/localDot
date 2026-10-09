import { useEffect, useRef, useState } from "react";
import { count, spendText } from "../copy/format.ts";
import type { TaskRow } from "../session/status.ts";
import { Collapse, Disclosure } from "../ui/Disclosure.tsx";
import { StatusGlyph } from "../ui/StatusGlyph.tsx";
import { clock } from "./activity.ts";
import type { WorkStep } from "./thread.ts";

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
// The work list shows the latest steps; the rest are in Activity.
const SHOWN_STEPS = 12;

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
  spend,
}: {
  steps: readonly WorkStep[];
  startMs: number | null;
  // What the turn cost, said once its work is over.
  spend?: { usd: number; estimated: boolean };
  // Given for the latest turn while its task has not ended.
  live: LiveWork | null;
  ended?: "done" | "stopped" | "interrupted" | "error";
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
  const shown = steps.slice(-SHOWN_STEPS);
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
    !running && spend ? spendText(spend.usd, spend.estimated) : "",
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
        {shown.length ? (
          <ol className="thread-work-list" aria-label="Steps in this turn">
            {shown.map((step) => (
              <li key={step.key} className="thread-work-step">
                <StatusGlyph state={step.state} />
                <span className="thread-work-title">{step.title}</span>
                {step.time && <span className="thread-work-time num">{step.time}</span>}
              </li>
            ))}
          </ol>
        ) : (
          <p className="thread-note">No steps yet.</p>
        )}
        {steps.length > shown.length && (
          <p className="thread-note">
            {count(steps.length - shown.length, "earlier step is", "earlier steps are")} in
            Activity.
          </p>
        )}
      </Disclosure>
    </div>
  );
}
