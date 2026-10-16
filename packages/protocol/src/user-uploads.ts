import { z } from "zod";
import { keyLikePresent } from "./key-like.ts";

// Incoming user files are disk-backed data, not model context or outbound browser uploads.
export const USER_UPLOAD = Object.freeze({
  bytes: 10 * 1024 ** 3,
  totalBytes: 20 * 1024 ** 3,
  chunkBytes: 4 * 1024 ** 2,
  count: 16,
  retentionMs: 24 * 60 * 60 * 1000,
});
export const UserUploadId = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
export const UserUploadName = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (name) =>
      name.isWellFormed() &&
      new TextEncoder().encode(name).byteLength <= 255 &&
      !name.startsWith(".") &&
      !/[\\/%\p{Cc}]/u.test(name) &&
      !keyLikePresent(name),
  );
export const UploadDigest = z.string().regex(/^[a-f0-9]{64}$/);
export const UserUploadCreate = z.strictObject({
  id: UserUploadId,
  name: UserUploadName,
  bytes: z.number().int().min(0).max(USER_UPLOAD.bytes),
});
export type UserUploadCreate = z.infer<typeof UserUploadCreate>;
export const UserUploadStatus = UserUploadCreate.extend({
  offset: z.number().int().min(0).max(USER_UPLOAD.bytes),
  phase: z.enum(["receiving", "placing", "paused", "complete"]),
  path: z.string().max(1024).optional(),
  sha256: UploadDigest.optional(),
  problem: z
    .enum([
      "computer_unavailable",
      "computer_update_required",
      "storage_full",
      "verification_failed",
    ])
    .optional(),
});
export type UserUploadStatus = z.infer<typeof UserUploadStatus>;
export const UserUploadReceipt = z.strictObject({
  path: z.string().max(1024),
  bytes: z.number().int().min(0).max(USER_UPLOAD.bytes),
  sha256: UploadDigest,
});
export type UserUploadReceipt = z.infer<typeof UserUploadReceipt>;
export const userUploadPath = (id: string, name: string) => `Downloads/Uploads/${id}/${name}`;
