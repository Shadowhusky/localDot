import { describe, expect, it } from "vitest";
import { SELFTEST_CHECKS, type SelfTestReport, selfTestPassed } from "./selftest.ts";

const passing = (): SelfTestReport => ({
  ok: true,
  ms: 12,
  checks: SELFTEST_CHECKS.map((c) => ({ ...c, ok: true, detail: "fine" })),
});

describe("selfTestPassed", () => {
  it("refuses an isolation check relabelled as a trust check", () => {
    const report = passing();
    report.checks = report.checks.map((check) =>
      check.id === "gateway" ? { ...check, kind: "trust" } : check,
    );
    expect(selfTestPassed(report)).toBe(false);
  });

  it("passes a report with every check, each once and ok", () => {
    expect(selfTestPassed(passing())).toBe(true);
  });

  it("fails a report that leaves a check out, whatever the rest says", () => {
    const report = passing();
    const withoutDns = { ...report, checks: report.checks.filter((c) => c.id !== "dns") };
    expect(selfTestPassed(withoutDns)).toBe(false);
    expect(selfTestPassed({ ...report, checks: [] })).toBe(false);
  });

  it("fails a report that names a check twice, or fails any check, even one it added", () => {
    const report = passing();
    const twice = { ...report, checks: [...report.checks, { ...report.checks[0], id: "route" }] };
    expect(selfTestPassed(twice as SelfTestReport)).toBe(false);
    const extra = {
      ...report,
      checks: [...report.checks, { id: "new", kind: "isolation", ok: false, detail: "open" }],
    } satisfies SelfTestReport;
    expect(selfTestPassed(extra)).toBe(false);
    const lying = {
      ...report,
      checks: report.checks.map((c) => (c.id === "gateway" ? { ...c, ok: false } : c)),
    };
    expect(selfTestPassed(lying)).toBe(false);
  });
});
