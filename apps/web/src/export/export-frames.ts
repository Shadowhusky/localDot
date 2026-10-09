import type { RecordingGap } from "@localdot/protocol";
import type { Scene } from "@localdot/stage";
import { type FrameSource, sourceAt } from "../replay/decode-policy.ts";
import type { ExportPlan } from "./export-plan.ts";

export interface FramePicks {
  // Session time of each frame of the video.
  times: Float64Array;
  sources: FrameSource[];
  // The session times the recording is read at: only the frames that show its picture, in order.
  videoTimes: number[];
}

export function pickFrames(
  plan: Pick<ExportPlan, "frames" | "sessionMsAt" | "gapAt">,
  video: { firstMs: number; lastMs: number } | null,
  gaps: RecordingGap[],
): FramePicks {
  const times = new Float64Array(plan.frames);
  const sources: FrameSource[] = [];
  const videoTimes: number[] = [];
  for (let index = 0; index < plan.frames; index++) {
    const time = plan.sessionMsAt(index);
    const source =
      plan.gapAt(index) === "user-control"
        ? "hold"
        : sourceAt(time, {
            hasVideo: !!video,
            firstMs: video?.firstMs ?? null,
            lastMs: video?.lastMs ?? null,
            gaps,
          });
    times[index] = time;
    sources.push(source);
    if (source === "video") videoTimes.push(time);
  }
  return { times, sources, videoTimes };
}

// What a frame shows, as text: two frames with the same look are one picture, rendered once. The
// HUD's clock is left out because nothing on the picture shows it. dot, when shown, is alive in
// every frame, so its frame number stands for its look.
export function frameLook(
  picture: string | null,
  scene: Scene | null,
  text: string | null,
  dot: number | null = null,
) {
  return JSON.stringify([picture, scene && { ...scene, hud: null }, text, dot]);
}
