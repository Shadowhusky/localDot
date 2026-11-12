import { useMemo, useRef, useState } from "react";
import { t } from "../i18n/index.ts";
import type { TimelineRow } from "../session/key-uses.ts";
import type { StepRowView } from "../session/session-view.ts";
import { StepRow } from "./LiveWorkLine.tsx";
import type { AgentModel } from "./model.ts";
import { type WorkStepCache, workSteps } from "./thread.ts";

const MOST = 30;

// A task's steps, the newest first, under the picture of the computer it works on. Each unfolds its
// details in place, as it does in the conversation.
export function LatestSteps({
  rows,
  model,
  live,
  nowMs,
  sessionId,
}: {
  rows: readonly TimelineRow<StepRowView>[];
  model: AgentModel;
  live: boolean;
  nowMs?: number;
  sessionId?: string;
}) {
  const built = useRef<WorkStepCache>(new Map());
  const steps = useMemo(() => workSteps(rows, model, built.current), [rows, model]);
  const newest = steps.slice(-MOST).reverse();
  const [open, setOpen] = useState<string | null>(null);
  const toggle = (key: string) => setOpen((was) => (was === key ? null : key));
  return (
    <section className="phone-latest-steps" aria-label={t`Latest steps`}>
      <h3>{live ? t`Latest steps` : t`Steps`}</h3>
      {newest.length ? (
        newest.map((step, index) => (
          <StepRow
            key={step.key}
            id={`latest-${step.key}`}
            step={step}
            sessionId={sessionId}
            open={open === step.key}
            onToggle={toggle}
            current={live && index === 0}
            {...(live && index === 0 ? { runningFrom: step.startT, nowMs } : {})}
          />
        ))
      ) : (
        <p className="thread-note">{t`No steps yet.`}</p>
      )}
    </section>
  );
}
