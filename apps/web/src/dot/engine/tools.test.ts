import { mulberry32 } from "@localdot/stage";
import { describe, expect, it } from "vitest";
import { DotEngine, type DotPose } from "./engine.ts";
import type { DotState } from "./states.ts";
import { type DotTool, TOOL_GAP_MS, TOOL_HOLD_MS, TOOLS } from "./tools.ts";

const engine = (state: DotState = "acting", reducedMotion = false) =>
  new DotEngine({ seed: 5, t: 0, state, lod: "glance", reducedMotion, control: true });

const amount = (p: DotPose, tool: DotTool) => p.props.find((x) => x.tool === tool)?.amount ?? 0;

// The largest amount a tool reached between two times, sampled every frame.
function peak(e: DotEngine, tool: DotTool, from: number, to: number): number {
  let m = 0;
  for (let t = from; t <= to; t += 16) m = Math.max(m, amount(e.pose(t), tool));
  return m;
}

describe("dot's tools", () => {
  it("comes out of dot at once when nothing was out, and settles fully out", () => {
    const e = engine();
    e.setTool("typing", 0);
    expect(amount(e.pose(16), "typing")).toBeGreaterThan(0);
    expect(amount(e.pose(1500), "typing")).toBeCloseTo(1, 3);
  });

  it("holds a prop for its minimum dwell, and a faster change shows only the latest request", () => {
    const e = engine();
    e.setTool("typing", 0);
    e.pose(200);
    e.setTool("terminal", 200);
    e.pose(400);
    e.setTool("browsing", 400);
    expect(peak(e, "typing", 0, TOOL_HOLD_MS - 16)).toBeGreaterThan(0.9);
    expect(amount(e.pose(TOOL_HOLD_MS - 16), "browsing")).toBe(0);
    expect(amount(e.pose(TOOL_HOLD_MS + 120), "browsing")).toBeGreaterThan(0);
    expect(peak(e, "terminal", 0, 3000)).toBe(0);
    expect(amount(e.pose(3000), "typing")).toBeLessThan(0.001);
    expect(amount(e.pose(3000), "browsing")).toBeCloseTo(1, 3);
  });

  it("keeps the work's prop out through a short pause between two actions", () => {
    const e = engine();
    e.setTool("typing", 0);
    e.pose(1000);
    e.setTool("thinking", 1000);
    e.pose(1000 + TOOL_GAP_MS - 300);
    e.setTool("typing", 1000 + TOOL_GAP_MS - 300);
    expect(peak(e, "thinking", 1000, 5000)).toBe(0);
    for (const t of [1200, 2000, 3000, 5000])
      expect(amount(e.pose(t), "typing")).toBeGreaterThan(0.99);
  });

  it("lets a long pause replace the work once the gap has passed", () => {
    const e = engine();
    e.setTool("typing", 0);
    e.pose(1000);
    e.setTool("thinking", 1000);
    expect(amount(e.pose(1000 + TOOL_GAP_MS - 16), "thinking")).toBe(0);
    expect(amount(e.pose(1000 + TOOL_GAP_MS + 150), "thinking")).toBeGreaterThan(0);
    expect(amount(e.pose(5000), "thinking")).toBeCloseTo(1, 3);
    expect(amount(e.pose(5000), "typing")).toBeLessThan(0.001);
  });

  it("turns a leaving prop around from where it is, without restarting its loops", () => {
    const e = engine();
    e.setTool("terminal", 0);
    e.pose(2000);
    e.setTool(null, 2000);
    const leaving = 2000 + TOOL_GAP_MS + 120;
    const before = e.pose(leaving).props.find((p) => p.tool === "terminal");
    expect(before?.amount).toBeGreaterThan(0.05);
    expect(before?.amount).toBeLessThan(0.95);
    e.setTool("terminal", leaving);
    const after = e.pose(leaving).props.find((p) => p.tool === "terminal");
    expect(after?.amount).toBeCloseTo(before?.amount ?? 0, 9);
    expect(after?.clock).toBe(before?.clock);
    // It carries its speed into the turn, so the next frame is close by, then it comes back out.
    const next = e.pose(leaving + 16).props.find((p) => p.tool === "terminal");
    expect(Math.abs((next?.amount ?? 0) - (after?.amount ?? 0))).toBeLessThan(0.06);
    expect(amount(e.pose(leaving + 400), "terminal")).toBeGreaterThan(after?.amount ?? 1);
    expect(amount(e.pose(leaving + 2000), "terminal")).toBeCloseTo(1, 3);
  });

  it("moves the body and eyes continuously from tool to tool and back", () => {
    const e = engine();
    const script: [number, DotTool | null][] = [
      [0, "typing"],
      [1200, "terminal"],
      [2400, "pointing"],
      [3600, "sending"],
      [4800, "needs-you"],
      [6000, "looking"],
      [7600, null],
    ];
    let i = 0;
    let last: DotPose | null = null;
    let jump = 0;
    for (let t = 0; t <= 11_000; t += 16) {
      for (let s = script[i]; s && s[0] <= t; s = script[++i]) e.setTool(s[1], s[0]);
      const p = e.pose(t);
      if (last) {
        const moved = Math.max(
          Math.abs(p.body.x - last.body.x),
          Math.abs(p.body.y - last.body.y),
          64 * Math.abs(p.body.sx - last.body.sx),
          Math.abs(p.gaze.x - last.gaze.x) / 2,
        );
        jump = Math.max(jump, moved);
      }
      last = p;
    }
    expect(jump).toBeLessThan(1.6);
    expect(last?.props).toEqual([]);
  });

  it("taps keys in rhythm with the characters typed, counting each action from zero", () => {
    const e = engine();
    e.setTool("typing", 0);
    e.beat("a1", 4, 100);
    let beats = e.pose(100).props[0]?.beats ?? [];
    expect(beats).toHaveLength(4);
    for (const [j, b] of beats.entries()) expect(Math.abs(-b.age - j * 85)).toBeLessThanOrEqual(15);
    e.beat("a1", 4, 400);
    e.beat("a1", 6, 500);
    beats = e.pose(500).props[0]?.beats ?? [];
    expect(beats).toHaveLength(6);
    e.beat("a2", 1, 600);
    expect(e.pose(600).props[0]?.beats).toHaveLength(7);
    e.beat("a2", 100, 700);
    expect(e.pose(700).props[0]?.beats).toHaveLength(21);
  });

  it("scrolls the terminal a line per output arrival", () => {
    const e = engine();
    e.setTool("terminal", 0);
    e.beat("s1", 1, 300);
    e.beat("s1", 2, 600);
    const p = e.pose(2000).props[0];
    expect(p?.lines).toBe(2);
    expect(p?.scroll).toBeCloseTo(2, 2);
  });

  it("taps the pointer when an action's input goes to the computer", () => {
    const e = engine();
    e.setTool("pointing", 0);
    e.react("dispatch", 500);
    expect(e.pose(560).props[0]?.beats.map((b) => b.age)).toEqual([60]);
  });

  it("tucks every prop away when the task finishes well", () => {
    const e = engine();
    e.setTool("sending", 0);
    e.pose(2000);
    e.react("success", 2000);
    expect(amount(e.pose(2400), "sending")).toBeLessThan(0.5);
    expect(e.pose(4000).props).toEqual([]);
  });

  it("fades props in place under reduced motion, with their loops held still", () => {
    const e = engine("acting", true);
    e.setTool("sending", 0);
    const p = e.pose(3000).props[0];
    expect(p?.still).toBe(true);
    expect(p?.clock).toBe(0);
  });

  it("shows no props where the body does not animate, but still turns the eyes", () => {
    const e = new DotEngine({ seed: 5, t: 0, state: "acting", lod: "badge" });
    const plain = new DotEngine({ seed: 5, t: 0, state: "acting", lod: "badge" });
    e.setTool("typing", 0);
    expect(e.pose(1500).props).toEqual([]);
    expect(e.pose(1500).body).toEqual(plain.pose(1500).body);
    expect(e.pose(1500).gaze.y).toBeGreaterThan(plain.pose(1500).gaze.y + 2);
  });

  it("poses identically whatever the frame rate", () => {
    const inputs: [number, (e: DotEngine, t: number) => void][] = [];
    TOOLS.forEach((tool, i) => {
      inputs.push([i * 1300, (e, t) => e.setTool(tool, t)]);
      inputs.push([i * 1300 + 300, (e, t) => e.beat(`k${i}`, 7, t)]);
      inputs.push([i * 1300 + 500, (e, t) => e.react("dispatch", t)]);
    });
    const drive = (step: () => number) => {
      const e = engine();
      const probes: string[] = [];
      let i = 0;
      let next = 0;
      for (let t = 0; t <= 18_000; t += step()) {
        for (let input = inputs[i]; input && input[0] <= t; input = inputs[++i]) {
          for (; next < input[0]; next += 250) probes.push(JSON.stringify(e.pose(next)));
          e.pose(input[0]);
          input[1](e, input[0]);
        }
        for (; next <= t; next += 250) probes.push(JSON.stringify(e.pose(next)));
      }
      return probes;
    };
    const rng = mulberry32(3);
    const round = (s: string) => s.replace(/-?\d+\.\d{7,}/g, (n) => Number(n).toFixed(6));
    expect(drive(() => 1000 / 60).map(round)).toEqual(drive(() => 3 + rng() * 120).map(round));
  });
});
