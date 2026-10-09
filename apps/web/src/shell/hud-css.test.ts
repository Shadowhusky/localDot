import { expect, it } from "vitest";
import { readSource } from "../testing/read-source.ts";

const hud = await readSource(new URL("./hud.css", import.meta.url));
const tokens = await readSource(new URL("../ui/tokens.css", import.meta.url));
const overlays = await readSource(new URL("../ui/overlays.css", import.meta.url));

it("lifts the island over a sheet's scrim, so Stop and Take control stay in reach", () => {
  expect(hud).toMatch(/\.island-anchor\[data-lifted\] \{\s*z-index: var\(--layer-island-lifted\);/);
  const lifted = Number(/--layer-island-lifted: (\d+);/.exec(tokens)?.[1]);
  const layer = Number(/\.ui-layer \{[^}]*z-index: (\d+);/.exec(overlays)?.[1]);
  expect(layer).toBeGreaterThan(0);
  expect(lifted).toBeGreaterThan(layer);
});
