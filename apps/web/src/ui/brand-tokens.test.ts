import { BRAND_TOKENS } from "@localdot/protocol";
import { expect, it } from "vitest";
import { readSource } from "../testing/read-source.ts";
import { readTokens } from "../testing/tokens.ts";

const tokensCss = await readSource(new URL("./tokens.css", import.meta.url));
const dotCss = await readSource(new URL("../dot/dot.css", import.meta.url));

it("gives the installer page the app's own tokens", () => {
  const tokens = readTokens([tokensCss, dotCss]);
  for (const [name, value] of Object.entries(BRAND_TOKENS)) {
    expect(tokens.get(`--${name}`), name).toBe(value);
  }
});
