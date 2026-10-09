// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { addView, kick, removeView } from "./scheduler.ts";

type Report = (entries: Pick<IntersectionObserverEntry, "target" | "isIntersecting">[]) => void;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("scheduler", () => {
  it("gives no frames to a view off screen or in a hidden tab", () => {
    const pending: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => pending.push(cb));
    let report: Report = () => {};
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(cb: Report) {
          report = cb;
        }
        observe() {}
        unobserve() {}
      },
    );
    let hidden = false;
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
    const flush = () => {
      for (const cb of pending.splice(0)) cb(0);
    };
    const root = document.createElement("span");
    const view = { root, visible: true, frame: vi.fn() };

    addView(view);
    flush();
    expect(view.frame).toHaveBeenCalledTimes(1);

    hidden = true;
    flush();
    document.dispatchEvent(new Event("visibilitychange"));
    expect(view.frame).toHaveBeenCalledTimes(1);
    expect(pending).toHaveLength(0);

    hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
    flush();
    expect(view.frame).toHaveBeenCalledTimes(2);

    report([{ target: root, isIntersecting: false }]);
    flush();
    expect(view.frame).toHaveBeenCalledTimes(2);
    expect(pending).toHaveLength(0);

    report([{ target: root, isIntersecting: true }]);
    flush();
    expect(view.frame).toHaveBeenCalledTimes(3);

    removeView(view);
    flush();
    expect(view.frame).toHaveBeenCalledTimes(3);
    expect(pending).toHaveLength(0);
    delete (document as { hidden?: boolean }).hidden;
  });

  it("sleeps while every view is calm, until the first needs a frame or something changes", () => {
    vi.useFakeTimers();
    const pending: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => pending.push(cb));
    vi.stubGlobal("IntersectionObserver", undefined);
    const flush = () => {
      for (const cb of pending.splice(0)) cb(0);
    };
    let wait = 0;
    const view = { root: document.createElement("span"), visible: true, frame: vi.fn(() => wait) };
    addView(view);
    flush();
    expect(pending).toHaveLength(1);

    wait = 120;
    flush();
    expect(view.frame).toHaveBeenCalledTimes(2);
    expect(pending).toHaveLength(0);
    vi.advanceTimersByTime(119);
    expect(pending).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(pending).toHaveLength(1);

    flush();
    expect(pending).toHaveLength(0);
    kick();
    expect(pending).toHaveLength(1);
    removeView(view);
  });
});
