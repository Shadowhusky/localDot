// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { APPEARANCE_EVENT } from "../onboarding/appearance.ts";
import { FakeWorker, fakeChromium } from "../testing/fake-chromium.ts";
import type { FrameSource } from "./frame-source.ts";
import { backingScale, holdEngine, RESIZE_SETTLE_MS, RESTART_MS } from "./stage-engine.ts";

// A kept stage outlives its page in tests and on a remount; one that is away read the theme from
// whatever the document held then, and threw where it held no tokens.
it("reads the appearance of a kept stage when it is placed again, not while it is away", () => {
  const restore = fakeChromium();
  const key = {};
  const anchor = document.createElement("template");
  document.body.append(anchor);
  try {
    const held = holdEngine(key);
    held.engine.place(anchor);
    const worker = FakeWorker.instances.at(-1);
    const themes = () => worker?.sent.filter(({ message }) => message.type === "theme").length;
    held.engine.unplace(anchor);
    held.release();
    window.dispatchEvent(new Event(APPEARANCE_EVENT));
    expect(themes()).toBe(0);
    const again = holdEngine(key);
    again.engine.place(anchor);
    expect(themes()).toBe(1);
    window.dispatchEvent(new Event(APPEARANCE_EVENT));
    expect(themes()).toBe(2);
    again.engine.close();
  } finally {
    anchor.remove();
    restore();
  }
});

it("tells its stage when the canvas is clipped away or has no size, and how much of the window it covers", () => {
  const restore = fakeChromium();
  const sizes: ((entries: { contentRect: { width: number; height: number } }[]) => void)[] = [];
  const sights: ((entries: { isIntersecting: boolean; intersectionRatio: number }[]) => void)[] =
    [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(report: (typeof sizes)[number]) {
        sizes.push(report);
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(report: (typeof sights)[number]) {
        sights.push(report);
      }
      observe() {}
      disconnect() {}
    },
  );
  const anchor = document.createElement("template");
  document.body.append(anchor);
  try {
    const held = holdEngine(null);
    held.engine.place(anchor);
    const views: { onScreen: boolean; share: number }[] = [];
    held.engine.onView((view) => views.push(view));
    const area = window.innerWidth * window.innerHeight;
    sizes[0]?.([{ contentRect: { width: area / 1000, height: 500 } }]);
    expect(views.at(-1)).toEqual({ onScreen: true, share: 0.5 });
    sights[0]?.([{ isIntersecting: true, intersectionRatio: 0 }]);
    expect(views.at(-1)?.onScreen).toBe(false);
    sights[0]?.([{ isIntersecting: true, intersectionRatio: 0.4 }]);
    expect(views.at(-1)?.onScreen).toBe(true);
    sizes[0]?.([{ contentRect: { width: 0, height: 0 } }]);
    expect(views.at(-1)).toEqual({ onScreen: false, share: 0 });
    held.engine.close();
  } finally {
    anchor.remove();
    restore();
  }
});

it("sizes the canvas to a box that changed once at once, and to one that keeps changing once it settles", () => {
  vi.useFakeTimers();
  const restore = fakeChromium();
  const sizes: ((entries: { contentRect: { width: number; height: number } }[]) => void)[] = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(report: (typeof sizes)[number]) {
        sizes.push(report);
      }
      observe() {}
      disconnect() {}
    },
  );
  const anchor = document.createElement("template");
  document.body.append(anchor);
  try {
    const held = holdEngine(null);
    held.engine.place(anchor);
    const worker = FakeWorker.instances.at(-1);
    const resizes = () =>
      worker?.sent
        .filter(({ message }) => message.type === "resize")
        .map(({ message }) => `${message.width}x${message.height}`);
    const box = (width: number) => sizes[0]?.([{ contentRect: { width, height: width * 0.625 } }]);
    box(1000);
    expect(resizes()).toEqual(["1000x625"]);
    // A rail sliding open beside the stage narrows it on every frame.
    for (let width = 990; width >= 900; width -= 10) {
      vi.advanceTimersByTime(16);
      box(width);
    }
    vi.advanceTimersByTime(RESIZE_SETTLE_MS - 1);
    expect(resizes()).toEqual(["1000x625"]);
    vi.advanceTimersByTime(1);
    expect(resizes()).toEqual(["1000x625", "900x563"]);
    // The size the canvas already has is not sent again.
    box(900);
    vi.advanceTimersByTime(RESIZE_SETTLE_MS);
    expect(resizes()).toEqual(["1000x625", "900x563"]);
    held.engine.close();
  } finally {
    anchor.remove();
    restore();
    vi.useRealTimers();
  }
});

describe("the frames of a tap that carries a track", () => {
  function setup() {
    const restore = fakeChromium();
    const anchor = document.createElement("template");
    document.body.append(anchor);
    const held = holdEngine(null);
    held.engine.place(anchor);
    const worker = FakeWorker.instances.at(-1);
    if (!worker) throw new Error("no worker");
    const caps = (tracks: boolean) => worker.onmessage?.({ data: { type: "caps", tracks } });
    const stopped: string[] = [];
    const track = { id: "clone", stop: () => stopped.push("clone") } as unknown as MediaStreamTrack;
    const frames = vi.fn();
    const source: FrameSource = {
      trackId: "t1",
      track,
      frames,
      stop: () => {
        source.track?.stop();
        stopped.push("source");
      },
    };
    const sent = () => worker.sent.filter(({ message }) => message.type === "frames");
    const done = () => {
      held.engine.close();
      anchor.remove();
      restore();
    };
    return { engine: held.engine, worker, caps, track, frames, source, sent, stopped, done };
  }

  it("hands the track to a worker that reads tracks, and never copies frames on the page", () => {
    const { engine, caps, track, frames, source, sent, stopped, done } = setup();
    try {
      caps(true);
      engine.attach(source);
      expect(sent()).toEqual([
        { message: { type: "frames", sourceId: 1, track }, transfer: [track] },
      ]);
      expect(frames).not.toHaveBeenCalled();
      expect(engine.canvas.dataset.path).toBe("track");
      engine.detach();
      expect(stopped).toEqual(["source"]);
    } finally {
      done();
    }
  });

  it("waits for the worker to say whether it reads tracks", () => {
    const { engine, caps, track, source, sent, done } = setup();
    try {
      engine.attach(source);
      expect(sent()).toEqual([]);
      caps(true);
      expect(sent().map(({ message }) => message.track)).toEqual([track]);
    } finally {
      done();
    }
  });

  it("copies the video's frames for a worker that cannot read tracks, and ends the clone", () => {
    const { engine, caps, frames, source, sent, stopped, done } = setup();
    try {
      caps(false);
      engine.attach(source);
      expect(sent().map(({ message }) => message)).toEqual([
        { type: "frames", sourceId: 1, pushed: true, first: undefined },
      ]);
      expect(frames).toHaveBeenCalledTimes(1);
      expect(stopped).toEqual(["clone"]);
      expect(engine.canvas.dataset.path).toBe("presented");
    } finally {
      done();
    }
  });

  it("copies the video's frames where a track cannot be handed to a worker", () => {
    const { engine, worker, caps, frames, source, sent, done } = setup();
    try {
      const post = worker.postMessage.bind(worker);
      worker.postMessage = (message, transfer = []) => {
        if ("track" in message) throw new DOMException("not transferable", "DataCloneError");
        post(message, transfer);
      };
      caps(true);
      engine.attach(source);
      expect(sent().map(({ message }) => message.pushed)).toEqual([true]);
      expect(frames).toHaveBeenCalledTimes(1);
      expect(engine.canvas.dataset.path).toBe("presented");
    } finally {
      done();
    }
  });
});

describe("backingScale", () => {
  it("takes every pixel of the device until the picture is drawn one to one", () => {
    expect(backingScale({ width: 968, height: 605 }, 2)).toBe(2);
    expect(backingScale({ width: 374, height: 234 }, 3)).toBe(3);
    expect(backingScale({ width: 1000, height: 625 }, 1)).toBe(1);
    expect(backingScale({ width: 1728, height: 1080 }, 2)).toBeCloseTo(2560 / 1728);
    expect(backingScale({ width: 2560, height: 1440 }, 2)).toBeCloseTo(1600 / 1440);
  });

  it("never gives a stage fewer pixels than its own CSS size", () => {
    expect(backingScale({ width: 3840, height: 2400 }, 2)).toBe(1);
    expect(backingScale({ width: 3840, height: 2400 }, 1)).toBe(1);
  });

  it("follows a box with no size yet to the device", () => {
    expect(backingScale({ width: 0, height: 0 }, 2)).toBe(2);
  });
});

describe("starting again", () => {
  const placed = () => {
    const restore = fakeChromium();
    const anchor = document.createElement("template");
    document.body.append(anchor);
    const held = holdEngine(null);
    held.engine.place(anchor);
    const first = FakeWorker.instances.at(-1) as FakeWorker;
    return {
      ...held,
      anchor,
      first,
      restarts: vi.fn(),
      done() {
        held.release();
        anchor.remove();
        restore();
      },
    };
  };
  const source = (): FrameSource => ({
    trackId: "t",
    readable: new ReadableStream<VideoFrame>(),
    stop: vi.fn(),
  });

  it("starts a new worker on a new canvas, in the same place, with all the page told the old one", () => {
    const { engine, anchor, first, restarts, done } = placed();
    try {
      engine.onRestart(restarts);
      const old = engine.canvas;
      engine.setView({ dim: true });
      engine.setView({ fps: 30 });
      engine.setClock({ wallAnchor: 1, sessionAnchor: 2 } as never);
      engine.pushEvents([{ type: "a" }] as never);
      engine.pushEvents([{ type: "b" }] as never);
      engine.attach(source());
      engine.restart();
      const next = FakeWorker.instances.at(-1) as FakeWorker;
      expect(next).not.toBe(first);
      expect(first.terminated).toBe(true);
      expect(engine.canvas).not.toBe(old);
      expect(old.isConnected).toBe(false);
      expect(engine.canvas.nextElementSibling).toBe(anchor);
      expect(engine.canvas.className).toBe("stage-canvas");
      const sent = next.sent.map(({ message }) => message);
      expect(sent[0]?.type).toBe("init");
      expect(sent).toContainEqual({ type: "view", view: { dim: true, fps: 30 } });
      expect(sent).toContainEqual({ type: "clock", clock: { wallAnchor: 1, sessionAnchor: 2 } });
      expect(sent).toContainEqual({ type: "events", events: [{ type: "a" }, { type: "b" }] });
      expect(sent.some(({ type }) => type === "frames")).toBe(false);
      expect(restarts).toHaveBeenCalledOnce();
    } finally {
      done();
    }
  });

  it("forgets what a new session no longer holds", () => {
    const { engine, done } = placed();
    try {
      engine.pushEvents([{ type: "a" }] as never);
      engine.resetSession();
      engine.pushEvents([{ type: "b" }] as never);
      engine.restart();
      const sent = (FakeWorker.instances.at(-1) as FakeWorker).sent.map(({ message }) => message);
      expect(sent).toContainEqual({ type: "events", events: [{ type: "b" }] });
    } finally {
      done();
    }
  });

  it("tells a listener the stage's reports go on from the new worker", () => {
    const { engine, done } = placed();
    try {
      const stats = vi.fn();
      engine.onStats(stats);
      engine.restart();
      const next = FakeWorker.instances.at(-1) as FakeWorker;
      engine.attach(source());
      const frames = next.sent.findLast(({ message }) => message.type === "frames");
      next.onmessage?.({
        data: {
          type: "stats",
          sourceId: frames?.message.sourceId,
          stats: { presented: 1, fps: 30, lastFrameAt: 1, width: 1280, height: 800 },
        },
      });
      expect(stats).toHaveBeenCalledOnce();
    } finally {
      done();
    }
  });

  it("starts again when its worker's script doesn't load, less often each time", () => {
    vi.useFakeTimers();
    const { first, done } = placed();
    try {
      first.onerror?.(new Event("error"));
      vi.advanceTimersByTime(RESTART_MS.min);
      expect(FakeWorker.instances.at(-1)).not.toBe(first);
      const second = FakeWorker.instances.at(-1) as FakeWorker;
      second.onerror?.(new Event("error"));
      vi.advanceTimersByTime(RESTART_MS.min);
      expect(FakeWorker.instances.at(-1)).toBe(second);
      vi.advanceTimersByTime(RESTART_MS.min);
      expect(FakeWorker.instances.at(-1)).not.toBe(second);
    } finally {
      done();
      vi.useRealTimers();
    }
  });

  it("leaves a worker that started and then threw to show that it stopped", () => {
    vi.useFakeTimers();
    const { first, done } = placed();
    try {
      first.onmessage?.({ data: { type: "caps", tracks: false } });
      first.onerror?.(new Event("error"));
      vi.advanceTimersByTime(RESTART_MS.max);
      expect(FakeWorker.instances.at(-1)).toBe(first);
    } finally {
      done();
      vi.useRealTimers();
    }
  });

  it("holds off asking again and again, until a viewer insists", () => {
    const { engine, first, done } = placed();
    try {
      engine.restart();
      const second = FakeWorker.instances.at(-1) as FakeWorker;
      expect(second).not.toBe(first);
      engine.restart();
      expect(FakeWorker.instances.at(-1)).toBe(second);
      engine.restart({ now: true });
      expect(FakeWorker.instances.at(-1)).not.toBe(second);
    } finally {
      done();
    }
  });

  it("stays out of a replay's way", () => {
    const { engine, first, done } = placed();
    try {
      engine.replay.open({ sessionId: "s" } as never);
      engine.restart();
      expect(FakeWorker.instances.at(-1)).toBe(first);
      engine.replay.close();
      engine.restart();
      expect(FakeWorker.instances.at(-1)).not.toBe(first);
    } finally {
      done();
    }
  });

  it("starts when it is next placed, if it has no place now", () => {
    const { engine, anchor, first, done } = placed();
    try {
      engine.unplace(anchor);
      engine.restart();
      expect(FakeWorker.instances.at(-1)).toBe(first);
      expect(first.terminated).toBe(true);
      engine.place(anchor);
      expect(FakeWorker.instances.at(-1)).not.toBe(first);
    } finally {
      done();
    }
  });
});
