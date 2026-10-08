import { z } from "zod";
import { BrowserActionPermit } from "./browser-control.ts";
import { BrowserUploadDestination, BrowserUploadFiles } from "./upload-metadata.ts";

export * from "./upload-metadata.ts";

export const BrowserUploadAccess = z.strictObject({ permit: BrowserActionPermit, tabId: z.uuid() });
export const BrowserUploadRequest = BrowserUploadAccess.extend({
  chooserId: z.uuid(),
  destination: BrowserUploadDestination,
  files: BrowserUploadFiles,
}).strict();
export type BrowserUploadRequest = z.infer<typeof BrowserUploadRequest>;
export const BrowserUploadReceipt = z.strictObject({
  chooserId: z.uuid(),
  destination: BrowserUploadDestination,
  files: BrowserUploadFiles,
});
export type BrowserUploadReceipt = z.infer<typeof BrowserUploadReceipt>;
