import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { KeydClient } from "../../keyd/client.ts";
import { startKeyd, TEST_KEYD_PORTS } from "../../keyd/testing/keyd-process.ts";
import { evalCellOptions, removeEvalContainers } from "./cell.ts";
import { keydModelMode, modelModeConfig } from "./model-mode.ts";
import { runSuite } from "./suite.ts";

// Opt-in only: LOCALDOT_EVAL_MODEL=<client>:<model> and LOCALDOT_EVAL_SPEND_CAP_USD, plus the
// desktop (LOCALDOT_DOCKER_TESTS=1). keyd meters every model call against the cap. The report is
// the result; a model that fails tasks does not fail this run.
const env = (name: string) => process.env[name];
const selected = Boolean(env("LOCALDOT_EVAL_MODEL"));

describe.skipIf(!selected)("desktop tasks with a real model (spend-capped)", () => {
  it("runs the suite under keyd's budget and writes the report", async () => {
    const config = modelModeConfig(env);
    if (!config) return;
    if (env("LOCALDOT_DOCKER_TESTS") !== "1")
      throw new Error("model mode drives a real desktop: set LOCALDOT_DOCKER_TESTS=1");
    const cell = evalCellOptions();
    const keyd = await startKeyd();
    try {
      const outDir =
        env("LOCALDOT_EVAL_OUT") || mkdtempSync(join(tmpdir(), "localdot-eval-model-"));
      const report = await runSuite({
        outDir,
        cell,
        only: env("LOCALDOT_EVAL_TASKS")?.split(",").filter(Boolean),
        model: keydModelMode(config, new KeydClient(keyd.socketPath), TEST_KEYD_PORTS.from, env),
        log: (line) => console.log(line),
      });
      console.log(`eval report: ${join(outDir, "report.md")}`);
      expect(report.tasks.reduce((sum, t) => sum + t.costUSD, 0)).toBeLessThanOrEqual(
        config.capUSD,
      );
    } finally {
      removeEvalContainers(cell);
      await keyd.stop();
    }
  });
});
