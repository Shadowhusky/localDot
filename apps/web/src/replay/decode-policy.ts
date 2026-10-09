import type { RecordingGap } from "@localdot/protocol";

export const JUMP_AHEAD_MS = 1500;
export type DecodeMode = "play" | "exact" | "preview";
export type DecodeStep = "hold" | "advance" | "seek-exact" | "seek-key";
export interface DecodeState {
  targetMs: number;
  mode: DecodeMode;
  shownMs: number | null;
  shownKeyMs: number | null;
  targetKeyMs: number | null;
  nextMs: number | null;
  // The shown frame is a preview's lone key frame, with nothing decoded after it.
  keyOnly: boolean;
}

export function nextDecodeStep(state: DecodeState): DecodeStep {
  const sameKey = state.shownKeyMs === state.targetKeyMs;
  if (state.mode === "preview") return state.shownKeyMs !== null && sameKey ? "hold" : "seek-key";
  if (state.mode === "exact") {
    if (state.keyOnly) return "seek-exact";
    if (
      sameKey &&
      state.shownMs !== null &&
      state.shownMs <= state.targetMs &&
      (state.nextMs === null || state.nextMs > state.targetMs)
    )
      return "hold";
    if (state.nextMs !== null && sameKey && state.nextMs <= state.targetMs) return "advance";
    return "seek-exact";
  }
  if (state.nextMs === null || (state.shownMs !== null && state.targetMs < state.shownMs))
    return "seek-exact";
  if (state.targetMs - state.nextMs > JUMP_AHEAD_MS) return "seek-key";
  return state.nextMs <= state.targetMs ? "advance" : "hold";
}

export type FrameSource = "video" | "backdrop" | "hold";
export function sourceAt(
  tMs: number,
  video: {
    hasVideo: boolean;
    firstMs: number | null;
    lastMs: number | null;
    gaps: RecordingGap[];
  },
): FrameSource {
  if (!video.hasVideo || video.firstMs === null || tMs < video.firstMs) return "backdrop";
  const atMicros = tMs * 1000;
  const containing = video.gaps.filter(
    (gap) => gap.from <= atMicros && (gap.to === null || atMicros < gap.to),
  );
  if (containing.some((gap) => gap.reason === "user-control")) return "hold";
  if (
    containing.length ||
    (video.lastMs !== null && tMs > video.lastMs && video.gaps.some((gap) => gap.to === null))
  )
    return "backdrop";
  return "video";
}
