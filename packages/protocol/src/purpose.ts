import { z } from "zod";
import type { KeydRecord } from "./keyd.ts";

// The purpose check: Auto uses Jev when a Jev key is saved, else the fast model, else nothing;
// Off keeps only the checks on actions that act as the user.
export const PurposeCheck = z.enum(["auto", "off"]);
export type PurposeCheck = z.infer<typeof PurposeCheck>;

// What private data a task has read. The origin names where (a host, a file, a memory file),
// never what was read.
export const TaintKind = z.enum(["screen", "memory", "files", "recall", "app"]);
export type TaintKind = z.infer<typeof TaintKind>;
export const TaintSource = z.strictObject({
  kind: TaintKind,
  origin: z
    .string()
    .min(1)
    .max(200)
    .refine((value) => value.isWellFormed() && !/[\0\r\n]/.test(value)),
});
export type TaintSource = z.infer<typeof TaintSource>;

export const JEV_HOST = "api.typesafe.ai";
export const JEV_PATH = "/v1/systemone";
export const JEV_MODEL = "jev-latest";
export const JEV_SECRET_ID = "jev";

// A Jev key is a web API key bound to Jev's host, sent as a bearer token.
export function isJevKey(record: Pick<KeydRecord, "kind" | "hosts" | "header" | "format">) {
  return (
    record.kind === "http" &&
    (record.hosts ?? []).includes(JEV_HOST) &&
    record.header?.toLowerCase() === "authorization" &&
    record.format === "bearer"
  );
}
