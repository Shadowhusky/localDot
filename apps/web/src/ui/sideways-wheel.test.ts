// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { sidewaysWheel } from "./sideways-wheel.ts";

function strip(width: number, content: number) {
  const element = document.createElement("div");
  Object.defineProperty(element, "clientWidth", { value: width });
  Object.defineProperty(element, "scrollWidth", { value: content });
  document.body.append(element);
  return element;
}
const wheel = (element: HTMLElement, deltaY: number, deltaX = 0) => {
  const event = new WheelEvent("wheel", { deltaY, deltaX, cancelable: true });
  element.dispatchEvent(event);
  return event.defaultPrevented;
};

afterEach(() => document.body.replaceChildren());

describe("a sideways strip under a mouse wheel", () => {
  it("moves sideways as the wheel turns, until its end, then lets the page scroll", () => {
    const element = strip(300, 500);
    const undo = sidewaysWheel(element);
    expect(wheel(element, 120)).toBe(true);
    expect(element.scrollLeft).toBe(120);
    expect(wheel(element, 120)).toBe(true);
    expect(element.scrollLeft).toBe(200);
    expect(wheel(element, 120)).toBe(false);
    expect(wheel(element, -500)).toBe(true);
    expect(element.scrollLeft).toBe(0);
    expect(wheel(element, -40)).toBe(false);
    undo?.();
    expect(wheel(element, 120)).toBe(false);
  });

  it("leaves a sideways swipe, and a strip with nothing to scroll, to the browser", () => {
    const element = strip(300, 500);
    sidewaysWheel(element);
    expect(wheel(element, 10, 40)).toBe(false);
    const short = strip(300, 300);
    sidewaysWheel(short);
    expect(wheel(short, 120)).toBe(false);
  });
});
