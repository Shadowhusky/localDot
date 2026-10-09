// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { placeElement, registerPlace } from "./places.ts";
import { Presence } from "./presence.ts";

interface Run {
  frames: Keyframe[];
  options: KeyframeAnimationOptions;
  animation: { startTime: number | null; cancel(): void; finished: Promise<void> };
  finish(): void;
  cancelled: boolean;
}

type Rect = { left: number; top: number; width: number };
type Name = "hero" | "dock" | "badge";

const RECTS: Record<Name, Rect> = {
  hero: { left: 420, top: 217, width: 224 },
  dock: { left: 8, top: 716, width: 96 },
  badge: { left: 300, top: 60, width: 32 },
};

let clock = 0;
let runs: Run[] = [];
let rects = new Map<Element, Rect>();
const cleanups: (() => void)[] = [];

const domRect = ({ left, top, width }: Rect) => ({ left, top, width, height: width }) as DOMRect;

function place(name: Name, at: Rect = RECTS[name]) {
  const element = document.createElement("span");
  rects.set(element, { ...at });
  element.getBoundingClientRect = () => domRect(rects.get(element) ?? at);
  document.body.append(element);
  cleanups.push(registerPlace(name, element));
  return element;
}

// What a scroll or a drag does to a place: moves its box on screen.
function move(name: Name, dx: number, dy: number) {
  const r = rects.get(placeElement(name) as HTMLElement) as Rect;
  r.left += dx;
  r.top += dy;
}

function presence(reducedMotion = false) {
  const layer = document.createElement("div");
  const frame = document.createElement("div");
  const host = document.createElement("span");
  frame.append(host);
  layer.append(frame);
  document.body.append(layer);
  // At rest the frame fills its place; in the layer only its transform says where it is.
  frame.getBoundingClientRect = () =>
    frame.parentElement === layer
      ? domRect({ left: 0, top: 0, width: 0 })
      : (frame.parentElement as HTMLElement).getBoundingClientRect();
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
  return { p, frame, layer };
}

async function finish(run: Run) {
  clock = Number(run.animation.startTime) + Number(run.options.duration);
  run.finish();
  await run.animation.finished;
  await Promise.resolve();
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
  rects = new Map();
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
  vi.unstubAllGlobals();
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

  it("lands in its place where the flight ends and lets go of it in the same frame", async () => {
    const { p, frame, layer } = presence();
    p.goTo("hero");
    p.goTo("dock");
    const run = runs[0] as Run;
    expect(frame.parentElement).toBe(layer);
    expect(frame.dataset.flying).toBe("");
    await finish(run);
    expect(run.cancelled).toBe(true);
    expect(frame.dataset.flying).toBeUndefined();
    expect(frame.parentElement).toBe(placeElement("dock"));
    expect(frame.style.transform).toBe("");
  });

  it("rests inside its place, so whatever moves the place moves dot, with nothing to chase", () => {
    const { p, frame } = presence();
    p.goTo("dock");
    const dock = placeElement("dock");
    expect(frame.parentElement).toBe(dock);
    expect(frame.style.transform).toBe("");
    move("dock", -30, -240);
    p.follow(false);
    p.follow(true);
    p.goTo("dock");
    expect(runs).toHaveLength(0);
    expect(frame.parentElement).toBe(dock);
    expect(frame.style.transform).toBe("");
  });

  it("takes off from where the page has carried it", () => {
    const { p, frame, layer } = presence();
    p.goTo("hero");
    move("hero", -100, 50);
    p.goTo("dock");
    expect(frame.parentElement).toBe(layer);
    expect(parse(runs[0]?.frames[0]?.transform)).toMatchObject({ x: 320, y: 267, k: 1 });
  });

  it("turns to where its place has moved while it flew, then lands in it", async () => {
    const { p, frame, layer } = presence();
    p.goTo("hero");
    p.goTo("dock");
    move("dock", 0, -100);
    await finish(runs[0] as Run);
    expect(runs).toHaveLength(2);
    expect(frame.parentElement).toBe(layer);
    const from = parse(runs[1]?.frames[0]?.transform);
    expect(Math.hypot(from.x - 8, from.y - 716)).toBeLessThan(0.5);
    expect(parse(runs[1]?.frames.at(-1)?.transform)).toMatchObject({ x: 8, y: 616 });
    await finish(runs[1] as Run);
    expect(frame.parentElement).toBe(placeElement("dock"));
  });

  it("takes off from where it last rested when its place has been hidden", () => {
    const { p, frame, layer } = presence();
    p.goTo("dock");
    rects.set(placeElement("dock") as HTMLElement, { left: 0, top: 0, width: 0 });
    place("dock", { left: 1072, top: 229, width: 72 });
    p.goTo("dock");
    expect(frame.parentElement).toBe(layer);
    expect(parse(runs[0]?.frames[0]?.transform)).toMatchObject({ x: 8, y: 716 });
    expect(parse(runs[0]?.frames.at(-1)?.transform)).toMatchObject({ x: 1072, y: 229 });
  });

  it("goes to a box for its place once the box is laid out", () => {
    const watchers: { report(): void; watching: Set<Element> }[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        watching = new Set<Element>();
        report: () => void;
        constructor(report: () => void) {
          this.report = report;
          watchers.push(this);
        }
        observe(element: Element) {
          this.watching.add(element);
        }
        unobserve(element: Element) {
          this.watching.delete(element);
        }
        disconnect() {
          this.watching.clear();
        }
      },
    );
    const { p, frame } = presence();
    p.goTo("dock");
    const replay = place("dock", { left: 0, top: 0, width: 0 });
    p.goTo("dock");
    expect(runs).toHaveLength(0);
    expect(frame.dataset.shown).toBeUndefined();
    rects.set(replay, { left: 1072, top: 229, width: 72 });
    for (const watcher of watchers) if (watcher.watching.has(replay)) watcher.report();
    expect(frame.dataset.shown).toBe("");
    expect(frame.parentElement).toBe(replay);
  });

  it("gives its frame back to the layer when it goes", () => {
    const { p, frame, layer } = presence();
    p.goTo("dock");
    p.destroy();
    expect(frame.parentElement).toBe(layer);
  });

  it("comes back to its place once the place has a box again", () => {
    const { p, frame } = presence();
    p.goTo("dock");
    const dock = placeElement("dock") as HTMLElement;
    rects.set(dock, { left: 0, top: 0, width: 0 });
    p.goTo("dock");
    expect(frame.dataset.shown).toBeUndefined();
    rects.set(dock, { ...RECTS.dock });
    p.follow(false);
    expect(frame.dataset.shown).toBe("");
    expect(frame.parentElement).toBe(dock);
    expect(runs).toHaveLength(0);
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
    expect(frame.parentElement).toBe(placeElement("dock"));
  });
});
