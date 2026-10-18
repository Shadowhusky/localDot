import { observeAt, sceneAt } from "@localdot/stage";
import {
  canEncodeVideo,
  Mp4OutputFormat,
  Output,
  Quality,
  StreamTarget,
  type StreamTargetChunk,
  type VideoEncodingConfig,
  VideoSample,
  VideoSampleSource,
  WebMOutputFormat,
} from "mediabunny";
import { Rectangle } from "pixi.js";
import { recordedPresence } from "../dot/dot-feed.ts";
import { ObserveBackdrop } from "../replay/backdrop.ts";
import { replayView } from "../replay/recording-source.ts";
import type { PixiPresenter } from "../stage/pixi-presenter.ts";
import { burnInText } from "./burn-in.ts";
import { frameLook, pickFrames } from "./export-frames.ts";
import { type ExportPlan, type ExportRequest, planExport } from "./export-plan.ts";
import type { ExportIn, ExportOut, ExportSourceSample } from "./export-protocol.ts";
import { createExportScene } from "./export-scene.ts";
import { ExportVideo } from "./export-video.ts";

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

// Every export asks for the graphics chip's encoder and takes the browser's own where there is none.
// The encoder's real-time mode is left alone: it holds each frame to the clock and made a video
// several times slower to export (lane L13's measurements).
async function encoding(request: ExportRequest, plan: ExportPlan): Promise<VideoEncodingConfig> {
  const codec = request.format === "webm" ? "vp9" : "avc";
  const config: VideoEncodingConfig = {
    codec,
    quality: new Quality({ bitrate: plan.bitrate, bitrateMode: "variable" }),
    keyFrameInterval: 5,
  };
  const hardware = await canEncodeVideo(codec, {
    width: request.size.w,
    height: request.size.h,
    quality: config.quality,
    frameRate: plan.fps,
    hardwareAcceleration: "prefer-hardware",
  }).catch(() => false);
  return { ...config, hardwareAcceleration: hardware ? "prefer-hardware" : "no-preference" };
}

interface Held {
  sample: VideoSample;
  from: number;
}

async function render(start: Extract<ExportIn, { type: "start" }>): Promise<void> {
  let presenter: PixiPresenter | undefined;
  let composition: Awaited<ReturnType<typeof createExportScene>> | undefined;
  let video: ExportVideo | undefined;
  let backdrop: ObserveBackdrop | undefined;
  let samples: AsyncGenerator<VideoSample | null, void, unknown> | undefined;
  // The last picture rendered, from the frame it first shows on.
  let held: Held | null = null;
  const originalEncode = VideoEncoder.prototype.encode;
  let peakEncodeQueue = 0;
  VideoEncoder.prototype.encode = function (frame, options) {
    originalEncode.call(this, frame, options);
    peakEncodeQueue = Math.max(peakEncodeQueue, this.encodeQueueSize);
  };
  try {
    const { request } = start;
    const plan = planExport(request, start.model, start.activity, start.gaps);
    if (request.sessionId !== start.source.sessionId) throw new Error("Mismatched export source.");
    const { w: width, h: height } = request.size;
    const canvas = new OffscreenCanvas(width, height);
    composition = await createExportScene({
      canvas,
      request,
      source: start.source,
      model: start.model,
      theme: start.theme,
      firstMs: plan.sessionMsAt(0),
      signal: cancellation.signal,
    });
    presenter = composition.presenter;
    const dot = composition.dot;
    backdrop = new ObserveBackdrop(start.source);
    if (start.source.video) video = await ExportVideo.open(start.source, cancellation.signal);
    cancelled();
    const picks = pickFrames(plan, video ?? null, start.gaps);
    samples = video?.samples(picks.videoTimes);
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
      format:
        request.format === "webm"
          ? new WebMOutputFormat()
          : new Mp4OutputFormat({ fastStart: false }),
      target: new StreamTarget(writable, { chunked: true, chunkSize: 4 * 1024 * 1024 }),
    });
    const encoder = new VideoSampleSource(await encoding(request, plan));
    output.addVideoTrack(encoder, { frameRate: plan.fps });
    await output.start();
    const view = replayView(start.source, { reducedMotion: false });
    const screenName = start.source.screen ?? "desktop";
    const hashes: string[] | null = start.hashes ? [] : null;
    let peakOpenFrames = 0;
    let sourceSamples: ExportSourceSample[] = [];
    let picture: string | null = null;
    let look: string | null = null;
    // A picture is encoded once it is known how long it stays: until the frame that looks different,
    // or for a second at most, so a still stretch still has a frame every second.
    const emit = async (shown: Held, until: number) => {
      try {
        shown.sample.setTimestamp(shown.from / plan.fps);
        shown.sample.setDuration((until - shown.from) / plan.fps);
        cancelled();
        await encoder.add(shown.sample);
      } finally {
        shown.sample.close();
      }
    };
    for (let index = 0; index < plan.frames; index++) {
      cancelled();
      const time = picks.times[index] ?? 0;
      const source = picks.sources[index] ?? "hold";
      if (start.probe) sourceSamples.push({ tMs: time, source });
      let incoming: VideoSample | null = null;
      try {
        if (source === "video" && samples) {
          incoming = (await samples.next()).value ?? null;
          if (incoming) picture = `video ${incoming.timestamp}`;
        } else if (source === "backdrop") {
          picture = `screenshot ${observeAt(start.model, time, screenName)?.frameId ?? ""}`;
        }
        cancelled();
        peakOpenFrames = Math.max(peakOpenFrames, Number(!!incoming) + Number(!!held));
        const scene = request.overlays ? sceneAt(start.model, time, view) : null;
        const caption = plan.captionAt(index);
        const gap = plan.gapAt(index);
        dot?.update((index / plan.fps) * 1000, recordedPresence(start.model, time));
        const next = frameLook(picture, scene, burnInText(caption, gap), dot ? index : null);
        const changed = next !== look;
        if (!held || changed || index - held.from >= plan.fps) {
          let sample: VideoSample;
          if (!held || changed) {
            if (incoming) presenter.present(incoming.toVideoFrame());
            else if (source === "backdrop") {
              const still = await backdrop.frameAt(start.model, time);
              cancelled();
              if (still) presenter.present(still, { backdrop: true });
              else presenter.clearVideo();
            }
            composition.draw(scene, caption, gap);
            if (hashes) {
              const { pixels } = presenter.app.renderer.extract.pixels({
                target: presenter.app.stage,
                frame: new Rectangle(0, 0, width, height),
                clearColor: start.theme.void.color,
              });
              const hash = new Uint8Array(
                await crypto.subtle.digest("SHA-256", pixels.slice().buffer),
              );
              hashes.push(Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join(""));
            }
            sample = new VideoSample(canvas, { timestamp: index / plan.fps });
            look = next;
          } else {
            sample = held.sample.clone();
            if (hashes) hashes.push(hashes.at(-1) ?? "");
          }
          if (held) await emit(held, index);
          held = { sample, from: index };
        } else if (hashes) hashes.push(hashes.at(-1) ?? "");
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
        incoming?.close();
      }
    }
    if (held) await emit(held, plan.frames);
    held = null;
    cancelled();
    encoder.close();
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
    held?.sample.close();
    await samples?.return(undefined).catch(() => {});
    video?.close();
    backdrop?.close();
    composition?.close();
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
