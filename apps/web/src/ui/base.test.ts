import { readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { readSource } from "../testing/read-source.ts";
import { cssBlocks } from "../testing/tokens.ts";

const SRC = new URL("../", import.meta.url);
const baseCss = await readSource(new URL("./base.css", import.meta.url));
const stylesheets = (await readdir(SRC, { recursive: true }))
  .filter((path) => path.endsWith(".css") && !path.includes("_spike") && !path.startsWith("ui/"))
  .sort();

describe("base layer", () => {
  // The reset drops the browser's bold, so a rule that sizes a heading has to weight it too.
  it("gives every sized heading an explicit weight", async () => {
    const unweighted: string[] = [];
    for (const path of stylesheets) {
      for (const { selector, body } of cssBlocks(await readSource(new URL(path, SRC)))) {
        if (!/(^|[\s,>+~])h[1-6]\b/.test(selector) || !/font-size\s*:/.test(body)) continue;
        if (!/font-weight\s*:/.test(body))
          unweighted.push(`${path} ${selector.replace(/\s+/g, " ")}`);
      }
    }
    expect(stylesheets).toContain("agent/usage.css");
    expect(unweighted).toEqual([]);
  });

  it("stops every base transition that moves something when the viewer asks for less motion", () => {
    const blocks = cssBlocks(baseCss);
    const moving = blocks
      .filter(
        ({ media, body }) => !media.length && /transition\s*:\s*(?!opacity\b|none\b)\w/.test(body),
      )
      .map(({ selector }) => selector);
    const still = blocks
      .filter(
        ({ media, body }) =>
          media.some((m) => m.includes("prefers-reduced-motion: reduce")) &&
          /transition\s*:\s*none/.test(body),
      )
      .flatMap(({ selector }) => selector.split(",").map((s) => s.trim()));
    expect(moving).toContain("summary::before");
    expect(moving.filter((selector) => !still.includes(selector))).toEqual([]);
  });
});
