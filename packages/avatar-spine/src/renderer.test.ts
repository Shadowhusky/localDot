// @vitest-environment happy-dom
import { buildSkeleton, toyRig } from "@localdot/rig-gen";
import { loadSkeleton } from "@localdot/rig-gen/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SpineRenderer, type SpineRendererOptions } from "./renderer.ts";
import { toyBinding } from "./toy.ts";

const pixi = vi.hoisted(() => ({
  apps: [] as { destroy: ReturnType<typeof vi.fn> }[],
  load: vi.fn(),
  from: vi.fn(),
}));

// WebGL cannot run here; these stand-ins record what mount creates and what it tears down.
vi.mock("pixi.js", () => ({
  Application: class {
    canvas = document.createElement("canvas");
    stage = { addChild: vi.fn() };
    screen = { width: 240, height: 360 };
    renderer = { resize: vi.fn() };
    destroy = vi.fn();
    constructor() {
      pixi.apps.push(this);
    }
    async init() {}
  },
  Assets: { resolver: { hasKey: () => true }, add: vi.fn(), load: pixi.load },
}));
vi.mock("@esotericsoftware/spine-pixi-v8", () => ({ Spine: { from: pixi.from } }));

afterEach(() => {
  pixi.apps.length = 0;
  vi.resetAllMocks();
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
});

const host = () => document.body.appendChild(document.createElement("div"));

describe("SpineRenderer.mount", () => {
  it("tears the app down when a pack file fails to load", async () => {
    const failure = new Error("rig.skel: 404");
    pixi.load.mockRejectedValueOnce(failure);
    const el = host();
    await expect(new SpineRenderer(options()).mount(el)).rejects.toBe(failure);
    expect(pixi.apps[0]?.destroy).toHaveBeenCalledWith(true, { children: true });
    expect(pixi.from).not.toHaveBeenCalled();
    expect(el.querySelector("canvas")).toBeNull();
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
});
