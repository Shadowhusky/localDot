import { useMemo, useRef } from "react";
import type { TimelineRow } from "../session/key-uses.ts";
import type { StepRowView } from "../session/session-view.ts";
import { ActivityRow } from "./ActivityRow.tsx";
import type { AgentModel } from "./model.ts";
import { type WorkStepCache, workSteps } from "./thread.ts";

const MOST = 30;

// A task's steps, the newest first, under the picture of the computer it works on.
export function LatestSteps({
  rows,
  model,
  live,
  nowMs,
}: {
  rows: readonly TimelineRow<StepRowView>[];
  model: AgentModel;
  live: boolean;
  nowMs?: number;
}) {
  const built = useRef<WorkStepCache>(new Map());
  const steps = useMemo(() => workSteps(rows, model, built.current), [rows, model]);
  const newest = steps.slice(-MOST).reverse();
  return (
    <section className="phone-latest-steps" aria-label="Latest steps">
      <h3>{live ? "Latest steps" : "Steps"}</h3>
      {newest.length ? (
        newest.map((step, index) => (
          <ActivityRow
            key={step.key}
            id={`latest-${step.key}`}
            view={step.meta === step.title ? { ...step, meta: "" } : step}
            current={live && index === 0}
            {...(live && index === 0 ? { runningFrom: step.startT, nowMs } : {})}
          />
        ))
      ) : (
        <p className="thread-note">No steps yet.</p>
      )}
    </section>
  );
}
