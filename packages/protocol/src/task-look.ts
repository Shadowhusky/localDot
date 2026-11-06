import { z } from "zod";
import { PERSONAS, type PersonaId, Wearable } from "./personas.ts";

// A task's look: one thing on the head, one on the face and one on the body.
export type WearSlot = "head" | "face" | "body";

export const WEAR_SLOT: Readonly<Record<Wearable, WearSlot>> = {
  cap: "head",
  beret: "head",
  mortarboard: "head",
  headphones: "head",
  bow: "head",
  beanie: "head",
  "party-hat": "head",
  crown: "head",
  "wizard-hat": "head",
  "top-hat": "head",
  "chef-hat": "head",
  "hard-hat": "head",
  sprout: "head",
  "flower-crown": "head",
  antenna: "head",
  "cat-ears": "head",
  halo: "head",
  "viking-helmet": "head",
  "cowboy-hat": "head",
  "propeller-cap": "head",
  headband: "head",
  sunglasses: "face",
  "round-glasses": "face",
  mustache: "face",
  monocle: "face",
  "heart-glasses": "face",
  "clown-nose": "face",
  blush: "face",
  hoodie: "body",
  suit: "body",
  scarf: "body",
  "star-pin": "body",
  "bow-tie": "body",
  medal: "body",
  pearls: "body",
  "striped-tee": "body",
  overalls: "body",
  lei: "body",
};

export const WEAR_SLOTS: readonly WearSlot[] = ["head", "face", "body"];

export const LookWearables = z
  .array(Wearable)
  .max(WEAR_SLOTS.length)
  .refine(
    (list) => new Set(list.map((name) => WEAR_SLOT[name])).size === list.length,
    "One thing for each place",
  );
export type LookWearables = z.infer<typeof LookWearables>;

// What a dot's kind of work is known by: the first thing it wears. Only that dot's tasks wear it, so
// a hoodie in the list always means code.
const SIGNATURES: Partial<Record<PersonaId, Wearable>> = Object.fromEntries(
  Object.values(PERSONAS).flatMap((persona) =>
    persona.wearables[0] ? [[persona.id, persona.wearables[0]]] : [],
  ),
);
const SIGNATURE_SET: ReadonlySet<Wearable> = new Set(Object.values(SIGNATURES));
const poolFor = (slot: WearSlot) =>
  Wearable.options.filter((name) => WEAR_SLOT[name] === slot && !SIGNATURE_SET.has(name));
const POOLS: Readonly<Record<WearSlot, readonly Wearable[]>> = {
  head: poolFor("head"),
  face: poolFor("face"),
  body: poolFor("body"),
};

// A number in [0, 1) from the seed and a salt, spread by every character: task ids that begin alike
// land far apart. FNV-1a with a final mix.
export function seedDraw(seed: string, salt: string): number {
  let h = 0x811c9dc5;
  for (const text of [seed, salt])
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 2 ** 32;
}

// How often a task wears something in a place its dot leaves free. Everything wears something on its
// head; a dot's own tasks, which share what it is known by, are told apart by more of the rest.
const WEARS: Readonly<Record<WearSlot, number>> = { head: 1, face: 0.5, body: 0.6 };
const WEARS_WITH_DOT = 0.75;

// The look a task gets when it starts: what its dot is known by, where it has one, and then a draw
// from the task itself for each place left, the same every time and on every device.
export function taskOutfit(seed: string, persona?: PersonaId): Wearable[] {
  const signature = persona && SIGNATURES[persona];
  const out: Wearable[] = signature ? [signature] : [];
  for (const slot of WEAR_SLOTS) {
    if (signature && WEAR_SLOT[signature] === slot) continue;
    if (seedDraw(seed, `${slot}?`) >= Math.max(WEARS[slot], signature ? WEARS_WITH_DOT : 0))
      continue;
    const pool = POOLS[slot];
    const pick = pool[Math.floor(seedDraw(seed, slot) * pool.length)];
    if (pick) out.push(pick);
  }
  return out;
}
