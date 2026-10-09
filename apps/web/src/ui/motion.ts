import { matches, REDUCED_MOTION } from "./media.ts";

// A --dur-* token in milliseconds. The built stylesheet writes durations in their shortest form
// (340ms becomes .34s), so the unit is read rather than assumed.
export function tokenMs(style: CSSStyleDeclaration, name: string, fallback: number): number {
  const value = style.getPropertyValue(name).trim();
  const number = Number.parseFloat(value);
  if (!Number.isFinite(number)) return fallback;
  return value.endsWith("ms") ? number : value.endsWith("s") ? number * 1000 : fallback;
}

// New content arriving in place: it fades in while rising the last few pixels on the snappy spring.
// A newer arrival takes over from the one still moving; under reduced motion it only fades.
export function riseIn(element: HTMLElement, rise = 8): void {
  if (typeof element.animate !== "function") return;
  for (const motion of element.getAnimations()) motion.cancel();
  const style = getComputedStyle(element);
  const reduced = matches(REDUCED_MOTION);
  const frames = reduced
    ? [{ opacity: 0 }, { opacity: 1 }]
    : [
        { opacity: 0, transform: `translateY(${rise}px)` },
        { opacity: 1, transform: "none" },
      ];
  const duration = reduced
    ? tokenMs(style, "--dur-fade", 150)
    : tokenMs(style, "--dur-snappy", 340);
  try {
    element.animate(frames, {
      duration,
      easing: style.getPropertyValue("--ease-spring").trim() || "ease-out",
    });
  } catch {
    element.animate(frames, { duration, easing: "ease-out" });
  }
}
