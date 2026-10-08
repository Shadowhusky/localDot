import { z } from "zod";
import { BrowserActionPermit, BrowserManualPermit } from "./browser-control.ts";
import { ULID_PATTERN } from "./ids.ts";
import { DOWNLOAD_BYTES, QuarantineOrigin } from "./quarantine.ts";

const sessionId = z.string().regex(ULID_PATTERN);
export const BrowserDownloadBinding = z
  .discriminatedUnion("holder", [
    z.strictObject({ holder: z.literal("agent"), sessionId, permit: BrowserActionPermit }),
    z.strictObject({ holder: z.literal("user"), sessionId, permit: BrowserManualPermit }),
  ])
  .refine(
    (value) =>
      value.permit.parentCellId !== value.permit.browserCellId &&
      (value.holder === "user" || value.sessionId === value.permit.owner.sessionId),
  );
export type BrowserDownloadBinding = z.infer<typeof BrowserDownloadBinding>;

export const BrowserDownloadGuid = z.uuid().refine((value) => value === value.toLowerCase());
export const BrowserDownloadOffer = z.strictObject({
  guid: BrowserDownloadGuid,
  bytes: z.number().int().nonnegative().max(DOWNLOAD_BYTES),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  origin: QuarantineOrigin,
});
export type BrowserDownloadOffer = z.infer<typeof BrowserDownloadOffer>;
export const BrowserDownloadRequest = z.strictObject({ binding: BrowserDownloadBinding });
export const BrowserDownloadRead = BrowserDownloadRequest.extend({
  guid: BrowserDownloadGuid,
}).strict();
export const BrowserDownloadAck = BrowserDownloadRead.extend({
  bytes: z.number().int().nonnegative().max(DOWNLOAD_BYTES),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
}).strict();
