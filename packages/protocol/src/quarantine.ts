import { z } from "zod";
import { ULID_PATTERN } from "./ids.ts";

export const DOWNLOAD_BYTES = 1024 * 1024 * 1024;
export const UPLOAD_BYTES = 100 * 1024 * 1024;
export const QUARANTINE_BYTES = 10 * DOWNLOAD_BYTES;
export const QUARANTINE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const QUARANTINE_ITEMS = 4096;
export const QUARANTINE_INGESTS = 4;

export function safeDownloadName(value: string): string {
  let normalized = value
    .normalize("NFC")
    .replace(/[\p{Cc}\p{Cf}<>:"/\\|?*]/gu, "_")
    .replace(/^[.\s]+|[.\s]+$/gu, "");
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(normalized))
    normalized = `_${normalized}`;
  let name = "";
  let bytes = 0;
  for (const character of normalized) {
    const length = new TextEncoder().encode(character).length;
    if (bytes + length > 180) break;
    name += character;
    bytes += length;
  }
  name = name.replace(/[.\s]+$/gu, "");
  return name || "download";
}

const id = z.string().regex(ULID_PATTERN);
const revision = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER - 2);
const bytes = z.number().int().nonnegative().max(DOWNLOAD_BYTES);
const digest = z.string().regex(/^[0-9a-f]{64}$/u);
const filename = z
  .string()
  .min(1)
  .max(180)
  .refine((value) => safeDownloadName(value) === value);
const source = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u)
  .refine((value) =>
    value
      .split(".")
      .every(
        (label) =>
          label.length > 0 && label.length <= 63 && !label.startsWith("-") && !label.endsWith("-"),
      ),
  );
export const DownloadKind = z.enum(["document", "image", "archive", "program", "other"]);
export type DownloadKind = z.infer<typeof DownloadKind>;
export const QuarantineOrigin = z
  .strictObject({
    parentCellId: id,
    browserCellId: id,
    browserInstance: z.uuid(),
    sessionId: id,
    source,
    name: z.string().max(4096),
  })
  .refine((value) => value.parentCellId !== value.browserCellId);
export type QuarantineOrigin = z.infer<typeof QuarantineOrigin>;

export const QuarantineRelease = z.strictObject({
  revision,
  bytes,
  sha256: digest,
  name: filename,
  to: z.literal("computer"),
});
export type QuarantineRelease = z.infer<typeof QuarantineRelease>;
export const PlacementRequest = z.strictObject({
  transferId: id,
  parentCellId: id,
  name: filename,
  bytes,
  sha256: digest,
});
export type PlacementRequest = z.infer<typeof PlacementRequest>;
export const PlacementCommand = PlacementRequest.extend({ reconcileOnly: z.boolean() }).strict();
export type PlacementCommand = z.infer<typeof PlacementCommand>;
export const PlacementReceipt = PlacementRequest.extend({
  path: z
    .string()
    .min(1)
    .max(512)
    .refine(
      (value) =>
        value.startsWith("~/Downloads/") && value.slice(12) === safeDownloadName(value.slice(12)),
    ),
}).strict();
export type PlacementReceipt = z.infer<typeof PlacementReceipt>;
export const PlacementNotPlaced = PlacementRequest.extend({
  status: z.literal("not-placed"),
}).strict();
export type PlacementNotPlaced = z.infer<typeof PlacementNotPlaced>;
export const PlacementResult = z.union([PlacementReceipt, PlacementNotPlaced]);
export type PlacementResult = z.infer<typeof PlacementResult>;
const release = z.strictObject({ transferId: id, approvedRevision: revision });
const common = {
  version: z.literal(1),
  id,
  parentCellId: id,
  browserCellId: id,
  browserInstance: z.uuid(),
  // Present for browser-spooled items; survives release/discard and daemon restart.
  browserDownloadGuid: z
    .uuid()
    .refine((value) => value === value.toLowerCase())
    .optional(),
  sessionId: id,
  name: filename,
  source,
  bytes,
  sha256: digest,
  kind: DownloadKind,
  createdAt: z.number().int().nonnegative(),
  revision,
};
export const QuarantineItem = z
  .discriminatedUnion("state", [
    z.strictObject({
      ...common,
      state: z.literal("held"),
      recovery: z
        .strictObject({ approvedRevision: revision, result: PlacementNotPlaced })
        .optional(),
    }),
    z.strictObject({ ...common, state: z.literal("releasing"), release }),
    z.strictObject({ ...common, state: z.literal("released"), release, receipt: PlacementReceipt }),
    z.strictObject({ ...common, state: z.literal("discarded") }),
    z.strictObject({
      ...common,
      state: z.literal("failed"),
      reason: z.enum(["corrupt", "delivery"]),
    }),
  ])
  .refine((value) => value.parentCellId !== value.browserCellId)
  .refine(
    (value) =>
      value.state !== "held" ||
      !value.recovery ||
      (value.revision === value.recovery.approvedRevision + 2 &&
        value.recovery.result.parentCellId === value.parentCellId &&
        value.recovery.result.bytes === value.bytes &&
        value.recovery.result.sha256 === value.sha256 &&
        value.recovery.result.name === value.name),
  )
  .refine(
    (value) =>
      (value.state !== "releasing" && value.state !== "released") ||
      value.revision === value.release.approvedRevision + (value.state === "released" ? 2 : 1),
  )
  .refine(
    (value) =>
      value.state !== "released" ||
      (value.receipt.transferId === value.release.transferId &&
        value.receipt.parentCellId === value.parentCellId &&
        value.receipt.bytes === value.bytes &&
        value.receipt.sha256 === value.sha256 &&
        value.receipt.name === value.name),
  );
export type QuarantineItem = z.infer<typeof QuarantineItem>;
