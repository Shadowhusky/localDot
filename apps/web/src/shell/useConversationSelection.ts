import { useEffect, useRef, useState } from "react";
import type { ConversationRow } from "../agent/conversation-list.ts";
import { choose, selectedLabel } from "../agent/conversation-selection.ts";
import { announce } from "../ui/Announcer.tsx";

const NONE: ReadonlySet<string> = new Set();

export interface ConversationSelection {
  selecting: boolean;
  // The chosen among those listed, in their order: what an action takes.
  picked: readonly ConversationRow[];
  chosen(id: string): boolean;
  // Starts with `id` chosen, or the run from `from` to it, or none.
  start(id?: string, from?: string | null): void;
  // A press on a row; with `range`, the run from the one pressed before.
  press(id: string, range: boolean): void;
  all(on: boolean): void;
  stop(): void;
  // Those an action took away. Once none is left chosen, selecting ends.
  drop(ids: readonly string[]): void;
}

// Choosing conversations to act on together. Only those listed count, so what shows ticked is
// what an action takes; the count is announced as it changes.
export function useConversationSelection(
  listed: readonly ConversationRow[],
): ConversationSelection {
  const [selecting, setSelecting] = useState(false);
  const [chosen, setChosen] = useState(NONE);
  const last = useRef<string | null>(null);
  const order = listed.map((row) => row.entry.sessionId);
  const picked = listed.filter((row) => chosen.has(row.entry.sessionId));
  const n = picked.length;
  useEffect(() => {
    if (selecting) announce("conversation-selection", selectedLabel(n));
  }, [selecting, n]);
  const stop = () => {
    setSelecting(false);
    setChosen(NONE);
    last.current = null;
  };
  return {
    selecting,
    picked,
    chosen: (id) => chosen.has(id),
    start(id, from = null) {
      setSelecting(true);
      setChosen(id ? choose(NONE, order, id, from) : NONE);
      last.current = id ?? null;
    },
    press(id, range) {
      const from = range ? last.current : null;
      setChosen((was) => choose(was, order, id, from));
      last.current = id;
    },
    all(on) {
      setChosen(on ? new Set(order) : NONE);
      last.current = null;
    },
    stop,
    drop(ids) {
      const rest = new Set([...chosen].filter((id) => !ids.includes(id)));
      if (picked.every((row) => !rest.has(row.entry.sessionId))) stop();
      else setChosen(rest);
    },
  };
}
