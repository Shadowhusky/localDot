import { describe, expect, it } from "vitest";
import { analyseEvents } from "./analyse.ts";
import { markdownReport, suiteReport, taskReport } from "./report.ts";

const pass = { ok: true, reasons: [] };
const fail = (reason: string) => ({ ok: false, reasons: [reason] });
const call = (ok: boolean, skipped = false, refused = false) => ({
  name: "computer",
  ok,
  skipped,
  refused,
});
const run = {
  outcome: "done" as const,
  wallMs: 12_500,
  calls: [call(true), call(false, false, true), call(false, true), { ...call(true), name: "done" }],
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
    maxHandoffs: 2,
    ...over,
  });

describe("taskReport", () => {
  it("counts calls, keeps the safety counts and prices the tokens", () => {
    const t = report({ prices: { inputUSDPerMTok: 1, outputUSDPerMTok: 10 } });
    expect(t).toMatchObject({
      status: "pass-assisted",
      noopRejected: true,
      wallSeconds: 12.5,
      modelTurns: 4,
      toolCalls: 4,
      failedCalls: 1,
      skippedCalls: 1,
      refusedCalls: 1,
      approvals: 3,
      handoffs: 1,
      maxHandoffs: 2,
    });
    expect(t.costUSD).toBeCloseTo(3);
    expect(report({}).costUSD).toBe(0);
  });

  it("reports a pass as assisted when the simulated user did handed-over inputs", () => {
    expect(report({}).status).toBe("pass-assisted");
    expect(report({ analysis: { ...analysis, handoffs: 0 } }).status).toBe("pass");
  });

  it("marks a task whose capabilities have not landed as an expected failure", () => {
    expect(report({ landed: false, verdict: fail("no shape") }).status).toBe("expected-fail");
    expect(report({ landed: false }).status).toBe("unexpected-pass");
    expect(report({ verdict: fail("no shape") }).status).toBe("fail");
  });

  it("expects a failure only when the run shows the missing action refused", () => {
    const t = report({
      landed: false,
      requires: ["drag"],
      verdict: fail("no shape"),
      run: { ...run, calls: [call(true), call(false)] },
    });
    expect(t.status).toBe("fail");
    expect(t.reasons).toEqual(["no shape", "the run never tried drag"]);
  });

  it("reports a harness error as an error, whatever the task requires", () => {
    for (const landed of [true, false])
      expect(
        report({
          landed,
          verdict: fail("the run did not happen"),
          noop: undefined,
          harnessError: "the expected window did not appear",
        }),
      ).toMatchObject({ status: "error", harnessError: "the expected window did not appear" });
  });

  it("leaves the no-op verdict out when the no-op run did not happen", () => {
    expect(report({ noop: undefined }).noopRejected).toBeUndefined();
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

  it("fails when a task needs more hand-offs than its ceiling", () => {
    const r = suiteReport([report({ id: "a", maxHandoffs: 0 }), report({ id: "b" })], meta);
    expect(r.problems).toEqual(["a needed 1 hand-off; its ceiling is 0"]);
  });

  it("fails on a harness error, even in a task expected to fail", () => {
    const r = suiteReport(
      [
        report({
          id: "d",
          landed: false,
          requires: ["drag"],
          verdict: fail("the run did not happen"),
          noop: undefined,
          harnessError: "the expected window did not appear",
        }),
      ],
      meta,
    );
    expect(r).toMatchObject({
      ok: false,
      problems: ["d: the harness failed: the expected window did not appear"],
    });
  });

  it("fails when the no-op run did not happen", () => {
    const r = suiteReport([report({ id: "a", noop: undefined })], meta);
    expect(r.problems).toEqual(["a: the no-op run did not happen"]);
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
    expect(md).toContain("| calc-fill | pass-assisted | 4 | 4 (1/1) | 12.5 | – |");
    expect(md).toContain("| 3 | 1/2 | 0 |");
    expect(md).toContain("suite holds");
  });
});
