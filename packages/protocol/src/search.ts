import { z } from "zod";
import { ULID_PATTERN } from "./ids.ts";

export const SearchKind = z.enum(["title", "user", "assistant", "summary", "step", "file", "note"]);
export type SearchKind = z.infer<typeof SearchKind>;
export const SEARCH_QUERY_MAX = 200;
export const SEARCH_MARK_START = "\uE000";
export const SEARCH_MARK_END = "\uE001";
export const SearchHit = z.strictObject({
  sessionId: z.string().regex(ULID_PATTERN).nullable(),
  title: z.string().max(200).nullable(),
  startedAt: z.string().max(40).nullable(),
  kind: SearchKind,
  at: z.string().max(40),
  snippet: z.string().max(600),
});
export type SearchHit = z.infer<typeof SearchHit>;
export const SearchReply = z.strictObject({
  hits: z.array(SearchHit).max(50),
  complete: z.boolean(),
  mode: z.enum(["fts", "like"]),
});
export type SearchReply = z.infer<typeof SearchReply>;
