import { type RefObject, useLayoutEffect, useRef } from "react";
import { flushSync } from "react-dom";
import { matches, REDUCED_MOTION } from "./media.ts";
import { tokenMs } from "./motion.ts";

// Set while closeGap's commit runs.
let closing = false;

function glide(
  element: HTMLElement,
  frames: Keyframe[],
  duration: number,
  style: CSSStyleDeclaration,
) {
  try {
    element.animate(frames, {
      duration,
      easing: style.getPropertyValue("--ease-spring").trim() || "ease-out",
    });
  } catch {
    element.animate(frames, { duration, easing: "ease-out" });
  }
}

// What scrolls an element's content, if anything does.
function scrollerOf(element: Element): HTMLElement | null {
  for (let at = element.parentElement; at; at = at.parentElement)
    if (/(auto|scroll)/.test(getComputedStyle(at).overflowY)) return at;
  return null;
}

// Takes rows out in one commit so that the list closes behind them with no jump: useFlip glides those
// below, quickly, and what the browser moves on its own follows smoothly too: a scroller at its end
// that lost height, or one holding its place by what is above it. Pass the rows that go, read here
// before they do.
export function closeGap(rows: readonly Element[], remove: () => void): void {
  const scrollers = new Map<HTMLElement, number>();
  for (const parent of new Set(rows.map((row) => row.parentElement))) {
    const scroller = parent && scrollerOf(parent);
    if (scroller) scrollers.set(scroller, scroller.scrollTop);
  }
  closing = true;
  try {
    flushSync(remove);
  } finally {
    closing = false;
  }
  if (matches(REDUCED_MOTION)) return;
  for (const [scroller, was] of scrollers) {
    const moved = was - scroller.scrollTop;
    if (Math.abs(moved) < 0.5) continue;
    const style = getComputedStyle(scroller);
    for (const child of scroller.children)
      if (typeof child.animate === "function")
        glide(
          child as HTMLElement,
          [{ transform: `translateY(${-moved}px)` }, { transform: "none" }],
          tokenMs(style, "--dur-snappy", 340),
          style,
        );
  }
}

// When `order` changes, each item marked `data-flip="<key>"` inside `container` glides from where it
// was to its new place, and a newcomer grows in where it lands (FLIP). Places are read against the
// scroller's content, so scrolling or a resize between orders moves nothing; across, against the
// item's own layout, so a row of cards that scrolls sideways moves nothing either. Under reduced
// motion items take their places at once and newcomers only fade in. Only what could be on screen
// moves, so a long list costs no more than a short one.
export function useFlip(container: RefObject<HTMLElement | null>, order: string): void {
  const places = useRef(new Map<string, { x: number; y: number }>());
  const shown = useRef<string | null>(null);
  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    const origin = element.getBoundingClientRect().top - element.scrollTop;
    const items = [...element.querySelectorAll<HTMLElement>("[data-flip]")];
    const now = new Map(
      items.map((item) => [
        item.dataset.flip ?? "",
        { x: item.offsetLeft, y: item.getBoundingClientRect().top - origin },
      ]),
    );
    if (shown.current && shown.current !== order && typeof element.animate === "function") {
      const style = getComputedStyle(element);
      const still = matches(REDUCED_MOTION);
      const height = window.innerHeight;
      const onScreen = (y: number) => y + origin > -height && y + origin < 2 * height;
      const moveMs = closing
        ? tokenMs(style, "--dur-snappy", 340)
        : tokenMs(style, "--dur-default", 470);
      for (const item of items) {
        const was = places.current.get(item.dataset.flip ?? "");
        const is = now.get(item.dataset.flip ?? "") ?? { x: 0, y: 0 };
        if (!onScreen(is.y) && (was === undefined || !onScreen(was.y))) continue;
        // What comes with a gap closing (a foot back under the rows) waits until they have passed.
        if (was === undefined && closing && !still)
          item.animate([{ opacity: 0 }, { opacity: 0, offset: 0.5 }, { opacity: 1 }], moveMs);
        else if (was === undefined)
          glide(
            item,
            still
              ? [{ opacity: 0 }, { opacity: 1 }]
              : [
                  { opacity: 0, transform: "scale(0.96)" },
                  { opacity: 1, transform: "none" },
                ],
            tokenMs(style, still ? "--dur-fade" : "--dur-default", still ? 150 : 470),
            style,
          );
        else if (!still && (Math.abs(was.y - is.y) > 0.5 || Math.abs(was.x - is.x) > 0.5))
          glide(
            item,
            [
              {
                transform:
                  Math.abs(was.x - is.x) > 0.5
                    ? `translate(${was.x - is.x}px, ${was.y - is.y}px)`
                    : `translateY(${was.y - is.y}px)`,
              },
              { transform: "none" },
            ],
            moveMs,
            style,
          );
      }
    }
    places.current = now;
    shown.current = order;
  });
}
