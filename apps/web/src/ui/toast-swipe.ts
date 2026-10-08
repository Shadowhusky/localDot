import { type SpringParams, springValue } from "@localdot/stage";
import { project, rubberband, velocityOf } from "./sheet-drag.ts";

// Movement before a press becomes a swipe, so a tap on the toast stays a tap.
const SLOP = 10;
const WINDOW_MS = 100;
// Projected past this share of its width (sideways) or its height (up), a release sends it away.
const AWAY_X = 0.4;
const AWAY_UP = 0.5;
const SETTLE: SpringParams = { dampingRatio: 1, response: 0.3 };

export type SwipeAxis = "x" | "up";

export function swipeOutcome(
  axis: SwipeAxis,
  offset: number,
  velocity: number,
  size: { width: number; height: number },
): "away" | "back" {
  const landing = offset + project(velocity);
  if (axis === "up") return landing < -size.height * AWAY_UP ? "away" : "back";
  return Math.abs(landing) > size.width * AWAY_X && Math.sign(landing) === Math.sign(offset)
    ? "away"
    : "back";
}

export interface SwipeHost {
  // A swipe has begun or ended: the toast's time stands still meanwhile.
  holding(on: boolean): void;
  // The release sends it away; it carries on off by itself until gone() is called.
  away(): void;
  gone(): void;
  reducedMotion(): boolean;
}

interface Press {
  id: number;
  x: number;
  y: number;
  // Where the toast was when the finger landed, so one still springing home is caught where it is.
  from: number;
  axis?: SwipeAxis;
  samples: { t: number; y: number }[];
}

// Sideways or up, the toast follows the finger 1:1 from where it was grabbed; pulled down, it gives a
// little and springs back. A release is projected forward: far enough and it carries on out at the
// speed it was let go, otherwise it springs home.
export function attachToastSwipe(element: HTMLElement, host: SwipeHost): () => void {
  let press: Press | undefined;
  let offset = 0;
  let axis: SwipeAxis = "x";
  let frame = 0;
  let leaving = false;
  let swiped = false;

  const apply = (value: number) => {
    offset = value;
    const travel =
      axis === "x"
        ? Math.abs(value) / (element.offsetWidth || 1)
        : Math.max(0, -value) / (element.offsetHeight * 1.5 || 1);
    element.style.transform =
      axis === "x" ? `translate3d(${value}px, 0, 0)` : `translate3d(0, ${value}px, 0)`;
    element.style.opacity = `${1 - Math.min(1, travel) * 0.8}`;
  };

  const clear = () => {
    element.style.removeProperty("transform");
    element.style.removeProperty("opacity");
    element.style.removeProperty("transition");
    offset = 0;
  };

  const animate = (to: number, velocity: number, done: () => void) => {
    const from = offset;
    const start = performance.now();
    const step = (now: number) => {
      const t = (now - start) / 1000;
      const value = springValue(from, to, velocity, t, SETTLE);
      apply(value);
      const past = to !== 0 && Math.abs(value) >= Math.abs(to);
      if (past || (Math.abs(value - to) < 0.5 && t > 0.05)) {
        frame = 0;
        done();
        return;
      }
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
  };

  const release = (velocity: number) => {
    const size = { width: element.offsetWidth, height: element.offsetHeight };
    if (swipeOutcome(axis, offset, velocity, size) === "away") {
      leaving = true;
      host.away();
      if (host.reducedMotion()) return host.gone();
      const to = axis === "x" ? Math.sign(offset) * (size.width + 24) : -(size.height + 24);
      animate(to, velocity, host.gone);
      return;
    }
    host.holding(false);
    if (host.reducedMotion()) return clear();
    animate(0, velocity, clear);
  };

  const begin = (event: PointerEvent) => {
    element.setPointerCapture(event.pointerId);
    element.style.transition = "none";
    host.holding(true);
  };

  const onPointerDown = (event: PointerEvent) => {
    swiped = false;
    if (press || leaving || (event.pointerType === "mouse" && event.button !== 0)) return;
    if (!frame && event.target instanceof Element && event.target.closest("button, a, input"))
      return;
    press = { id: event.pointerId, x: event.clientX, y: event.clientY, from: 0, samples: [] };
    if (!frame) return;
    cancelAnimationFrame(frame);
    frame = 0;
    press.axis = axis;
    press.from = offset;
    begin(event);
  };

  const onPointerMove = (event: PointerEvent) => {
    const current = press;
    if (!current || event.pointerId !== current.id) return;
    const dx = event.clientX - current.x;
    const dy = event.clientY - current.y;
    if (!current.axis) {
      if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;
      current.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "up";
      axis = current.axis;
      begin(event);
    }
    const raw = current.from + (axis === "x" ? dx : dy);
    apply(axis === "up" && raw > 0 ? rubberband(raw, element.offsetHeight) : raw);
    current.samples.push({ t: event.timeStamp, y: raw });
    if (current.samples.length > 32) current.samples.shift();
  };

  const onPointerEnd = (event: PointerEvent) => {
    const current = press;
    if (!current || event.pointerId !== current.id) return;
    press = undefined;
    if (!current.axis) return;
    swiped = true;
    if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
    const recent = current.samples.at(-1);
    const still = !recent || event.timeStamp - recent.t > WINDOW_MS / 2;
    release(event.type === "pointercancel" || still ? 0 : velocityOf(current.samples));
  };

  // The click that ends a swipe is not a tap on the toast.
  const onClick = (event: MouseEvent) => {
    if (!swiped) return;
    swiped = false;
    event.stopPropagation();
  };

  element.addEventListener("pointerdown", onPointerDown);
  element.addEventListener("click", onClick, true);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerEnd);
  window.addEventListener("pointercancel", onPointerEnd);
  return () => {
    cancelAnimationFrame(frame);
    element.removeEventListener("pointerdown", onPointerDown);
    element.removeEventListener("click", onClick, true);
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerEnd);
    window.removeEventListener("pointercancel", onPointerEnd);
  };
}
