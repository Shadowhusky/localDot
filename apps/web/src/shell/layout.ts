import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from "react";
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
// A keyboard has gone once the viewport has held still this long after the focus left its field.
const KEYBOARD_GONE_MS = 1200;

// Only a field in focus keeps a keyboard up.
export function typing(): boolean {
  const active = document.activeElement;
  return (
    active instanceof HTMLElement &&
    (active.isContentEditable || active.matches("input, textarea, select"))
  );
}

// The layout viewport's height. As Safari pans the page to show a field it takes the pan off
// innerHeight too, so innerHeight less the visual viewport stops measuring the keyboard; this holds.
export const pageHeight = () => document.documentElement.clientHeight;

// Pinched in, the visual viewport is narrower than the page. Its own scale can't say so: held
// sideways, iOS 26 reports the ratio of the screen's sides with no zoom at all.
export const pinched = (view: VisualViewport) =>
  view.width < document.documentElement.clientWidth - 1;

export function keyboardUp(): boolean {
  const view = window.visualViewport;
  return !!view && !pinched(view) && pageHeight() - view.height > KEYBOARD_PX;
}

export const onViewport = (onChange: () => void) => {
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

// Whether a keyboard for the computer is up, read when the viewport, the focus or the composer's
// keyboard lock changes rather than on each of the page's renders.
let computerKeyboard = false;
const readComputerKeyboard = () => {
  computerKeyboard =
    keyboardUp() &&
    typing() &&
    !document.activeElement?.matches(".composer-field") &&
    !document.querySelector(".app[data-composer-keyboard]");
};
const onComputerKeyboard = (onChange: () => void) => {
  const changed = () => {
    const before = computerKeyboard;
    readComputerKeyboard();
    if (computerKeyboard !== before) onChange();
  };
  readComputerKeyboard();
  const stop = onViewport(changed);
  const lock = new MutationObserver(changed);
  lock.observe(document.body, {
    subtree: true,
    attributes: true,
    attributeFilter: ["data-composer-keyboard"],
  });
  document.addEventListener("focusin", changed);
  document.addEventListener("focusout", changed);
  return () => {
    stop();
    lock.disconnect();
    document.removeEventListener("focusin", changed);
    document.removeEventListener("focusout", changed);
  };
};
const noKeyboard = () => () => {};

// Computer keyboard input can collapse the band. Composer typing keeps the background static.
export function useKeyboardUp(on = true): boolean {
  const handheld = useMediaQuery(HANDHELD) && on;
  const up = useSyncExternalStore(
    handheld ? onComputerKeyboard : noKeyboard,
    () => handheld && computerKeyboard,
    () => false,
  );
  return handheld && up;
}

// Keep handheld layouts fitted to the visible viewport, including Home Screen launches and
// keyboard dismissal. Restricting this to an open keyboard can leave stale browser-chrome space.
// Pinch zoom is a viewing operation and must not reflow the app.
export function useViewportFit(page: { current: HTMLElement | null }, on = true): void {
  const handheld = useMediaQuery(HANDHELD) && on;
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
    // Once the keyboard has had time to go, WebKit can still leave the visual viewport as short as
    // the keyboard made it, with no event to come. While it stays at just that measure the page
    // keeps the height it had before the keyboard, rather than a gap under the composer.
    let stale: { height: number; rest: number } | undefined;
    // The height from before the keyboard, while it may be on its way down.
    let leaving: number | undefined;
    let goneTimer: ReturnType<typeof setTimeout> | undefined;
    const fit = () => {
      frame = 0;
      // Background tabs and keyboard transitions can briefly report an empty viewport.
      // Never save that transient geometry as the next resting layout.
      if (document.hidden || pinched(view) || !Number.isFinite(view.height) || view.height <= 0)
        return;
      const focused = document.activeElement?.matches(".composer-field");
      if (stale?.height !== view.height) stale = undefined;
      const visible = stale ? stale.rest : view.height;
      if (focused && focusedHeight === undefined) focusedHeight = restingHeight;
      // OS keyboard controls can reopen it without pointerdown or focusin. A stale
      // dismissal flag must not let that resize shrink the entire app.
      if (focused && dismissed && (focusedHeight ?? restingHeight) - visible > 1) dismissed = false;
      // Lock on focus, before the first keyboard frame, and keep the lock through
      // dismissal. The 120px detection threshold must never resize the background.
      const toolbar = element.querySelector<HTMLElement>(".thread-toolbar");
      if (focused && !composing && !dismissed && focusedHeight !== undefined) {
        element
          .querySelector<HTMLElement>(".thread-dock")
          ?.style.setProperty(
            "--_composer-rest-height",
            `${toolbar?.getBoundingClientRect().height ?? 0}px`,
          );
        composing = true;
      }
      const covered = (focusedHeight ?? restingHeight) - visible;
      if (covered > KEYBOARD_PX) sawKeyboard = true;
      if (composing && (!focused || sawKeyboard) && covered <= 1) {
        composing = false;
        focusedHeight = undefined;
        sawKeyboard = false;
        dismissed = !!focused;
      }
      if (!composing) restingHeight = visible;
      element.toggleAttribute("data-composer-keyboard", composing);
      const height = `${composing ? (focusedHeight ?? restingHeight) : visible}px`;
      // A fixed shell follows the visual viewport's origin while the toolbar
      // follows its bottom. Merely shrinking the app lets Safari pan it away.
      // WebKit can leave offsetTop at the previous keyboard pan after restoring height.
      // Clamp it to real occluded space, and never apply a stale pan to a resting shell.
      const layoutHeight = Math.max(pageHeight(), focusedHeight ?? restingHeight, visible);
      const offset = Math.min(
        Math.max(0, view.offsetTop || 0),
        Math.max(0, layoutHeight - visible),
      );
      const top = `${composing || (keyboardUp() && !stale) ? offset : 0}px`;
      const bottom = `${offset + visible}px`;
      if (toolbar && toolbar.style.getPropertyValue("--_composer-bottom") !== bottom)
        toolbar.style.setProperty("--_composer-bottom", bottom);
      if (element.style.getPropertyValue("--_visible-h") !== height)
        element.style.setProperty("--_visible-h", height);
      if (element.style.getPropertyValue("--_visible-top") !== top)
        element.style.setProperty("--_visible-top", top);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(fit);
    };
    fit();
    const waitForGone = () => {
      clearTimeout(goneTimer);
      goneTimer = setTimeout(() => {
        if (leaving !== undefined && !typing() && view.height < leaving - 1)
          stale = { height: view.height, rest: leaving };
        leaving = undefined;
        schedule();
      }, KEYBOARD_GONE_MS);
    };
    const stop = onViewport(() => {
      if (leaving !== undefined) waitForGone();
      schedule();
    });
    const focus = () => {
      dismissed = false;
      if (typing()) {
        stale = undefined;
        leaving = undefined;
        clearTimeout(goneTimer);
      }
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
    const blur = () => {
      schedule();
      leaving = focusedHeight;
      waitForGone();
    };
    document.addEventListener("focusin", focus);
    document.addEventListener("focusout", blur);
    document.addEventListener("visibilitychange", schedule);
    return () => {
      stop();
      clearTimeout(goneTimer);
      document.removeEventListener("pointerdown", pointer, true);
      document.removeEventListener("focusin", focus);
      document.removeEventListener("focusout", blur);
      document.removeEventListener("visibilitychange", schedule);
      element.removeAttribute("data-composer-keyboard");
      element
        .querySelector<HTMLElement>(".thread-toolbar")
        ?.style.removeProperty("--_composer-bottom");
      element
        .querySelector<HTMLElement>(".thread-dock")
        ?.style.removeProperty("--_composer-rest-height");
      cancelAnimationFrame(frame);
      element.style.removeProperty("--_visible-h");
      element.style.removeProperty("--_visible-top");
    };
  }, [page, handheld]);
}

// How much of the page's foot the on-screen keyboard covers, so a sheet can rest on top of it. Less
// than a keyboard is Safari's toolbars coming and going, which cover nothing.
function keyboardInset(): number {
  const view = window.visualViewport;
  if (!view || pinched(view)) return 0;
  const inset = Math.round(pageHeight() - view.height - view.offsetTop);
  return inset >= KEYBOARD_PX ? inset : 0;
}

// How far the message toolbar's top stands above the page's foot, keyboard and all: what a sheet
// rising from the bottom keeps clear of, so the toolbar never covers its answers.
export function useToolbarInset(): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const read = () => {
      const toolbar = [...document.querySelectorAll<HTMLElement>(".thread-toolbar")].find(
        (element) => element.getClientRects().length > 0,
      );
      const top = toolbar?.getBoundingClientRect().top;
      setInset(top === undefined ? 0 : Math.max(0, Math.round(pageHeight() - top)));
    };
    read();
    const sizes = new ResizeObserver(read);
    for (const element of document.querySelectorAll(".thread-toolbar")) sizes.observe(element);
    const stop = onViewport(read);
    return () => {
      sizes.disconnect();
      stop();
    };
  }, []);
  return inset;
}

export function useKeyboardInset(): number {
  return useSyncExternalStore(onViewport, keyboardInset, () => 0);
}
