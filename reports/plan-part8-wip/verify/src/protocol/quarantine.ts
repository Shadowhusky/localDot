import { z } from "zod";
import { ULID_PATTERN } from "./ids.ts";

// Downloads from the signed-in browser wait here, on the Mac, until the user releases them
// (spec "download into a quarantine that the user releases"; P8-R16).
export const QUARANTINE_MAX_TOTAL_BYTES = 10 * 1024 ** 3;
export const QUARANTINE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const DownloadKind = z.enum(["program", "archive", "document", "media", "other"]);
export type DownloadKind = z.infer<typeof DownloadKind>;

export const QuarantineItem = z.object({
  id: z.string().regex(ULID_PATTERN),
  cellId: z.string().regex(ULID_PATTERN), // the computer (desktop cell) whose browser fetched it
  sessionId: z.string().regex(ULID_PATTERN).optional(),
  name: z.string().min(1).max(130),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  kind: DownloadKind,
  source: z.string().max(253), // the host it came from
  createdAt: z.string(),
  state: z.enum(["held", "released", "discarded"]),
  releasedTo: z.enum(["computer", "mac"]).optional(),
  releasedPath: z.string().max(1024).optional(),
});
export type QuarantineItem = z.infer<typeof QuarantineItem>;

export const ReleaseRequest = z.object({ to: z.literal("computer") });
export const ReleaseReply = z.object({ path: z.string() });
