import { type SpringParams, springValue } from "@localdot/stage";
import { project, rubberband, velocityOf } from "./sheet-drag.ts";

// The width of the action face a row slides aside to show.
export const SWIPE_FACE = 88;
// Movement before a press becomes a swipe, so a tap or a scroll stays what it was.
const SLOP = 10;
const WINDOW_MS = 100;
// Only a flick carries momentum, so only a flick lands with a little overshoot.
const SETTLE: SpringParams = { dampingRatio: 1, response: 0.3 };
const MOMENTUM: SpringParams = { dampingRatio: 0.8, response: 0.35 };
const FLICK_SPEED = 300;

// Where a released row comes to rest: open on its face when its projected landing passes half the
// face, or closed.
export function swipeRest(offset: number, velocity: number, face = SWIPE_FACE): "open" | "closed" {
  return offset + project(velocity) < -face / 2 ? "open" : "closed";
}

export interface RowSwipeHost {
  // The row came to rest open on its face, or closed again.
  rest(open: boolean): void;
  reducedMotion(): boolean;
}

interface Press {
  id: number;
  x: number;
  y: number;
  from: number;
  axis?: "x" | "y";
  samples: { t: number; y: number }[];
}

// The row follows the finger sideways 1:1 from where it was grabbed, giving less and less past its
// face or its home; a release is projected forward and springs to open or closed.
export function attachRowSwipe(
  element: HTMLElement,
  host: RowSwipeHost,
  face = SWIPE_FACE,
): { open(): void; close(): void; detach(): void } {
  let press: Press | undefined;
  let offset = 0;
  let frame = 0;
  let swiped = false;

  const apply = (value: number) => {
    offset = value;
    element.style.transform = value ? `translate3d(${value}px, 0, 0)` : "";
  };

  const settle = (to: number, velocity: number) => {
    cancelAnimationFrame(frame);
    host.rest(to !== 0);
    if (host.reducedMotion()) {
      apply(to);
      return;
    }
    const from = offset;
    const spring = Math.abs(velocity) > FLICK_SPEED ? MOMENTUM : SETTLE;
    const start = performance.now();
    const step = (now: number) => {
      const t = (now - start) / 1000;
      const value = springValue(from, to, velocity, t, spring);
      if (Math.abs(value - to) < 0.5 && t > 0.05) {
        apply(to);
        frame = 0;
        return;
      }
      apply(value);
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
  };

  const onPointerDown = (event: PointerEvent) => {
    swiped = false;
    if (press || event.pointerType === "mouse") return;
    cancelAnimationFrame(frame);
    frame = 0;
    press = { id: event.pointerId, x: event.clientX, y: event.clientY, from: offset, samples: [] };
  };

  const onPointerMove = (event: PointerEvent) => {
    const current = press;
    if (!current || event.pointerId !== current.id) return;
    const dx = event.clientX - current.x;
    const dy = event.clientY - current.y;
    if (!current.axis) {
      if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;
      current.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
      if (current.axis === "y") return;
      element.setPointerCapture(event.pointerId);
    }
    if (current.axis !== "x") return;
    const raw = current.from + dx;
    apply(
      raw > 0
        ? rubberband(raw, element.offsetWidth)
        : raw < -face
          ? -face + rubberband(raw + face, element.offsetWidth)
          : raw,
    );
    current.samples.push({ t: event.timeStamp, y: raw });
    if (current.samples.length > 32) current.samples.shift();
  };

  const onPointerEnd = (event: PointerEvent) => {
    const current = press;
    if (!current || event.pointerId !== current.id) return;
    press = undefined;
    if (current.axis !== "x") {
      // A tap on a row resting open closes it rather than opening the row.
      if (!current.axis && offset !== 0 && event.type === "pointerup") {
        swiped = true;
        settle(0, 0);
      }
      return;
    }
    swiped = true;
    if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
    const recent = current.samples.at(-1);
    const still = !recent || event.timeStamp - recent.t > WINDOW_MS / 2;
    const velocity = event.type === "pointercancel" || still ? 0 : velocityOf(current.samples);
    settle(swipeRest(offset, velocity, face) === "open" ? -face : 0, velocity);
  };

  // The click that ends a swipe is not a press on the row.
  const onClick = (event: MouseEvent) => {
    if (!swiped) return;
    swiped = false;
    event.preventDefault();
    event.stopPropagation();
  };

  element.addEventListener("pointerdown", onPointerDown);
  element.addEventListener("click", onClick, true);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerEnd);
  window.addEventListener("pointercancel", onPointerEnd);
  return {
    open: () => {
      if (offset !== -face) settle(-face, 0);
    },
    close: () => {
      if (offset !== 0) settle(0, 0);
    },
    detach: () => {
      cancelAnimationFrame(frame);
      element.removeEventListener("pointerdown", onPointerDown);
      element.removeEventListener("click", onClick, true);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerEnd);
      window.removeEventListener("pointercancel", onPointerEnd);
    },
  };
}
