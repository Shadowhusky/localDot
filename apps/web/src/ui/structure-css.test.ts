import { expect, it } from "vitest";
import { readSource } from "../testing/read-source.ts";
import { cssBlocks } from "../testing/tokens.ts";

const blocks = cssBlocks(await readSource(new URL("./structure.css", import.meta.url)));
const body = (selector: string) => blocks.find((block) => block.selector === selector)?.body ?? "";

it("keeps a row's detail in its column, so a long one never runs under the trailing control", () => {
  expect(body(".ui-group-row-detail")).toMatch(/min-width:\s*0;/);
});

it("keeps a row's title to one line and its second line to two, whatever their length", () => {
  const title = blocks.find(
    (block) => block.media.length === 0 && block.selector.startsWith(".ui-group-row-label,"),
  )?.body;
  expect(title).toMatch(/white-space:\s*nowrap;/);
  expect(title).toMatch(/text-overflow:\s*ellipsis;/);
  const detail = blocks.find((block) =>
    block.selector.startsWith(":is(.ui-group-row-detail, .ui-group-row .ui-choice-note)"),
  )?.body;
  expect(detail).toMatch(/-webkit-line-clamp:\s*2;/);
  expect(body(".ui-group-row-trailing")).toMatch(/white-space:\s*nowrap;/);
});

it("draws an inline disclosure as a quiet line of text, not a full-width row", () => {
  expect(body(".ui-disclosure[data-inline] > .ui-disclosure-trigger")).toMatch(/width:\s*auto;/);
});
