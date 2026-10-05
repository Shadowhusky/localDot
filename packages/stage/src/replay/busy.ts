import { type ActivitySpan, microsToMs } from "@localdot/protocol";
import type { SessionModel } from "../model.ts";
import { SETTLE_CAP_MS, TARGET_FADE_MS, TARGET_HOLD_MS } from "../timing.ts";
import { mergeSpans, type Span } from "./playback-map.ts";
export const ACTIVITY_TAIL_MS = 100;
export const MARK_SHOW_MS = 1200;
export const STEP_EDGE_MS = 600;
export const START_SHOW_MS = 1000;
export function busySpans(model: SessionModel, activity: ActivitySpan[], endMs: number): Span[] {
  const start = model.startT ?? 0;
  const spans: Span[] = [{ from: start, to: start + START_SHOW_MS }];
  for (const span of activity)
    spans.push({ from: microsToMs(span.from), to: microsToMs(span.to) + ACTIVITY_TAIL_MS });
  for (const a of model.actions) {
    const end = a.cancel?.t ?? a.resultT ?? model.ended?.t ?? a.intentT + SETTLE_CAP_MS;
    const lastProgress = a.progress.at(-1)?.t ?? end;
    spans.push({
      from: a.intentT,
      to: Math.max(end, lastProgress) + TARGET_HOLD_MS + TARGET_FADE_MS,
    });
  }
  for (const mark of model.marks) spans.push({ from: mark.t, to: mark.t + MARK_SHOW_MS });
  for (const step of model.steps) {
    spans.push({ from: step.startT, to: step.startT + STEP_EDGE_MS });
    if (step.endT !== undefined) spans.push({ from: step.endT, to: step.endT + STEP_EDGE_MS });
  }
  return mergeSpans(spans, start, endMs);
}
