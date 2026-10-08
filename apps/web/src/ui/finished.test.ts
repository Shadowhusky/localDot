// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { afterMotion } from "./finished.ts";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  vi.useRealTimers();
});

interface Moving {
  animation: Animation;
  finish(): void;
  cancel(): void;
}

function moving(iterations = 1): Moving {
  let finish = () => {};
  let cancel = () => {};
  const finished = new Promise<Animation>((resolve, reject) => {
    finish = () => resolve(animation);
    cancel = () => reject(new DOMException("cancelled", "AbortError"));
  });
  // A rejection nobody waits for yet must not fail the run.
  finished.catch(() => {});
  const animation = {
    finished,
    effect: { getComputedTiming: () => ({ endTime: iterations === Infinity ? Infinity : 200 }) },
  } as unknown as Animation;
  return { animation, finish, cancel };
}

function element(...animations: Animation[]): Element {
  return { getAnimations: () => animations } as unknown as Element;
}

describe("afterMotion", () => {
  it("calls back at once when nothing moves, or where animations cannot be read", () => {
    const done = vi.fn();
    afterMotion([element(), null, {} as Element], done);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("waits for every finite animation, however it ends, and ignores one that never ends", async () => {
    const done = vi.fn();
    const first = moving();
    const second = moving();
    const spinner = moving(Infinity);
    afterMotion([element(first.animation, spinner.animation), element(second.animation)], done);
    first.finish();
    await Promise.resolve();
    expect(done).not.toHaveBeenCalled();
    second.cancel();
    await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(1));
  });

  it("gives up waiting after a second, and once cancelled never calls back", async () => {
    const late = vi.fn();
    afterMotion([element(moving().animation)], late);
    vi.advanceTimersByTime(999);
    expect(late).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(late).toHaveBeenCalledTimes(1);

    const never = vi.fn();
    const quick = moving();
    const cancel = afterMotion([element(quick.animation)], never);
    cancel();
    quick.finish();
    await Promise.resolve();
    vi.advanceTimersByTime(2000);
    expect(never).not.toHaveBeenCalled();
  });
});
