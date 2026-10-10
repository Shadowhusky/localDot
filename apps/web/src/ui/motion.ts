// A --dur-* token in milliseconds. The built stylesheet writes durations in their shortest form
// (340ms becomes .34s), so the unit is read rather than assumed.
export function tokenMs(style: CSSStyleDeclaration, name: string, fallback: number): number {
  const value = style.getPropertyValue(name).trim();
  const number = Number.parseFloat(value);
  if (!Number.isFinite(number)) return fallback;
  return value.endsWith("ms") ? number : value.endsWith("s") ? number * 1000 : fallback;
}

// Reveal content without changing its scrollable overflow or its visual position.
// A newer arrival takes over from the previous reveal.
export function fadeIn(element: HTMLElement): void {
  if (typeof element.animate !== "function") return;
  for (const motion of element.getAnimations()) motion.cancel();
  const style = getComputedStyle(element);
  element.animate([{ opacity: 0 }, { opacity: 1 }], {
    duration: tokenMs(style, "--dur-fade", 150),
    easing: "ease-out",
  });
}
