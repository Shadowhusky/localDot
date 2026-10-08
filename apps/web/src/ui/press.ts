import type { FocusEvent, KeyboardEvent, PointerEvent } from "react";

// A small control squeezes when pressed; a wide one only darkens, since scaling it reads as a wobble.
// 44 rather than the plan's 40, so controls a coarse pointer grows to 44 px still squeeze.
const SQUEEZE_WIDTH = 120;
const SQUEEZE_HEIGHT = 44;

let armed: HTMLElement | undefined;

function disarm() {
  armed = undefined;
}

function press(element: HTMLElement) {
  if (element.getAttribute("aria-disabled") === "true") return;
  const { width, height } = element.getBoundingClientRect();
  element.dataset.pressed = width <= SQUEEZE_WIDTH && height <= SQUEEZE_HEIGHT ? "squeeze" : "fill";
}

function release(element: HTMLElement) {
  delete element.dataset.pressed;
}

// The press is written straight onto the element, so it shows in the frame the pointer lands in
// rather than after a render. It lets go when the pointer slides off and comes back if it returns.
export const pressHandlers = {
  onPointerDown(event: PointerEvent<HTMLElement>) {
    if (event.button !== 0) return;
    armed = event.currentTarget;
    document.addEventListener("pointerup", disarm, { capture: true, once: true });
    document.addEventListener("pointercancel", disarm, { capture: true, once: true });
    press(event.currentTarget);
  },
  onPointerEnter(event: PointerEvent<HTMLElement>) {
    if (armed === event.currentTarget && event.buttons & 1) press(event.currentTarget);
  },
  onPointerUp(event: PointerEvent<HTMLElement>) {
    release(event.currentTarget);
  },
  onPointerLeave(event: PointerEvent<HTMLElement>) {
    release(event.currentTarget);
  },
  onPointerCancel(event: PointerEvent<HTMLElement>) {
    release(event.currentTarget);
  },
  onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === " " && !event.repeat) press(event.currentTarget);
  },
  onKeyUp(event: KeyboardEvent<HTMLElement>) {
    if (event.key === " ") release(event.currentTarget);
  },
  onBlur(event: FocusEvent<HTMLElement>) {
    release(event.currentTarget);
  },
};
