import { expect, it } from "vitest";
import { readSource } from "../testing/read-source.ts";

const structure = await readSource(new URL("../ui/structure.css", import.meta.url));

it("keys dot's xenon arc on the page, so a phone's Activity sheet outside the app takes it too", () => {
  expect(structure).toMatch(
    /:where\(:root:has\(\.app\.control\)\) \.ui-status-glyph\[data-state="doing"\] \{\s*color: var\(--color-xenon\);/,
  );
});
