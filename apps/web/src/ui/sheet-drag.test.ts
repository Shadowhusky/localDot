// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attachSheetDrag,
  DISMISS_AT,
  detentStops,
  nearestStop,
  project,
  restingStop,
  rubberband,
  scrolledToTop,
  takesSheet,
  velocityOf,
} from "./sheet-drag.ts";

describe("sheet drag", () => {
  it("projects a release the way a scroll view decelerates", () => {
    expect(project(0)).toBe(0);
    expect(project(1000)).toBeCloseTo(499, 0);
    expect(project(-500)).toBeCloseTo(-249.5, 1);
  });

  it("resists more the further it is pulled past the open position", () => {
    const near = rubberband(20, 600);
    const far = rubberband(200, 600);
    expect(near).toBeLessThan(20);
    expect(near).toBeGreaterThan(0);
    expect(far).toBeLessThan(200);
    expect(far / 200).toBeLessThan(near / 20);
    expect(rubberband(10_000, 600)).toBeLessThan(600);
  });

  it("closes on a release projected past 30% of the height and springs back otherwise", () => {
    const height = 600;
    expect(DISMISS_AT).toBe(0.3);
    expect(restingStop(100, 0, [0], height)).toBe(0);
    expect(restingStop(181, 0, [0], height)).toBe("dismiss");
    // A flick from near the top still closes; a slow push back up does not.
    expect(restingStop(40, 900, [0], height)).toBe("dismiss");
    expect(restingStop(300, -800, [0], height)).toBe(0);
  });

  it("rests medium 198 px under large, and a lone detent at the top", () => {
    expect(detentStops(["medium", "large"])).toEqual([198, 0]);
    expect(detentStops(["large"])).toEqual([0]);
    expect(detentStops(["fit"])).toEqual([0]);
  });

  it("settles a release into the detent nearest where it would land", () => {
    const stops = detentStops(["medium", "large"]);
    const height = 804;
    // Let go still, nearer large: back to large; nearer medium: medium.
    expect(restingStop(60, 0, stops, height)).toBe(1);
    expect(restingStop(120, 0, stops, height)).toBe(0);
    // A flick up from medium throws it to large; a gentle one down from large lands in medium.
    expect(restingStop(198, -900, stops, height)).toBe(1);
    expect(restingStop(10, 400, stops, height)).toBe(0);
    // Past medium by 30 % of what shows there, it closes.
    expect(restingStop(198 + 180, 0, stops, height)).toBe(0);
    expect(restingStop(198 + 195, 0, stops, height)).toBe("dismiss");
    // Thrown past the lowest stop, the nearest stop is the lowest, never the highest.
    expect(nearestStop(198 + 2000, stops)).toBe(0);
    expect(nearestStop(-500, stops)).toBe(1);
  });

  it("reads velocity over the last 100 ms of movement", () => {
    expect(velocityOf([])).toBe(0);
    expect(velocityOf([{ t: 0, y: 0 }])).toBe(0);
    const samples = [
      { t: 0, y: 0 },
      { t: 400, y: 10 },
      { t: 450, y: 60 },
      { t: 500, y: 110 },
    ];
    expect(velocityOf(samples)).toBe(1000);
  });

  it("gives a finger on the content to the sheet only when the sheet can go that way", () => {
    // Up raises a sheet resting below its top height; at its top the content scrolls instead.
    expect(takesSheet(2, -12, true, false)).toBe(true);
    expect(takesSheet(2, -12, false, true)).toBe(false);
    // Down lowers it once the content is scrolled to its top, at any height.
    expect(takesSheet(-3, 12, false, true)).toBe(true);
    expect(takesSheet(-3, 12, true, false)).toBe(false);
    // Sideways belongs to the content (Activity's pages swipe).
    expect(takesSheet(12, 4, true, true)).toBe(false);
    expect(takesSheet(3, 0, true, true)).toBe(false);
  });

  it("counts only what scrolls between the finger and the sheet", () => {
    const panel = document.createElement("section");
    panel.innerHTML =
      '<div class="body"><div class="pages"><div class="list"><p class="row">Row</p></div></div></div>';
    document.body.append(panel);
    const scroller = (selector: string, overflow: string, top: number) => {
      const node = panel.querySelector(selector) as HTMLElement;
      node.style.overflowY = overflow;
      node.scrollTop = top;
    };
    const row = panel.querySelector(".row") as Element;
    expect(scrolledToTop(row, panel)).toBe(true);
    scroller(".list", "auto", 40);
    expect(scrolledToTop(row, panel)).toBe(false);
    scroller(".list", "auto", 0);
    // Moved by script, an element that hides its overflow cannot be scrolled back by a finger.
    scroller(".pages", "hidden", 30);
    expect(scrolledToTop(row, panel)).toBe(true);
    scroller(".body", "scroll", 1);
    expect(scrolledToTop(row, panel)).toBe(false);
    panel.remove();
  });
});

describe("picking a sheet up", () => {
  const attached: (() => void)[] = [];
  afterEach(() => {
    for (const detach of attached.splice(0)) detach();
    document.body.replaceChildren();
    vi.useRealTimers();
  });

  // A bottom sheet resting `at` below its highest stop, with a grabber strip, a header holding a
  // title and a button, and a scrolling list. Without motion a release lands at once.
  function sheet({ at = 0, stops = [0], closes = true, motion = false } = {}) {
    const panel = document.createElement("section");
    panel.innerHTML = `
      <div class="handle" data-sheet-grip></div>
      <header data-sheet-grip><h2>Activity</h2><button type="button">Done</button></header>
      <div class="list"><p class="row">Opened the page</p></div>`;
    document.body.append(panel);
    Object.assign(panel, {
      setPointerCapture() {},
      hasPointerCapture: () => true,
      releasePointerCapture() {},
    });
    const list = panel.querySelector(".list") as HTMLElement;
    list.style.overflowY = "auto";
    const moved: number[] = [];
    const rest = vi.fn();
    const close = vi.fn();
    attached.push(
      attachSheetDrag({
        panel,
        scrim: null,
        stops: () => stops,
        rest,
        allowDismiss: () => closes,
        close,
        reducedMotion: () => !motion,
        presentation: { read: () => at, apply: (offset) => moved.push(offset), clear() {} },
      }),
    );
    const pointer = (
      type: string,
      target: Element,
      y: number,
      { kind = "touch", t = 0, x = 20 } = {},
    ) => {
      const event = new PointerEvent(type, {
        pointerId: 1,
        pointerType: kind,
        button: 0,
        clientX: x,
        clientY: y,
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(event, "timeStamp", { value: t });
      target.dispatchEvent(event);
    };
    // The browser's own touch event for the same move: whether it was stopped says who scrolls.
    const touchMove = (target: Element, y: number, x = 20) => {
      const event = new TouchEvent("touchmove", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "touches", { value: [{ clientX: x, clientY: y }] });
      target.dispatchEvent(event);
      return event.defaultPrevented;
    };
    const part = (selector: string) => panel.querySelector(selector) as Element;
    return { list, moved, rest, close, pointer, touchMove, part };
  }

  it("follows any pointer from the header, but leaves a press on its button to the button", () => {
    const { moved, pointer, part } = sheet();
    pointer("pointerdown", part("h2"), 100, { kind: "mouse" });
    pointer("pointermove", part("h2"), 140, { kind: "mouse" });
    expect(moved.at(-1)).toBe(40);
    pointer("pointerup", part("h2"), 140, { kind: "mouse", t: 200 });
    moved.length = 0;
    pointer("pointerdown", part("button"), 100, { kind: "mouse" });
    pointer("pointermove", part("button"), 160, { kind: "mouse" });
    expect(moved).toEqual([]);
  });

  it("never moves the sheet for a mouse on the content", () => {
    const { moved, pointer, part } = sheet();
    pointer("pointerdown", part(".row"), 100, { kind: "mouse" });
    pointer("pointermove", part(".row"), 160, { kind: "mouse" });
    expect(moved).toEqual([]);
  });

  it("raises a sheet resting below its top height by a finger moving up on its content", () => {
    const { moved, rest, pointer, touchMove, part } = sheet({ at: 198, stops: [198, 0] });
    pointer("pointerdown", part(".row"), 400);
    expect(touchMove(part(".row"), 397)).toBe(true);
    pointer("pointermove", part(".row"), 397, { t: 10 });
    pointer("pointermove", part(".row"), 300, { t: 20 });
    expect(touchMove(part(".row"), 300)).toBe(true);
    expect(moved.at(-1)).toBe(98);
    pointer("pointermove", part(".row"), 200, { t: 30 });
    pointer("pointerup", part(".row"), 200, { t: 35 });
    expect(rest).toHaveBeenCalledWith(1);
  });

  it("leaves the content to scroll once the sheet is at its top height, until it is scrolled up", () => {
    const { list, moved, pointer, touchMove, part } = sheet();
    pointer("pointerdown", part(".row"), 400);
    expect(touchMove(part(".row"), 396)).toBe(false);
    pointer("pointermove", part(".row"), 300, { t: 20 });
    expect(moved).toEqual([]);
    pointer("pointercancel", part(".row"), 300, { t: 30 });

    list.scrollTop = 80;
    pointer("pointerdown", part(".row"), 300);
    expect(touchMove(part(".row"), 304)).toBe(false);
    pointer("pointermove", part(".row"), 400, { t: 20 });
    expect(moved).toEqual([]);
    pointer("pointercancel", part(".row"), 400, { t: 30 });

    list.scrollTop = 0;
    pointer("pointerdown", part(".row"), 300);
    expect(touchMove(part(".row"), 304)).toBe(true);
    pointer("pointermove", part(".row"), 360, { t: 20 });
    expect(moved.at(-1)).toBe(60);
  });

  it("lets a sideways swipe on the content go to the content", () => {
    const { moved, pointer, touchMove, part } = sheet({ at: 198, stops: [198, 0] });
    pointer("pointerdown", part(".row"), 400, { x: 200 });
    expect(touchMove(part(".row"), 398, 180)).toBe(false);
    pointer("pointermove", part(".row"), 380, { x: 60, t: 20 });
    expect(moved).toEqual([]);
  });

  it("lands a flick on a sheet that may not close at its nearest height, not its highest", () => {
    const { close, rest, pointer, part } = sheet({ stops: [0, 370], closes: false });
    pointer("pointerdown", part(".handle"), 10);
    pointer("pointermove", part(".handle"), 22, { t: 0 });
    pointer("pointermove", part(".handle"), 90, { t: 16 });
    pointer("pointermove", part(".handle"), 160, { t: 32 });
    pointer("pointerup", part(".handle"), 160, { t: 40 });
    expect(close).not.toHaveBeenCalled();
    expect(rest).toHaveBeenCalledWith(1);
  });

  it("counts a springing sheet as resting where it is headed, and catches it only for the sheet", () => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"] });
    const { moved, pointer, touchMove, part } = sheet({ at: 198, stops: [198, 0], motion: true });
    // Flung up from medium, it springs toward large.
    pointer("pointerdown", part(".handle"), 400);
    pointer("pointermove", part(".handle"), 380, { t: 0 });
    pointer("pointermove", part(".handle"), 300, { t: 16 });
    pointer("pointerup", part(".handle"), 300, { t: 20 });
    vi.advanceTimersByTime(48);
    // Headed for its top, a swipe up on the content scrolls the content, and the spring runs on.
    pointer("pointerdown", part(".row"), 500);
    expect(touchMove(part(".row"), 496)).toBe(false);
    const springing = moved.length;
    vi.advanceTimersByTime(48);
    expect(moved.length).toBeGreaterThan(springing);
    pointer("pointercancel", part(".row"), 496);
    // A swipe down from the content's top takes it: it stops where it is and follows from there.
    pointer("pointerdown", part(".row"), 500);
    const caught = moved.at(-1) as number;
    expect(touchMove(part(".row"), 504)).toBe(true);
    vi.advanceTimersByTime(48);
    pointer("pointermove", part(".row"), 560, { t: 200 });
    expect(moved.at(-1)).toBeCloseTo(caught + 56, 5);
  });
});
