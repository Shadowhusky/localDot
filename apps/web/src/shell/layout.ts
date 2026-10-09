import { useSyncExternalStore } from "react";
import { PHONE, useMediaQuery } from "../ui/media.ts";

// Wide: the stage beside both rails. Laptop: the stage beside one rail that switches between Chat
// and Activity. Tablet: the stage over that rail. Phone: the stage over the thread.
export type Layout = "wide" | "laptop" | "tablet" | "phone";

export function useLayout(): Layout {
  const wide = useMediaQuery("(width >= 1880px)");
  const laptop = useMediaQuery("(width >= 1100px)");
  const phone = useMediaQuery(PHONE);
  return wide ? "wide" : laptop ? "laptop" : phone ? "phone" : "tablet";
}

// The on-screen keyboard takes this much of a phone's height or more when it is up.
const KEYBOARD_PX = 120;

function keyboardUp(): boolean {
  const view = window.visualViewport;
  return !!view && window.innerHeight - view.height > KEYBOARD_PX;
}

// A phone's keyboard is up: the band collapses and dot moves into the island.
export function useKeyboardUp(): boolean {
  const phone = useMediaQuery(PHONE);
  const up = useSyncExternalStore(
    (onChange) => {
      const view = window.visualViewport;
      view?.addEventListener("resize", onChange);
      return () => view?.removeEventListener("resize", onChange);
    },
    keyboardUp,
    () => false,
  );
  return phone && up;
}
