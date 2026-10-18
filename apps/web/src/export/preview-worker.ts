import "@localdot/protocol/csp";
import { sceneAt } from "@localdot/stage";
import { recordedPresence } from "../dot/dot-feed.ts";
import { ObserveBackdrop } from "../replay/backdrop.ts";
import { sourceAt } from "../replay/decode-policy.ts";
import { replayView } from "../replay/recording-source.ts";
import { ReplayVideo } from "../replay/replay-video.ts";
import { planExport } from "./export-plan.ts";
import { createExportScene } from "./export-scene.ts";
import type { PreviewIn, PreviewOut } from "./preview-protocol.ts";

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<PreviewIn>) => void) | null;
  postMessage(message: PreviewOut): void;
  close(): void;
};
const controller = new AbortController();
let draw: ((index: number) => Promise<void>) | undefined;
let cleanup: (() => void) | undefined;
let started = false;
let drawing = false;

function fail() {
  controller.abort();
  cleanup?.();
  scope.postMessage({ type: "error" });
  scope.close();
}

async function start(message: Extract<PreviewIn, { type: "start" }>) {
  const { context, request, theme, canvas } = message;
  const { model, source } = context;
  const plan = planExport(request, model, context.activity, context.gaps);
  if (request.sessionId !== source.sessionId) throw new Error("Mismatched preview source");
  // Preview keeps the composition's proportions without allocating a full-resolution export.
  const scale = Math.min(1, 960 / request.size.w);
  const size = { w: Math.round(request.size.w * scale), h: Math.round(request.size.h * scale) };
  const renderRequest = { ...request, size };
  const composition = await createExportScene({
    canvas,
    request: renderRequest,
    source,
    model,
    theme,
    firstMs: plan.sessionMsAt(0),
    signal: controller.signal,
  });
  const backdrop = new ObserveBackdrop(source);
  let video: ReplayVideo | null = null;
  cleanup = () => {
    video?.close();
    backdrop.close();
    composition.close();
  };
  if (source.video) video = await ReplayVideo.open(source, controller.signal);
  const view = replayView(source, { reducedMotion: false });
  let previous = -1;
  draw = async (index) => {
    const time = plan.sessionMsAt(index);
    // Stateful dot animation and held frames must not carry a later picture into an earlier seek.
    if (index < previous) {
      composition.reset(time, (index / plan.fps) * 1000);
    }
    const gap = plan.gapAt(index);
    const pick =
      gap === "user-control"
        ? "hold"
        : sourceAt(time, {
            hasVideo: !!video,
            firstMs: video?.firstMs ?? null,
            lastMs: video?.lastMs ?? null,
            gaps: context.gaps,
          });
    if (pick === "video" && video) {
      const continuous =
        index === previous + 1 && previous >= 0 && time - plan.sessionMsAt(previous) <= 1500;
      // A seek or an idle skip must show the exact requested picture, never a nearby key frame.
      const frame = await video.want(time, continuous ? "play" : "exact");
      if (frame) composition.presenter.present(frame);
      else composition.presenter.clearVideo();
    } else if (pick === "backdrop") {
      const frame = await backdrop.frameAt(model, time);
      if (frame) composition.presenter.present(frame, { backdrop: true });
      else composition.presenter.clearVideo();
    } else if (previous < 0 || index !== previous + 1) {
      // No unrelated picture survives seeking into a private stretch.
      composition.presenter.clearVideo();
    }
    composition.dot?.update((index / plan.fps) * 1000, recordedPresence(model, time));
    composition.draw(
      request.overlays ? sceneAt(model, time, view) : null,
      plan.captionAt(index),
      gap,
    );
    previous = index;
    scope.postMessage({ type: "frame", index, sessionMs: time });
  };
  scope.postMessage({ type: "ready" });
}

scope.onmessage = ({ data }) => {
  if (data.type === "start" && !started) {
    started = true;
    void start(data).catch(fail);
  } else if (data.type === "frame" && draw && !drawing) {
    drawing = true;
    void draw(data.index)
      .catch(fail)
      .finally(() => {
        drawing = false;
      });
  }
};
