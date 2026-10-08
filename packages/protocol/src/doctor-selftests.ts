import { z } from "zod";
import { ServiceProcessIdentity } from "./install-services.ts";
import { SELFTEST_CHECK_IDS } from "./selftest.ts";

export const DoctorSelfTestsRequest = z.strictObject({
  v: z.literal(1),
  requestId: z.string().uuid(),
});
export const DoctorCellSelfTest = z
  .strictObject({
    id: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
    outcome: z.enum(["passed", "failed", "unavailable"]),
    checks: z
      .array(
        z.strictObject({
          id: z.string().refine((id) => SELFTEST_CHECK_IDS.includes(id)),
          ok: z.boolean(),
        }),
      )
      .max(SELFTEST_CHECK_IDS.length),
  })
  .refine((cell) => {
    if (cell.outcome === "unavailable") return cell.checks.length === 0;
    const complete =
      cell.checks.length === SELFTEST_CHECK_IDS.length &&
      new Set(cell.checks.map((c) => c.id)).size === SELFTEST_CHECK_IDS.length;
    return complete && (cell.outcome === "passed") === cell.checks.every((c) => c.ok);
  });
export const DoctorSelfTestsReply = z
  .strictObject({
    v: z.literal(1),
    requestId: z.string().uuid(),
    service: ServiceProcessIdentity,
    bootId: z.string().uuid(),
    cells: z.array(DoctorCellSelfTest).max(64),
  })
  .refine((reply) => new Set(reply.cells.map((cell) => cell.id)).size === reply.cells.length);
export type DoctorSelfTestsReply = z.infer<typeof DoctorSelfTestsReply>;
