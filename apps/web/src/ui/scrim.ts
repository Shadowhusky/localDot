import { type MouseEvent, type PointerEvent, useRef } from "react";

// A press on the dim area closes the layer only when it starts and ends there: a drag that began on
// the panel (selecting text, or a slider pulled too far) never does. It closes on the click, so a
// tap's late click cannot land on the page once the dim area has gone. The press keeps focus where
// it was, inside the layer.
export function useScrim(dismiss: () => void) {
  const down = useRef(false);
  return {
    onPointerDown(event: PointerEvent<HTMLElement>) {
      down.current = event.target === event.currentTarget && event.button === 0;
      // Only for a mouse: WebKit drops the tap's click when a touch's pointerdown is cancelled.
      if (down.current && event.pointerType === "mouse") event.preventDefault();
    },
    onClick(event: MouseEvent<HTMLElement>) {
      const both = down.current && event.target === event.currentTarget;
      down.current = false;
      if (both) dismiss();
    },
  };
}
