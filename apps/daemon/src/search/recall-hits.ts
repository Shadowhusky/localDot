import type { RecallHit } from "../agent/tools/deps.ts";
import type { SearchIndex } from "./search-index.ts";

export function recallHits(
  index: Pick<SearchIndex, "search">,
  query: string,
  limit: number,
  _currentSessionId: string,
): RecallHit[] {
  return index.search({ query, limit, details: true }).map((r) => ({
    ...(r.sessionId && r.kind !== "note" ? { sessionId: r.sessionId } : {}),
    title: r.title ?? (r.kind === "note" ? "Daily note" : "Untitled task"),
    day: r.at.slice(0, 10),
    kind: r.kind,
    snippet: r.snippet.replace(/[\uE000\uE001]/g, ""),
    ...(r.context ? { context: r.context } : {}),
  }));
}
