import type { Camera, Scene } from "@localdot/stage";
// This polyfill avoids generated functions, keeping the stage compatible with our strict CSP.
import "pixi.js/unsafe-eval";
// Loaded here, not by init(): iOS Safari otherwise registers its extensions twice and init fails.
import "pixi.js/webworker";
import {
  Application,
  Container,
  DOMAdapter,
  extensions,
  Graphics,
  isSafari,
  Matrix,
  Rectangle,
  RendererType,
  RenderTexture,
  type Sprite,
  type WebGLRenderer,
  WebWorkerAdapter,
} from "pixi.js";
import { type BrowserWindow, browserWindow, type StageScreen } from "./composite.ts";
import { frameUploader } from "./frame-upload.ts";
import { Overlays } from "./overlays.ts";
import { PictureLayer } from "./picture-layer.ts";
import type { Presenter } from "./pump.ts";
import type { StageTheme } from "./theme.ts";
import type { VideoQuad } from "./video-quad.ts";
import type { StageComposite } from "./worker-protocol.ts";

export interface PresenterOptions {
  width: number;
  height: number;
  dpr: number;
  theme: StageTheme;
  // Reports, once, a frame of another size than the session's screen.
  warn(message: string): void;
}

let frameUploads = false;

const webgl2 = (renderer: Application["renderer"]) =>
  renderer.type === RendererType.WEBGL && (renderer as WebGLRenderer).context.webGLVersion === 2;

// --color-stage-dim over the picture: what is left of each pixel under its 42 % veil.
const DIM_LEVEL = 0.58;
const DIM_MS = 200;

// The browser's window fades in over the desktop, and a covered screen's picture goes this long
// after its screen last showed, so a task that comes back gets it at once.
const REVEAL_MS = 160;
const POSTER_KEPT_MS = 60_000;
const WINDOW_SHADOW = [
  { reach: 1, alpha: 0.28 },
  { reach: 3, alpha: 0.14 },
  { reach: 6, alpha: 0.07 },
] as const;

// Video quad and world overlays under one camera matrix, screen overlays on top, on an
// OffscreenCanvas in the worker (spec "Rendering"). With the browser in front, its quad takes that
// place, inside its window (composite.ts), over the desktop's picture under the desktop's camera.
export class PixiPresenter implements Presenter {
  readonly app: Application;
  readonly world = new Container();
  readonly screen = new Container();
  readonly overlays: Overlays;
  warned = false;
  #main: PictureLayer;
  #under: PictureLayer;
  readonly #below = new Container();
  readonly #windowFrame = new Graphics();
  #composite: StageComposite | null = null;
  #window: BrowserWindow | null = null;
  #frameDrawn: string | null = null;
  #posterTimer: ReturnType<typeof setTimeout> | undefined;
  #reveal: { start: number | null; ms: number } | null = null;
  #backdrop = false;
  #dim = { from: 1, to: 1, start: 0, ms: 0 };
  // The canvas size the next render takes.
  #resize: { w: number; h: number } | null = null;
  #dpr: number;
  readonly #warn: (message: string) => void;

  static async create(canvas: OffscreenCanvas, opts: PresenterOptions): Promise<PixiPresenter> {
    DOMAdapter.set(WebWorkerAdapter);
    if (!frameUploads) {
      frameUploads = true;
      extensions.add(frameUploader(isSafari()));
    }
    const app = new Application();
    await app.init({
      canvas,
      width: opts.width,
      height: opts.height,
      resolution: 1,
      autoDensity: false,
      preference: "webgl",
      // Multisampling the whole canvas costs the GPU on every frame, for the overlays' edges only.
      antialias: false,
      background: opts.theme.void.color,
      backgroundAlpha: 1,
      autoStart: false,
      sharedTicker: false,
      manageImports: false,
    });
    return new PixiPresenter(app, opts);
  }

  private constructor(app: Application, opts: PresenterOptions) {
    this.app = app;
    this.#warn = opts.warn;
    this.#dpr = opts.dpr;
    this.#main = this.#layer(app);
    this.#under = this.#layer(app);
    this.#under.quad.visible = false;
    this.#below.visible = false;
    this.#windowFrame.visible = false;
    this.overlays = new Overlays(opts.theme, opts.dpr);
    this.world.addChild(this.#main.quad, this.overlays.world);
    this.#below.addChild(this.#under.quad, this.#windowFrame);
    this.screen.addChild(this.overlays.screen);
    app.stage.addChild(this.#below, this.world, this.screen);
    this.overlays.setViewport(opts.width, opts.height);
  }

  #layer(app: Application): PictureLayer {
    return new PictureLayer(app, webgl2(app.renderer), (frame, screen) => {
      if (this.warned || this.#backdrop) return;
      this.warned = true;
      this.#warn(`frame ${frame.w}x${frame.h} drawn into a ${screen.w}x${screen.h} screen`);
    });
  }

  get video(): Sprite | VideoQuad {
    return this.#main.quad;
  }

  get received(): number {
    return this.#main.received;
  }

  get presented(): number {
    return this.#main.presented;
  }

  // The newest frame's, so the camera frames a new size from the render that uploads it.
  get frameSize(): { w: number; h: number } | null {
    return this.#main.frameSize;
  }

  // Painted frames per second.
  get fps(): number {
    return this.#main.fps;
  }

  // The desktop's picture under the browser's window.
  get under(): { presented: number; fps: number; present(frame: VideoFrame): void } {
    return this.#under;
  }

  // Owns the frame: it is closed after its upload, or at once when a newer one supersedes it.
  present(frame: VideoFrame, options?: { backdrop?: boolean }): void {
    this.#backdrop = options?.backdrop === true;
    this.#main.present(frame);
  }

  get hasFrame(): boolean {
    return this.#main.hasFrame || this.#under.hasFrame;
  }

  // Which screen is in front. Their pictures change places as it changes, so what is on show stays
  // on show until its screen's own frames come.
  setComposite(next: StageComposite | null, reducedMotion = false): void {
    const was = this.#composite?.front === "browser";
    const is = next?.front === "browser";
    this.#composite = next;
    this.#window = is && next ? browserWindow(next.desktop) : null;
    if (was !== is) {
      const main = this.#main;
      const under = this.#under;
      this.#below.removeChild(under.quad);
      this.world.removeChild(main.quad);
      this.world.addChildAt(under.quad, 0);
      this.#below.addChildAt(main.quad, 0);
      this.#main = under;
      this.#under = main;
      main.quad.visible = main.hasPicture;
      under.quad.visible = under.hasPicture;
      main.around(null);
      under.around(null);
      this.#reveal = is && !reducedMotion ? { start: null, ms: REVEAL_MS } : null;
    }
    this.#below.visible = is;
    if (next) this.#under.place(next.desktop);
    clearTimeout(this.#posterTimer);
    if (!is) {
      if (next) this.#posterTimer = setTimeout(() => this.clearCovered(), POSTER_KEPT_MS);
      else this.clearCovered();
    }
  }

  // The covered browser's picture, which should not come back: another task's, or none's.
  clearCovered(): void {
    if (this.#composite?.front !== "browser") this.#under.clear();
  }

  setDesktopCamera(cam: Camera): void {
    this.#below.scale.set(cam.scale);
    this.#below.position.set(cam.tx, cam.ty);
    this.#drawWindowFrame(cam);
  }

  // A soft shadow each side of the browser's window, so it reads as one.
  #drawWindowFrame(cam: Camera): void {
    const window = this.#window;
    const g = this.#windowFrame;
    if (!window) {
      g.visible = false;
      return;
    }
    g.visible = this.#main.hasPicture;
    const unit = this.#dpr / cam.scale;
    const key = `${window.x}/${window.y}/${window.w}/${window.h}/${unit}`;
    if (key === this.#frameDrawn) return;
    this.#frameDrawn = key;
    g.clear();
    for (const { reach, alpha } of WINDOW_SHADOW) {
      const r = reach * unit;
      g.rect(window.x - r, window.y, window.w + 2 * r, window.h).fill({ color: 0, alpha });
    }
  }

  #revealLevel(now: number): number {
    const reveal = this.#reveal;
    if (!reveal) return 1;
    if (reveal.start === null) {
      if (!this.#main.hasPicture) return 1;
      reveal.start = now;
    }
    const k = (now - reveal.start) / reveal.ms;
    if (k >= 1) this.#reveal = null;
    return Math.min(1, Math.max(0, k));
  }

  // What changes the picture over time without a new scene: the dim's level, the fields' fade.
  fades(now: number): number[] {
    return [this.#tint(now), this.overlays.fieldsAlpha(now), this.#revealLevel(now)];
  }

  setScreen(screen: StageScreen | null): void {
    this.#main.place(screen);
  }

  clearVideo(): void {
    this.#main.clear();
  }

  setCamera(cam: Camera): void {
    // Drawn one to one, a picture half a pixel off would be blurred across its every texel.
    const snap = (at: number) => (cam.scale === 1 ? Math.round(at) : at);
    this.world.scale.set(cam.scale);
    this.world.position.set(snap(cam.tx), snap(cam.ty));
    this.overlays.setCamera(cam);
  }

  // The canvas takes its new size in the render that next draws into it: resizing clears it, so a
  // size taken any earlier could reach a display frame as a blank stage.
  setViewport(width: number, height: number, dpr = this.#dpr): void {
    this.#dpr = dpr;
    this.#resize = { w: width, h: height };
    this.overlays.setViewport(width, height, dpr);
  }

  draw(scene: Scene | null): void {
    this.#lastScene = scene;
    this.overlays.draw(scene);
  }

  #lastScene: Scene | null = null;

  // Under an open decision the picture dims and the overlays over it stay lit, so the ring on what
  // dot will press still shows. The level fades from wherever it is.
  setDim(on: boolean, reducedMotion = false): void {
    const now = performance.now();
    this.#dim = { from: this.#dimLevel(now), to: on ? DIM_LEVEL : 1, start: now, ms: DIM_MS };
    if (reducedMotion) this.#dim.ms = 0;
  }

  #tint(now: number): number {
    return Math.round(255 * this.#dimLevel(now));
  }

  #dimLevel(now: number): number {
    const { from, to, start, ms } = this.#dim;
    const k = ms > 0 ? Math.min(1, (now - start) / ms) : 1;
    return from + (to - from) * k;
  }

  render(): void {
    const frame = this.#main.take();
    const under = this.#under.take();
    try {
      if (frame) this.#main.upload(frame);
      if (under) this.#under.upload(under);
      const now = performance.now();
      const level = this.#tint(now);
      const tint = (level << 16) | (level << 8) | level;
      this.#main.quad.tint = tint;
      this.#under.quad.tint = tint;
      const reveal = this.#revealLevel(now);
      if (this.#window) {
        this.#main.quad.alpha = reveal;
        this.#windowFrame.alpha = reveal;
        this.#windowFrame.visible = this.#main.hasPicture;
        if ("state" in this.#main.quad) this.#main.quad.state.blend = reveal < 1;
        this.#under.around(reveal === 1 && this.#main.hasPicture ? this.#window : null);
      } else {
        this.#main.quad.alpha = 1;
        if ("state" in this.#main.quad) this.#main.quad.state.blend = false;
      }
      if (this.#resize) {
        this.app.renderer.resize(this.#resize.w, this.#resize.h);
        this.#resize = null;
      }
      this.app.renderer.render(this.app.stage);
      if (frame) this.#main.painted(now);
      if (under) this.#under.painted(now);
    } finally {
      frame?.close();
      under?.close();
    }
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
