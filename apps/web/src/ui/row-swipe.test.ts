// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attachSwipe,
  COMMIT_AT,
  SWIPE_FACE,
  type SwipeFaces,
  type SwipeHost,
  swipeArmed,
  swipeLanding,
  swipeOffset,
  swipeRest,
} from "./row-swipe.ts";

describe("where a swiped row comes to rest", () => {
  it("opens past half its face and closes short of it when let go still", () => {
    expect(swipeRest(-SWIPE_FACE / 2 - 1, 0)).toBe("open");
    expect(swipeRest(-SWIPE_FACE / 2 + 1, 0)).toBe("closed");
  });

  it("projects a flick forward, so a short fast swipe opens and a flick back closes", () => {
    expect(swipeRest(-12, -600)).toBe("open");
    expect(swipeRest(-80, 600)).toBe("closed");
  });
});

const WIDTH = 360;
const BOTH: SwipeFaces = { leading: 76, trailing: 152, commits: ["leading", "trailing"] };

describe("a row with actions on both sides", () => {
  it("opens the side its projected landing passes half of, either way", () => {
    expect(swipeLanding(-77, 0, BOTH, WIDTH)).toBe("trailing");
    expect(swipeLanding(-75, 0, BOTH, WIDTH)).toBe("closed");
    expect(swipeLanding(39, 0, BOTH, WIDTH)).toBe("leading");
    expect(swipeLanding(20, 600, BOTH, WIDTH)).toBe("leading");
    expect(swipeLanding(-152, 900, BOTH, WIDTH)).toBe("closed");
  });

  it("carries out a side's action only when dragged past the commit line, never on a flick", () => {
    const line = COMMIT_AT * WIDTH;
    expect(swipeLanding(-line, 0, BOTH, WIDTH)).toBe("commit-trailing");
    expect(swipeLanding(line, 0, BOTH, WIDTH)).toBe("commit-leading");
    expect(swipeLanding(-line + 1, -3000, BOTH, WIDTH)).toBe("trailing");
    expect(swipeArmed(-line, BOTH, WIDTH)).toBe(true);
    expect(swipeArmed(-line + 1, BOTH, WIDTH)).toBe(false);
  });

  it("never commits on a side that does not, or that has nothing behind it", () => {
    const open: SwipeFaces = { leading: 0, trailing: 76 };
    expect(swipeLanding(-WIDTH, 0, open, WIDTH)).toBe("trailing");
    expect(swipeArmed(WIDTH, { ...BOTH, leading: 0 }, WIDTH)).toBe(false);
  });

  it("follows 1:1 to the commit line and gives less and less past what it can show", () => {
    expect(swipeOffset(-200, BOTH, WIDTH)).toBe(-200);
    expect(swipeOffset(WIDTH, BOTH, WIDTH)).toBe(WIDTH);
    expect(Math.abs(swipeOffset(-WIDTH - 100, BOTH, WIDTH))).toBeLessThan(WIDTH + 100);
    const open: SwipeFaces = { leading: 0, trailing: 76 };
    expect(swipeOffset(-76, open, WIDTH)).toBe(-76);
    expect(swipeOffset(-176, open, WIDTH)).toBeGreaterThan(-176);
    expect(swipeOffset(-176, open, WIDTH)).toBeLessThan(-76);
    expect(swipeOffset(60, open, WIDTH)).toBeGreaterThan(0);
    expect(swipeOffset(60, open, WIDTH)).toBeLessThan(60);
  });
});

describe("swiping a row", () => {
  const attached: (() => void)[] = [];
  afterEach(() => {
    for (const detach of attached.splice(0)) detach();
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  function row(over: Partial<SwipeHost> = {}, faces: SwipeFaces = BOTH) {
    const element = document.createElement("div");
    Object.defineProperty(element, "offsetWidth", { value: WIDTH });
    document.body.append(element);
    const host = {
      rest: vi.fn(),
      reducedMotion: () => true,
      moved: vi.fn(),
      armed: vi.fn(),
      leaves: vi.fn((side: string) => side === "trailing"),
      commit: vi.fn(),
      ...over,
    };
    const swipe = attachSwipe(element, host, faces);
    attached.push(swipe.detach);
    let t = 0;
    const pointer = (type: string, x: number, { kind = "touch", y = 100 } = {}) => {
      const event = new PointerEvent(type, {
        pointerId: 1,
        pointerType: kind,
        button: 0,
        clientX: x,
        clientY: y,
        bubbles: true,
        cancelable: true,
      });
      t += 16;
      Object.defineProperty(event, "timeStamp", { value: t });
      element.dispatchEvent(event);
    };
    // A finger dragged from `from` to `to` that stops before it lifts, so it carries no speed.
    const drag = (from: number, to: number, opts: { kind?: string; y?: number } = {}) => {
      pointer("pointerdown", from, opts);
      for (let step = 1; step <= 10; step++)
        pointer("pointermove", from + ((to - from) * step) / 10, opts);
      t += 100;
      pointer("pointerup", to, opts);
    };
    return { element, host, swipe, pointer, drag };
  }

  const offsetOf = (element: HTMLElement) =>
    Number(/translate3d\((-?[\d.]+)px/.exec(element.style.transform)?.[1] ?? 0);

  it("rests open on the trailing faces after a short swipe left, and closes on a tap", () => {
    const { element, host, drag, pointer } = row();
    drag(300, 180);
    expect(host.rest).toHaveBeenLastCalledWith("trailing");
    expect(offsetOf(element)).toBe(-152);
    pointer("pointerdown", 200);
    pointer("pointerup", 200);
    expect(host.rest).toHaveBeenLastCalledWith(null);
    expect(offsetOf(element)).toBe(0);
  });

  it("lights the commit line as it is crossed, and archives by sliding the row away first", () => {
    const { element, host, drag } = row();
    drag(340, 100);
    expect(host.armed).toHaveBeenCalledWith(true);
    expect(host.armed).toHaveBeenLastCalledWith(false);
    expect(host.commit).toHaveBeenCalledWith("trailing");
    expect(offsetOf(element)).toBe(-WIDTH);
  });

  it("pins with a long swipe right and comes home", () => {
    const { element, host, drag } = row();
    drag(40, 300);
    expect(host.commit).toHaveBeenCalledWith("leading");
    expect(offsetOf(element)).toBe(0);
  });

  it("leaves a mouse, a scroll and a press by the screen's edge to the page", () => {
    const { host, drag } = row();
    drag(300, 100, { kind: "mouse" });
    drag(5, 300);
    const { host: scrolled, pointer } = row();
    pointer("pointerdown", 200, { y: 100 });
    pointer("pointermove", 204, { y: 160 });
    pointer("pointermove", 120, { y: 170 });
    pointer("pointerup", 120, { y: 170 });
    expect(host.moved).not.toHaveBeenCalled();
    expect(host.commit).not.toHaveBeenCalled();
    expect(scrolled.moved).not.toHaveBeenCalled();
  });

  it("spends the click that ends a swipe, so the row is not opened", () => {
    const { element, drag } = row();
    const opened = vi.fn();
    element.addEventListener("click", opened);
    drag(300, 180);
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(opened).not.toHaveBeenCalled();
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(opened).toHaveBeenCalledTimes(1);
  });

  it("catches a row still springing home where it is", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (step: FrameRequestCallback) => frames.push(step));
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const { element, drag, pointer } = row({ reducedMotion: () => false });
    drag(300, 250);
    frames.shift()?.(performance.now() + 40);
    const caught = offsetOf(element);
    expect(caught).toBeLessThan(0);
    expect(caught).toBeGreaterThan(-50);
    pointer("pointerdown", 200);
    pointer("pointermove", 230);
    expect(offsetOf(element)).toBeCloseTo(caught + 30, 1);
  });

  it("lets go of a press that became a hold, so the row stays put under the menu", () => {
    const { host, swipe, pointer } = row();
    pointer("pointerdown", 200);
    swipe.cancel();
    pointer("pointermove", 100);
    pointer("pointerup", 100);
    expect(host.moved).not.toHaveBeenCalled();
  });
});
