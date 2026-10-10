import { expect, it } from "vitest";
import { readSource } from "../testing/read-source.ts";

const css = await readSource(new URL("./stage-frame.css", import.meta.url));
const app = await readSource(new URL("../app.css", import.meta.url));
const rule = (selector: string) =>
  new RegExp(`${selector.replace(/[.[\]()]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";

it("lets a long narration wrap anywhere instead of spilling out of the band", () => {
  expect(rule(".narration-line")).toMatch(/overflow-wrap:\s*anywhere;/);
});

it("gives dot's line the band's whole width beside dot, up to the stage's right edge", () => {
  expect(rule(".narration")).toMatch(/width:\s*calc\(100% - var\(--line-x\)\);/);
  expect(rule(".stage-band:has(.control-strip) .narration")).toMatch(
    /width:\s*calc\(100% - var\(--line-x\) - var\(--control-strip-w\)/,
  );
  expect(rule(".narration-line")).toMatch(/line-clamp:\s*2;/);
});

it("keeps the rim mounted and lights it by opacity alone", () => {
  expect(css).toMatch(
    /\.stage-spill > i,\s*\.stage-rim > i \{[^}]*opacity: 0;[^}]*transition: opacity/,
  );
});

it("animates the picture and the veil with tokens that exist", () => {
  expect(app).not.toMatch(/var\(--duration-|var\(--ease-(?:veil|lit)\)/);
});
