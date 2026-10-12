import { isDeepStrictEqual as equal } from "node:util";
import { z } from "zod";
import { PrivateRecords } from "../agent/safety/private-records.ts";
import { decodeRecord } from "./store.ts";
import type { CellRecord } from "./types.ts";

const identity = z.string().regex(/^[0-9a-f]{64}$/);
export const RuntimeImages = z.strictObject({
  gate: z
    .string()
    .max(512)
    .regex(/^[a-z0-9][a-z0-9./:_-]+@sha256:[0-9a-f]{64}$/),
  desktop: z
    .string()
    .max(512)
    .regex(/^[a-z0-9][a-z0-9./:_-]+@sha256:[0-9a-f]{64}$/),
});
export function runtimeSource(raw: unknown): CellRecord {
  const copy = structuredClone(raw);
  const id = (copy as CellRecord | undefined)?.id;
  const source =
    typeof id === "string" ? decodeRecord(copy, id, { from: 1024, to: 65535 }) : undefined;
  if (
    source?.kind !== "desktop" ||
    !source.ownership ||
    Object.values(source.ownership).some((id) => !identity.safeParse(id).success) ||
    new Set(Object.values(source.ownership)).size !== 4
  )
    throw new Error("Computer update requires an exact desktop ownership record");
  return source;
}
const Journal = z
  .strictObject({
    v: z.literal(1),
    operationId: z.uuid(),
    source: z.unknown().transform(runtimeSource),
    images: RuntimeImages,
    systemImage: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .optional(),
    fullcolor: z.boolean(),
    phase: z.enum(["retiring", "creating", "prepared"]),
    candidates: z.strictObject({ gate: identity.nullable(), desktop: identity.nullable() }),
  })
  .superRefine((j, ctx) => {
    const ids = Object.values(j.candidates).filter((id) => id !== null);
    if (
      new Set([...Object.values(j.source.ownership ?? {}), ...ids]).size !== 4 + ids.length ||
      (j.phase === "retiring" && ids.length !== 0) ||
      (j.phase === "prepared" && ids.length !== 2)
    )
      ctx.addIssue({ code: "custom", message: "Invalid update ownership phase" });
  });
export type RuntimeUpdateJournal = z.infer<typeof Journal>;
export function parseRuntimeUpdateJournal(input: unknown): RuntimeUpdateJournal {
  return Journal.parse(input);
}

export function preparedRuntimeRecord(journal: RuntimeUpdateJournal): CellRecord {
  const j = Journal.parse(journal);
  if (j.phase !== "prepared" || !j.candidates.gate || !j.candidates.desktop)
    throw new Error("Computer runtime is not prepared");
  return runtimeSource({ ...j.source, ownership: { ...j.source.ownership, ...j.candidates } });
}

/** Private because source contains the existing cell tokens. It is never a public receipt. */
export class RuntimeUpdateStore {
  readonly #records: PrivateRecords<RuntimeUpdateJournal>;
  constructor(home: string) {
    this.#records = new PrivateRecords(home, "computer-updates", (raw, id) => {
      const parsed = Journal.parse(raw);
      if (parsed.source.id !== id) throw new Error("Computer update owner mismatch");
      return parsed;
    });
  }
  list() {
    return this.#records.list();
  }
  read(id: string) {
    return this.#records.read(id);
  }
  write(input: RuntimeUpdateJournal): void {
    const next = Journal.parse(input),
      before = this.read(next.source.id);
    if (!before || before.operationId !== next.operationId) {
      if (
        next.phase !== "retiring" ||
        (before &&
          (before.phase !== "prepared" || !equal(preparedRuntimeRecord(before), next.source)))
      )
        throw new Error("Previous computer update is unresolved");
    } else {
      const phases = ["retiring", "creating", "prepared"];
      if (
        !equal({ ...before, phase: next.phase, candidates: next.candidates }, next) ||
        ![phases.indexOf(before.phase), phases.indexOf(before.phase) + 1].includes(
          phases.indexOf(next.phase),
        ) ||
        Object.entries(before.candidates).some(
          ([role, id]) => id !== null && next.candidates[role as "gate" | "desktop"] !== id,
        )
      )
        throw new Error("Computer update identity or phase changed");
    }
    this.#records.write(next.source.id, next);
  }
}
