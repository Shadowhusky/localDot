import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { evalCellOptions, removeLabelled } from "./cell.ts";
import { runSuite } from "./suite.ts";

// Needs Docker and the desktop image. Every container is created for this run, carries the eval
// label, and is removed by that label alone: LOCALDOT_DOCKER_TESTS=1 pnpm test:eval.
const enabled = process.env.LOCALDOT_DOCKER_TESTS === "1" && !process.env.LOCALDOT_EVAL_MODEL;

describe.skipIf(!enabled)("desktop tasks through the whole agent stack (oracle mode)", () => {
  const cell = enabled ? evalCellOptions() : undefined;
  beforeAll(() => {
    if (cell) removeLabelled(cell.label);
  });
  afterAll(() => {
    if (cell) removeLabelled(cell.label);
  });

  it("passes every task whose capabilities have landed and writes the report", async () => {
    if (!cell) return;
    const outDir = process.env.LOCALDOT_EVAL_OUT || mkdtempSync(join(tmpdir(), "localdot-eval-"));
    const report = await runSuite({
      outDir,
      cell,
      only: process.env.LOCALDOT_EVAL_TASKS?.split(",").filter(Boolean),
      log: (line) => console.log(line),
    });
    console.log(`eval report: ${join(outDir, "report.md")}`);
    expect(report.problems).toEqual([]);
  });
});
