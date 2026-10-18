import { cameraFor, type Scene, type SessionModel } from "@localdot/stage";
import { recordedPresence } from "../dot/dot-feed.ts";
import { replayGeometry } from "../replay/recording-source.ts";
import { PixiPresenter } from "../stage/pixi-presenter.ts";
import type { StageTheme } from "../stage/theme.ts";
import type { ReplaySource } from "../stage/worker-protocol.ts";
import { ExportBurnIn } from "./burn-in.ts";
import { dotLayout, dotSeed, pictureHeight } from "./dot-band.ts";
import { ExportDot, loadDotPlates } from "./export-dot.ts";
import type { ExportPlan, ExportRequest } from "./export-plan.ts";

// Preview and the saved file use the same composition: camera, pointer, captions and dot.
export async function createExportScene(options: {
  canvas: OffscreenCanvas;
  request: ExportRequest;
  source: ReplaySource;
  model: SessionModel;
  theme: StageTheme;
  firstMs: number;
  signal: AbortSignal;
}) {
  const { canvas, request, source, model, theme, firstMs, signal } = options;
  const { w: width, h: height } = request.size;
  const pictureH = pictureHeight(request);
  const presenter = await PixiPresenter.create(canvas, {
    width,
    height,
    dpr: width / 1280,
    theme,
    warn() {},
  });
  let plates: Awaited<ReturnType<typeof loadDotPlates>> = null;
  const close = () => {
    presenter.clearVideo();
    presenter.app.destroy(true, { children: true, texture: true, textureSource: true });
    if (plates) for (const bitmap of Object.values(plates)) bitmap.close();
  };
  try {
    signal.throwIfAborted();
    presenter.overlays.setViewport(width, pictureH);
    const screen = replayGeometry(model, source);
    presenter.setScreen(screen);
    presenter.setCamera(
      cameraFor({
        stageW: width,
        stageH: pictureH,
        desktopW: screen?.w ?? 1280,
        desktopH: screen?.h ?? 800,
        zoom: 1,
      }),
    );
    const burnIn = new ExportBurnIn(
      theme,
      width,
      pictureH,
      request.dot === "over" ? "head" : "foot",
    );
    presenter.screen.addChild(burnIn);
    let dot: ExportDot | null = null;
    if (request.dot) {
      plates = await loadDotPlates(dotLayout(request.size, request.dot).frame.size, signal);
      signal.throwIfAborted();
      dot = new ExportDot({
        theme,
        size: request.size,
        placement: request.dot,
        plates,
        seed: dotSeed(request.sessionId),
        t: 0,
        first: recordedPresence(model, firstMs),
      });
      presenter.app.stage.addChild(dot);
    }
    return {
      presenter,
      get dot() {
        return dot;
      },
      reset(time: number, outputMs: number) {
        presenter.clearVideo();
        if (!request.dot) return;
        dot?.destroy({ children: true, texture: true, textureSource: true });
        dot = new ExportDot({
          theme,
          size: request.size,
          placement: request.dot,
          plates,
          seed: dotSeed(request.sessionId),
          t: outputMs,
          first: recordedPresence(model, time),
        });
        presenter.app.stage.addChild(dot);
      },
      draw(scene: Scene | null, caption: string | null, gap: ReturnType<ExportPlan["gapAt"]>) {
        presenter.draw(scene);
        burnIn.draw(caption, gap);
        presenter.render();
      },
      close,
    };
  } catch (error) {
    close();
    throw error;
  }
}
