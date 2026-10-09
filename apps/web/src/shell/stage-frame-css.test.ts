import { expect, it } from "vitest";
import { readSource } from "../testing/read-source.ts";

const css = await readSource(new URL("./stage-frame.css", import.meta.url));
const rule = (selector: string) =>
  new RegExp(`${selector.replace(/[.[\]]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";

it("lets a long narration wrap anywhere instead of spilling out of the band", () => {
  expect(rule(".narration-line")).toMatch(/overflow-wrap:\s*anywhere;/);
});

it("keeps the rim mounted and lights it by opacity alone", () => {
  expect(css).toMatch(
    /\.stage-spill > i,\s*\.stage-rim > i \{[^}]*opacity: 0;[^}]*transition: opacity/,
  );
});
