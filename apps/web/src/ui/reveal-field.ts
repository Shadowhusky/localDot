import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { matches, REDUCED_MOTION } from "./media.ts";

const INVALID = '[aria-invalid="true"]';
// Clear of the edge of what scrolls, so the field's label and message show too.
const ROOM = 16;
// How long after focus an on-screen keyboard may still arrive and cover the field.
const KEYBOARD_MS = 800;

function scrollerOf(element: HTMLElement): HTMLElement | null {
  for (let at = element.parentElement; at; at = at.parentElement) {
    const { overflowY } = getComputedStyle(at);
    if ((overflowY === "auto" || overflowY === "scroll") && at.scrollHeight > at.clientHeight)
      return at;
  }
  return null;
}

const px = (value: string) => Number.parseFloat(value) || 0;

// Scrolls only what holds the element, as little as it takes, clear of anything stuck over its
// edges (its scroll-padding) and of an on-screen keyboard. scrollIntoView would also move a clipped
// sheet around it and lift the sheet's header out of place.
function bringIntoView(element: HTMLElement, smooth: boolean) {
  const scroller = scrollerOf(element);
  if (!scroller) return;
  const style = getComputedStyle(scroller);
  const box = scroller.getBoundingClientRect();
  const viewport = window.visualViewport;
  const top = box.top + px(style.scrollPaddingTop) + ROOM;
  const bottom =
    Math.min(box.bottom, viewport ? viewport.offsetTop + viewport.height : box.bottom) -
    px(style.scrollPaddingBottom) -
    ROOM;
  const at = element.getBoundingClientRect();
  const by =
    at.top < top || at.height > bottom - top
      ? at.top - top
      : at.bottom > bottom
        ? at.bottom - bottom
        : 0;
  if (!by) return;
  const to = scroller.scrollTop + by;
  if (smooth && typeof scroller.scrollTo === "function")
    scroller.scrollTo({ top: to, behavior: "smooth" });
  else scroller.scrollTop = to;
}

// Lit once, however often it is revealed: reading the layout starts the light again.
function pulse(element: HTMLElement) {
  element.removeAttribute("data-reveal");
  element.getBoundingClientRect();
  element.setAttribute("data-reveal", "");
  element.addEventListener("animationend", () => element.removeAttribute("data-reveal"), {
    once: true,
  });
}

// Takes the user to a control that needs them: in view with its label and message, focused, and
// lit for a moment.
export function revealField(control: HTMLElement): void {
  const field = control.closest<HTMLElement>(".ui-field") ?? control;
  const smooth = !matches(REDUCED_MOTION);
  bringIntoView(field, smooth);
  control.focus({ preventScroll: true });
  pulse(control.closest<HTMLElement>(".ui-field-box") ?? control);
  const viewport = window.visualViewport;
  if (!viewport) return;
  const again = () => bringIntoView(field, smooth);
  viewport.addEventListener("resize", again, { once: true });
  setTimeout(() => viewport.removeEventListener("resize", again), KEYBOARD_MS);
}

// The first field in `scope` that says it is wrong, else the first match of each `otherwise` in
// turn; hidden parts of the form are passed over. Returns what it revealed.
export function revealInvalid(
  scope: ParentNode | null | undefined,
  ...otherwise: readonly string[]
): HTMLElement | null {
  if (!scope) return null;
  for (const selector of [INVALID, ...otherwise]) {
    const control = [...scope.querySelectorAll<HTMLElement>(selector)].find(
      (element) => !element.closest("[hidden], [inert]"),
    );
    if (control) {
      revealField(control);
      return control;
    }
  }
  return null;
}

// For a form that finds its problems on trying to save: call `reveal` with the state that shows
// them, and once they are drawn the first is revealed. `scope` goes on what holds the form's fields.
export function useRevealInvalid<T extends HTMLElement = HTMLElement>() {
  const scope = useRef<T>(null);
  const [asked, setAsked] = useState(0);
  useLayoutEffect(() => {
    if (asked) revealInvalid(scope.current);
  }, [asked]);
  const reveal = useCallback(() => setAsked((count) => count + 1), []);
  return { scope, reveal };
}
