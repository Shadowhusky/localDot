import type { PersonaId, Wearable } from "@localdot/protocol";

// Which dot the Dots chapter shows at its progress `c`: the everyday dot until the first stretch,
// then each in `order` for an equal share of [from, to].
export function roleAt(
  c: number,
  order: readonly PersonaId[],
  from: number,
  to: number,
): PersonaId {
  const step = (to - from) / order.length;
  let index = -1;
  for (let i = 0; i < order.length; i++) if (c >= from + i * step) index = i;
  return index < 0 ? "everyday" : (order[index] as PersonaId);
}

// Open source: dot pins a star on beside the GitHub link.
export function pinned(worn: readonly Wearable[]): Wearable[] {
  return worn.includes("star-pin") ? [...worn] : [...worn, "star-pin"];
}
