import { useLayoutEffect, useSyncExternalStore } from "react";
import { useMediaQuery } from "../ui/media.ts";

// Wide: the stage beside both rails. Laptop: the stage beside one rail that switches between Chat
// and Activity. Tablet: the stage over that rail. Phone: the stage over the thread, or beside it
// while the phone is held sideways.
export type Layout = "wide" | "laptop" | "tablet" | "phone";

// A phone held sideways is wider than a phone, and far too short for the tablet layout.
export const LANDSCAPE_PHONE =
  "(pointer: coarse) and (orientation: landscape) and (height < 500px)";
export const HANDHELD = `(width < 700px), ${LANDSCAPE_PHONE}`;

export function useLayout(): Layout {
  const wide = useMediaQuery("(width >= 1880px)");
  const laptop = useMediaQuery("(width >= 1100px)");
  const handheld = useMediaQuery(HANDHELD);
  return handheld ? "phone" : wide ? "wide" : laptop ? "laptop" : "tablet";
}

// The on-screen keyboard takes this much of a phone's height or more when it is up.
const KEYBOARD_PX = 120;

function keyboardUp(): boolean {
  const view = window.visualViewport;
  return !!view && window.innerHeight - view.height > KEYBOARD_PX;
}

const onViewport = (onChange: () => void) => {
  const view = window.visualViewport;
  view?.addEventListener("resize", onChange);
  view?.addEventListener("scroll", onChange);
  return () => {
    view?.removeEventListener("resize", onChange);
    view?.removeEventListener("scroll", onChange);
  };
};

// A phone's keyboard is up: the band collapses and dot moves into the island.
export function useKeyboardUp(): boolean {
  const handheld = useMediaQuery(HANDHELD);
  const up = useSyncExternalStore(onViewport, keyboardUp, () => false);
  return handheld && up;
}

// While the keyboard is up the page fits the part of the screen the keyboard leaves, so the stage
// stays where it was and the toolbar rides on the keyboard. iOS pans the page rather than resizing
// it, so the page moves back by what it panned.
export function useKeyboardFit(page: { current: HTMLElement | null }, up: boolean): void {
  useLayoutEffect(() => {
    const element = page.current;
    const view = window.visualViewport;
    if (!element || !view || !up) return;
    const fit = () => {
      element.style.setProperty("--_visible-h", `${view.height}px`);
      element.style.setProperty("--_visible-top", `${view.offsetTop}px`);
    };
    fit();
    const stop = onViewport(fit);
    return () => {
      stop();
      element.style.removeProperty("--_visible-h");
      element.style.removeProperty("--_visible-top");
    };
  }, [page, up]);
}
