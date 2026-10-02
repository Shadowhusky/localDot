import type { Camera, Scene } from "@localdot/stage";
// This polyfill avoids generated functions, keeping the stage compatible with our strict CSP.
import "pixi.js/unsafe-eval";
import {
  Application,
  Container,
  DOMAdapter,
  ImageSource,
  Matrix,
  Rectangle,
  RenderTexture,
  Sprite,
  Texture,
  WebWorkerAdapter,
} from "pixi.js";
import { videoPlacement } from "./geometry.ts";
import { Overlays } from "./overlays.ts";
import type { Presenter } from "./pump.ts";
import type { StageTheme } from "./theme.ts";

export interface PresenterOptions {
  width: number;
  height: number;
  dpr: number;
  theme: StageTheme;
  // Reports, once, a frame of another size than the session's screen.
  warn(message: string): void;
}

// Video quad and world overlays under one camera matrix, screen overlays on top, on an
// OffscreenCanvas in the worker (spec "Rendering").
export class PixiPresenter implements Presenter {
  readonly app: Application;
  readonly world = new Container();
  readonly screen = new Container();
  readonly video = new Sprite();
  readonly overlays: Overlays;
  presented = 0;
  warned = false;
  #source: ImageSource | null = null;
  #pending: VideoFrame | null = null;
  #frameSize: { w: number; h: number } | null = null;
  #screen: { w: number; h: number } | null = null;
  readonly #warn: (message: string) => void;

  static async create(canvas: OffscreenCanvas, opts: PresenterOptions): Promise<PixiPresenter> {
    DOMAdapter.set(WebWorkerAdapter);
    const app = new Application();
    await app.init({
      canvas,
      width: opts.width,
      height: opts.height,
      resolution: 1,
      autoDensity: false,
      preference: "webgl",
      antialias: true,
      background: opts.theme.void.color,
      backgroundAlpha: 1,
      autoStart: false,
      sharedTicker: false,
    });
    return new PixiPresenter(app, opts);
  }

  private constructor(app: Application, opts: PresenterOptions) {
    this.app = app;
    this.#warn = opts.warn;
    this.overlays = new Overlays(opts.theme, opts.dpr);
    this.world.addChild(this.video, this.overlays.world);
    this.screen.addChild(this.overlays.screen);
    app.stage.addChild(this.world, this.screen);
    this.overlays.setViewport(opts.width, opts.height);
  }

  get frameSize(): { w: number; h: number } | null {
    return this.#frameSize;
  }

  // Owns the frame: it is closed after its upload, or at once when a newer one supersedes it.
  present(frame: VideoFrame): void {
    const w = frame.displayWidth;
    const h = frame.displayHeight;
    if (!this.#source || this.#frameSize?.w !== w || this.#frameSize?.h !== h) {
      this.#source?.destroy();
      this.#source = new ImageSource({
        resource: frame,
        width: w,
        height: h,
        autoGarbageCollect: false,
      });
      this.video.texture = new Texture({ source: this.#source });
      this.#frameSize = { w, h };
      this.#place();
    } else {
      this.#source.resource = frame;
      this.#source.update();
    }
    this.#pending?.close();
    this.#pending = frame;
    this.presented += 1;
  }

  setScreen(screen: { w: number; h: number } | null): void {
    this.#screen = screen;
    this.#place();
  }

  // The session's screen is the world; a frame of another size is drawn into it, not the reverse.
  #place(): void {
    if (!this.#frameSize) return;
    const screen = this.#screen ?? this.#frameSize;
    const p = videoPlacement(this.#frameSize, screen);
    this.video.scale.set(p.sx, p.sy);
    if (p.mismatch && !this.warned) {
      this.warned = true;
      this.#warn(
        `frame ${this.#frameSize.w}x${this.#frameSize.h} drawn into a ${screen.w}x${screen.h} session screen`,
      );
    }
  }

  setCamera(cam: Camera): void {
    this.world.scale.set(cam.scale);
    this.world.position.set(cam.tx, cam.ty);
    this.overlays.setCamera(cam);
  }

  setViewport(width: number, height: number): void {
    this.app.renderer.resize(width, height);
    this.overlays.setViewport(width, height);
  }

  draw(scene: Scene | null): void {
    this.#lastScene = scene;
    this.overlays.draw(scene);
  }

  #lastScene: Scene | null = null;

  render(): void {
    this.app.renderer.render(this.app.stage);
    const f = this.#pending;
    this.#pending = null;
    f?.close();
  }

  // Oracle (Task 16): a crop of the composite, or of the overlays alone (the video sprite hidden),
  // rendered with the given camera into a transparent render texture, as RGBA bytes. The overlays
  // size themselves by the camera at draw time (unit = dpr / cam.scale), so the scene is redrawn
  // under `cam` and restored afterwards. The bytes are premultiplied RGBA: a half-transparent
  // xenon pixel reads darker than #3FB5DE, so only solid strokes match the oracle's tolerance.
  extract(
    crop: { x: number; y: number; w: number; h: number },
    layer: "overlays" | "composite",
    cam: Camera,
    scene: Scene | null,
  ): Uint8ClampedArray {
    const rt = RenderTexture.create({ width: crop.w, height: crop.h, resolution: 1 });
    const transform = new Matrix().translate(-crop.x, -crop.y);
    const saved = {
      cam: { scale: this.world.scale.x, tx: this.world.position.x, ty: this.world.position.y },
      video: this.video.visible,
      scene: this.#lastScene,
    };
    this.setCamera(cam);
    this.overlays.draw(scene);
    this.video.visible = layer === "composite";
    this.app.renderer.render({
      container: this.app.stage,
      target: rt,
      transform,
      clear: true,
      clearColor: [0, 0, 0, 0],
    });
    const { pixels } = this.app.renderer.extract.pixels({
      target: rt,
      frame: new Rectangle(0, 0, crop.w, crop.h),
    });
    this.video.visible = saved.video;
    this.setCamera(saved.cam);
    this.overlays.draw(saved.scene);
    rt.destroy(true);
    return pixels;
  }
}
