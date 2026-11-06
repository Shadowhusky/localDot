import { type Application, ImageSource, RendererType, Sprite, Texture } from "pixi.js";
import { FRAME_UPLOAD } from "./frame-upload.ts";
import { videoPlacement } from "./geometry.ts";
import { FrameRate } from "./pump.ts";
import { type QuadHole, VideoQuad } from "./video-quad.ts";

type Size = { w: number; h: number };

// One screen's picture on the stage: the quad, its texture, and the newest frame waiting for it.
export class PictureLayer {
  readonly quad: Sprite | VideoQuad;
  // Frames handed in, and frames painted: one superseded before a render is closed unseen.
  received = 0;
  presented = 0;
  readonly #painted = new FrameRate(performance.now());
  #source: ImageSource | null = null;
  // Canvas2D redraws its source on every render; a closed VideoFrame cannot be retained.
  #softwareFrame: OffscreenCanvas | null = null;
  // The newest frame, uploaded at the next render; one it supersedes is closed unseen.
  #next: VideoFrame | null = null;
  #latestSize: Size | null = null;
  #frameSize: Size | null = null;
  #screen: Size | null = null;
  #around: QuadHole | null = null;
  readonly #app: Application;
  readonly #mismatch: (frame: Size, screen: Size) => void;

  constructor(app: Application, webgl2: boolean, mismatch: (frame: Size, screen: Size) => void) {
    this.#app = app;
    this.#mismatch = mismatch;
    this.quad = webgl2 ? new VideoQuad() : new Sprite();
  }

  // The newest frame's, so the camera frames a new size from the render that uploads it.
  get frameSize(): Size | null {
    return this.#latestSize;
  }

  get fps(): number {
    return this.#painted.fps;
  }

  get hasFrame(): boolean {
    return this.#next !== null;
  }

  // Whether a picture has reached its texture.
  get hasPicture(): boolean {
    return this.#source !== null;
  }

  // Owns the frame: it is closed after its upload, or at once when a newer one supersedes it.
  present(frame: VideoFrame): void {
    this.#next?.close();
    this.#next = frame;
    this.received += 1;
    const w = frame.displayWidth;
    const h = frame.displayHeight;
    if (this.#latestSize?.w !== w || this.#latestSize.h !== h) this.#latestSize = { w, h };
  }

  // The frame waiting, handed to the render that uploads it.
  take(): VideoFrame | null {
    const frame = this.#next;
    this.#next = null;
    return frame;
  }

  upload(frame: VideoFrame): void {
    this.quad.visible = true;
    const w = frame.displayWidth;
    const h = frame.displayHeight;
    let resource: VideoFrame | OffscreenCanvas = frame;
    if (this.#app.renderer.type === RendererType.CANVAS) {
      if (!this.#softwareFrame) this.#softwareFrame = new OffscreenCanvas(w, h);
      if (this.#softwareFrame.width !== w) this.#softwareFrame.width = w;
      if (this.#softwareFrame.height !== h) this.#softwareFrame.height = h;
      const context = this.#softwareFrame.getContext("2d");
      if (!context) throw new Error("Cannot create the software video surface.");
      context.drawImage(frame, 0, 0, w, h);
      resource = this.#softwareFrame;
    }
    if (!this.#source || this.#frameSize?.w !== w || this.#frameSize?.h !== h) {
      this.#source?.destroy();
      this.#source = new ImageSource({
        resource,
        width: w,
        height: h,
        alphaMode: "premultiplied-alpha",
        autoGarbageCollect: false,
      });
      this.#source.uploadMethodId = FRAME_UPLOAD;
      if (this.quad instanceof VideoQuad) this.quad.show(this.#source, w, h);
      else this.quad.texture = new Texture({ source: this.#source });
      this.#frameSize = { w, h };
      this.place(this.#screen);
    } else {
      this.#source.resource = resource;
      this.#source.update();
    }
  }

  painted(now: number): void {
    this.presented += 1;
    this.#painted.count(now);
  }

  // The screen is the world; a frame of another size is drawn into it, not the reverse.
  place(screen: Size | null): void {
    this.#screen = screen;
    if (!this.#frameSize) return;
    const onto = screen ?? this.#frameSize;
    const p = videoPlacement(this.#frameSize, onto);
    this.quad.scale.set(p.sx, p.sy);
    if (p.mismatch) this.#mismatch(this.#frameSize, onto);
  }

  // Stops drawing what a part of the screen covers, given in the screen's pixels.
  around(hole: QuadHole | null): void {
    if (!(this.quad instanceof VideoQuad) || hole === this.#around) return;
    this.#around = hole;
    const frame = this.#frameSize;
    const screen = this.#screen ?? frame;
    if (!hole || !frame || !screen) {
      this.quad.around(null);
      return;
    }
    const sx = frame.w / screen.w;
    const sy = frame.h / screen.h;
    this.quad.around({
      x: hole.x * sx,
      y: hole.y * sy,
      w: hole.w * sx,
      h: hole.h * sy,
    });
  }

  clear(): void {
    this.#next?.close();
    this.#next = null;
    this.quad.visible = false;
    if (this.quad instanceof VideoQuad) this.quad.show(Texture.EMPTY.source, 1, 1);
    else this.quad.texture = Texture.EMPTY;
    this.#source?.destroy();
    this.#source = null;
    this.#softwareFrame = null;
    this.#frameSize = null;
    this.#latestSize = null;
  }
}
