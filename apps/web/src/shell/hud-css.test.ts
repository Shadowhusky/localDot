import { expect, it } from "vitest";
import { readSource } from "../testing/read-source.ts";

const hud = await readSource(new URL("./hud.css", import.meta.url));
const tokens = await readSource(new URL("../ui/tokens.css", import.meta.url));
const overlays = await readSource(new URL("../ui/overlays.css", import.meta.url));
const app = await readSource(new URL("../app.css", import.meta.url));
const frame = await readSource(new URL("./stage-frame.css", import.meta.url));

const px = (block: string, name: string) =>
  Number(new RegExp(`${name}: (\\d+)px;`).exec(block)?.[1]);
// The innermost rules, as [selector, declarations].
const rules = (css: string) =>
  [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{};]+)\{([^{}]*)\}/g)].map(
    ([, selector, body]) => [(selector ?? "").trim(), body ?? ""],
  );
const phoneTokens = /@media \(width < 700px\)[^{]*\{\s*:root \{([^}]*)\}/.exec(tokens)?.[1] ?? "";

it("lifts the island over a sheet's scrim, so Stop and Take control stay in reach", () => {
  expect(hud).toMatch(/\.island-anchor\[data-lifted\] \{\s*z-index: var\(--layer-island-lifted\);/);
  const lifted = Number(/--layer-island-lifted: (\d+);/.exec(tokens)?.[1]);
  const layer = Number(/\.ui-layer \{[^}]*z-index: (\d+);/.exec(overlays)?.[1]);
  expect(layer).toBeGreaterThan(0);
  expect(lifted).toBeGreaterThan(layer);
});

it("hangs the island its height and a gap over the stage, clear of the picture", () => {
  expect(hud).toMatch(
    /\.island-anchor \{[^}]*top: calc\(var\(--_lower, 0px\) - var\(--island-h\) - var\(--_island-gap\)\);/,
  );
  expect(px(tokens, "--island-gap")).toBeGreaterThan(0);
  expect(frame).toMatch(/\.app \{\s*--_island-gap: var\(--island-gap\);\s*\}/);
});

it("keeps the island in one place whatever the state: nothing moves it onto the picture", () => {
  const moved = rules(hud).filter(
    ([selector, body]) =>
      selector?.includes(".island-anchor") &&
      selector !== ".island-anchor" &&
      /(^|[\s;])(top|translate|inset):/.test(body ?? ""),
  );
  expect(moved).toEqual([]);
});

it("keeps a strip for the island over the stage, under the top bar or the phone's safe area", () => {
  const strip = (block: string) => px(block, "--island-h") + px(tokens, "--island-gap");
  expect(px(tokens, "--stage-top") - px(tokens, "--bar-h")).toBeGreaterThan(strip(tokens));
  expect(px(phoneTokens, "--stage-top")).toBeGreaterThan(strip(phoneTokens));
  expect(app).toMatch(
    /\.stage-col \{[^}]*padding: calc\(var\(--stage-top\) \+ env\(safe-area-inset-top\)\) 8px 0;/,
  );
  expect(app).toMatch(/\.app\[data-focus\] \.stage-col \{\s*padding: var\(--stage-top\) 0 8px;/);
  expect(app).toMatch(/width: calc\(\(100dvh - var\(--stage-top\) - 8px\) \* 1\.6\);/);
});

it("gives a full screen stage the screen under the island's strip", () => {
  expect(frame).toMatch(
    /\.app\[data-full\] \.stage-col \{[^}]*--_strip: calc\([^;]*var\(--island-h\) \+ var\(--_island-gap\)\);[^}]*padding: var\(--_strip\) 0 calc\(var\(--spacing\) \* 16\);/,
  );
  expect(frame).toMatch(/width: min\(100vw, \(100dvh - var\(--_strip\) - 64px\) \* 1\.6\);/);
});

it("keeps full screen's manual controls in the reserved row outside the picture", () => {
  expect(frame).toMatch(
    /\.app\[data-full\] \.control-strip \{[^}]*position: static;[^}]*translate: none;/,
  );
  expect(frame).toMatch(
    /\.app\[data-full\] \.stage-col \{[^}]*padding: var\(--_strip\) 0 calc\(var\(--spacing\) \* 16\);/,
  );
});

it("keeps full screen's faded controls under the pointer, so a tap on one lands on it", () => {
  const faded = [...rules(hud), ...rules(frame)].filter(([selector]) =>
    selector?.includes(".app[data-full][data-still]"),
  );
  expect(faded.length).toBeGreaterThan(0);
  expect(faded.filter(([, body]) => /pointer-events:\s*none/.test(body ?? ""))).toEqual([]);
});
