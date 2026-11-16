import { clsx } from "clsx";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { REDUCED_MOTION, useMediaQuery } from "./media.ts";

// How fast a long name slides, and how long it rests at each end before it turns back.
const SPEED = 36;
const REST_MS = 1600;
// The fade at its end (--spacing × 4): the name slides past it, so its last letters rest clear.
const FADE = 16;

// A name too long for its room slides along to show the rest of itself, rests, and slides back, as a
// long title does in Apple's lists; one that fits stays still. Under reduced motion it wraps onto
// another line instead, so the whole name still shows.
export function Marquee({ children, className }: { children: ReactNode; className?: string }) {
  const box = useRef<HTMLSpanElement>(null);
  const text = useRef<HTMLSpanElement>(null);
  const still = useMediaQuery(REDUCED_MOTION);
  const [over, setOver] = useState(0);
  useLayoutEffect(() => {
    const outer = box.current;
    const inner = text.current;
    if (!outer || !inner) return;
    const measure = () => setOver(Math.max(0, Math.ceil(inner.offsetWidth - outer.clientWidth)));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(outer);
    observer.observe(inner);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const inner = text.current;
    if (still || over < 2 || !inner || typeof inner.animate !== "function") return;
    const far = over + FADE;
    const slide = (far / SPEED) * 1000;
    const total = 2 * (REST_MS + slide);
    const at = (ms: number) => ms / total;
    const animation = inner.animate(
      [
        { transform: "translateX(0)", offset: 0 },
        { transform: "translateX(0)", offset: at(REST_MS), easing: "ease-in-out" },
        { transform: `translateX(${-far}px)`, offset: at(REST_MS + slide) },
        {
          transform: `translateX(${-far}px)`,
          offset: at(2 * REST_MS + slide),
          easing: "ease-in-out",
        },
        { transform: "translateX(0)", offset: 1 },
      ],
      { duration: total, iterations: Number.POSITIVE_INFINITY },
    );
    return () => animation.cancel();
  }, [still, over]);
  return (
    <span
      ref={box}
      className={clsx("ui-marquee", className)}
      data-over={(!still && over >= 2) || undefined}
      data-wrap={still || undefined}
    >
      <span ref={text} className="ui-marquee-text">
        {children}
      </span>
    </span>
  );
}
