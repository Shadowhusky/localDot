import { expect, it } from "vitest";
import { readSource } from "../testing/read-source.ts";
import { cssBlocks } from "../testing/tokens.ts";

const blocks = cssBlocks(await readSource(new URL("./settings.css", import.meta.url)));
const body = (selector: string) => blocks.find((block) => block.selector === selector)?.body ?? "";

it("keeps a fixed choice's mode on one line beside a label that wraps", () => {
  expect(body(".settings-locked-mode")).toMatch(/white-space:\s*nowrap;/);
  expect(body(".settings-locked-mode")).toMatch(/flex:\s*none;/);
});
