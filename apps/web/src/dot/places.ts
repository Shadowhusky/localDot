// The boxes dot can sit in, and the stage it looks at, as their elements register.
export type PlaceName = "hero" | "dock" | "badge" | "stage";

const places = new Map<PlaceName, HTMLElement>();
const listeners = new Set<() => void>();

export function placeElement(name: PlaceName): HTMLElement | null {
  return places.get(name) ?? null;
}

// A ref callback for a place's element.
export function registerPlace(name: PlaceName, element: HTMLElement): () => void {
  places.set(name, element);
  for (const listener of listeners) listener();
  return () => {
    if (places.get(name) !== element) return;
    places.delete(name);
    for (const listener of listeners) listener();
  };
}

export function onPlaces(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
