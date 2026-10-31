import { type Accessory, outfit, type PersonaId, type Wearable } from "@localdot/protocol";
import { useSyncExternalStore } from "react";

// What the user's dot wears, which every live dot shows unless it is told otherwise (a picker's
// preview of another dot), and this localDot's accessory, which any dot shown for it wears too.
let worn: readonly Wearable[] = [];
let accessory: Accessory | undefined;
const listeners = new Set<() => void>();

export function wearing(): readonly Wearable[] {
  return worn;
}

export function setWearing(next: readonly Wearable[], nextAccessory?: Accessory): void {
  if (next.join(" ") === worn.join(" ") && nextAccessory === accessory) return;
  worn = next;
  accessory = nextAccessory;
  for (const listener of listeners) listener();
}

export function onWearing(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Another dot as this localDot shows it: that dot's outfit with this localDot's accessory.
export function useOutfit(persona: PersonaId): Wearable[] {
  const shown = useSyncExternalStore(onWearing, () => accessory);
  return outfit(persona, shown);
}
