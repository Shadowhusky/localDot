import { describe, expect, it } from "vitest";
import { ROLE_ORDER } from "./content.ts";
import { layout } from "./director.ts";
import { placeAt, places } from "./places.ts";

const CHAPTERS = layout([
  ["out", 2],
  ["watch", 3],
  ["dots", 4],
]);

const page = () => {
  document.body.innerHTML = `
    <section data-chapter="out"><div class="beat" data-place="hello" data-span="0.6 1.1"></div></section>
    <section data-chapter="watch">
      <div class="beat" data-place="watch" data-span="0.1 0.4"></div>
      <div class="beat" data-place="step-in" data-span="0.4 0.7"></div>
    </section>
    <section data-chapter="dots"><div class="beat" data-place="pick" data-span="0.8 1"></div></section>`;
  return places(document, CHAPTERS);
};

describe("the places the address names", () => {
  it("names every beat and each dot, in story order", () => {
    expect(page().map((p) => p.name)).toEqual(["hello", "watch", "step-in", ...ROLE_ORDER, "pick"]);
  });

  it("opens each where its words show whole: the middle of its stretch", () => {
    const step = page().find((p) => p.name === "step-in");
    expect(step?.from).toBeCloseTo(2 + 0.4 * 3);
    expect(step?.at).toBeCloseTo(2 + 0.55 * 3);
    // A beat running on past its chapter still opens inside the chapter.
    expect(page()[0]?.at).toBeCloseTo(0.85 * 2);
  });

  it("is at the last place begun, and at none before the first", () => {
    const list = page();
    expect(placeAt(list, 0.5)).toBeNull();
    expect(placeAt(list, 1.3)?.name).toBe("hello");
    expect(placeAt(list, 2 + 0.5 * 3)?.name).toBe("step-in");
  });
});
