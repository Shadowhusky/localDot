// @vitest-environment happy-dom
import { buildSkeleton, toyRig } from "@localdot/rig-gen";
import { loadSkeleton } from "@localdot/rig-gen/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SpineRenderer, type SpineRendererOptions } from "./renderer.ts";
import { toyBinding } from "./toy.ts";

const pixi = vi.hoisted(() => ({
  apps: [] as {
    destroy: ReturnType<typeof vi.fn>;
    stage: { addChild: ReturnType<typeof vi.fn> };
  }[],
  graphics: [] as { rect: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> }[],
  load: vi.fn(),
  from: vi.fn(),
}));

// WebGL cannot run here; these stand-ins record what mount creates and what it tears down.
vi.mock("pixi.js", () => ({
  Application: class {
    canvas = document.createElement("canvas");
    stage = { addChild: vi.fn() };
    screen = { width: 240, height: 360 };
    renderer = {
      resize: vi.fn((width: number, height: number) => {
        this.screen = { width, height };
      }),
    };
    destroy = vi.fn();
    constructor() {
      pixi.apps.push(this);
    }
    async init() {}
  },
  Graphics: class {
    clear = vi.fn(() => this);
    rect = vi.fn(() => this);
    fill = vi.fn(() => this);
    destroy = vi.fn();
    constructor() {
      pixi.graphics.push(this);
    }
  },
  Assets: { resolver: { hasKey: () => true }, add: vi.fn(), load: pixi.load },
}));
vi.mock("@esotericsoftware/spine-pixi-v8", () => ({ Spine: { from: pixi.from } }));

afterEach(() => {
  pixi.apps.length = 0;
  pixi.graphics.length = 0;
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

const options = (binding = toyBinding): SpineRendererOptions => ({
  skeletonUrl: "/pack/rig.skel",
  atlasUrl: "/pack/rig.atlas",
  binding,
  root: { x: 200, y: 600 },
  frames: { glance: { x: 0, y: 60, w: 400, h: 540 }, watch: { x: 70, y: 90, w: 260, h: 300 } },
});

const toySpine = () => ({
  skeleton: loadSkeleton(buildSkeleton(toyRig())),
  destroy: vi.fn(),
  scale: { set: vi.fn() },
  position: { set: vi.fn() },
  mask: null as unknown,
});

const host = () => document.body.appendChild(document.createElement("div"));

const liveClips = () => pixi.graphics.filter((clip) => clip.destroy.mock.calls.length === 0);

const rectNear = (x: number, y: number, w: number, h: number) =>
  [x, y, w, h].map((value) => expect.closeTo(value, 6));

describe("SpineRenderer.mount", () => {
  it("tears the app down when a pack file fails to load", async () => {
    const failure = new Error("rig.skel: 404");
    pixi.load.mockRejectedValueOnce(failure);
    const el = host();
    await expect(new SpineRenderer(options()).mount(el)).rejects.toBe(failure);
    expect(pixi.apps[0]?.destroy).toHaveBeenCalledWith(true, { children: true });
    expect(pixi.from).not.toHaveBeenCalled();
    expect(el.querySelector("canvas")).toBeNull();
    expect(liveClips()).toEqual([]);
  });

  it("tears the app down when the skeleton cannot be built", async () => {
    const failure = new Error("Region not found in atlas: face");
    pixi.from.mockImplementationOnce(() => {
      throw failure;
    });
    const el = host();
    await expect(new SpineRenderer(options()).mount(el)).rejects.toBe(failure);
    expect(pixi.apps[0]?.destroy).toHaveBeenCalledWith(true, { children: true });
    expect(el.querySelector("canvas")).toBeNull();
    expect(liveClips()).toEqual([]);
  });

  it("refuses a binding that does not match, tearing down the Spine and the app", async () => {
    const spine = toySpine();
    pixi.from.mockReturnValueOnce(spine);
    const el = host();
    await expect(
      new SpineRenderer(options({ ...toyBinding, mouth: "lips" })).mount(el),
    ).rejects.toThrow('avatar rig does not match its binding: slot "lips" not found');
    expect(spine.destroy).toHaveBeenCalled();
    expect(pixi.apps[0]?.destroy).toHaveBeenCalledWith(true, { children: true });
    expect(el.querySelector("canvas")).toBeNull();
    expect(liveClips()).toEqual([]);
  });

  it("names a malformed binding's missing fields instead of failing on them", async () => {
    pixi.from.mockReturnValueOnce(toySpine());
    const binding = JSON.parse(
      JSON.stringify({ ...toyBinding, eyes: { right: toyBinding.eyes.right } }),
    );
    await expect(new SpineRenderer(options(binding)).mount(host())).rejects.toThrow(
      "avatar rig does not match its binding: eyes.left must be an object",
    );
  });

  it("keeps the app and shows its canvas when the pack matches", async () => {
    const spine = toySpine();
    pixi.from.mockReturnValueOnce(spine);
    const el = host();
    await new SpineRenderer(options()).mount(el);
    expect(pixi.apps[0]?.destroy).not.toHaveBeenCalled();
    expect(spine.destroy).not.toHaveBeenCalled();
    expect(el.querySelector("canvas")).not.toBeNull();
  });

  it("holds the neutral pose until the host's first apply", async () => {
    const spine = toySpine();
    const blush = spine.skeleton.findSlot("blush");
    // rig-gen writes no slot colours, so the setup pose shows the blush fully opaque.
    expect(blush?.pose.color.a).toBe(1);
    pixi.from.mockReturnValueOnce(spine);
    await new SpineRenderer(options()).mount(host());
    expect(blush?.pose.color.a).toBe(0);
  });
});

describe("SpineRenderer frame clip", () => {
  it("masks the skeleton to its glance frame as placed in the view", async () => {
    const spine = toySpine();
    pixi.from.mockReturnValueOnce(spine);
    await new SpineRenderer(options()).mount(host());
    const [clip] = pixi.graphics;
    expect(clip).toBeDefined();
    expect(spine.mask).toBe(clip);
    // Pixi only notices a redrawn mask that sits in the scene.
    expect(pixi.apps[0]?.stage.addChild.mock.calls.flat()).toContain(clip);
    // 400x540 frame in the 240x360 view: scale 0.6, so 240x324 starting 18 px down.
    expect(clip?.rect.mock.lastCall).toEqual(rectNear(0, 18, 240, 324));
  });

  it("moves the clip to the watch frame when the presence changes", async () => {
    pixi.from.mockReturnValueOnce(toySpine());
    const renderer = new SpineRenderer(options());
    await renderer.mount(host());
    renderer.setPresence("watch");
    // 260x300 frame in the 240x360 view: scale 12/13, so 240 wide and centred down.
    expect(pixi.graphics[0]?.rect.mock.lastCall).toEqual(rectNear(0, 540 / 13, 240, 3600 / 13));
  });

  it("re-clips when the element resizes", async () => {
    const onResize: (() => void)[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          onResize.push(callback);
        }
        observe() {}
        disconnect() {}
      },
    );
    pixi.from.mockReturnValueOnce(toySpine());
    const el = host();
    await new SpineRenderer(options()).mount(el);
    Object.defineProperties(el, { clientWidth: { value: 480 }, clientHeight: { value: 360 } });
    for (const callback of onResize) callback();
    // 400x540 frame in a 480x360 view: scale 2/3, so full height and centred across.
    expect(pixi.graphics[0]?.rect.mock.lastCall).toEqual(rectNear(320 / 3, 0, 800 / 3, 360));
  });

  it("destroys the clip on unmount", async () => {
    pixi.from.mockReturnValueOnce(toySpine());
    const renderer = new SpineRenderer(options());
    await renderer.mount(host());
    expect(pixi.graphics).toHaveLength(1);
    renderer.unmount();
    expect(liveClips()).toEqual([]);
  });
});
