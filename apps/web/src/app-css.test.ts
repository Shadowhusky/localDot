import { expect, it } from "vitest";
import { readSource } from "./testing/read-source.ts";
import { cssBlocks } from "./testing/tokens.ts";

const blocks = cssBlocks(await readSource(new URL("./app.css", import.meta.url)));
const body = (selector: string) => blocks.find((block) => block.selector === selector)?.body ?? "";

it("never lets the page itself scroll, so focus moving into a popover can't shift it", () => {
  expect(body(".app")).toMatch(/overflow:\s*clip;/);
});
