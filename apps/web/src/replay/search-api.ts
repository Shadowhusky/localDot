import { SEARCH_QUERY_MAX, type SearchHit, SearchReply } from "@localdot/protocol";
import { useEffect, useState } from "react";
import type { ApiClient } from "../lib/api.ts";

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
export const SEARCH_DEBOUNCE_MS = 250;

export async function searchTasks(
  api: ApiClient,
  query: string,
  signal: AbortSignal,
): Promise<SearchReply> {
  return SearchReply.parse(
    await api.get(`/api/search?q=${encodeURIComponent(query.slice(0, SEARCH_QUERY_MAX))}`, {
      signal,
    }),
  );
}

export const searchable = (query: string) => {
  const q = query.trim();
  return q.length >= 2 || CJK.test(q);
};

export interface TaskMatches {
  // The best match in each task's words, by task.
  tasks: ReadonlyMap<string, SearchHit>;
  // Daily notes that match, which belong to no task still kept.
  notes: readonly SearchHit[];
  // A newer query is still being looked up.
  pending: boolean;
}
const NONE: TaskMatches = { tasks: new Map(), notes: [], pending: false };

// What earlier tasks said that matches the query, looked up once typing pauses. The last answer
// stays until the next arrives, so rows don't blink while the user types.
export function useTaskSearch(api: ApiClient, query: string): TaskMatches {
  const q = query.trim();
  const eligible = searchable(q);
  const [found, setFound] = useState<{ query: string; matches: TaskMatches }>({
    query: "",
    matches: NONE,
  });
  useEffect(() => {
    if (!eligible) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      searchTasks(api, q, controller.signal).then(
        (reply) => {
          if (controller.signal.aborted) return;
          setFound({
            query: q,
            matches: {
              tasks: new Map(
                reply.hits.flatMap((hit) => (hit.sessionId ? [[hit.sessionId, hit] as const] : [])),
              ),
              notes: reply.hits.filter((hit) => hit.sessionId === null),
              pending: false,
            },
          });
        },
        () => {
          if (!controller.signal.aborted) setFound({ query: q, matches: NONE });
        },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [api, q, eligible]);
  if (!eligible) return NONE;
  return found.query === q ? found.matches : { ...found.matches, pending: true };
}
