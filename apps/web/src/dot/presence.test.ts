// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerPlace } from "./places.ts";
import { Presence } from "./presence.ts";

interface Run {
  frames: Keyframe[];
  options: KeyframeAnimationOptions;
  animation: { startTime: number | null; cancel(): void; finished: Promise<void> };
  finish(): void;
  cancelled: boolean;
}

const RECTS = {
  hero: { left: 420, top: 217, width: 224 },
  dock: { left: 8, top: 716, width: 96 },
  badge: { left: 300, top: 60, width: 32 },
} as const;

let clock = 0;
let runs: Run[] = [];
const cleanups: (() => void)[] = [];

function place(name: keyof typeof RECTS) {
  const element = document.createElement("span");
  const r = RECTS[name];
  element.getBoundingClientRect = () =>
    ({ left: r.left, top: r.top, width: r.width, height: r.width }) as DOMRect;
  document.body.append(element);
  cleanups.push(registerPlace(name, element));
}

function presence(reducedMotion = false) {
  const frame = document.createElement("div");
  const host = document.createElement("span");
  frame.append(host);
  document.body.append(frame);
  frame.animate = ((frames: Keyframe[], options: KeyframeAnimationOptions) => {
    let finish = () => {};
    let cancel = () => {};
    const finished = new Promise<void>((resolve, reject) => {
      finish = resolve;
      cancel = () => reject(new Error("cancelled"));
    });
    const run: Run = {
      frames,
      options,
      finish,
      cancelled: false,
      animation: {
        startTime: null,
        finished,
        cancel: () => {
          run.cancelled = true;
          cancel();
        },
      },
    };
    runs.push(run);
    return run.animation as unknown as Animation;
  }) as typeof frame.animate;
  const p = new Presence(frame, host, { state: "idle", control: false, reducedMotion });
  cleanups.push(() => p.destroy());
  return { p, frame };
}

const parse = (transform: unknown) => {
  const m = /translate3d\(([-\d.]+)px, ([-\d.]+)px, 0\) scale\(([-\d.]+)\)/.exec(String(transform));
  if (!m) throw new Error(`not a dot transform: ${String(transform)}`);
  return { x: Number(m[1]), y: Number(m[2]), k: Number(m[3]) };
};

// Where a run is drawn at time t, between the frames it was given.
function drawnAt(run: Run, t: number) {
  const span = Number(run.options.duration);
  const at = ((t - Number(run.animation.startTime)) / span) * (run.frames.length - 1);
  const i = Math.min(Math.floor(at), run.frames.length - 2);
  const a = parse(run.frames[i]?.transform);
  const b = parse(run.frames[i + 1]?.transform);
  const f = at - i;
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, k: a.k + (b.k - a.k) * f };
}

beforeEach(() => {
  clock = 1000;
  runs = [];
  Object.defineProperty(document, "timeline", {
    configurable: true,
    value: {
      get currentTime() {
        return clock;
      },
    },
  });
  for (const name of ["hero", "dock", "badge"] as const) place(name);
});

afterEach(() => {
  for (const fn of cleanups.splice(0).reverse()) fn();
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("dot's presence", () => {
  it("hands each flight to the compositor, starting at the frame it was asked for", () => {
    const { p } = presence();
    p.goTo("hero");
    expect(runs).toHaveLength(0);
    p.goTo("dock");
    const [run] = runs;
    expect(run?.animation.startTime).toBe(1000);
    expect(run?.options).toMatchObject({ easing: "linear", fill: "forwards" });
    expect(parse(run?.frames[0]?.transform)).toMatchObject({ x: 420, y: 217, k: 1 });
    expect(parse(run?.frames.at(-1)?.transform)).toMatchObject({ x: 8, y: 716 });
  });

  it("turns mid-flight from where it is on screen, with one flight and one take-off", () => {
    const { p } = presence();
    const hop = vi.spyOn(p.view, "hop");
    p.goTo("hero");
    p.goTo("dock");
    const first = runs[0] as Run;
    clock = 1000 + 230;
    const shown = drawnAt(first, clock);
    p.goTo("hero");
    expect(first.cancelled).toBe(true);
    expect(runs).toHaveLength(2);
    const second = runs[1] as Run;
    expect(second.animation.startTime).toBe(clock);
    const start = parse(second.frames[0]?.transform);
    expect(Math.abs(start.x - shown.x)).toBeLessThan(1);
    expect(Math.abs(start.y - shown.y)).toBeLessThan(1);
    expect(Math.abs(start.k - shown.k)).toBeLessThan(0.01);
    // It was still moving, so the turn carries on rather than restarting.
    const next = parse(second.frames[1]?.transform);
    const before = drawnAt(first, clock - 1000 / 60);
    expect(Math.sign(next.y - start.y)).toBe(Math.sign(start.y - before.y));
    expect(hop).toHaveBeenCalledTimes(1);
  });

  it("lands where the flight ends and lets go of it in the same frame", async () => {
    const { p, frame } = presence();
    p.goTo("hero");
    p.goTo("dock");
    const run = runs[0] as Run;
    expect(frame.dataset.flying).toBe("");
    run.finish();
    await run.animation.finished;
    await Promise.resolve();
    expect(run.cancelled).toBe(true);
    expect(frame.dataset.flying).toBeUndefined();
    expect(parse(frame.style.transform)).toEqual({ x: 8, y: 716, k: 1 });
  });

  it("fades instead of flying under reduced motion", () => {
    vi.useFakeTimers();
    const { p, frame } = presence(true);
    p.goTo("hero");
    p.goTo("dock");
    expect(runs).toHaveLength(0);
    expect(frame.dataset.shown).toBeUndefined();
    vi.advanceTimersByTime(200);
    expect(frame.dataset.shown).toBe("");
    expect(parse(frame.style.transform)).toEqual({ x: 8, y: 716, k: 1 });
  });
});
