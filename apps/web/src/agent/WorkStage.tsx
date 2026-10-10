import { memo, useMemo, useState } from "react";
import { Badge } from "../ui/Badge.tsx";
import { Button } from "../ui/Button.tsx";
import { SegmentedControl } from "../ui/SegmentedControl.tsx";
import { DiffViewer } from "./DiffViewer.tsx";
import type { AgentModel, AgentStep } from "./model.ts";
import { TerminalViewer } from "./TerminalViewer.tsx";
import { useFollowScroll } from "./useFollowScroll.ts";

type View = "auto" | "computer" | "work";
const KEY = "localdot.stage-view.v1";
const VIEWS = [
  { value: "auto", label: "Auto" },
  { value: "computer", label: "Computer" },
  { value: "work", label: "Work" },
] as const;
const background = (step: AgentStep) => step.kind === "shell" || step.kind === "file";

// The existing, redacted event projection is the only source. No commands, file reads, or polling.
export function workStageSteps(steps: AgentModel["steps"]) {
  const ordered = [...steps.values()].sort(
    (a, b) => (a.startedAt ?? a.firstSeenAt ?? 0) - (b.startedAt ?? b.firstSeenAt ?? 0),
  );
  const last = ordered.findLast(
    (step) =>
      background(step) || step.kind === "gui" || step.kind === "browser" || step.kind === "app",
  );
  return { auto: !!last && background(last), steps: ordered.filter(background).slice(-8) };
}

function initialView(): View {
  try {
    const value = localStorage.getItem(KEY);
    if (value === "computer" || value === "work") return value;
  } catch {
    /* The view still works when storage is unavailable. */
  }
  return "auto";
}

export function WorkStage({
  model,
  owner,
  available,
}: {
  model: AgentModel;
  owner: string;
  available: boolean;
}) {
  const [view, setView] = useState(initialView);
  const work = useMemo(() => workStageSteps(model.steps), [model.steps]);
  // Human input and manual control always reveal the real computer without losing the preference.
  if (!available) return null;
  const shown = view === "work" || (view === "auto" && work.auto);
  return (
    <>
      {shown && (
        <WorkOutput
          key={owner}
          owner={owner}
          changes={model.changes}
          ended={!!model.ended}
          steps={work.steps}
        />
      )}
      <div className="work-stage-switch" data-picture-overlay>
        <SegmentedControl
          aria-label="Screen view"
          items={VIEWS}
          value={view}
          size={28}
          variant="quiet"
          onValueChange={(value) => {
            const next = value as View;
            setView(next);
            try {
              localStorage.setItem(KEY, next);
            } catch {
              /* Keep the in-memory choice. */
            }
          }}
        />
      </div>
    </>
  );
}

const WorkOutput = memo(function WorkOutput({
  owner,
  changes: fileChanges,
  ended,
  steps,
}: {
  owner: string;
  changes: AgentModel["changes"];
  ended: boolean;
  steps: readonly AgentStep[];
}) {
  const scroll = useFollowScroll(owner, true, { glide: false });
  const latest = steps.at(-1);
  return (
    <section className="work-stage" aria-label="Live work" data-picture-overlay>
      <header className="work-stage-heading">
        <span>Work</span>
        <span className="work-stage-caption">
          {latest?.tool?.title || latest?.intent || "Commands & files"}
        </span>
      </header>
      <section
        className="work-stage-scroll"
        ref={scroll.ref}
        onScroll={scroll.onScroll}
        onWheel={scroll.interrupt}
        onTouchStart={scroll.interrupt}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users must be able to scroll command output.
        tabIndex={0}
        aria-label="Work output"
      >
        <div className="work-stage-list">
          {!steps.length && (
            <p className="work-stage-empty">
              Commands and file changes will appear here as dot works.
            </p>
          )}
          {steps.map((step) => {
            const changes = fileChanges.filter(
              (change) => change.type === "file" && change.step === step.id,
            );
            const failed = step.status === "failed" || step.tool?.ok === false;
            const done = !!step.status || step.tool?.ok !== undefined;
            const label = failed
              ? "Failed"
              : done
                ? step.status === "cancelled"
                  ? "Stopped"
                  : step.status === "blocked"
                    ? "Blocked"
                    : "Finished"
                : ended
                  ? "Stopped"
                  : "Running";
            return (
              <article className="work-stage-entry" data-anchor={step.id} key={step.id}>
                <div className="work-stage-entry-head">
                  <h3>
                    {step.tool?.title ||
                      step.intent ||
                      (step.kind === "shell" ? "Command" : "File changes")}
                  </h3>
                  <Badge tone={failed ? "danger" : "neutral"}>{label}</Badge>
                </div>
                {step.intent && step.tool?.title && step.intent !== step.tool.title && (
                  <p className="work-stage-intent">{step.intent}</p>
                )}
                {step.kind === "shell" || step.output.length > 0 ? (
                  <TerminalViewer
                    step={step}
                    emptyText={done || ended ? "No output." : "Waiting for output…"}
                  />
                ) : null}
                {changes.map((change) => (
                  <DiffViewer key={change.id} change={change} />
                ))}
                {step.note && <p className="work-stage-intent">{step.note}</p>}
              </article>
            );
          })}
        </div>
      </section>
      {!scroll.pinned && (
        <div className="work-stage-latest">
          <Button size="sm" variant="secondary" onClick={scroll.jump}>
            Latest
          </Button>
        </div>
      )}
    </section>
  );
});
