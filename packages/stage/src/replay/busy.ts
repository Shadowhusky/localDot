import { type ActivitySpan, microsToMs } from "@localdot/protocol";
import type { SessionModel } from "../model.ts";
import { SETTLE_CAP_MS, TARGET_FADE_MS, TARGET_HOLD_MS } from "../timing.ts";
import { mergeSpans, type Span } from "./playback-map.ts";
export const ACTIVITY_TAIL_MS = 100;
export const MARK_SHOW_MS = 1200;
export const STEP_EDGE_MS = 600;
export const START_SHOW_MS = 1000;
export const WORK_GRACE_MS = 1500;
export function busySpans(model: SessionModel, activity: ActivitySpan[], endMs: number): Span[] {
  const start = model.startT ?? 0;
  const spans: Span[] = [{ from: start, to: start + START_SHOW_MS }];
  const work: Span[] = [];
  for (const a of model.actions) {
    const end = a.cancel?.t ?? a.resultT ?? model.ended?.t ?? a.intentT + SETTLE_CAP_MS;
    const lastProgress = a.progress.at(-1)?.t ?? end;
    const to = Math.max(end, lastProgress);
    spans.push({ from: a.intentT, to: to + TARGET_HOLD_MS + TARGET_FADE_MS });
    work.push({ from: a.intentT, to: to + WORK_GRACE_MS });
  }
  for (const step of model.steps)
    work.push({ from: step.startT, to: (step.endT ?? endMs) + WORK_GRACE_MS });
  // Screen changes while dot is only thinking (a caret blinking, a clock ticking, a spinner) are
  // not dot's work: that time is skippable unless an action or step is still settling.
  const thinking = subtractSpans(thinkingSpans(model, endMs), mergeSpans(work, start, endMs));
  for (const span of activity)
    spans.push(
      ...subtractSpans(
        [{ from: microsToMs(span.from), to: microsToMs(span.to) + ACTIVITY_TAIL_MS }],
        thinking,
      ),
    );
  for (const mark of model.marks) spans.push({ from: mark.t, to: mark.t + MARK_SHOW_MS });
  for (const step of model.steps) {
    spans.push({ from: step.startT, to: step.startT + STEP_EDGE_MS });
    if (step.endT !== undefined) spans.push({ from: step.endT, to: step.endT + STEP_EDGE_MS });
  }
  return mergeSpans(spans, start, endMs);
}

const THINKING = new Set(["thinking", "observing"]);

function thinkingSpans(model: SessionModel, endMs: number): Span[] {
  const spans: Span[] = [];
  model.agentStates.forEach((entry, index) => {
    if (!THINKING.has(entry.state)) return;
    const to = model.agentStates[index + 1]?.t ?? model.ended?.t ?? endMs;
    if (to > entry.t) spans.push({ from: entry.t, to });
  });
  return spans;
}

// `spans` with every stretch covered by `cuts` taken out; `cuts` must be sorted and disjoint.
function subtractSpans(spans: Span[], cuts: Span[]): Span[] {
  const out: Span[] = [];
  for (const span of spans) {
    let from = span.from;
    for (const cut of cuts) {
      if (cut.to <= from || cut.from >= span.to) continue;
      if (cut.from > from) out.push({ from, to: cut.from });
      from = Math.max(from, cut.to);
    }
    if (span.to > from) out.push({ from, to: span.to });
  }
  return out;
}
