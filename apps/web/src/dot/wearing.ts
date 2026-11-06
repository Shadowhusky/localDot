import { type Accessory, outfit, type PersonaId, type Wearable } from "@localdot/protocol";
import { useSyncExternalStore } from "react";
import { rememberedOwnDot, rememberOwnDot } from "./arrival.ts";

// What the user's dot wears, which every live dot shows unless it is told otherwise (a picker's
// preview of another dot), and this localDot's accessory, which any dot shown for it wears too.
// Until settings are read, as it was on the last visit.
let { worn, accessory } = rememberedOwnDot();
let known = false;
const listeners = new Set<(arrival: boolean) => void>();

export function wearing(): readonly Wearable[] {
  return worn;
}

export function setWearing(next: readonly Wearable[], nextAccessory?: Accessory): void {
  const arrival = !known;
  known = true;
  if (next.join(" ") === worn.join(" ") && nextAccessory === accessory) return;
  worn = next;
  accessory = nextAccessory;
  rememberOwnDot(worn, accessory);
  for (const listener of listeners) listener(arrival);
}

// Told of each change, and whether it is what the dot wears arriving rather than a change to see.
export function onWearing(listener: (arrival: boolean) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Another dot as this localDot shows it: that dot's outfit with this localDot's accessory.
export function useOutfit(persona: PersonaId): Wearable[];
export function useOutfit(persona: PersonaId | undefined): Wearable[] | undefined;
export function useOutfit(persona: PersonaId | undefined): Wearable[] | undefined {
  const shown = useSyncExternalStore(onWearing, () => accessory);
  return persona && outfit(persona, shown);
}
