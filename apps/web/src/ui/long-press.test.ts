// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachLongPress, HOLD_MS } from "./long-press.ts";

describe("touch and hold", () => {
  let detach: (() => void) | undefined;
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    detach?.();
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  function held() {
    const element = document.createElement("div");
    const input = document.createElement("input");
    element.append(input);
    const menu = document.createElement("button");
    document.body.append(element, menu);
    const host = { pressing: vi.fn(), hold: vi.fn() };
    detach = attachLongPress(element, host);
    const pointer = (
      type: string,
      target: Element,
      { x = 50, y = 50, kind = "touch", button = 0 } = {},
    ) =>
      target.dispatchEvent(
        new PointerEvent(type, {
          pointerId: 1,
          pointerType: kind,
          isPrimary: true,
          button,
          clientX: x,
          clientY: y,
          bubbles: true,
          cancelable: true,
        }),
      );
    const click = (target: Element) => {
      const event = new MouseEvent("click", { bubbles: true, cancelable: true });
      target.dispatchEvent(event);
      return event.defaultPrevented;
    };
    return { element, input, menu, host, pointer, click };
  }

  it("holds once a still finger has waited, sinking the row meanwhile", () => {
    const { element, host, pointer } = held();
    pointer("pointerdown", element);
    expect(host.pressing).toHaveBeenLastCalledWith(true);
    vi.advanceTimersByTime(HOLD_MS - 1);
    expect(host.hold).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(host.hold).toHaveBeenCalledTimes(1);
    expect(host.pressing).toHaveBeenLastCalledWith(false);
  });

  it("lets a finger that moves scroll or swipe instead, and a quick tap stay a tap", () => {
    const { element, host, pointer } = held();
    pointer("pointerdown", element);
    pointer("pointermove", element, { x: 60 });
    vi.advanceTimersByTime(HOLD_MS * 2);
    pointer("pointerdown", element);
    pointer("pointerup", element);
    vi.advanceTimersByTime(HOLD_MS * 2);
    expect(host.hold).not.toHaveBeenCalled();
  });

  it("spends the click its lifting sends, wherever it lands, and nothing after", () => {
    const { element, menu, host, pointer, click } = held();
    pointer("pointerdown", element);
    vi.advanceTimersByTime(HOLD_MS);
    expect(host.hold).toHaveBeenCalled();
    pointer("pointerup", menu);
    expect(click(menu)).toBe(true);
    expect(click(menu)).toBe(false);
  });

  it("spends nothing once the lift's click could no longer come, or the next press has come", () => {
    const { element, menu, pointer, click } = held();
    pointer("pointerdown", element);
    vi.advanceTimersByTime(HOLD_MS);
    pointer("pointerup", menu);
    vi.advanceTimersByTime(1000);
    expect(click(menu)).toBe(false);
    pointer("pointerdown", element);
    vi.advanceTimersByTime(HOLD_MS);
    pointer("pointerup", menu);
    pointer("pointerdown", menu);
    expect(click(menu)).toBe(false);
  });

  it("opens on a right click, once, and leaves a mouse's press and a name being typed alone", () => {
    const { element, input, host, pointer } = held();
    pointer("pointerdown", element, { kind: "mouse" });
    vi.advanceTimersByTime(HOLD_MS * 2);
    pointer("pointerdown", input);
    vi.advanceTimersByTime(HOLD_MS * 2);
    expect(host.hold).not.toHaveBeenCalled();
    const menu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    element.dispatchEvent(menu);
    expect(menu.defaultPrevented).toBe(true);
    expect(host.hold).toHaveBeenCalledTimes(1);
    const typed = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    input.dispatchEvent(typed);
    expect(typed.defaultPrevented).toBe(false);
  });

  it("counts Android's own long press after a hold as that same hold", () => {
    const { element, host, pointer } = held();
    pointer("pointerdown", element);
    vi.advanceTimersByTime(HOLD_MS);
    element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    expect(host.hold).toHaveBeenCalledTimes(1);
  });
});
