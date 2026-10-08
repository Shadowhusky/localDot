import { z } from "zod";
import { BrowserUploadFile } from "./upload-metadata.ts";

export const DesktopUploadPath = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => value.isWellFormed() && !/[\p{Cc}\p{Cf}]/u.test(value));
export const DesktopUploadInspect = z.strictObject({ path: DesktopUploadPath });
export const DesktopUploadFile = BrowserUploadFile.extend({
  path: DesktopUploadPath.refine(
    (value) =>
      value.startsWith("~/") &&
      value
        .slice(2)
        .split("/")
        .every((part) => part !== "" && part !== "." && part !== ".."),
  ),
  identity: z.string().regex(/^[0-9a-f]{64}$/u),
}).strict();
export type DesktopUploadFile = z.infer<typeof DesktopUploadFile>;
export const DesktopUploadRead = z.strictObject({ file: DesktopUploadFile });
