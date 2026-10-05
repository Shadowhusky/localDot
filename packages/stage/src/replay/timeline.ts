import type { MarkKind, MarkTone } from "../marks.ts";
import { planAt, type SessionModel, type StepState } from "../model.ts";
export type ChapterStatus = "doing" | "ok" | "failed" | "blocked" | "cancelled";
export interface Chapter {
  id: string;
  label: string;
  startT: number;
  endT: number;
  status: ChapterStatus;
}
// Movement is a valid protocol input and must remain visible on the timeline.
export type TickKind =
  | "click"
  | "move"
  | "type"
  | "key"
  | "scroll"
  | "drag"
  | "wait"
  | "cancel"
  | MarkKind;
export interface Tick {
  t: number;
  kind: TickKind;
  label: string;
  tone: MarkTone;
  step?: string;
}
export const STEP_KIND_LABEL: Record<string, string> = {
  gui: "Working on screen",
  shell: "Shell",
  file: "Files",
  browser: "Reading page",
  ask: "Asking you",
  think: "Thinking",
};
const statuses = new Set(["doing", "ok", "failed", "blocked", "cancelled"]);
function endOf(model: SessionModel, step: StepState, index: number, endMs: number): number {
  return Math.max(
    step.startT,
    Math.min(step.endT ?? endMs, model.steps[index + 1]?.startT ?? endMs, endMs),
  );
}
export function chapters(model: SessionModel, endMs: number): Chapter[] {
  return model.steps.map((step, index) => {
    const actionIndex = model.byStep.get(step.id);
    const a = actionIndex === undefined ? undefined : model.actions[actionIndex];
    const item =
      step.planItem === undefined
        ? undefined
        : planAt(model, step.startT).find((item) => item.id === step.planItem);
    return {
      id: step.id,
      label: a?.label ?? item?.text ?? STEP_KIND_LABEL[step.kind] ?? step.kind,
      startT: step.startT,
      endT: endOf(model, step, index, endMs),
      status:
        step.status !== undefined && statuses.has(step.status)
          ? (step.status as ChapterStatus)
          : "doing",
    };
  });
}
export function ticks(model: SessionModel): Tick[] {
  const out: { tick: Tick; seq: number }[] = [];
  for (const [index, a] of model.actions.entries()) {
    const step = a.step ? { step: a.step } : {};
    out.push({
      seq: a.dispatchSeq ?? a.intentSeq ?? index,
      tick: {
        t: a.dispatch?.t ?? a.intentT,
        kind: a.dispatch?.input.kind ?? a.verb,
        label: a.label,
        tone: "neutral",
        ...step,
      },
    });
    if (a.cancel)
      out.push({
        seq: a.cancelSeq ?? a.intentSeq ?? index,
        tick: { t: a.cancel.t, kind: "cancel", label: a.cancel.reason, tone: "failure", ...step },
      });
  }
  for (const m of model.marks)
    out.push({
      seq: m.seq,
      tick: {
        t: m.t,
        kind: m.kind,
        label: m.label,
        tone: m.tone,
        ...(m.step ? { step: m.step } : {}),
      },
    });
  out.sort((a, b) => a.tick.t - b.tick.t || a.seq - b.seq);
  return out.map((row) => row.tick);
}
export function stepBounds(
  model: SessionModel,
  stepId: string,
): { startT: number; endT: number } | undefined {
  const index = model.stepIndex.get(stepId);
  if (index === undefined) return undefined;
  const step = model.steps[index];
  if (!step) return undefined;
  // A live open final step has no known end yet. chapters receives the live slice's endMs.
  const end = step.endT ?? model.steps[index + 1]?.startT ?? model.ended?.t ?? step.startT;
  return { startT: step.startT, endT: endOf(model, step, index, end) };
}
