import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AgentLimits, ModelBinding } from "@localdot/protocol";
import sharp from "sharp";
import { analyseEvents } from "./analyse.ts";
import {
  type EvalCell,
  type EvalCellOptions,
  removeEvalContainers,
  startEvalCell,
} from "./cell.ts";
import type { Verdict } from "./checks.ts";
import { type DesktopFacts, oracleModel } from "./oracle.ts";
import {
  type EvalReport,
  markdownReport,
  type Prices,
  suiteReport,
  type TaskReport,
  taskReport,
} from "./report.ts";
import { type AgentRun, type ModelUnderTest, runAgent } from "./stack.ts";
import { capabilityLanded, type EvalTask, noopPolicy, TASKS } from "./tasks.ts";

export const ORACLE_BINDING = ModelBinding.parse({
  route: "oracle",
  client: "openai-compatible",
  model: "oracle",
  computer: "generic",
  coords: "pixels",
  vision: true,
  reasoning: false,
  contextTokens: 200_000,
  maxOutputTokens: 4096,
});

export interface ModelSession {
  under: ModelUnderTest;
  end(): Promise<void>;
}

export interface ModelMode {
  label: string;
  prices: Prices;
  capUSD: number;
  limits?: AgentLimits;
  begin(budgetUSD: number): Promise<ModelSession>;
}

export interface SuiteOptions {
  outDir: string;
  cell: EvalCellOptions;
  only?: readonly string[];
  model?: ModelMode;
  log?(line: string): void;
}

const failed = (reason: string): Verdict => ({ ok: false, reasons: [reason] });

async function saveScreen(cell: EvalCell, path: string): Promise<void> {
  try {
    const res = await fetch(`${cell.baseUrl}/observe`, {
      method: "POST",
      headers: { authorization: `Bearer ${cell.token}`, "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(20_000),
    });
    const { image } = (await res.json()) as { image: string };
    await sharp(Buffer.from(image, "base64")).png().toFile(path);
  } catch {
    /* A missing final screenshot does not change the verdict. */
  }
}

function saveRun(dir: string, run: AgentRun): void {
  writeFileSync(
    join(dir, "events.jsonl"),
    `${run.events.map((e) => JSON.stringify(e)).join("\n")}\n`,
  );
}

async function runTask(task: EvalTask, o: SuiteOptions, spentUSD: number): Promise<TaskReport> {
  const dir = join(o.outDir, task.id);
  mkdirSync(join(dir, "noop"), { recursive: true });
  mkdirSync(join(dir, "run"), { recursive: true });
  const landed = task.requires.every(capabilityLanded);
  const log = o.log ?? (() => {});
  let cell: EvalCell | undefined;
  let run: AgentRun | undefined;
  let noop: Verdict = failed("the no-op run did not happen");
  let verdict: Verdict = failed("the run did not happen");
  let error: string | undefined;
  let session: ModelSession | undefined;
  try {
    if (o.model && o.model.capUSD - spentUSD <= 0) throw new Error("the spend cap is used up");
    cell = await startEvalCell(task.id, o.cell);
    log(`${task.id}: desktop ready`);
    await task.setup(cell);
    log(`${task.id}: set up`);
    const oracle = (policy: typeof noopPolicy) => (facts: () => DesktopFacts) => ({
      binding: ORACLE_BINDING,
      model: oracleModel(policy, facts).model,
    });
    const idle = await runAgent({
      cell,
      home: join(dir, "noop"),
      task: task.prompt,
      model: oracle(noopPolicy),
      timeoutMs: 120_000,
    });
    saveRun(join(dir, "noop"), idle);
    noop = await task.check(cell);
    log(`${task.id}: no-op ${noop.ok ? "ACCEPTED" : "rejected"}`);
    session = o.model ? await o.model.begin(o.model.capUSD - spentUSD) : undefined;
    run = await runAgent({
      cell,
      home: join(dir, "run"),
      task: task.prompt,
      model: session ? session.under : oracle(task.oracle()),
      timeoutMs: task.timeoutMs,
      ...(o.model?.limits ? { limits: o.model.limits } : {}),
    });
    saveRun(join(dir, "run"), run);
    await saveScreen(cell, join(dir, "final.png"));
    verdict = await task.check(cell);
    log(
      `${task.id}: ${run.outcome} in ${(run.wallMs / 1000).toFixed(1)} s, ${verdict.ok ? "passed" : `failed (${verdict.reasons.join("; ")})`}`,
    );
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
    verdict = failed(error);
    log(`${task.id}: ${error}`);
  } finally {
    await session?.end().catch(() => log(`${task.id}: the model session did not close cleanly`));
    if (cell) removeEvalContainers(o.cell, cell.name);
  }
  const events = run?.events ?? [];
  return taskReport({
    id: task.id,
    requires: task.requires,
    landed,
    verdict,
    noop,
    run: run ?? { outcome: "error", error, wallMs: 0, calls: [] },
    analysis: analyseEvents(events),
    ...(o.model?.prices ? { prices: o.model.prices } : {}),
  });
}

export async function runSuite(o: SuiteOptions): Promise<EvalReport> {
  mkdirSync(o.outDir, { recursive: true });
  const tasks = TASKS.filter((t) => !o.only?.length || o.only.includes(t.id));
  const reports: TaskReport[] = [];
  let spent = 0;
  for (const task of tasks) {
    const report = await runTask(task, o, spent);
    spent += report.costUSD;
    reports.push(report);
  }
  const report = suiteReport(reports, {
    mode: o.model ? "model" : "oracle",
    ...(o.model ? { model: o.model.label } : {}),
    generatedAt: new Date().toISOString(),
    image: o.cell.image,
  });
  writeFileSync(join(o.outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(o.outDir, "report.md"), markdownReport(report));
  return report;
}
