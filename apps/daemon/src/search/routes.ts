import { SEARCH_QUERY_MAX, SearchKind, SearchReply } from "@localdot/protocol";
import type { Hono } from "hono";
import type { SearchFeed } from "./search-feed.ts";
import type { SearchIndex } from "./search-index.ts";

export interface SearchRoutesDeps {
  index: Pick<SearchIndex, "search" | "mode">;
  feed: Pick<SearchFeed, "complete">;
}
export function searchRoutes(app: Hono, deps: SearchRoutesDeps): void {
  app.get("/api/search", (c) => {
    const q = c.req.query("q") ?? "";
    if (!q.trim() || q.length > SEARCH_QUERY_MAX || !q.isWellFormed() || q.includes("\0"))
      return c.text("invalid search", 400);
    const rawKind = c.req.query("kind");
    const kind = rawKind === undefined ? undefined : SearchKind.safeParse(rawKind);
    if (kind && !kind.success) return c.text("invalid search kind", 400);
    const rawLimit = c.req.query("limit");
    const limit = rawLimit === undefined ? 20 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50)
      return c.text("invalid search limit", 400);
    const hits = deps.index.search({
      query: q,
      limit,
      ...(kind?.success ? { kind: kind.data } : {}),
    });
    return c.json(
      SearchReply.parse({ hits, complete: deps.feed.complete, mode: deps.index.mode }),
      200,
      { "cache-control": "no-store" },
    );
  });
}
