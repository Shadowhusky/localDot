import { describe, expect, it } from "vitest";
import { ulid } from "./ids.ts";
import { PERSONAS, type PersonaId, Wearable } from "./personas.ts";
import { LookWearables, taskOutfit, WEAR_SLOT, WEAR_SLOTS } from "./task-look.ts";

// Tasks as a list holds them: ids made one after another, so they share their time's first letters.
const neighbours = (count: number) => Array.from({ length: count }, () => ulid());

describe("a task's look", () => {
  it("has a place for everything a dot can wear", () => {
    for (const name of Wearable.options) expect(WEAR_SLOTS).toContain(WEAR_SLOT[name]);
  });

  it("is the same every time for the same task", () => {
    for (const seed of neighbours(50))
      expect(taskOutfit(seed, "coder")).toEqual(taskOutfit(seed, "coder"));
  });

  it("wears at most one thing in each place, and always something", () => {
    for (const seed of neighbours(500))
      for (const persona of [undefined, ...Object.keys(PERSONAS)] as (PersonaId | undefined)[]) {
        const look = taskOutfit(seed, persona);
        expect(look.length).toBeGreaterThan(0);
        expect(LookWearables.safeParse(look).success).toBe(true);
      }
  });

  it("shows what its dot is known by, and only that dot's tasks wear it", () => {
    const known = Object.values(PERSONAS).flatMap((persona) => persona.wearables.slice(0, 1));
    for (const persona of Object.values(PERSONAS)) {
      for (const seed of neighbours(200)) {
        const look = taskOutfit(seed, persona.id);
        const signature = persona.wearables[0];
        if (signature) expect(look).toContain(signature);
        expect(look.filter((name) => known.includes(name) && name !== signature)).toEqual([]);
      }
    }
  });

  it("rarely looks like the task next to it", () => {
    for (const persona of [undefined, "coder", "research", "design"] as const) {
      const looks = neighbours(4000).map((seed) => taskOutfit(seed, persona));
      let same = 0;
      for (let at = 1; at < looks.length; at++)
        if (looks[at]?.join() === looks[at - 1]?.join()) same += 1;
      expect(same / looks.length, persona).toBeLessThan(0.03);
      expect(new Set(looks.map((look) => look.join())).size, persona).toBeGreaterThan(60);
    }
  });

  it("refuses two things in one place", () => {
    expect(LookWearables.safeParse(["cap", "crown"]).success).toBe(false);
    expect(LookWearables.safeParse(["cap", "monocle", "lei"]).success).toBe(true);
  });
});
