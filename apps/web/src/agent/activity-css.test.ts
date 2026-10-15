import { expect, it } from "vitest";
import { readSource } from "../testing/read-source.ts";

const structure = await readSource(new URL("../ui/structure.css", import.meta.url));
const activity = await readSource(new URL("./activity.css", import.meta.url));

it("keys dot's xenon arc on the page, so a phone's Activity sheet outside the app takes it too", () => {
  expect(structure).toMatch(
    /:where\(:root:has\(\.app\.control\)\) \.ui-status-glyph\[data-state="doing"\] \{\s*color: var\(--color-xenon\);/,
  );
});

it("shows every word of a step that has nothing to unfold, with its time where the others' are", () => {
  expect(activity).toMatch(
    /\.activity-row\[data-open\] :is\(\.activity-row-title, \.activity-row-meta\),\s*\.activity-timeline div\.activity-row-head :is\(\.activity-row-title, \.activity-row-meta\) \{\s*display: block;/,
  );
  expect(activity).toMatch(
    /\.activity-timeline div\.activity-row-head \.activity-row-time \{\s*margin-inline-end: calc\(var\(--spacing\) \* 5\);/,
  );
});
