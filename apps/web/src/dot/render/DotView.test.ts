// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DotEngine } from "../engine/engine.ts";
import { DotView, type DotViewOptions } from "./DotView.ts";

const T0 = 1000;
let clock = T0;
const views: DotView[] = [];
beforeEach(() => {
  clock = T0;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
});
afterEach(() => {
  for (const v of views.splice(0)) v.destroy();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mount(o: Partial<DotViewOptions> = {}) {
  const root = document.createElement("span");
  document.body.appendChild(root);
  const view = new DotView(root, {
    size: 24,
    state: "idle",
    control: false,
    reducedMotion: false,
    seed: 1,
    ...o,
  });
  views.push(view);
  const plate = (name: string) => root.querySelector(`.dot-plate-${name}`) as HTMLImageElement;
  return { root, view, plate };
}

// Frames every 16 ms from just after `from` up to `to`, as the shared rAF loop would give them.
function drive(view: DotView, from: number, to: number, each?: (t: number) => void) {
  for (let t = from + 16; t <= to; t += 16) {
    clock = t;
    view.frame(t);
    each?.(t);
  }
}

// The left eye's lid clip: its opening at the centre and the upper lid's slope, in frame units.
function lid(root: HTMLElement) {
  const d = root.querySelector('clipPath[id$="-lidL"] path')?.getAttribute("d") ?? "";
  // M-W y1 Q0 c W y2 L W bottom Q0 c -W bottom Z
  const n = (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  const [, y1 = 0, , , w = 1, y2 = 0, , bottom = 0] = n;
  return { open: bottom - (y1 + y2) / 2, slope: (y2 - y1) / (2 * w) };
}

const steps = (values: number[]) => values.slice(1).map((v, i) => Math.abs(v - (values[i] ?? v)));
const between = (values: number[], lo: number, hi: number) =>
  new Set(values.filter((v) => v > lo && v < hi)).size;

describe("DotView", () => {
  it("loads the neutral plate at once and the xenon and dim plates only when they show", () => {
    const { view, plate } = mount();
    expect(plate("neutral").srcset).toMatch(/body-neutral-48.* 48w, .* 96w, .* 192w, .* 448w$/);
    expect(plate("neutral").sizes).toBe("24px");
    drive(view, T0, T0 + 2000);
    expect(plate("xenon").srcset).toBe("");
    expect(plate("dim").srcset).toBe("");

    view.setControl(true);
    drive(view, clock, clock + 50);
    expect(plate("xenon").srcset).toMatch(/body-xenon-48/);
    expect(plate("dim").srcset).toBe("");

    view.setState("offline");
    drive(view, clock, clock + 400);
    expect(plate("dim").srcset).toMatch(/body-dim-48/);
  });

  it("starts with the SVG body, swaps to the plate once it loads, and keeps SVG if a plate fails", () => {
    const loaded = mount();
    expect(loaded.root.dataset.skin).toBe("loading");
    loaded.plate("neutral").dispatchEvent(new Event("load"));
    expect(loaded.root.dataset.skin).toBe("plate");

    const failed = mount({ control: true });
    drive(failed.view, T0, T0 + 50);
    failed.plate("xenon").dispatchEvent(new Event("error"));
    expect(failed.root.dataset.skin).toBe("svg");
    failed.plate("neutral").dispatchEvent(new Event("load"));
    expect(failed.root.dataset.skin).toBe("svg");
  });

  it("draws the face with the badge rules and moves to richer detail as it grows", () => {
    const { root, view } = mount();
    expect(root.dataset.lod).toBe("badge");
    expect(root.querySelectorAll(".dot-eye")).toHaveLength(2);
    expect(root.querySelector<HTMLImageElement>(".dot-shadow")?.srcset).toBe("");
    view.setSize(224);
    expect(root.dataset.lod).toBe("hero");
    expect(root.querySelector<HTMLImageElement>(".dot-shadow")?.srcset).toMatch(/shadow-96/);
    expect((root.querySelector(".dot-eye") as SVGRectElement).style.fill).toMatch(/^url\(/);
  });

  it("catches every blink at its peak while calm frames are skipped, never closing below a device pixel", () => {
    const { root, view } = mount();
    const twin = new DotEngine({ seed: 1, t: T0, state: "idle", lod: "badge" });
    const peaks: number[] = [];
    let wasClosed = false;
    for (let t = T0; t < T0 + 30_000; t++) {
      const closed = twin.pose(t).blink >= 0.85;
      if (closed && !wasClosed) peaks.push(t);
      wasClosed = closed;
    }
    expect(peaks.length).toBeGreaterThan(5);
    const shown: [number, number][] = [];
    drive(view, T0, T0 + 30_000, (t) => shown.push([t, lid(root).open]));
    const minOpen = 1 / (24 / 64);
    for (const p of peaks) {
      const during = shown.filter(([t]) => t >= p && t < p + 40).map(([, open]) => open);
      expect(Math.min(...during), `blink at ${p}`).toBeLessThan(minOpen + 0.05);
    }
    expect(Math.min(...shown.map(([, open]) => open))).toBeGreaterThan(minOpen - 0.01);
  });

  it("crossfades the xenon rim over many frames at badge size when control changes", () => {
    const { view, plate } = mount({ state: "resting" });
    const rim = () => Number(plate("xenon").style.opacity || 0);
    drive(view, T0, T0 + 2000);
    for (const on of [true, false]) {
      const seen: number[] = [];
      view.setControl(on);
      drive(view, clock, clock + 1000, () => seen.push(rim()));
      expect(between(seen, 0.02, 0.98)).toBeGreaterThanOrEqual(8);
      expect(Math.max(...steps(seen))).toBeLessThan(0.15);
      expect(seen.at(-1)).toBe(on ? 1 : 0);
    }
  });

  it("morphs a small lid change over several frames at badge size", () => {
    const { root, view } = mount({ state: "reconnecting", reducedMotion: true });
    drive(view, T0, T0 + 2000);
    const opens = [lid(root).open];
    view.setState("waking");
    drive(view, clock, clock + 600, () => opens.push(lid(root).open));
    expect(opens[0]).toBeCloseTo(0.58 * 12.5, 2);
    expect(opens.at(-1)).toBeCloseTo(0.5 * 12.5, 2);
    expect(between(opens, 6.3, 7.2)).toBeGreaterThanOrEqual(4);
  });

  it("morphs the lid tilt over many frames at badge size from worried to annoyed", () => {
    const { root, view } = mount({ state: "error" });
    drive(view, T0, T0 + 3000);
    const slopes: number[] = [lid(root).slope];
    view.setState("annoyed");
    drive(view, clock, clock + 1000, () => slopes.push(lid(root).slope));
    expect(slopes[0]).toBeLessThan(-0.38);
    expect(slopes.at(-1)).toBeGreaterThan(0.32);
    expect(between(slopes, -0.38, 0.32)).toBeGreaterThanOrEqual(8);
    expect(Math.max(...steps(slopes))).toBeLessThan(0.15);
  });

  it("removes everything it drew when destroyed", () => {
    const { root, view } = mount();
    view.destroy();
    views.splice(views.indexOf(view), 1);
    expect(root.childElementCount).toBe(0);
    expect(root.dataset.skin).toBeUndefined();
  });
});
