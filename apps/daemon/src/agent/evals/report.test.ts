import { describe, expect, it } from "vitest";
import { analyseEvents } from "./analyse.ts";
import { markdownReport, suiteReport, taskReport } from "./report.ts";

const pass = { ok: true, reasons: [] };
const fail = (reason: string) => ({ ok: false, reasons: [reason] });
const run = {
  outcome: "done" as const,
  wallMs: 12_500,
  calls: [
    { name: "computer", ok: true, skipped: false },
    { name: "computer", ok: false, skipped: false },
    { name: "computer", ok: false, skipped: true },
    { name: "done", ok: true, skipped: false },
  ],
};
const analysis = {
  ...analyseEvents([]),
  modelTurns: 4,
  approvals: 3,
  handoffs: 1,
  inputTokens: 2_000_000,
  outputTokens: 100_000,
};
const report = (over: Partial<Parameters<typeof taskReport>[0]>) =>
  taskReport({
    id: "t",
    requires: [],
    landed: true,
    verdict: pass,
    noop: fail("nothing"),
    run,
    analysis,
    ...over,
  });

describe("taskReport", () => {
  it("counts calls, keeps the safety counts and prices the tokens", () => {
    const t = report({ prices: { inputUSDPerMTok: 1, outputUSDPerMTok: 10 } });
    expect(t).toMatchObject({
      status: "pass",
      noopRejected: true,
      wallSeconds: 12.5,
      modelTurns: 4,
      toolCalls: 4,
      failedCalls: 1,
      skippedCalls: 1,
      approvals: 3,
      handoffs: 1,
    });
    expect(t.costUSD).toBeCloseTo(3);
    expect(report({}).costUSD).toBe(0);
  });

  it("marks a task whose capabilities have not landed as an expected failure", () => {
    expect(report({ landed: false, verdict: fail("no shape") }).status).toBe("expected-fail");
    expect(report({ landed: false }).status).toBe("unexpected-pass");
    expect(report({ verdict: fail("no shape") }).status).toBe("fail");
  });
});

describe("suiteReport", () => {
  const meta = { mode: "oracle" as const, generatedAt: "2026-10-08T00:00:00.000Z", image: "img" };

  it("holds with passes and expected failures only", () => {
    const r = suiteReport(
      [report({}), report({ id: "d", landed: false, verdict: fail("x") })],
      meta,
    );
    expect(r).toMatchObject({ ok: true, problems: [] });
  });

  it("fails on a failed task, an unnoticed pass or a checker that accepts a no-op", () => {
    const r = suiteReport(
      [
        report({ id: "a", verdict: fail("wrong cell") }),
        report({ id: "b", landed: false, requires: ["drag"] }),
        report({ id: "c", noop: pass }),
      ],
      meta,
    );
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual([
      "a failed: wrong cell",
      "b passed although it requires drag; make it required",
      "c: the checker accepted a run that did nothing",
    ]);
  });
});

describe("markdownReport", () => {
  it("renders one row per task with phase medians and counts", () => {
    const md = markdownReport(
      suiteReport([report({ id: "calc-fill" })], {
        mode: "oracle",
        generatedAt: "2026-10-08T00:00:00.000Z",
        image: "localdot/desktop:dev",
      }),
    );
    expect(md).toContain("| Task | Result | Turns | Calls (failed/skipped) | Wall s | Pre-auth |");
    expect(md).toContain("| calc-fill | pass | 4 | 4 (1/1) | 12.5 | – |");
    expect(md).toContain("suite holds");
  });
});
