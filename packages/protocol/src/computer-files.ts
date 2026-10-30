import { z } from "zod";
import { PreviewReason } from "./deliverables.ts";

// A file on dot's computer, by the path its tools name it with: under the home folder, as "~/…".
export const COMPUTER_PATH_MAX = 1024;
export function isComputerPath(path: string): boolean {
  if (path.length > COMPUTER_PATH_MAX || !path.startsWith("~/") || !path.isWellFormed())
    return false;
  return path
    .slice(2)
    .split("/")
    .every((part) => part !== "" && part !== "." && part !== ".." && !/[\\\p{Cc}]/u.test(part));
}
export function computerFileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}
// What the viewer learns of a file on dot's computer before it shows it: its size now, or why it
// can't be read.
export const ComputerFileReply = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("file"),
    path: z.string().max(COMPUTER_PATH_MAX),
    bytes: z.number().int().nonnegative(),
  }),
  z.strictObject({ kind: z.literal("none"), reason: PreviewReason }),
]);
export type ComputerFileReply = z.infer<typeof ComputerFileReply>;
