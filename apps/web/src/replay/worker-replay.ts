import {
  buildPlaybackMap,
  cameraFor,
  idleAt,
  playAt,
  playDuration,
  playMsAt,
  type ReplayClock,
  type SessionModel,
  sceneAt,
  sessionAt,
  type View,
} from "@localdot/stage";
import type { PixiPresenter } from "../stage/pixi-presenter.ts";
import type {
  ReplayProbeCommand,
  ReplaySource,
  ReplayTransport,
  WorkerOut,
} from "../stage/worker-protocol.ts";
import { ObserveBackdrop } from "./backdrop.ts";
import { type DecodeMode, sourceAt } from "./decode-policy.ts";
import { ReplayProbe } from "./probe.ts";
import { replayGeometry, replayView } from "./recording-source.ts";
import { ReplayVideo } from "./replay-video.ts";

interface ReplayContext {
  presenter: PixiPresenter;
  model(): SessionModel;
  view(): View;
  viewport(): { w: number; h: number };
  post(message: WorkerOut): void;
}

export class WorkerReplay {
  readonly #source: ReplaySource;
  readonly #context: ReplayContext;
  readonly #backdrop: ObserveBackdrop;
  readonly #probe = new ReplayProbe();
  readonly #opening = new AbortController();
  #video: ReplayVideo | null = null;
  #map = buildPlaybackMap(0, 0, [], false);
  #clock: ReplayClock = { playing: false, speed: 1, anchorWallMs: 0, anchorPlayMs: 0 };
  #targetMs = 0;
  #seekMode: DecodeMode = "exact";
  #generation = 0;
  #lastTime = Number.NEGATIVE_INFINITY;
  #lastTarget = Number.NaN;
  #dirty = true;
  #busy = false;
  #loading = false;
  #closed = false;
  #backdropFailed = false;
  #displayed: { source: "video" | "backdrop"; timestamp: number } | null = null;

  constructor(source: ReplaySource, context: ReplayContext) {
    this.#source = source;
    this.#context = context;
    this.#backdrop = new ObserveBackdrop(source);
    context.presenter.clearVideo();
    if (source.video) {
      this.#loading = true;
      context.post({ type: "replay-status", status: { state: "loading" } });
      void this.#openVideo();
    } else {
      context.post({ type: "replay-status", status: { state: "no-video" } });
    }
  }

  async #openVideo(): Promise<void> {
    try {
      const video = await ReplayVideo.open(this.#source, this.#opening.signal);
      if (this.#closed) {
        video.close();
        return;
      }
      this.#video = video;
      this.#context.post({
        type: "replay-status",
        status: { state: "ready", firstMs: video.firstMs, lastMs: video.lastMs },
      });
    } catch {
      if (!this.#closed)
        this.#context.post({
          type: "replay-status",
          status: {
            state: "error",
            message: "The recording could not be opened. Showing captured steps.",
          },
        });
    } finally {
      this.#loading = false;
      this.#dirty = true;
    }
  }

  transport(transport: ReplayTransport): void {
    this.#map = transport.map;
    const position = Math.max(0, Math.min(playDuration(this.#map), transport.atPlayMs));
    this.#clock = {
      playing: transport.playing,
      speed: transport.speed,
      anchorWallMs: performance.now(),
      anchorPlayMs: position,
    };
    this.#targetMs = sessionAt(this.#map, position);
    this.#seekMode = "exact";
    this.invalidate();
  }

  seek(targetMs: number, mode: "exact" | "preview"): void {
    if (!Number.isFinite(targetMs)) return;
    this.#targetMs = Math.max(0, targetMs);
    this.#clock = {
      ...this.#clock,
      playing: false,
      anchorWallMs: performance.now(),
      anchorPlayMs: playAt(this.#map, this.#targetMs),
    };
    this.#seekMode = mode;
    this.invalidate();
  }

  invalidate(): void {
    this.#generation++;
    this.#dirty = true;
  }

  tick(): void {
    if (this.#closed || this.#loading || this.#busy) return;
    const now = performance.now();
    const playMs = playMsAt(this.#clock, now);
    const targetMs = this.#clock.playing ? sessionAt(this.#map, playMs) : this.#targetMs;
    if (!this.#dirty && targetMs === this.#lastTarget) return;
    const generation = this.#generation;
    const ended = this.#clock.playing && playMs >= playDuration(this.#map);
    this.#busy = true;
    void this.#present(targetMs, generation, ended)
      .catch(() => {
        if (this.#closed || generation !== this.#generation) return;
        this.#context.presenter.clearVideo();
        this.#probe.present(null, "none");
        this.#displayed = null;
        if (this.#video) {
          this.#video.close();
          this.#video = null;
        } else {
          this.#backdropFailed = true;
        }
        this.#context.post({
          type: "replay-status",
          status: { state: "error", message: "Replay media is unavailable at this step." },
        });
        this.#dirty = true;
      })
      .finally(() => {
        this.#busy = false;
      });
  }

  async #present(targetMs: number, generation: number, ended: boolean): Promise<void> {
    const selected = sourceAt(targetMs, {
      hasVideo: this.#video !== null,
      firstMs: this.#video?.firstMs ?? null,
      lastMs: this.#video?.lastMs ?? null,
      gaps: this.#source.gaps,
    });
    let frame: VideoFrame | null = null;
    try {
      if (selected === "video" && this.#video)
        frame = await this.#video.want(targetMs, this.#clock.playing ? "play" : this.#seekMode);
      else if (selected === "backdrop" && !this.#backdropFailed)
        frame = await this.#backdrop.frameAt(this.#context.model(), targetMs);
      if (this.#closed || generation !== this.#generation) return;
      const presenter = this.#context.presenter;
      const model = this.#context.model();
      presenter.setScreen(replayGeometry(model, this.#source, targetMs));
      if (frame && selected !== "hold") {
        const unchanged =
          this.#displayed?.source === selected && this.#displayed.timestamp === frame.timestamp;
        this.#probe.present(frame, selected);
        if (!unchanged) {
          this.#displayed = { source: selected, timestamp: frame.timestamp };
          presenter.present(frame, { backdrop: selected === "backdrop" });
          frame = null;
        }
      } else if (selected === "backdrop") {
        presenter.clearVideo();
        this.#displayed = null;
        this.#probe.present(null, "none");
      } else if (selected === "hold") {
        this.#probe.present(null, "none");
      }
      const camera = this.#camera(targetMs);
      presenter.setCamera(camera);
      presenter.draw(sceneAt(model, targetMs, replayView(this.#source, this.#context.view())));
      presenter.render();
      this.#targetMs = targetMs;
      this.#lastTarget = targetMs;
      this.#dirty = false;
      if (ended)
        this.#clock = { ...this.#clock, playing: false, anchorPlayMs: playDuration(this.#map) };
      const now = performance.now();
      if (!this.#clock.playing || now - this.#lastTime >= 100) {
        this.#lastTime = now;
        this.#context.post({
          type: "replay-time",
          tMs: targetMs,
          playing: this.#clock.playing,
          idle: idleAt(this.#map, targetMs),
        });
      }
      if (ended) this.#context.post({ type: "replay-ended" });
    } finally {
      frame?.close();
    }
  }

  #camera(tMs = this.#targetMs) {
    const screen = replayGeometry(this.#context.model(), this.#source, tMs) ??
      this.#context.presenter.frameSize ?? { w: 1280, h: 800 };
    const viewport = this.#context.viewport();
    return cameraFor({
      stageW: viewport.w,
      stageH: viewport.h,
      desktopW: screen.w,
      desktopH: screen.h,
      zoom: 1,
    });
  }

  async probe(command: ReplayProbeCommand): Promise<unknown> {
    if (this.#closed) return { error: "Replay is closed." };
    return this.#probe.handle(command, {
      presenter: this.#context.presenter,
      model: this.#context.model(),
      view: replayView(this.#source, this.#context.view()),
      camera: this.#camera(),
      viewport: this.#context.viewport(),
      stats: this.#video?.stats() ?? { openFrames: 0, decodeQueue: 0, seeks: 0, decoded: 0 },
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#generation++;
    this.#opening.abort();
    this.#video?.close();
    this.#backdrop.close();
    this.#probe.close();
    this.#context.presenter.clearVideo();
  }
}
