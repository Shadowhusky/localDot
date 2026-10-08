import {
  microsToMs,
  type RecordingGap,
  type RecordingGapReason,
  type ScreenName,
} from "@localdot/protocol";
import {
  type Chapter,
  type ChapterStatus,
  type MarkTone,
  type PlaybackMap,
  playAt,
  playDuration,
  type ReplaySpeed,
  type SessionModel,
  type Tick,
  type TickKind,
} from "@localdot/stage";

export interface ChapterView {
  id: string;
  label: string;
  status: ChapterStatus;
  x0: number;
  x1: number;
  startT: number;
  endT: number;
}
export interface TickBucket {
  x: number;
  t: number;
  kinds: TickKind[];
  tone: MarkTone;
  count: number;
  label: string;
}
export interface IdleBand {
  x0: number;
  x1: number;
  skippedMs: number;
}
export interface GapBand {
  x0: number;
  x1: number;
  reason: RecordingGapReason;
}
export interface ScrubberModel {
  durationPlayMs: number;
  chapters: ChapterView[];
  ticks: TickBucket[];
  idle: IdleBand[];
  gaps: GapBand[];
}
export const TICK_BUCKET_PX = 4;
const tonePriority: Record<MarkTone, number> = { neutral: 0, user: 1, attention: 2, failure: 3 };

export function scrubberModel(input: {
  chapters: Chapter[];
  ticks: Tick[];
  map: PlaybackMap;
  gaps: RecordingGap[];
  widthPx: number;
}): ScrubberModel {
  const durationPlayMs = playDuration(input.map);
  const fraction = (time: number) =>
    durationPlayMs > 0 ? playAt(input.map, time) / durationPlayMs : 0;
  const bucketCount = Number.isFinite(input.widthPx)
    ? Math.max(0, Math.floor(input.widthPx / TICK_BUCKET_PX))
    : 0;
  const buckets = new Map<number, TickBucket>();
  if (bucketCount > 0)
    for (const tick of input.ticks) {
      const position = fraction(tick.t);
      const slot = Math.min(bucketCount - 1, Math.floor(position * bucketCount));
      const bucket = buckets.get(slot);
      if (!bucket) {
        buckets.set(slot, {
          x: position,
          t: tick.t,
          kinds: [tick.kind],
          tone: tick.tone,
          count: 1,
          label: tick.label,
        });
        continue;
      }
      bucket.count += 1;
      if (!bucket.kinds.includes(tick.kind)) bucket.kinds.push(tick.kind);
      if (tonePriority[tick.tone] > tonePriority[bucket.tone]) bucket.tone = tick.tone;
    }
  return {
    durationPlayMs,
    chapters: input.chapters.map((chapter) => ({
      ...chapter,
      x0: fraction(chapter.startT),
      x1: fraction(chapter.endT),
    })),
    ticks: [...buckets.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, bucket]) => ({
        ...bucket,
        label: bucket.count > 1 ? `${bucket.label} and ${bucket.count - 1} more` : bucket.label,
      })),
    idle: input.map.segments
      .filter((segment) => segment.idle)
      .map((segment) => ({
        x0: fraction(segment.s0),
        x1: fraction(segment.s1),
        skippedMs: segment.s1 - segment.s0 - (segment.p1 - segment.p0),
      })),
    gaps: input.gaps.flatMap((gap) => {
      const start = Math.max(input.map.startMs, microsToMs(gap.from));
      const end = Math.min(input.map.endMs, gap.to === null ? input.map.endMs : microsToMs(gap.to));
      return end > start ? [{ x0: fraction(start), x1: fraction(end), reason: gap.reason }] : [];
    }),
  };
}

export function timeLabel(ms: number): string {
  const seconds = Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0;
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  return hours > 0
    ? `${hours}:${String(minutes % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`
    : `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}
export function speedLabel(speed: ReplaySpeed, idleNow: boolean): string | null {
  if (speed === 1) return idleNow ? "Idle skipped" : null;
  return `Playing at ${speed === 0.5 ? "½" : speed}×${idleNow ? " · idle skipped" : ""}`;
}
export function gapCard(kind: RecordingGapReason | "none" | "expired" | "failed"): {
  title: string;
  body: string;
} {
  const screenshotBody = "Steps are shown from screenshots.";
  switch (kind) {
    case "user-control":
      return {
        title: "You had control here",
        body: "Nothing was recorded while you were in control.",
      };
    case "stream-lost":
      return {
        title: "The picture dropped here",
        body: `localDot lost the computer's stream. ${screenshotBody}`,
      };
    case "disk-full":
      return {
        title: "Recording stopped: the disk was full",
        body: `${screenshotBody} Free some space and new sessions record again.`,
      };
    case "size-cap":
      return { title: "Recording stopped at the size limit", body: screenshotBody };
    case "recorder-error":
      return { title: "Recording stopped", body: screenshotBody };
    case "expired":
      return { title: "The video was removed to save space", body: screenshotBody };
    case "none":
    case "failed":
      return { title: "No video for this session", body: screenshotBody };
  }
}
export type ReplayCommand =
  | { kind: "toggle-play" }
  | { kind: "pause" }
  | { kind: "step"; dir: -1 | 1 }
  | { kind: "jump"; ms: number }
  | { kind: "speed"; dir: -1 | 1 }
  | { kind: "compare" }
  | { kind: "exit" };
export function replayKey(event: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  targetIsField: boolean;
}): ReplayCommand | null {
  if (event.metaKey || event.ctrlKey || event.altKey || event.targetIsField) return null;
  switch (event.key.toLowerCase()) {
    case " ":
      return { kind: "toggle-play" };
    case "k":
      return { kind: "pause" };
    case "arrowleft":
      return { kind: "step", dir: -1 };
    case "arrowright":
      return { kind: "step", dir: 1 };
    case "j":
      return { kind: "jump", ms: -10_000 };
    case "l":
      return { kind: "jump", ms: 10_000 };
    case "[":
      return { kind: "speed", dir: -1 };
    case "]":
      return { kind: "speed", dir: 1 };
    case "b":
      return { kind: "compare" };
    case "escape":
      return { kind: "exit" };
    default:
      return null;
  }
}
export function compareFrames(
  model: SessionModel,
  stepId: string,
  screen?: ScreenName,
): { before: string | null; after: string | null } {
  const stepIndex = model.stepIndex.get(stepId);
  const step = stepIndex === undefined ? undefined : model.steps[stepIndex];
  if (!step || model.observes.length === 0) return { before: null, after: null };
  if (screen !== undefined) {
    const matches = model.observes.filter((entry) => (entry.screen ?? "desktop") === screen);
    return {
      before: matches.findLast((entry) => entry.t < step.startT)?.frameId ?? null,
      after: matches.findLast((entry) => entry.step === stepId)?.frameId ?? null,
    };
  }
  let lower = 0;
  let upper = model.observes.length;
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2);
    const observe = model.observes[middle];
    if (observe && observe.t < step.startT) lower = middle + 1;
    else upper = middle;
  }
  return {
    before: model.observes[Math.max(0, lower - 1)]?.frameId ?? null,
    after: model.frames.get(stepId) ?? null,
  };
}
export type FollowAction = "stay" | "refresh" | "go-live";
export const FOLLOW_EDGE_MS = 250;
export const LIVE_EDGE_MS = 2000;
export function followRule(options: {
  live: boolean;
  playing: boolean;
  tMs: number;
  lastMs: number | null;
  liveNowMs: number;
}): FollowAction {
  if (
    !options.live ||
    !options.playing ||
    options.lastMs === null ||
    options.tMs < options.lastMs - FOLLOW_EDGE_MS
  )
    return "stay";
  return options.liveNowMs - options.lastMs <= LIVE_EDGE_MS ? "go-live" : "refresh";
}
export function suggestedExportName(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `localdot-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.mp4`;
}
