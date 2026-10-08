import { readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { readSource } from "../testing/read-source.ts";
import { cssBlocks } from "../testing/tokens.ts";

const SRC = new URL("../", import.meta.url);
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
});
