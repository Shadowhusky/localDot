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
  mergeSpans,
  playDuration,
  type SessionModel,
  type Span,
  sessionAt,
} from "@localdot/stage";
import { timeLabel } from "../replay/replay-view.ts";

export const EXPORT_FRAME_RATES = [10, 15, 24, 30, 50, 60] as const;
export type ExportFrameRate = (typeof EXPORT_FRAME_RATES)[number];
export const EXPORT_QUALITIES = ["low", "medium", "high"] as const;
export type ExportQuality = (typeof EXPORT_QUALITIES)[number];
export const EXPORT_FORMATS = ["mp4", "webm"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];
export const SPEED_LIMITS = { min: 0.25, max: 16 } as const;
// The largest picture an export makes: the computer's own screen.
export const MAX_EXPORT_SIZE = { w: 2560, h: 1600 } as const;

export interface ExportSize {
  w: number;
  h: number;
}

export interface ExportRequest {
  sessionId: string;
  fromMs: number;
  toMs: number;
  // Session time per second of video: 2 plays twice as fast, 0.5 at half speed.
  speed: number;
  skipIdle: boolean;
  captions: boolean;
  // dot's pointer, clicks and typing drawn over the picture.
  overlays: boolean;
  size: ExportSize;
  fps: ExportFrameRate;
  quality: ExportQuality;
  format: ExportFormat;
}
export interface ExportPlan {
  frames: number;
  fps: ExportFrameRate;
  durationS: number;
  bitrate: number;
  // Seconds of the video in which something moves; the rest is a still picture, encoded once.
  movingS: number;
  sessionMsAt(frame: number): number;
  captionAt(frame: number): string | null;
  gapAt(frame: number): RecordingGapReason | null;
}
export const PRIVACY_NOTE =
  "This video shows everything on the computer's screen in the range you chose. Fields marked secret appear as dots. Stretches where you had control were never recorded.";

export function validSpeed(speed: number): boolean {
  return Number.isFinite(speed) && speed >= SPEED_LIMITS.min && speed <= SPEED_LIMITS.max;
}

export function validSize(size: ExportSize): boolean {
  return (
    Number.isSafeInteger(size.w) &&
    Number.isSafeInteger(size.h) &&
    size.w % 2 === 0 &&
    size.h % 2 === 0 &&
    size.w >= 16 &&
    size.h >= 16 &&
    Math.max(size.w, size.h) <= MAX_EXPORT_SIZE.w &&
    size.w * size.h <= MAX_EXPORT_SIZE.w * MAX_EXPORT_SIZE.h
  );
}

export function speedText(speed: number): string {
  return `${Number(speed.toFixed(2))}×`;
}

// Bits per pixel of each frame the encoder is asked for, at 30 fps. A screen changes little from one
// frame to the next, so a higher frame rate costs less than its share: the rate grows by fps^0.6.
const BITS_PER_PIXEL: Record<ExportQuality, number> = { low: 0.022, medium: 0.04, high: 0.065 };
const MIN_BITRATE = 200_000;

export function exportBitrate(size: ExportSize, fps: number, quality: ExportQuality): number {
  const frames = 30 * (fps / 30) ** 0.6;
  return Math.max(MIN_BITRATE, Math.round(BITS_PER_PIXEL[quality] * size.w * size.h * frames));
}

export function fileSize(bytes: number): string {
  const megabytes = bytes / (1024 * 1024);
  if (megabytes < 1) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${megabytes < 10 ? megabytes.toFixed(1) : Math.round(megabytes)} MB`;
}

// A video's length, rounded up so a short one never reads as 0:00.
export function videoLength(seconds: number): string {
  return timeLabel(Math.ceil(seconds) * 1000);
}

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
    !validSpeed(request.speed) ||
    !validSize(request.size) ||
    !EXPORT_FRAME_RATES.includes(request.fps) ||
    !EXPORT_QUALITIES.includes(request.quality) ||
    !EXPORT_FORMATS.includes(request.format) ||
    !Number.isFinite(request.fromMs) ||
    !Number.isFinite(request.toMs)
  )
    throw new RangeError("Invalid export settings.");
  const startMs = Math.max(model.startT ?? 0, request.fromMs);
  const endMs = Math.min(knownEnd(model, activity), request.toMs);
  if (endMs <= startMs) throw new RangeError("Choose a nonempty recorded range to export.");
  const { speed, captions, fps } = request;
  const busy = busySpans(model, activity, endMs);
  const map = buildPlaybackMap(startMs, endMs, busy, request.skipIdle);
  const frames = Math.ceil((playDuration(map) * fps) / (1000 * speed));
  let busyMs = 0;
  for (const span of mergeSpans(busy, startMs, endMs)) busyMs += span.to - span.from;
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
    return sessionAt(map, (frame / fps) * 1000 * speed);
  };
  return {
    frames,
    fps,
    durationS: frames / fps,
    bitrate: exportBitrate(request.size, fps, request.quality),
    movingS: Math.min(frames / fps, busyMs / (1000 * speed)),
    sessionMsAt,
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
