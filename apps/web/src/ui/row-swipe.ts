import { type SpringParams, springValue } from "@localdot/stage";
import { project, rubberband, velocityOf } from "./sheet-drag.ts";

// The width of the action face a row slides aside to show.
export const SWIPE_FACE = 88;
// Movement before a press becomes a swipe, so a tap or a scroll stays what it was.
const SLOP = 10;
const WINDOW_MS = 100;
// Presses this close to the screen's side edges belong to the browser's own back and forward swipe.
export const EDGE = 20;
// A row dragged past this share of its width carries out its first action on that side when let go.
export const COMMIT_AT = 0.55;
// Only a flick carries momentum, so only a flick lands with a little overshoot.
const SETTLE: SpringParams = { dampingRatio: 1, response: 0.3 };
const MOMENTUM: SpringParams = { dampingRatio: 0.8, response: 0.35 };
const FLICK_SPEED = 300;

export type SwipeSide = "leading" | "trailing";

// What a row can slide aside to show: the width of the faces behind each edge (0 for none), and the
// sides on which a long swipe carries out the first action outright, as Mail's does.
export interface SwipeFaces {
  leading: number;
  trailing: number;
  commits?: readonly SwipeSide[];
}

export type SwipeLanding = "closed" | SwipeSide | "commit-leading" | "commit-trailing";

const sideOf = (offset: number): SwipeSide => (offset < 0 ? "trailing" : "leading");

// Past the commit line on a side that commits. Only a row dragged that far commits, never a flick
// short of it, so an action is never carried out by accident.
export function swipeArmed(offset: number, faces: SwipeFaces, width: number): boolean {
  const side = sideOf(offset);
  return (
    offset !== 0 &&
    faces[side] > 0 &&
    !!faces.commits?.includes(side) &&
    Math.abs(offset) >= COMMIT_AT * width
  );
}

// Where a released row comes to rest: past the commit line it carries out that side's action;
// otherwise its projected landing opens the side it is on once it passes half that side's faces.
// A flick never carries it across home to the other side: it closes.
export function swipeLanding(
  offset: number,
  velocity: number,
  faces: SwipeFaces,
  width: number,
): SwipeLanding {
  if (swipeArmed(offset, faces, width)) return `commit-${sideOf(offset)}`;
  const landing = offset + project(velocity);
  const side = sideOf(offset || landing);
  if (side === "trailing" && faces.trailing > 0 && landing < -faces.trailing / 2) return "trailing";
  if (side === "leading" && faces.leading > 0 && landing > faces.leading / 2) return "leading";
  return "closed";
}

// Where a released row with one face behind its trailing edge comes to rest.
export function swipeRest(offset: number, velocity: number, face = SWIPE_FACE): "open" | "closed" {
  return swipeLanding(
    offset,
    velocity,
    { leading: 0, trailing: face },
    Number.POSITIVE_INFINITY,
  ) === "trailing"
    ? "open"
    : "closed";
}

// How far a row dragged `raw` from home shows: 1:1 across its faces, and on a side that commits on
// across the row, so the line can be reached; beyond that, and on a side with nothing behind it, it
// gives less and less.
export function swipeOffset(raw: number, faces: SwipeFaces, width: number): number {
  const side = sideOf(raw);
  const reach = faces[side] > 0 && faces.commits?.includes(side) ? width : faces[side];
  const distance = Math.abs(raw);
  return (
    Math.sign(raw) * (distance <= reach ? distance : reach + rubberband(distance - reach, width))
  );
}

export interface SwipeHost {
  // The row came to rest open on a side, or closed.
  rest(side: SwipeSide | null): void;
  reducedMotion(): boolean;
  // Each frame it moves, how far: the faces fill what it uncovers.
  moved?(offset: number): void;
  // It crossed the commit line, one way or the other, while held.
  armed?(armed: boolean): void;
  // Let go past the commit line: whether the row leaves that way, as when its action takes it out
  // of the list, or comes home. `commit` runs once it has left, or at once when it comes home.
  leaves?(side: SwipeSide): boolean;
  commit?(side: SwipeSide): void;
}

export interface Swipe {
  open(side: SwipeSide): void;
  close(): void;
  // Slides the row out past `side`'s edge, then runs `then`.
  away(side: SwipeSide, then: () => void): void;
  // Lets go of a press that has not yet become a swipe, as when it became a hold instead.
  cancel(): void;
  detach(): void;
}

interface Press {
  id: number;
  x: number;
  y: number;
  from: number;
  width: number;
  axis?: "x" | "y";
  armed: boolean;
  samples: { t: number; y: number }[];
}

// The row follows the finger sideways 1:1 from where it was grabbed; a release is projected forward
// and springs, from where the row is and at the finger's speed, to a side or home, or carries out
// that side's action. A press on a row still moving catches it where it is.
export function attachSwipe(element: HTMLElement, host: SwipeHost, faces: SwipeFaces): Swipe {
  let press: Press | undefined;
  let offset = 0;
  let frame = 0;
  let swiped = false;

  const apply = (value: number) => {
    offset = value;
    element.style.transform = value ? `translate3d(${value}px, 0, 0)` : "";
    host.moved?.(value);
  };

  const settle = (to: number, velocity: number, done?: () => void) => {
    cancelAnimationFrame(frame);
    frame = 0;
    if (host.reducedMotion()) {
      apply(to);
      done?.();
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
        done?.();
        return;
      }
      apply(value);
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
  };

  const restAt = (side: SwipeSide | null, velocity: number) => {
    host.rest(side);
    settle(
      side === "leading" ? faces.leading : side === "trailing" ? -faces.trailing : 0,
      velocity,
    );
  };

  const away = (side: SwipeSide, then: () => void, velocity = 0) => {
    host.rest(null);
    const width = element.offsetWidth;
    settle(side === "trailing" ? -width : width, velocity, then);
  };

  const onPointerDown = (event: PointerEvent) => {
    swiped = false;
    if (press || event.pointerType === "mouse") return;
    if (event.clientX < EDGE || event.clientX > window.innerWidth - EDGE) return;
    cancelAnimationFrame(frame);
    frame = 0;
    press = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      from: offset,
      width: element.offsetWidth,
      armed: false,
      samples: [],
    };
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
      // A pointer the browser no longer tracks can't be captured; the window still hears it.
      try {
        element.setPointerCapture?.(event.pointerId);
      } catch {}
    }
    if (current.axis !== "x") return;
    const raw = current.from + dx;
    apply(swipeOffset(raw, faces, current.width));
    const armed = swipeArmed(offset, faces, current.width);
    if (armed !== current.armed) {
      current.armed = armed;
      host.armed?.(armed);
    }
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
        restAt(null, 0);
      }
      return;
    }
    swiped = true;
    if (element.hasPointerCapture?.(event.pointerId))
      element.releasePointerCapture(event.pointerId);
    const recent = current.samples.at(-1);
    const still = !recent || event.timeStamp - recent.t > WINDOW_MS / 2;
    const cancelled = event.type === "pointercancel";
    const velocity = cancelled || still ? 0 : velocityOf(current.samples);
    const landing = cancelled ? "closed" : swipeLanding(offset, velocity, faces, current.width);
    const disarm = () => {
      if (current.armed) host.armed?.(false);
    };
    if (landing === "commit-leading" || landing === "commit-trailing") {
      const side = landing === "commit-leading" ? "leading" : "trailing";
      // A row that leaves keeps its action lit until it has gone.
      if (host.leaves?.(side))
        away(
          side,
          () => {
            disarm();
            host.commit?.(side);
          },
          velocity,
        );
      else {
        disarm();
        restAt(null, velocity);
        host.commit?.(side);
      }
    } else {
      disarm();
      restAt(landing === "closed" ? null : landing, velocity);
    }
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
    open: (side) => {
      if (offset !== (side === "leading" ? faces.leading : -faces.trailing)) restAt(side, 0);
    },
    close: () => {
      if (offset !== 0) restAt(null, 0);
    },
    away: (side, then) => away(side, then),
    cancel: () => {
      if (!press?.axis) press = undefined;
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

export interface RowSwipeHost {
  // The row came to rest open on its face, or closed again.
  rest(open: boolean): void;
  reducedMotion(): boolean;
}

// A row with one face behind its trailing edge, which a swipe left shows.
export function attachRowSwipe(
  element: HTMLElement,
  host: RowSwipeHost,
  face = SWIPE_FACE,
): { open(): void; close(): void; detach(): void } {
  const swipe = attachSwipe(
    element,
    { rest: (side) => host.rest(side !== null), reducedMotion: host.reducedMotion },
    { leading: 0, trailing: face },
  );
  return { open: () => swipe.open("trailing"), close: swipe.close, detach: swipe.detach };
}
