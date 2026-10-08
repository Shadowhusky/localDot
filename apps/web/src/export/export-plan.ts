import {
  type ActivitySpan,
  microsToMs,
  type RecordingGap,
  type RecordingGapReason,
  ULID_PATTERN,
} from "@localdot/protocol";
import {
  buildPlaybackMap,
  busySpans,
  chapters,
  idleAt,
  mergeSpans,
  playDuration,
  type SessionModel,
  type Span,
  sessionAt,
} from "@localdot/stage";
import { speedLabel } from "../replay/replay-view.ts";

export const EXPORT_FPS = 30;
export const EXPORT_SIZES = [
  { w: 1280, h: 800 },
  { w: 1920, h: 1200 },
  { w: 2560, h: 1600 },
] as const;
export type ExportSpeed = 1 | 2 | 4 | 8;
export interface ExportRequest {
  sessionId: string;
  fromMs: number;
  toMs: number;
  speed: ExportSpeed;
  skipIdle: boolean;
  size: { w: number; h: number };
  captions: boolean;
}
export interface ExportPlan {
  frames: number;
  durationS: number;
  sessionMsAt(frame: number): number;
  labelAt(frame: number): string | null;
  captionAt(frame: number): string | null;
  gapAt(frame: number): RecordingGapReason | null;
}
export const PRIVACY_NOTE =
  "This video shows everything on the computer's screen in the range you chose. Fields marked secret appear as dots. Stretches where you had control were never recorded.";

function knownEnd(model: SessionModel, activity: ActivitySpan[]): number {
  if (model.ended) return model.ended.t;
  let endMs = model.startT ?? 0;
  for (const entries of [
    model.agentStates,
    model.observes,
    model.plans,
    model.marks,
    model.keyUses,
  ])
    for (const entry of entries) endMs = Math.max(endMs, entry.t);
  for (const step of model.steps) endMs = Math.max(endMs, step.endT ?? step.startT);
  for (const action of model.actions)
    endMs = Math.max(
      endMs,
      action.intentT,
      action.targetT ?? 0,
      action.dispatch?.t ?? 0,
      action.progress.at(-1)?.t ?? 0,
      action.settleT ?? 0,
      action.resultT ?? 0,
      action.cancel?.t ?? 0,
    );
  for (const span of activity) endMs = Math.max(endMs, microsToMs(span.to));
  return endMs;
}

function precedingIndex<T>(
  entries: readonly T[],
  time: number,
  start: (entry: T) => number,
): number {
  let lower = 0;
  let upper = entries.length;
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2);
    const entry = entries[middle];
    if (entry !== undefined && start(entry) <= time) lower = middle + 1;
    else upper = middle;
  }
  return lower - 1;
}

const GAP_PRIORITY: readonly RecordingGapReason[] = [
  "user-control",
  "stream-lost",
  "disk-full",
  "size-cap",
  "recorder-error",
];

export function planExport(
  request: ExportRequest,
  model: SessionModel,
  activity: ActivitySpan[],
  gaps: RecordingGap[],
): ExportPlan {
  if (
    !ULID_PATTERN.test(request.sessionId) ||
    ![1, 2, 4, 8].includes(request.speed) ||
    !EXPORT_SIZES.some((size) => size.w === request.size.w && size.h === request.size.h) ||
    !Number.isFinite(request.fromMs) ||
    !Number.isFinite(request.toMs)
  )
    throw new RangeError("Invalid export settings.");
  const startMs = Math.max(model.startT ?? 0, request.fromMs);
  const endMs = Math.min(knownEnd(model, activity), request.toMs);
  if (endMs <= startMs) throw new RangeError("Choose a nonempty recorded range to export.");
  const speed = request.speed;
  const captions = request.captions;
  const map = buildPlaybackMap(startMs, endMs, busySpans(model, activity, endMs), request.skipIdle);
  const frames = Math.ceil((playDuration(map) * EXPORT_FPS) / (1000 * speed));
  const chapterList = chapters(model, endMs);
  const gapSpans = new Map<RecordingGapReason, Span[]>();
  for (const reason of GAP_PRIORITY)
    gapSpans.set(
      reason,
      mergeSpans(
        gaps
          .filter((gap) => gap.reason === reason)
          .map((gap) => ({
            from: microsToMs(gap.from),
            to: gap.to === null ? endMs : microsToMs(gap.to),
          })),
        startMs,
        endMs,
      ),
    );
  const sessionMsAt = (frame: number) => {
    if (!Number.isSafeInteger(frame) || frame < 0 || frame >= frames)
      throw new RangeError("Export frame is outside the chosen range.");
    return sessionAt(map, (frame / EXPORT_FPS) * 1000 * speed);
  };
  return {
    frames,
    durationS: frames / EXPORT_FPS,
    sessionMsAt,
    labelAt(frame) {
      const time = sessionMsAt(frame);
      return speedLabel(speed, idleAt(map, time));
    },
    captionAt(frame) {
      const time = sessionMsAt(frame);
      if (!captions) return null;
      const chapter = chapterList[precedingIndex(chapterList, time, (entry) => entry.startT)];
      return chapter && time < chapter.endT ? chapter.label : null;
    },
    gapAt(frame) {
      const time = sessionMsAt(frame);
      for (const reason of GAP_PRIORITY) {
        const spans = gapSpans.get(reason) ?? [];
        const span = spans[precedingIndex(spans, time, (entry) => entry.from)];
        if (span && time < span.to) return reason;
      }
      return null;
    },
  };
}
