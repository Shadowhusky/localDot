import { type RefObject, useLayoutEffect, useRef } from "react";
import { matches, REDUCED_MOTION } from "./media.ts";
import { tokenMs } from "./motion.ts";

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

// When `order` changes, each item marked `data-flip="<key>"` inside `container` glides from where it
// was to its new place, and a newcomer grows in where it lands (FLIP). Places are read against the
// scroller's content, so scrolling or a resize between orders moves nothing; across, against the
// item's own layout, so a row of cards that scrolls sideways moves nothing either. Under reduced
// motion items take their places at once and newcomers only fade in.
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
      for (const item of items) {
        const was = places.current.get(item.dataset.flip ?? "");
        const is = now.get(item.dataset.flip ?? "") ?? { x: 0, y: 0 };
        if (was === undefined)
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
            tokenMs(style, "--dur-default", 470),
            style,
          );
      }
    }
    places.current = now;
    shown.current = order;
  });
}
