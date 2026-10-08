import { cameraFor, sceneAt } from "@localdot/stage";
import {
  CanvasSource,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  StreamTarget,
  type StreamTargetChunk,
} from "mediabunny";
import { Rectangle } from "pixi.js";
import { ObserveBackdrop } from "../replay/backdrop.ts";
import { sourceAt } from "../replay/decode-policy.ts";
import { replayGeometry, replayView } from "../replay/recording-source.ts";
import { ReplayVideo } from "../replay/replay-video.ts";
import { PixiPresenter } from "../stage/pixi-presenter.ts";
import { ExportBurnIn } from "./burn-in.ts";
import { EXPORT_FPS, planExport } from "./export-plan.ts";
import type { ExportIn, ExportOut, ExportSourceSample } from "./export-protocol.ts";

const scope = self as unknown as {
  postMessage(message: ExportOut, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<ExportIn>) => void) | null;
  close(): void;
};
const cancellation = new AbortController();
const acknowledgements = new Map<number, { resolve(): void; reject(error: Error): void }>();
let output: Output | undefined;
let cancelling: Promise<void> | undefined;
let started = false;

function post(message: ExportOut, transfer: Transferable[] = []): void {
  scope.postMessage(message, transfer);
}

function cancelled(): void {
  cancellation.signal.throwIfAborted();
}

async function render(start: Extract<ExportIn, { type: "start" }>): Promise<void> {
  let presenter: PixiPresenter | undefined;
  let video: ReplayVideo | undefined;
  let backdrop: ObserveBackdrop | undefined;
  const originalEncode = VideoEncoder.prototype.encode;
  let peakEncodeQueue = 0;
  VideoEncoder.prototype.encode = function (frame, options) {
    originalEncode.call(this, frame, options);
    peakEncodeQueue = Math.max(peakEncodeQueue, this.encodeQueueSize);
  };
  try {
    const plan = planExport(start.request, start.model, start.activity, start.gaps);
    if (start.request.sessionId !== start.source.sessionId)
      throw new Error("Mismatched export source.");
    const { w: width, h: height } = start.request.size;
    const canvas = new OffscreenCanvas(width, height);
    presenter = await PixiPresenter.create(canvas, {
      width,
      height,
      dpr: width / 1280,
      theme: start.theme,
      warn() {},
    });
    cancelled();
    presenter.setScreen(replayGeometry(start.model, start.source));
    const screen = replayGeometry(start.model, start.source) ?? { w: 1280, h: 800 };
    const camera = cameraFor({
      stageW: width,
      stageH: height,
      desktopW: screen.w,
      desktopH: screen.h,
      zoom: 1,
    });
    presenter.setCamera(camera);
    const burnIn = new ExportBurnIn(start.theme, width, height);
    presenter.screen.addChild(burnIn);
    backdrop = new ObserveBackdrop(start.source);
    if (start.source.video)
      video = await ReplayVideo.open(start.source, cancellation.signal, { sequential: true });
    cancelled();
    let bytes = 0;
    let chunk = 0;
    const writable = new WritableStream<StreamTargetChunk>({
      write(value) {
        cancelled();
        const index = chunk++;
        const data = value.data.slice().buffer;
        bytes = Math.max(bytes, value.position + data.byteLength);
        return new Promise<void>((resolve, reject) => {
          acknowledgements.set(index, { resolve, reject });
          post({ type: "chunk", chunk: index, position: value.position, data }, [data]);
        });
      },
    });
    output = new Output({
      format: new Mp4OutputFormat({ fastStart: false }),
      target: new StreamTarget(writable, { chunked: true, chunkSize: 4 * 1024 * 1024 }),
    });
    const canvasSource = new CanvasSource(canvas, {
      codec: "avc",
      bitrate: QUALITY_HIGH,
      keyFrameInterval: 2,
      latencyMode: "quality",
    });
    output.addVideoTrack(canvasSource, { frameRate: EXPORT_FPS });
    await output.start();
    const hashes: string[] | null = start.hashes ? [] : null;
    let peakOpenFrames = 0;
    let sourceSamples: ExportSourceSample[] = [];
    for (let index = 0; index < plan.frames; index++) {
      cancelled();
      const time = plan.sessionMsAt(index);
      const source =
        plan.gapAt(index) === "user-control"
          ? "hold"
          : sourceAt(time, {
              hasVideo: !!video,
              firstMs: video?.firstMs ?? null,
              lastMs: video?.lastMs ?? null,
              gaps: start.gaps,
            });
      if (start.probe) sourceSamples.push({ tMs: time, source });
      let frame: VideoFrame | null = null;
      try {
        if (source === "video" && video) frame = await video.want(time, "play");
        else if (source === "backdrop") frame = await backdrop.frameAt(start.model, time);
        cancelled();
        peakOpenFrames = Math.max(
          peakOpenFrames,
          (video?.stats().openFrames ?? 0) + Number(source === "backdrop" && !!frame),
        );
        if (frame) {
          presenter.present(frame, { backdrop: source === "backdrop" });
          frame = null;
        } else if (source === "backdrop") presenter.clearVideo();
        presenter.draw(
          sceneAt(start.model, time, replayView(start.source, { reducedMotion: false })),
        );
        burnIn.draw(plan.labelAt(index), plan.captionAt(index), plan.gapAt(index));
        presenter.render();
        if (hashes) {
          const { pixels } = presenter.app.renderer.extract.pixels({
            target: presenter.app.stage,
            frame: new Rectangle(0, 0, width, height),
            clearColor: start.theme.void.color,
          });
          const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", pixels.slice().buffer));
          hashes.push(Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join(""));
        }
        cancelled();
        await canvasSource.add(index / EXPORT_FPS, 1 / EXPORT_FPS);
        if (index % 15 === 0 || index === plan.frames - 1)
          post({
            type: "progress",
            done: index + 1,
            total: plan.frames,
            openFrames: peakOpenFrames,
            encodeQueue: peakEncodeQueue,
          });
        if (sourceSamples.length >= 200 || (sourceSamples.length && index === plan.frames - 1)) {
          post({ type: "sources", entries: sourceSamples });
          sourceSamples = [];
        }
      } finally {
        frame?.close();
      }
    }
    cancelled();
    canvasSource.close();
    await output.finalize();
    cancelled();
    post({ type: "done", frames: plan.frames, bytes, hashes });
  } catch {
    await (cancelling ?? output?.cancel())?.catch(() => {});
    post(
      cancellation.signal.aborted
        ? { type: "cancelled" }
        : {
            type: "error",
            message:
              "The recording could not be exported. Check that its media is available and try again.",
          },
    );
  } finally {
    VideoEncoder.prototype.encode = originalEncode;
    video?.close();
    backdrop?.close();
    presenter?.clearVideo();
    presenter?.app.destroy(true, { children: true, texture: true, textureSource: true });
    output = undefined;
    scope.close();
  }
}

scope.onmessage = (event: MessageEvent<ExportIn>) => {
  const message = event.data;
  if (message.type === "start") {
    if (started) return;
    started = true;
    void render(message);
  } else if (message.type === "ack") {
    acknowledgements.get(message.chunk)?.resolve();
    acknowledgements.delete(message.chunk);
  } else if (message.type === "cancel") {
    cancellation.abort();
    for (const pending of acknowledgements.values())
      pending.reject(new DOMException("Export cancelled.", "AbortError"));
    acknowledgements.clear();
    cancelling = output?.cancel().catch(() => {});
  }
};
