import type { ExportFormat, ExportPlan, ExportQuality, ExportSize } from "./export-plan.ts";

// Fitted to exports of a 2-minute recording in Chrome on an Apple silicon Mac (lane L13's notes),
// then corrected by how this browser's own last export came out.
//
// A picture is encoded once for as long as it stays the same, so the work and the file follow the
// moving part of the video: about this share of its frames are new pictures, plus one a second.
const NEW_PICTURES = 0.45;
// Each picture encoded costs a fixed part and a part for each million pixels it has; a VP9 file is
// made by the browser's own encoder, a few times slower.
const PICTURE_MS = 2.3;
const MEGAPIXEL_MS = 0.4;
const START_MS = 200;
const WEBM_FACTOR = 3;
// How much of its target rate the encoder spends while the picture moves: a screen needs little,
// so a generous rate is mostly left unused.
const FILL: Record<ExportQuality, number> = { low: 0.55, medium: 0.45, high: 0.22 };
// A still stretch costs a key frame every few seconds (the worker's keyFrameInterval), each about
// this many seconds of the target rate.
const KEY_EVERY_S = 5;
const KEY_FRAME_S = 0.07;
const CONTAINER_BYTES = 64 * 1024;
const CALIBRATION_KEY = "localdot.export-calibration.v1";

export interface ExportEstimate {
  bytes: number;
  ms: number;
}

// How this browser's last export compared with the fitted estimate: above 1, slower or bigger.
export interface Calibration {
  time: number;
  size: number;
}

export const UNCALIBRATED: Calibration = { time: 1, size: 1 };

export function estimateExport(
  plan: Pick<ExportPlan, "frames" | "fps" | "durationS" | "movingS" | "bitrate">,
  request: { size: ExportSize; format: ExportFormat; quality: ExportQuality },
  calibration: Calibration = UNCALIBRATED,
): ExportEstimate {
  const pictures = Math.min(plan.frames, NEW_PICTURES * plan.movingS * plan.fps + plan.durationS);
  const pictureMs =
    (PICTURE_MS + (MEGAPIXEL_MS * request.size.w * request.size.h) / 1_000_000) *
    (request.format === "webm" ? WEBM_FACTOR : 1);
  return {
    bytes:
      ((plan.bitrate / 8) *
        (plan.movingS * FILL[request.quality] +
          ((plan.durationS - plan.movingS) / KEY_EVERY_S) * KEY_FRAME_S) +
        CONTAINER_BYTES) *
      calibration.size,
    ms: (START_MS + pictures * pictureMs) * calibration.time,
  };
}

// A short export says little about the next: its time is mostly starting up, its file mostly the
// container, so only one past these teaches anything.
const TEACHES = { ms: 1500, bytes: 512 * 1024 };

const ratio = (actual: number, expected: number, previous: number, least: number) =>
  expected >= least && actual > 0 ? Math.min(4, Math.max(0.25, actual / expected)) : previous;

export function calibrationFrom(
  fitted: ExportEstimate,
  actual: ExportEstimate,
  previous: Calibration,
): Calibration {
  return {
    time: ratio(actual.ms, fitted.ms, previous.time, TEACHES.ms),
    size: ratio(actual.bytes, fitted.bytes, previous.size, TEACHES.bytes),
  };
}

export function storedCalibration(): Calibration {
  try {
    const value = JSON.parse(localStorage.getItem(CALIBRATION_KEY) ?? "null") as unknown;
    if (!value || typeof value !== "object") return UNCALIBRATED;
    const { time, size } = value as Record<string, unknown>;
    const valid = (n: unknown): n is number => typeof n === "number" && n >= 0.25 && n <= 4;
    return { time: valid(time) ? time : 1, size: valid(size) ? size : 1 };
  } catch {
    return UNCALIBRATED;
  }
}

export function keepCalibration(calibration: Calibration): void {
  try {
    localStorage.setItem(CALIBRATION_KEY, JSON.stringify(calibration));
  } catch {}
}

// How long a wait is, in words: "a few seconds", "about 15 s", "about 2 min".
export function waitText(ms: number): string {
  if (!(ms >= 4500)) return "a few seconds";
  if (ms < 57_500) return `about ${Math.max(5, Math.round(ms / 5000) * 5)} s`;
  return `about ${Math.max(1, Math.round(ms / 60_000))} min`;
}
