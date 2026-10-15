import type { Wearable } from "@localdot/protocol";

// What the user's dot wears, which every live dot shows unless it is told otherwise (a picker's
// preview of another dot).
let worn: readonly Wearable[] = [];
const listeners = new Set<() => void>();

export function wearing(): readonly Wearable[] {
  return worn;
}

export function setWearing(next: readonly Wearable[]): void {
  if (next.join(" ") === worn.join(" ")) return;
  worn = next;
  for (const listener of listeners) listener();
}

export function onWearing(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
