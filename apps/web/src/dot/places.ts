// The boxes dot can sit in, and the stage it looks at, as their elements register.
export type PlaceName = "hero" | "dock" | "badge" | "intro" | "stage";

// Replay keeps Watch mounted under it, so a name can have two boxes: the latest one is dot's, and
// the one under it is dot's again once the latest goes.
const places = new Map<PlaceName, HTMLElement[]>();
const listeners = new Set<() => void>();

export function placeElement(name: PlaceName): HTMLElement | null {
  return places.get(name)?.at(-1) ?? null;
}

// A ref callback for a place's element.
export function registerPlace(name: PlaceName, element: HTMLElement): () => void {
  places.set(name, [...(places.get(name) ?? []).filter((held) => held !== element), element]);
  for (const listener of listeners) listener();
  return () => {
    const held = places.get(name) ?? [];
    if (!held.includes(element)) return;
    const rest = held.filter((other) => other !== element);
    if (rest.length) places.set(name, rest);
    else places.delete(name);
    for (const listener of listeners) listener();
  };
}

// A place moved without a resize or a transition of its own, as when the stage travels to full screen.
export function placesMoved(): void {
  for (const listener of listeners) listener();
}

export function onPlaces(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
