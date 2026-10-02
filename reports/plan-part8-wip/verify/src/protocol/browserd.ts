import { z } from "zod";
import { ULID_PATTERN } from "./ids.ts";

// browserd's own routes, beside the desktopd-compatible ones it serves (P8-R2). Every route needs
// the cell's bearer token; every route an agent action reaches answers 423 while the user holds
// the screen (P8-R11).
export const BROWSERD_PORT = 7700;
export const LOCKED_STATUS = 423;

export const LeaseHolder = z.enum(["agent", "user"]);
export type LeaseHolder = z.infer<typeof LeaseHolder>;

// PUT /lease. The daemon is the only caller; browserd starts with holder "user" (locked).
export const LeaseRequest = z.object({
  holder: LeaseHolder,
  leaseId: z.string().regex(ULID_PATTERN),
});
export type LeaseRequest = z.infer<typeof LeaseRequest>;
export const LeaseReply = z.object({
  holder: LeaseHolder,
  leaseId: z.string().regex(ULID_PATTERN),
  // Hand-back only: pages reloaded because a secret field still held a value.
  reloaded: z.number().int().nonnegative(),
  // Hand-back only: the X selections were cleared.
  selectionsCleared: z.boolean(),
});
export type LeaseReply = z.infer<typeof LeaseReply>;

// GET /state: what the agent's tool results mention after an action on the browser screen.
export const BrowserdState = z.object({
  url: z.string(), // redacted (redactUrl)
  title: z.string().max(256),
  chooser: z.enum(["none", "single", "multiple"]),
  pages: z.number().int().nonnegative(),
});
export type BrowserdState = z.infer<typeof BrowserdState>;

// Downloads Chromium finished, refused or failed, in the order they ended.
export const MAX_DOWNLOAD_BYTES = 1024 ** 3;
export const DownloadEntry = z.object({
  guid: z.string().regex(/^[0-9a-f-]{36}$/),
  seq: z.number().int().positive(),
  name: z.string().min(1).max(130), // safeFileName of Chromium's suggestedFilename
  url: z.string().max(4096), // redacted
  bytes: z.number().int().nonnegative(),
  state: z.enum(["done", "refused", "failed"]),
  reason: z.enum(["too-large", "canceled", "interrupted"]).optional(),
});
export type DownloadEntry = z.infer<typeof DownloadEntry>;
// GET /downloads?after=<seq>&waitMs=<0..25000>: a long poll.
export const DownloadList = z.object({ entries: z.array(DownloadEntry) });
export type DownloadList = z.infer<typeof DownloadList>;

// POST /upload?name=<file name>: raw bytes for the pending file chooser.
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
export const UploadReply = z.object({ name: z.string(), bytes: z.number().int().nonnegative() });
export type UploadReply = z.infer<typeof UploadReply>;

// The reasons browserd refuses an agent call with 403, so the daemon can tell the model why.
export const BrowserdRefusal = z.enum([
  "secret-field",
  "shortcut",
  "no-file-chooser",
  "not-a-web-url",
]);
export type BrowserdRefusal = z.infer<typeof BrowserdRefusal>;
