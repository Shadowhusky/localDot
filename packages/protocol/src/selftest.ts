import { z } from "zod";

// A desktop cell's boot self-test (desktopd GET /selftest). "isolation" checks prove the cell has
// no way out but its gate; "keyd" checks prove the gate reaches this cell's own keyd listener,
// which wants the cell's token; "trust" checks prove the cell's CA is installed.
export const SelfTestCheck = z.object({
  id: z.string().max(32),
  kind: z.enum(["isolation", "keyd", "trust"]),
  ok: z.boolean(),
  detail: z.string().max(500),
});
export type SelfTestCheck = z.infer<typeof SelfTestCheck>;

export const SelfTestReport = z.object({
  ok: z.boolean(),
  checks: z.array(SelfTestCheck).max(32),
  ms: z.number().nonnegative(),
});
export type SelfTestReport = z.infer<typeof SelfTestReport>;

// Every check desktopd's self-test runs, in its order.
export const SELFTEST_CHECKS = [
  { id: "route", kind: "isolation" },
  { id: "direct-ipv4", kind: "isolation" },
  { id: "direct-ipv6", kind: "isolation" },
  { id: "dns", kind: "isolation" },
  { id: "host", kind: "isolation" },
  { id: "gateway", kind: "isolation" },
  { id: "keyd-token", kind: "keyd" },
  { id: "keyd", kind: "keyd" },
  { id: "forwarder", kind: "keyd" },
  { id: "ca-system", kind: "trust" },
  { id: "ca-nss", kind: "trust" },
] as const satisfies readonly Pick<SelfTestCheck, "id" | "kind">[];
export const SELFTEST_CHECK_IDS: readonly string[] = SELFTEST_CHECKS.map((c) => c.id);

// The daemon recomputes the verdict from the checks rather than trusting the report's own ok, and
// it decides which checks there are: each one exactly once, so a desktopd built before a check
// existed, or one that leaves a check out, never makes a cell ready.
export function selfTestPassed(report: SelfTestReport): boolean {
  return (
    report.checks.every((c) => c.ok) &&
    SELFTEST_CHECKS.every(({ id, kind }) => {
      const matching = report.checks.filter((check) => check.id === id);
      return matching.length === 1 && matching[0]?.kind === kind;
    })
  );
}
