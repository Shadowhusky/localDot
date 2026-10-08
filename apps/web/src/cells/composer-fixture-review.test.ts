import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { CellSummarySchema, parseCells } from "./parse.ts";

// Evaluate only the inert data declarations from the frozen acceptance fixture,
// stopping before its first I/O. No browser, server, module imports or route work runs.
function sample(activeComposer: boolean) {
  const text = readFileSync(new URL("../../e2e/agent-layout.spec.ts", import.meta.url), "utf8");
  const cell = text.match(/^const CELL = "[^"]+";/m)?.[0];
  const paused = text.match(/^const pausedCell = \{[\s\S]*?^\};/m)?.[0];
  const data = text.match(
    /async function load\(page: Page, activeComposer = false\) \{([\s\S]*?)\n {2}if \(activeComposer\)/,
  )?.[1];
  if (!cell || !paused || !data || /await|fetch|request/.test(data))
    throw new Error("Acceptance fixture data declarations changed");
  const code = `const activeComposer = ${activeComposer};\n${cell}\n${paused}\n${data}\nJSON.stringify(shownCell);`;
  return JSON.parse(runInNewContext(code, {}, { timeout: 50 }) as string) as unknown;
}

describe("whole-browser composer fixture uses the current strict cell wire", () => {
  it("the existing paused layout is a valid positive control", () => {
    expect(CellSummarySchema.safeParse(sample(false)).success).toBe(true);
  });
  it("the active composer fixture is admitted by the production parser", () => {
    expect(CellSummarySchema.safeParse(sample(true)).success).toBe(true);
  });
  it("omitting the false paused member admits active state without weakening the schema", () => {
    const { paused: _paused, ...active } = sample(true) as Record<string, unknown>;
    expect(parseCells([active])).toHaveLength(1);
    expect(active).not.toHaveProperty("paused");
  });
});
