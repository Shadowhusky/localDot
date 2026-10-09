import type { RecallHit } from "../agent/tools/deps.ts";
import type { SearchIndex } from "./search-index.ts";

export function recallHits(
  index: Pick<SearchIndex, "search">,
  query: string,
  limit: number,
  excludeSessionId: string,
): RecallHit[] {
  return index.search({ query, limit, excludeSessionId }).map((r) => ({
    title: r.title ?? (r.kind === "note" ? "Daily note" : "Untitled task"),
    day: (r.startedAt ?? r.at).slice(0, 10),
    kind: r.kind,
    snippet: r.snippet.replace(/[\uE000\uE001]/g, ""),
  }));
}
