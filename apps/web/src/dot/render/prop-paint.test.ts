import { mulberry32 } from "@localdot/stage";
import { describe, expect, it } from "vitest";
import { DotEngine, type DotPose } from "../engine/engine.ts";
import { TOOLS } from "../engine/tools.ts";
import { paintProps } from "./prop-paint.ts";

// A 2D context that writes down what it is asked to draw, numbers rounded past float noise.
function recorder() {
  const log: string[] = [];
  const note = (name: string, args: unknown[]) =>
    log.push(
      `${name}(${args.map((a) => (typeof a === "number" ? a.toFixed(4) : String(a))).join(",")})`,
    );
  const gradient = () => ({ addColorStop: (...args: unknown[]) => note("stop", args) });
  const ctx = new Proxy(
    {},
    {
      get: (_target, name) =>
        name === "createLinearGradient" || name === "createRadialGradient"
          ? (...args: unknown[]) => {
              note(String(name), args);
              return gradient();
            }
          : (...args: unknown[]) => note(String(name), args),
      set: (_target, name, value) => {
        note(`${String(name)}=`, [typeof value === "object" ? "gradient" : value]);
        return true;
      },
    },
  ) as CanvasRenderingContext2D;
  return { ctx, log };
}

function paint(pose: DotPose): string[] {
  const { ctx, log } = recorder();
  for (const layer of ["back", "front"] as const) paintProps(ctx, pose, layer, "#3fb5de");
  return log;
}

// Every tool in turn, with its progress: keys typed or lines out, how its work ended, helpers.
function inputs(): [number, (e: DotEngine, t: number) => void][] {
  const out: [number, (e: DotEngine, t: number) => void][] = [];
  TOOLS.forEach((tool, i) => {
    const at = i * 1700;
    out.push([at, (e, t) => e.setTool(tool, t)]);
    out.push([at + 200, (e, t) => e.beat(`k${i}`, 2, t)]);
    out.push([at + 700, (e, t) => e.beat(`k${i}`, 4, t, i % 3 !== 0)]);
    out.push([at + 900, (e, t) => e.beat(`n${i}`, 1, t)]);
    out.push([at + 1000, (e, t) => e.setHelpers([{ id: `a${i}` }, { id: `b${i}` }], t)]);
    out.push([at + 1400, (e, t) => e.setHelpers([{ id: `a${i}`, ok: true }, { id: `b${i}` }], t)]);
  });
  return out;
}

const END = TOOLS.length * 1700 + 1500;

// The props painted every 100 ms, with the engine driven at a frame interval of `step`.
function film(step: () => number): string[][] {
  const e = new DotEngine({ seed: 9, t: 0, state: "acting", lod: "hero", control: true });
  const script = inputs();
  const frames: string[][] = [];
  let i = 0;
  let next = 0;
  for (let t = 0; t <= END; t += step()) {
    for (let input = script[i]; input && input[0] <= t; input = script[++i]) {
      for (; next < input[0]; next += 100) frames.push(paint(e.pose(next)));
      e.pose(input[0]);
      input[1](e, input[0]);
    }
    for (; next <= t; next += 100) frames.push(paint(e.pose(next)));
  }
  return frames;
}

describe("dot's prop painters", () => {
  it("draw the same frames whatever the frame rate", () => {
    const rng = mulberry32(4);
    const steady = film(() => 1000 / 60);
    expect(steady.length).toBeGreaterThan(300);
    expect(film(() => 3 + rng() * 140)).toEqual(steady);
  });

  it("draw a pose the same each time, from the pose alone", () => {
    const e = new DotEngine({ seed: 2, t: 0, state: "acting", lod: "glance" });
    e.setTool("terminal", 0);
    e.beat("s1", 3, 100);
    e.beat("s1", 3, 600, true);
    const pose = e.pose(1200);
    const first = paint(pose);
    e.pose(5000);
    expect(paint(pose)).toEqual(first);
  });

  it("draw something for every tool once its prop is out, and nothing once it is put away", () => {
    for (const tool of TOOLS) {
      const e = new DotEngine({ seed: 3, t: 0, state: "acting", lod: "hero" });
      e.setTool(tool, 0);
      e.beat("k", 1, 0);
      if (tool === "delegating") e.setHelpers([{ id: "a" }], 0);
      expect(
        paint(e.pose(1500)).filter((call) => call.startsWith("fill(")).length,
        tool,
      ).toBeGreaterThan(0);
      e.setTool(null, 1500);
      expect(paint(e.pose(9000)), tool).toEqual([]);
    }
  });
});
