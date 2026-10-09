import { beforeEach, expect, it, vi } from "vitest";
import { PixiPresenter } from "./pixi-presenter.ts";

const state = vi.hoisted(() => ({ now: 0, renders: 0 }));
vi.mock("pixi.js/unsafe-eval", () => ({}));
vi.mock("pixi.js/webworker", () => ({}));
vi.mock("./frame-upload.ts", () => ({ FRAME_UPLOAD: "video-frame", frameUploader: () => ({}) }));
vi.mock("./overlays.ts", () => ({
  Overlays: class {
    world = {};
    screen = {};
    setViewport() {}
    setCamera() {}
    draw() {}
    fieldsAlpha() {
      return 0;
    }
  },
}));
vi.mock("pixi.js", () => {
  class Container {
    scale = { set() {} };
    position = { set() {} };
    addChild() {}
  }
  class Sprite extends Container {
    visible = false;
    tint = 0xffffff;
    texture: unknown = null;
  }
  class ImageSource {
    resource: unknown;
    uploadMethodId = "";
    constructor(options: { resource: unknown }) {
      this.resource = options.resource;
    }
    update() {}
    destroy() {}
  }
  class Texture {
    static EMPTY = new Texture();
    source: unknown;
    constructor(options?: { source: unknown }) {
      this.source = options?.source;
    }
  }
  class Application {
    stage = new Container();
    renderer = {
      render: () => {
        state.renders += 1;
      },
      resize() {},
    };
    async init() {}
  }
  return {
    Application,
    Container,
    Sprite,
    ImageSource,
    Texture,
    DOMAdapter: { set() {} },
    extensions: { add() {} },
    isSafari: () => false,
    WebWorkerAdapter: {},
    Matrix: class {},
    Rectangle: class {},
    RenderTexture: class {},
  };
});

beforeEach(() => {
  state.now = 0;
  state.renders = 0;
  vi.spyOn(performance, "now").mockImplementation(() => state.now);
});

const frame = (w: number, h: number) => {
  const f = { displayWidth: w, displayHeight: h, closed: false, close: () => (f.closed = true) };
  return f;
};
const presenter = () =>
  PixiPresenter.create({} as OffscreenCanvas, {
    width: 390,
    height: 600,
    dpr: 3,
    theme: { void: { color: 0 } } as never,
    warn() {},
  });

it("gives the camera a new frame's size before the render that uploads it", async () => {
  const p = await presenter();
  p.present(frame(1280, 800) as unknown as VideoFrame);
  p.render();
  p.present(frame(2560, 1600) as unknown as VideoFrame);
  expect(p.frameSize).toEqual({ w: 2560, h: 1600 });
  p.clearVideo();
  expect(p.frameSize).toBeNull();
});

it("counts the frames it paints, not those a newer one superseded", async () => {
  const p = await presenter();
  const superseded = [frame(1280, 800), frame(1280, 800)];
  for (const f of superseded) p.present(f as unknown as VideoFrame);
  const shown = frame(1280, 800);
  p.present(shown as unknown as VideoFrame);
  expect(superseded.every((f) => f.closed)).toBe(true);
  expect(p.presented).toBe(0);
  p.render();
  expect(shown.closed).toBe(true);
  expect(p.received).toBe(3);
  expect(p.presented).toBe(1);
  // A render with no new frame paints the same picture again.
  p.render();
  expect(p.presented).toBe(1);
  // Over its first second, 33 frames arrive and every other one of the last 30 is painted.
  for (let k = 0; k < 30; k++) {
    state.now += 1000 / 30;
    p.present(frame(1280, 800) as unknown as VideoFrame);
    if (k % 2) p.render();
  }
  expect(p.received).toBe(33);
  expect(p.presented).toBe(16);
  expect(p.fps).toBe(16);
});
