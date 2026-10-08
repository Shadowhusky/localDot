import { z } from "zod";
import { ULID_PATTERN } from "./ids.ts";

const Id = z.string().length(26).regex(ULID_PATTERN);
const Name = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/);
const DockerId = z
  .string()
  .length(64)
  .regex(/^[a-f0-9]+$/);
// Null means no physical identity was recorded (for example a stopped browser). Retirement
// must prove the corresponding name absent, never adopt a resource found under that name.
const Resource = z.strictObject({ name: Name, id: DockerId.nullable() });
const Resources = z
  .strictObject({
    workload: Resource,
    gate: Resource,
    internalNetwork: Resource,
    egressNetwork: Resource,
    volume: Name,
  })
  .refine((value) => {
    const ids = [
      value.workload.id,
      value.gate.id,
      value.internalNetwork.id,
      value.egressNetwork.id,
    ].filter((id) => id !== null);
    return new Set(ids).size === ids.length;
  }, "resource identities must be distinct");
// Public ownership snapshot only: no daemon/cell/stream tokens, paths or provider credentials.
export const ComputerResetSource = z.strictObject({
  scale: z.union([z.literal(1), z.literal(2)]),
  desktop: Resources,
  browser: z.strictObject({ id: Id, owner: z.string().uuid(), resources: Resources }).nullable(),
});
export type ComputerResetSource = z.infer<typeof ComputerResetSource>;
export const ComputerResetRequest = z.strictObject({
  requestId: Id,
  eraseComputer: z.literal(true),
});
export type ComputerResetRequest = z.infer<typeof ComputerResetRequest>;
export const ComputerResetRecord = z
  .strictObject({
    v: z.literal(1),
    requestId: Id,
    oldCellId: Id,
    newCellId: Id,
    source: ComputerResetSource,
    phase: z.enum(["retiring", "retired", "creating", "ready"]),
  })
  .refine(
    (value) =>
      new Set([
        value.oldCellId,
        value.newCellId,
        ...(value.source.browser ? [value.source.browser.id] : []),
      ]).size === (value.source.browser ? 3 : 2),
    "reset requires fresh computer identities",
  );
export type ComputerResetRecord = z.infer<typeof ComputerResetRecord>;
