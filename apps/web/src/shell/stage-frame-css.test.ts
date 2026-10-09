import { expect, it } from "vitest";
import { readSource } from "../testing/read-source.ts";

const css = await readSource(new URL("./stage-frame.css", import.meta.url));
const app = await readSource(new URL("../app.css", import.meta.url));
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

it("gives a phone's curtain words the width, so its button is never cut off", () => {
  expect(css).toMatch(
    /\.curtain-col \{[^}]*max-width: min\(calc\(100% - var\(--spacing\) \* 12\), 320px\);/,
  );
});

it("keeps the last picture while reconnecting, under a chip rather than a full veil", () => {
  expect(app).toMatch(/\.stage-veil:not\(\[role="alert"\]\) \{\s*background-color: transparent;/);
  expect(app).not.toMatch(/var\(--duration-|var\(--ease-(?:veil|lit)\)/);
});
