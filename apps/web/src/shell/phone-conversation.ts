import { type PersonaId, taskOutfit, type Wearable } from "@localdot/protocol";
import { useCallback, useMemo } from "react";
import {
  conversationLook,
  conversationRows,
  type LiveFacts,
  lookSeed,
  useRecentConversations,
} from "../agent/conversation-list.ts";
import type { ApiClient } from "../lib/api.ts";

// The conversation on show, by the entry its list read: how its row stands and what its dot wears,
// so the dot on screen, the lines naming a dot and the headers wear what its row does, in Chat and
// in Studio alike. A task the list has yet to hear of is found by the conversation's other tasks
// (`tasks`), and `persona` is the dot its live task works as by that task's own events, which can
// come a moment before the list hears of it.
export function usePhoneConversation(
  api: ApiClient,
  shownId: string | null | undefined,
  tasks: readonly string[],
  facts: LiveFacts,
  persona: PersonaId | undefined,
  worn: readonly Wearable[],
) {
  const recent = useRecentConversations(api, true);
  const entryOf = useCallback(
    (id: string | null | undefined) =>
      id
        ? recent.entries.find((entry) => entry.sessionId === id || entry.sessions.includes(id))
        : undefined,
    [recent.entries],
  );
  const entry = entryOf(shownId);
  const row = useMemo(
    () => (entry ? conversationRows([entry], facts)[0] : undefined),
    [entry, facts],
  );
  // The conversation's entry for its look, which a new task's siblings already have.
  const dressedBy =
    entry ?? (shownId && tasks.includes(shownId) ? tasks.map(entryOf).find(Boolean) : undefined);
  const seed = dressedBy ? lookSeed(dressedBy) : (shownId ?? "");
  const dressed = dressedBy
    ? conversationLook(dressedBy, persona)
    : shownId
      ? taskOutfit(shownId, persona)
      : worn;
  const words = dressed.join(" ");
  // biome-ignore lint/correctness/useExhaustiveDependencies: the outfit's words say when it changed.
  const look = useMemo(() => dressed, [words]);
  // As each dot, for the lines that name one.
  const lookAs = useCallback(
    (dot: PersonaId) => (dressedBy ? conversationLook(dressedBy, dot) : taskOutfit(seed, dot)),
    [dressedBy, seed],
  );
  return { entryOf, entry, row, look, seed, lookAs, listing: recent.loading };
}
