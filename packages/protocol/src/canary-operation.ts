import { z } from "zod";
import { CanaryRunId } from "./canary-process.ts";
import { ULID_PATTERN } from "./ids.ts";

export const CANARY_ROLES = ["desktop", "gate", "internal", "egress", "home"] as const;
export type CanaryRole = (typeof CANARY_ROLES)[number];
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const image = z.strictObject({
  ref: z
    .string()
    .max(512)
    .regex(/^[a-z0-9][a-z0-9./:_-]+@sha256:[a-f0-9]{64}$/),
  id: digest,
});
const directory = z.strictObject({
  device: z.string().regex(/^(0|[1-9][0-9]{0,29})$/),
  inode: z.string().regex(/^[1-9][0-9]{0,29}$/),
});
// Names derive from the random run identity; no paths, PIDs, tokens or fake credentials persist.
export function canaryResourceName(runId: string, role: CanaryRole) {
  return `localdot-canary-${CanaryRunId.parse(runId).replaceAll("-", "")}-${role}`;
}
const id = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .nullable();
export const CanaryOperation = z
  .strictObject({
    v: z.literal(1),
    owner: z.string().regex(/^[a-f0-9]{32}$/),
    runId: CanaryRunId,
    cellId: z.string().regex(ULID_PATTERN),
    engineId: z.string().regex(/^[A-Za-z0-9_:-]{1,256}$/),
    images: z.strictObject({ desktop: image, gate: image }),
    phase: z.enum(["allocating", "active", "retired"]),
    directory: directory.nullable(),
    resources: z.strictObject({
      desktop: id,
      gate: id,
      internal: id,
      egress: id,
      // Docker volumes have no immutable ID. Exact random name + labels + zero references must
      // be freshly checked by cleanup; true only records an acknowledged create, not ownership.
      home: z.boolean(),
    }),
  })
  .refine((r) =>
    r.phase === "allocating"
      ? r.directory === null && Object.values(r.resources).every((v) => v === null || v === false)
      : r.directory !== null,
  );
export type CanaryOperation = z.infer<typeof CanaryOperation>;
export const CanaryOperationRecord = CanaryOperation.nullable();
export function canaryResourceLabels(operation: CanaryOperation, role: CanaryRole) {
  return {
    "localdot.install-owner": operation.owner,
    "localdot.canary-run": operation.runId,
    "localdot.cell": operation.cellId,
    "localdot.role": role,
  };
}
