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

function watchViewport(onChange: () => void) {
  const view = window.visualViewport;
  view?.addEventListener("resize", onChange);
  view?.addEventListener("scroll", onChange);
  return () => {
    view?.removeEventListener("resize", onChange);
    view?.removeEventListener("scroll", onChange);
  };
}

// A phone's keyboard is up: the band collapses and dot moves into the island.
export function useKeyboardUp(): boolean {
  const phone = useMediaQuery(PHONE);
  const up = useSyncExternalStore(watchViewport, keyboardUp, () => false);
  return phone && up;
}

// How much of the page's foot the on-screen keyboard covers, so a sheet can rest on top of it.
function keyboardInset(): number {
  const view = window.visualViewport;
  return view ? Math.max(0, Math.round(window.innerHeight - view.height - view.offsetTop)) : 0;
}

export function useKeyboardInset(): number {
  return useSyncExternalStore(watchViewport, keyboardInset, () => 0);
}
