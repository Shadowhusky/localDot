import { z } from "zod";
import { NOTES_FILE } from "./events.ts";
import { ULID_PATTERN } from "./ids.ts";
import { keyLikePresent } from "./key-like.ts";

export const MemoryBook = z.enum(["USER.md", "MEMORY.md"]);
export type MemoryBook = z.infer<typeof MemoryBook>;
export const NotesFileName = z.custom<`notes/${string}.md`>(
  (v) => typeof v === "string" && NOTES_FILE.test(v),
  "invalid notes file",
);
// USER.md, MEMORY.md, or a day's notes dot keeps for itself.
export const MemoryFileName = z.union([MemoryBook, NotesFileName]);
export type MemoryFileName = z.infer<typeof MemoryFileName>;
export const MEMORY_ENTRY_ID = /^(?:[0-9A-HJKMNP-TV-Z]{26}|x[0-9a-f]{16})$/;
export const MemoryEntryRevision = z.string().regex(/^[0-9a-f]{16}$/);
export const MemoryEntryText = z
  .string()
  .max(1000)
  .refine(
    (s) =>
      s.isWellFormed() &&
      !s.includes("\0") &&
      s.trim().length > 0 &&
      !s.includes("<!--") &&
      !s.includes("-->"),
    "invalid fact text",
  )
  .refine((s) => !keyLikePresent(s), "key-shaped text belongs in Keys");
const SessionId = z.string().regex(ULID_PATTERN);
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const MemoryEntrySource = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("task"),
    sessionId: SessionId,
    title: z.string().max(200).nullable(),
  }),
  z.strictObject({ kind: z.literal("user") }),
  z.strictObject({ kind: z.literal("unknown") }),
]);
export type MemoryEntrySource = z.infer<typeof MemoryEntrySource>;
export const MemoryEntry = z.strictObject({
  id: z.string().regex(MEMORY_ENTRY_ID),
  file: MemoryFileName,
  text: z.string().max(20_000),
  source: MemoryEntrySource,
  at: Day.nullable(),
  pinned: z.boolean(),
  revision: MemoryEntryRevision,
});
export type MemoryEntry = z.infer<typeof MemoryEntry>;
export const MemoryEntriesReply = z.strictObject({
  dir: z.string().max(1024),
  files: z
    .array(z.strictObject({ file: MemoryBook, entries: z.array(MemoryEntry).max(10_000) }))
    .length(2),
  // Daily notes with anything in them, the newest day first.
  notes: z
    .array(z.strictObject({ file: NotesFileName, entries: z.array(MemoryEntry).max(10_000) }))
    .max(10_000),
});
export type MemoryEntriesReply = z.infer<typeof MemoryEntriesReply>;
export const AddMemoryEntryRequest = z.strictObject({
  file: MemoryBook,
  text: MemoryEntryText,
  pinned: z.boolean().optional(),
});
export type AddMemoryEntryRequest = z.infer<typeof AddMemoryEntryRequest>;
export const EditMemoryEntryRequest = z
  .strictObject({
    file: MemoryFileName,
    revision: MemoryEntryRevision,
    text: MemoryEntryText.optional(),
    pinned: z.boolean().optional(),
  })
  .refine((v) => v.text !== undefined || v.pinned !== undefined, "nothing to change");
export type EditMemoryEntryRequest = z.infer<typeof EditMemoryEntryRequest>;
export const MemoryEntryChangeReply = z.strictObject({
  changeId: SessionId,
  entry: MemoryEntry.optional(),
});
export type MemoryEntryChangeReply = z.infer<typeof MemoryEntryChangeReply>;
