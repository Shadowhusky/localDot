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
  return !!view && view.scale === 1 && window.innerHeight - view.height > KEYBOARD_PX;
}

const onViewport = (onChange: () => void) => {
  const view = window.visualViewport;
  view?.addEventListener("resize", onChange);
  view?.addEventListener("scroll", onChange);
  window.addEventListener("resize", onChange);
  window.addEventListener("pageshow", onChange);
  return () => {
    view?.removeEventListener("resize", onChange);
    view?.removeEventListener("scroll", onChange);
    window.removeEventListener("resize", onChange);
    window.removeEventListener("pageshow", onChange);
  };
};

// Computer keyboard input can collapse the band. Composer typing keeps the background static.
export function useKeyboardUp(): boolean {
  const handheld = useMediaQuery(HANDHELD);
  const up = useSyncExternalStore(
    onViewport,
    () =>
      keyboardUp() &&
      !document.activeElement?.matches(".composer-field") &&
      !document.querySelector(".app[data-composer-keyboard]"),
    () => false,
  );
  return handheld && up;
}

// Keep handheld layouts fitted to the visible viewport, including Home Screen launches and
// keyboard dismissal. Restricting this to an open keyboard can leave stale browser-chrome space.
// Pinch zoom is a viewing operation and must not reflow the app.
export function useViewportFit(page: { current: HTMLElement | null }): void {
  const handheld = useMediaQuery(HANDHELD);
  useLayoutEffect(() => {
    const element = page.current;
    const view = window.visualViewport;
    if (!element || !view || !handheld) return;
    let frame = 0;
    let composing = false;
    // Capture the layout before iOS scrolls/resizes it to reveal the caret. Some
    // browsers resize innerHeight along with the visual viewport.
    let restingHeight = view.height;
    let focusedHeight: number | undefined;
    let sawKeyboard = false;
    let dismissed = false;
    const fit = () => {
      frame = 0;
      if (view.scale !== 1) return;
      const focused = document.activeElement?.matches(".composer-field");
      if (focused && focusedHeight === undefined) focusedHeight = restingHeight;
      // Lock on focus, before the first keyboard frame, and keep the lock through
      // dismissal. The 120px detection threshold must never resize the background.
      if (focused && !composing && !dismissed && focusedHeight !== undefined) {
        const toolbar = element.querySelector(".thread-toolbar");
        element.style.setProperty(
          "--_composer-rest-height",
          `${toolbar?.getBoundingClientRect().height ?? 0}px`,
        );
        composing = true;
      }
      const covered = (focusedHeight ?? restingHeight) - view.height;
      if (covered > KEYBOARD_PX) sawKeyboard = true;
      if (composing && (!focused || sawKeyboard) && covered <= 1 && view.offsetTop <= 1) {
        composing = false;
        focusedHeight = undefined;
        sawKeyboard = false;
        dismissed = !!focused;
      }
      if (!composing) restingHeight = view.height;
      element.toggleAttribute("data-composer-keyboard", composing);
      const height = `${composing ? (focusedHeight ?? restingHeight) : view.height}px`;
      // A fixed shell follows the visual viewport's origin while the toolbar
      // follows its bottom. Merely shrinking the app lets Safari pan it away.
      const top = `${composing || keyboardUp() ? view.offsetTop : 0}px`;
      const bottom = `${view.offsetTop + view.height}px`;
      if (element.style.getPropertyValue("--_composer-bottom") !== bottom)
        element.style.setProperty("--_composer-bottom", bottom);
      if (element.style.getPropertyValue("--_visible-h") !== height)
        element.style.setProperty("--_visible-h", height);
      if (element.style.getPropertyValue("--_visible-top") !== top)
        element.style.setProperty("--_visible-top", top);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(fit);
    };
    fit();
    const stop = onViewport(schedule);
    const focus = () => {
      dismissed = false;
      if (document.activeElement?.matches(".composer-field") && focusedHeight === undefined)
        focusedHeight = restingHeight;
      // Safari may begin caret reveal before the next animation frame.
      if (frame) cancelAnimationFrame(frame);
      fit();
    };
    const pointer = (event: PointerEvent) => {
      // Dismissing the software keyboard can leave the textarea focused. Tapping
      // it again opens a new keyboard transition without another focusin event.
      if (dismissed && event.target instanceof Element && event.target.matches(".composer-field"))
        focus();
    };
    document.addEventListener("pointerdown", pointer, true);
    document.addEventListener("focusin", focus);
    document.addEventListener("focusout", schedule);
    return () => {
      stop();
      document.removeEventListener("pointerdown", pointer, true);
      document.removeEventListener("focusin", focus);
      document.removeEventListener("focusout", schedule);
      element.removeAttribute("data-composer-keyboard");
      element.style.removeProperty("--_composer-bottom");
      element.style.removeProperty("--_composer-rest-height");
      cancelAnimationFrame(frame);
      element.style.removeProperty("--_visible-h");
      element.style.removeProperty("--_visible-top");
    };
  }, [page, handheld]);
}

// How much of the page's foot the on-screen keyboard covers, so a sheet can rest on top of it.
function keyboardInset(): number {
  const view = window.visualViewport;
  return view && view.scale === 1
    ? Math.max(0, Math.round(window.innerHeight - view.height - view.offsetTop))
    : 0;
}

export function useKeyboardInset(): number {
  return useSyncExternalStore(onViewport, keyboardInset, () => 0);
}
