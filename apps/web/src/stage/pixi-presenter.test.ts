import { beforeEach, describe, expect, it, vi } from "vitest";
import { browserWindow } from "./composite.ts";
import { PixiPresenter } from "./pixi-presenter.ts";
import { VideoQuad } from "./video-quad.ts";

const state = vi.hoisted(() => ({ now: 0, renders: 0, renderer: 1 }));
vi.mock("pixi.js/unsafe-eval", () => ({}));
vi.mock("pixi.js/webworker", () => ({}));
vi.mock("./frame-upload.ts", () => ({ FRAME_UPLOAD: "video-frame", frameUploader: () => ({}) }));
vi.mock("./video-quad.ts", () => ({
  VideoQuad: class {
    scale = { set() {} };
    visible = false;
    alpha = 1;
    tint = 0xffffff;
    state = { blend: false };
    shown: [unknown, number, number] | null = null;
    show(source: unknown, width: number, height: number) {
      this.shown = [source, width, height];
    }
    hole: unknown = null;
    around(hole: unknown) {
      this.hole = hole;
    }
  },
}));
vi.mock("./overlays.ts", () => ({
  Overlays: class {
    world = {};
    screen = {};
    density = 0;
    setViewport(_w: number, _h: number, dpr: number) {
      this.density = dpr;
    }
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
    visible = true;
    alpha = 1;
    addChild() {}
    addChildAt() {}
    removeChild() {}
  }
  class Graphics extends Container {
    clear() {}
    rect() {
      return this;
    }
    fill() {
      return this;
    }
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
      type: state.renderer,
      context: { webGLVersion: 2 },
      render: () => {
        state.renders += 1;
      },
      resize() {},
    };
    async init() {}
  }
  return {
    RendererType: { WEBGL: 1, CANVAS: 4 },
    Application,
    Container,
    Graphics,
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
  state.renderer = 1;
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

it("draws a frame through the filtered quad on WebGL, and as a plain sprite elsewhere", async () => {
  const webgl = await presenter();
  webgl.present(frame(2560, 1600) as unknown as VideoFrame);
  webgl.render();
  expect(webgl.video).toBeInstanceOf(VideoQuad);
  expect((webgl.video as unknown as { shown: unknown[] }).shown.slice(1)).toEqual([2560, 1600]);
  state.renderer = 4;
  const software = await presenter();
  expect(software.video).not.toBeInstanceOf(VideoQuad);
});

it("hands the overlays the canvas's density with its size", async () => {
  const p = await presenter();
  p.setViewport(2560, 1600, 1.48);
  expect((p.overlays as unknown as { density: number }).density).toBe(1.48);
});

it("takes a new canvas size only in the render that draws into it", async () => {
  const p = await presenter();
  const calls: string[] = [];
  vi.spyOn(p.app.renderer, "resize").mockImplementation((w, h) => {
    calls.push(`resize ${w}x${h}`);
  });
  vi.spyOn(p.app.renderer, "render").mockImplementation(() => {
    calls.push("render");
  });
  p.setViewport(800, 500);
  p.setViewport(780, 488);
  expect(calls).toEqual([]);
  p.render();
  p.render();
  expect(calls).toEqual(["resize 780x488", "render", "render"]);
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

it("keeps a reusable software surface after the decoded frame closes", async () => {
  const copied: unknown[] = [];
  class SoftwareCanvas {
    constructor(
      public width: number,
      public height: number,
    ) {}
    getContext() {
      return { drawImage: (frame: unknown) => copied.push(frame) };
    }
  }
  vi.stubGlobal("OffscreenCanvas", SoftwareCanvas);
  try {
    state.renderer = 4;
    const p = await presenter();
    const first = frame(1280, 800);
    p.present(first as unknown as VideoFrame);
    p.render();
    const surface = p.video.texture.source.resource;
    expect(surface).toBeInstanceOf(SoftwareCanvas);
    expect(first.closed).toBe(true);
    p.render();
    expect(copied).toEqual([first]);
    const second = frame(2560, 1600);
    p.present(second as unknown as VideoFrame);
    p.render();
    expect(p.video.texture.source.resource).toBe(surface);
    expect(surface).toMatchObject({ width: 2560, height: 1600 });
    expect(copied).toEqual([first, second]);
    expect(second.closed).toBe(true);
  } finally {
    vi.unstubAllGlobals();
  }
});

describe("the browser's window over the desktop", () => {
  const COMPOSITE = { desktop: { w: 2560, h: 1600 } };
  const inFront = (front: "desktop" | "browser") => ({ ...COMPOSITE, front });

  it("changes the pictures' places, so what is on show stays until its own frames come", async () => {
    const p = await presenter();
    p.setComposite(inFront("desktop"));
    const desktopQuad = p.video;
    p.present(frame(2560, 1600) as unknown as VideoFrame);
    p.render();
    p.setComposite(inFront("browser"));
    expect(p.video).not.toBe(desktopQuad);
    // The browser has no picture yet; the desktop's stays under it, on show.
    expect(p.frameSize).toBeNull();
    expect(desktopQuad.visible).toBe(true);
    expect(p.video.visible).toBe(false);
    p.setComposite(inFront("desktop"));
    expect(p.video).toBe(desktopQuad);
    expect(p.frameSize).toEqual({ w: 2560, h: 1600 });
  });

  it("feeds the desktop's frames to the picture under the window, and counts them apart", async () => {
    const p = await presenter();
    p.setComposite(inFront("browser"));
    const under = frame(2560, 1600);
    p.under.present(under as unknown as VideoFrame);
    expect(p.hasFrame).toBe(true);
    p.render();
    expect(under.closed).toBe(true);
    expect(p.under.presented).toBe(1);
    expect(p.presented).toBe(0);
  });

  it("lets go of a covered browser's picture, and only a covered one", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const p = await presenter();
      p.setComposite(inFront("browser"));
      p.present(frame(2560, 1600) as unknown as VideoFrame);
      p.render();
      const browserQuad = p.video;
      p.setComposite(inFront("desktop"));
      p.setComposite(inFront("browser"));
      expect(p.video).toBe(browserQuad);
      expect(p.frameSize).toEqual({ w: 2560, h: 1600 });
      vi.advanceTimersByTime(120_000);
      expect(p.frameSize).toEqual({ w: 2560, h: 1600 });
      p.setComposite(inFront("desktop"));
      vi.advanceTimersByTime(120_000);
      p.setComposite(inFront("browser"));
      expect(p.frameSize).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops drawing the desktop the window covers once the window is opaque", async () => {
    const p = await presenter();
    p.setComposite(inFront("desktop"));
    const desktopQuad = p.video as unknown as { hole: unknown };
    p.present(frame(2560, 1600) as unknown as VideoFrame);
    p.render();
    p.setComposite(inFront("browser"));
    p.render();
    // No picture yet in the window: the desktop shows whole under it.
    expect(desktopQuad.hole).toBeNull();
    p.present(frame(2560, 1600) as unknown as VideoFrame);
    p.render();
    expect(desktopQuad.hole).toBeNull();
    state.now += 500;
    p.render();
    const { x, y, w, h } = browserWindow({ w: 2560, h: 1600 });
    expect(desktopQuad.hole).toEqual({ x, y, w, h });
    p.setComposite(inFront("desktop"));
    expect(desktopQuad.hole).toBeNull();
  });

  it("draws one picture when Replay takes the stage, keeping no browser's behind it", async () => {
    const p = await presenter();
    p.setComposite(inFront("browser"));
    p.present(frame(2560, 1600) as unknown as VideoFrame);
    p.render();
    const browserQuad = p.video;
    p.setComposite(null);
    expect(p.video).not.toBe(browserQuad);
    p.setComposite(inFront("browser"));
    expect(p.video).toBe(browserQuad);
    expect(p.frameSize).toBeNull();
  });

  it("fades the window in once it has a picture, not under reduced motion", async () => {
    const p = await presenter();
    p.setComposite(inFront("browser"));
    p.present(frame(2560, 1600) as unknown as VideoFrame);
    p.render();
    const quad = p.video as unknown as { alpha: number };
    expect(quad.alpha).toBe(0);
    state.now += 80;
    p.render();
    expect(quad.alpha).toBeCloseTo(0.5);
    state.now += 200;
    p.render();
    expect(quad.alpha).toBe(1);
    p.setComposite(inFront("desktop"));
    p.setComposite(inFront("browser"), true);
    p.render();
    expect((p.video as unknown as { alpha: number }).alpha).toBe(1);
  });
});
