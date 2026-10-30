import { type KeyboardEvent, type PointerEvent, useRef, type WheelEvent } from "react";

// Movement before a press becomes a drag: selecting text, dragging the scrollbar or panning.
const SLOP = 10;
// The keys that move through the output while it holds the focus.
const MOVE_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  " ",
]);

interface Scroller {
  scrollTop: number;
  scrollLeft: number;
  scrollHeight: number;
  scrollWidth: number;
  clientHeight: number;
  clientWidth: number;
}

export const movesByKey = (key: string) => MOVE_KEYS.has(key);

const toward = (at: number, end: number, by: number) => (by < 0 ? at > 0 : by > 0 && at < end - 1);

// A wheel moves the output only where there is more of it that way. A trackpad pinch arrives as a
// wheel with Control held.
export function movesByWheel(
  output: Scroller,
  wheel: { deltaX: number; deltaY: number; ctrlKey: boolean },
): boolean {
  return (
    wheel.ctrlKey ||
    toward(output.scrollTop, output.scrollHeight - output.clientHeight, wheel.deltaY) ||
    toward(output.scrollLeft, output.scrollWidth - output.clientWidth, wheel.deltaX)
  );
}

export const dragged = (from: { x: number; y: number }, to: { x: number; y: number }) =>
  Math.hypot(to.x - from.x, to.y - from.y) >= SLOP;

// Calls `read` once the reader moves through the output: a wheel that scrolls it, the keys that do,
// a drag or a pan across it, a pinch. A click or a tap leaves dot's work followed.
export function useReading(read: () => void) {
  const pressed = useRef(new Map<number, { x: number; y: number }>());
  return {
    onWheel(event: WheelEvent<HTMLElement>) {
      if (movesByWheel(event.currentTarget, event)) read();
    },
    onKeyDown(event: KeyboardEvent) {
      if (movesByKey(event.key)) read();
    },
    onPointerDown(event: PointerEvent) {
      if (event.isPrimary) pressed.current.clear();
      pressed.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pressed.current.size > 1) read();
    },
    onPointerMove(event: PointerEvent) {
      const from = pressed.current.get(event.pointerId);
      if (!from) return;
      if (!event.buttons) pressed.current.delete(event.pointerId);
      else if (dragged(from, { x: event.clientX, y: event.clientY })) read();
    },
    onPointerUp(event: PointerEvent) {
      pressed.current.delete(event.pointerId);
    },
    // The browser took the touch to pan or zoom.
    onPointerCancel(event: PointerEvent) {
      if (pressed.current.delete(event.pointerId)) read();
    },
    // Dragging the scrollbar moves the output under a press that never moves.
    onScroll() {
      if (pressed.current.size) read();
    },
  };
}
