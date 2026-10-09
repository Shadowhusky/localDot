import type { Scene } from "@localdot/stage";
import { describe, expect, it } from "vitest";
import { IDLE_LOOK_MS, LINGER_MS, RenderGate, sceneKey } from "./render-gate.ts";

const cam = { scale: 0.5, tx: 0, ty: 0 };
const screen = { w: 2560, h: 1600 };
const scene = (x: number, hud = "Clicking Save") =>
  ({
    control: true,
    cursor: { visible: true, x, y: 400, alpha: 1 },
    rings: [],
    hud: { line: hud },
  }) as unknown as Scene;

describe("sceneKey", () => {
  it("is the same for what draws the same, and differs when anything drawn moves", () => {
    const key = sceneKey(scene(100), cam, screen, [255, 0]);
    expect(sceneKey(scene(100.001), cam, screen, [255, 0])).toBe(key);
    expect(sceneKey(scene(100, "Typing"), cam, screen, [255, 0])).toBe(key);
    expect(sceneKey(scene(101), cam, screen, [255, 0])).not.toBe(key);
    expect(sceneKey(scene(100), { ...cam, tx: 4 }, screen, [255, 0])).not.toBe(key);
    expect(sceneKey(scene(100), cam, { w: 1280, h: 800 }, [255, 0])).not.toBe(key);
    expect(sceneKey(scene(100), cam, screen, [200, 0])).not.toBe(key);
    expect(sceneKey(null, cam, screen, [255, 0])).not.toBe(key);
  });
});

describe("RenderGate", () => {
  it("renders the first look, then only on a change, a frame or an invalidation", () => {
    const gate = new RenderGate();
    expect(gate.due(0, "a", false)).toBe(true);
    expect(gate.due(16, "a", false)).toBe(false);
    expect(gate.due(33, "b", false)).toBe(true);
    expect(gate.due(50, "b", true)).toBe(true);
    expect(gate.due(66, "b", false)).toBe(false);
    gate.invalidate();
    expect(gate.due(83, "b", false)).toBe(true);
    expect(gate.due(100, "b", false)).toBe(false);
  });

  it("looks every display frame while things change, then a few times a second", () => {
    const gate = new RenderGate();
    gate.due(1000, "a", false);
    expect(gate.wait(1000 + LINGER_MS - 1)).toBe(0);
    expect(gate.due(1000 + LINGER_MS, "a", false)).toBe(false);
    expect(gate.wait(1000 + LINGER_MS)).toBe(IDLE_LOOK_MS);
    gate.due(5000, "b", false);
    expect(gate.wait(5016)).toBe(0);
  });
});
