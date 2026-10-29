// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DotEngine } from "../engine/engine.ts";
import { setWearing } from "../wearing.ts";
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
  setWearing([]);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mount(o: Partial<DotViewOptions> = {}, root = document.createElement("span")) {
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

function translate(root: HTMLElement): [number, number] {
  const body = root.querySelector(".dot-body") as HTMLElement;
  const m = body.style.transform.match(/translate\((-?[\d.]+)px, (-?[\d.]+)px\)/);
  return [Number(m?.[1]), Number(m?.[2])];
}

const worn = (root: HTMLElement) =>
  [...root.querySelectorAll<HTMLImageElement>(".dot-body > .dot-wear")].map(
    (img) => img.dataset.wear,
  );

// A matrix's six numbers, from an SVG transform attribute or a CSS transform.
const matrix = (text: string | null | undefined) =>
  (text?.match(/matrix\(([^)]*)\)/)?.[1] ?? "").split(/[\s,]+/).map(Number);

const steps = (values: number[]) => values.slice(1).map((v, i) => Math.abs(v - (values[i] ?? v)));
const between = (values: number[], lo: number, hi: number) =>
  new Set(values.filter((v) => v > lo && v < hi)).size;

describe("DotView", () => {
  it("wears its own outfit over the face, or the user's dot's, and changes with it", () => {
    setWearing(["headphones", "mustache"]);
    const { root, view } = mount({ wearables: ["round-glasses", "mortarboard"] });
    expect(worn(root)).toEqual(["mortarboard", "round-glasses"]);
    expect(root.querySelector(".dot-face ~ .dot-wear")).not.toBeNull();
    const glasses = root.querySelector<HTMLImageElement>('[data-wear="round-glasses"]');
    expect(glasses?.srcset).toMatch(/wear-round-glasses-48.* 48w, .* 448w$/);
    expect(glasses?.sizes).toBe("24px");

    view.setWearables(undefined);
    expect(worn(root)).toEqual(["headphones", "mustache"]);
    setWearing(["hoodie"]);
    expect(worn(root)).toEqual(["hoodie"]);
    view.setSize(96);
    expect(root.querySelector<HTMLImageElement>(".dot-wear")?.sizes).toBe("96px");
  });

  it("keeps what is on the face on the eyes as they look around, and the rest on the body", () => {
    const { root, view } = mount({ size: 192, wearables: ["round-glasses", "hoodie"] });
    view.setBias({ x: 6, y: 4 });
    drive(view, T0, T0 + 1200);
    const [left, right] = [...root.querySelectorAll(".dot-face g[transform]")].map((g) =>
      matrix(g.getAttribute("transform")),
    );
    const k = 192 / 64;
    const glasses = matrix(
      root.querySelector<HTMLElement>('[data-wear="round-glasses"]')?.style.transform,
    );
    const centre = [32 + (glasses[4] ?? 0) / k, 27.5 + (glasses[5] ?? 0) / k];
    expect(centre[0]).toBeGreaterThan(33);
    expect(centre[0]).toBeCloseTo(((left?.[4] ?? 0) + (right?.[4] ?? 0)) / 2, 0);
    expect(centre[1]).toBeCloseTo(((left?.[5] ?? 0) + (right?.[5] ?? 0)) / 2, 0);
    expect(root.querySelector<HTMLElement>('[data-wear="hoodie"]')?.style.transform).toBe("");
  });

  it("turns a hat with the face about its front edge, by a share across, while clothes stay", () => {
    const { root, view } = mount({ size: 192, wearables: ["cap", "hoodie"] });
    const cap = root.querySelector<HTMLElement>('[data-wear="cap"]');
    expect(cap?.style.transformOrigin).toBe("50% 26.5625%");
    const k = 192 / 64;
    // Where the eyes' midpoint went from its place on a still face, in frame units.
    const eyes = () => {
      const [l, r] = [...root.querySelectorAll(".dot-face g[transform]")].map((g) =>
        matrix(g.getAttribute("transform")),
      );
      return [((l?.[4] ?? 0) + (r?.[4] ?? 0)) / 2 - 32, ((l?.[5] ?? 0) + (r?.[5] ?? 0)) / 2 - 27.5];
    };
    for (const gaze of [
      { x: 6, y: 4 },
      { x: -5, y: -5 },
    ]) {
      view.setBias(gaze);
      drive(view, clock, clock + 3000);
      const [ex = 0, ey = 0] = eyes();
      const m = matrix(cap?.style.transform);
      const [dx, dy] = [(m[4] ?? 0) / k, (m[5] ?? 0) / k];
      // Up and down the bill keeps to the eyes; across, it follows them by about half.
      expect(Math.sign(dy)).toBe(Math.sign(ey));
      expect(Math.abs(dy - ey)).toBeLessThan(1.2);
      expect(dx / ex).toBeGreaterThan(0.3);
      expect(dx / ex).toBeLessThan(0.6);
      // The turn tilts and foreshortens it a little, never warps it.
      for (const [i, rest] of [1, 0, 0, 1].entries())
        expect(Math.abs((m[i] ?? rest) - rest)).toBeLessThanOrEqual(0.081);
    }
    expect(root.querySelector<HTMLElement>('[data-wear="hoodie"]')?.style.transform).toBe("");
  });

  it("dims what it wears with the body", () => {
    const { root, view } = mount({ wearables: ["beret"] });
    const beret = root.querySelector<HTMLElement>('[data-wear="beret"]');
    expect(beret?.style.filter).toBe("");
    view.setState("offline");
    drive(view, T0, T0 + 1500);
    expect(beret?.style.filter).toMatch(/^brightness\(0\.[3-5]\d*\)$/);
  });

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

  it("ignores late image events from a view destroyed on the same host", () => {
    const first = mount({ control: true });
    drive(first.view, T0, T0 + 50);
    const [oldNeutral, oldXenon] = [first.plate("neutral"), first.plate("xenon")];
    first.view.destroy();
    views.splice(views.indexOf(first.view), 1);
    const second = mount({}, first.root);
    oldNeutral.dispatchEvent(new Event("load"));
    expect(second.root.dataset.skin).toBe("loading");
    oldXenon.dispatchEvent(new Event("error"));
    expect(second.root.dataset.skin).toBe("loading");
  });

  it("paints a tool's prop behind and in front of the body, sized once, and clears it when put down", () => {
    const calls: string[] = [];
    const context = new Proxy(
      {},
      {
        get: (_target, name) =>
          name === "createLinearGradient" || name === "createRadialGradient"
            ? () => ({ addColorStop() {} })
            : (..._args: unknown[]) => calls.push(String(name)),
        set: () => true,
      },
    );
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      (() => context) as never,
    );
    const { root, view } = mount({ size: 96, state: "acting" });
    drive(view, T0, T0 + 200);
    expect(root.querySelector(".dot-props")).toBeNull();
    view.setTool("typing");
    drive(view, clock, clock + 400);
    const layers = [...root.children].map((node) => node.className);
    expect(layers.indexOf("dot-props dot-props-back")).toBeLessThan(layers.indexOf("dot-body"));
    expect(layers.indexOf("dot-props dot-props-front")).toBeGreaterThan(layers.indexOf("dot-body"));
    const front = root.querySelector<HTMLCanvasElement>(".dot-props-front");
    expect(front?.width).toBe(96);
    expect(calls).toContain("roundRect");
    view.setTool(null);
    drive(view, clock, clock + 4000);
    calls.length = 0;
    drive(view, clock, clock + 200);
    expect(calls).not.toContain("roundRect");
  });

  it("draws the face with the badge rules and moves to richer detail as it grows", () => {
    const { root, view } = mount();
    expect(root.dataset.lod).toBe("badge");
    expect(root.querySelectorAll(".dot-eye")).toHaveLength(2);
    expect(root.querySelector(".dot-eye")?.getAttribute("height")).toBe("12.500");
    expect(root.querySelector<HTMLImageElement>(".dot-shadow")?.srcset).toBe("");
    view.setSize(224);
    expect(root.dataset.lod).toBe("hero");
    expect(root.querySelector(".dot-eye")?.getAttribute("height")).toBe("10.000");
    expect(root.querySelector<HTMLImageElement>(".dot-shadow")?.srcset).toMatch(/shadow-96/);
    expect((root.querySelector(".dot-eye") as SVGRectElement).style.fill).toMatch(/^url\(/);
  });

  it("snaps a badge's body to device pixels and its eyes to half device pixels", () => {
    vi.stubGlobal("devicePixelRatio", 2);
    const { root, view } = mount({ state: "listening" });
    const halfDevPerUnit = (24 / 64) * 2 * 2;
    const offGrid = (v: number, per: number) => Math.abs(v * per - Math.round(v * per));
    drive(view, T0, T0 + 6000, () => {
      for (const v of translate(root)) expect(offGrid(v, 2)).toBeLessThan(1e-6);
      for (const g of root.querySelectorAll(".dot-face > g > g")) {
        const m = (g.getAttribute("transform")?.match(/-?[\d.]+/g) ?? []).map(Number);
        for (const v of m.slice(4)) expect(offGrid(v, halfDevPerUnit)).toBeLessThan(0.01);
      }
    });
    expect(translate(root)[0]).toBe(-0.5);
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

  it("keeps a speaking dot near its calm frame rate: no talk-bob on a badge, about 9 fps above", () => {
    const pose = vi.spyOn(DotEngine.prototype, "pose");
    const badge = mount({ state: "speaking" });
    const body = badge.root.querySelector(".dot-body") as HTMLElement;
    const scales = new Set<string>();
    drive(badge.view, T0, T0 + 20_000, () =>
      scales.add(body.style.transform.split("scale")[1] ?? ""),
    );
    expect(scales.size).toBe(1);
    expect(pose.mock.calls.length / 20).toBeLessThan(20);

    pose.mockClear();
    const hero = mount({ state: "speaking", size: 224 }).view;
    drive(hero, clock, clock + 20_000);
    expect(pose.mock.calls.length / 20).toBeLessThan(20);
  });

  it("jumps ahead instead of replaying a gap of more than 10 s", () => {
    const skip = vi.spyOn(DotEngine.prototype, "skipTo");
    const { view } = mount();
    drive(view, T0, T0 + 9000);
    expect(skip).not.toHaveBeenCalled();
    clock += 10_001;
    view.frame(clock);
    expect(skip).toHaveBeenCalledWith(clock);
  });

  it("removes everything it drew when destroyed", () => {
    const { root, view } = mount();
    view.destroy();
    views.splice(views.indexOf(view), 1);
    expect(root.childElementCount).toBe(0);
    expect(root.dataset.skin).toBeUndefined();
  });

  it("draws a prop's loops at 20 fps at the dock's size, and at 30 fps while Replay plays it", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const { view } = mount({ size: 56 });
    view.setTool("typing");
    drive(view, T0, T0 + 2000);
    const gaps = () => {
      const waits: number[] = [];
      drive(view, clock, clock + 500, (t) => waits.push(view.frame(t)));
      return Math.max(...waits);
    };
    expect(gaps()).toBeGreaterThan(33);
    expect(gaps()).toBeLessThanOrEqual(50);
    view.setFullRate(true);
    expect(gaps()).toBeLessThanOrEqual(33);
  });

  it("tells the loop how long a calm dot can wait, and draws a prop's loops at half rate", () => {
    const { view } = mount({ size: 96 });
    const waits: number[] = [];
    drive(view, T0, T0 + 4000);
    drive(view, clock, clock + 1000, (t) => waits.push(view.frame(t)));
    expect(Math.max(...waits)).toBeGreaterThan(33);
    expect(Math.max(...waits)).toBeLessThanOrEqual(110);

    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    view.setTool("typing");
    drive(view, clock, clock + 2000);
    const looping: number[] = [];
    drive(view, clock, clock + 500, (t) => looping.push(view.frame(t)));
    expect(looping.filter((w) => w > 0).length).toBeGreaterThan(looping.length / 3);
  });
});
