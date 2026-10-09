import { expect, it } from "vitest";
import { readSource } from "../testing/read-source.ts";
import { cssBlocks } from "../testing/tokens.ts";

const blocks = cssBlocks(await readSource(new URL("./feedback.css", import.meta.url)));

it("never draws amber as a rim or a face: attention reads from the words", () => {
  const amber = blocks.filter(
    ({ selector, body }) =>
      selector.includes('[data-tone="attention"]') && body.includes("--color-attention"),
  );
  expect(amber.map(({ selector }) => selector)).toEqual([]);
});

it("keeps a toast's details from widening it, so opening them only grows it downwards", () => {
  const details = blocks.find(({ selector }) => selector === ".ui-toast-details");
  expect(details?.body).toMatch(/contain:\s*inline-size;/);
});
