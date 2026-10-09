import { ConversationSnapshot } from "@localdot/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { type ApiClient, ApiError } from "../lib/api.ts";
import { announce } from "../ui/Announcer.tsx";

export const FINISH_FIRST = "Finish or stop the current task first.";

export interface Conversation {
  // The conversation's tasks, oldest first; the next message continues the latest.
  readonly sessions: readonly string[];
  // Older tasks of the conversation are left out.
  readonly more: boolean;
  // The daemon has said which conversation is current.
  readonly known: boolean;
  readonly busy: boolean;
  startNew(): Promise<boolean>;
  continueFrom(sessionId: string): Promise<boolean>;
  reload(): void;
}

const NONE: ConversationSnapshot = { sessions: [], more: false };

// Which conversation is current is the daemon's: a refresh, a stopped computer or a restart reads
// it back. The newest request wins, so a slow read never undoes a choice made after it.
export function useConversation(api: ApiClient): Conversation {
  const [state, setState] = useState<{ snapshot: ConversationSnapshot; known: boolean }>({
    snapshot: NONE,
    known: false,
  });
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const latest = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new revision reads it again.
  useEffect(() => {
    const ask = ++latest.current;
    const controller = new AbortController();
    api
      .get("/api/conversation", { signal: controller.signal })
      .then((data) => {
        if (ask === latest.current)
          setState({ snapshot: ConversationSnapshot.parse(data), known: true });
      })
      .catch(() => {});
    return () => controller.abort();
  }, [api, revision]);
  const act = useCallback(
    async (path: string, body?: unknown) => {
      const ask = ++latest.current;
      setBusy(true);
      try {
        const snapshot = ConversationSnapshot.parse(await api.post(path, body));
        if (ask === latest.current) setState({ snapshot, known: true });
        return true;
      } catch (error) {
        announce(
          "conversation",
          error instanceof ApiError && error.status === 409
            ? FINISH_FIRST
            : "That didn't work. Check the connection and try again.",
          "assertive",
        );
        return false;
      } finally {
        setBusy(false);
      }
    },
    [api],
  );
  const startNew = useCallback(() => act("/api/conversation/new"), [act]);
  const continueFrom = useCallback(
    (sessionId: string) => act("/api/conversation/continue", { sessionId }),
    [act],
  );
  const reload = useCallback(() => setRevision((value) => value + 1), []);
  return {
    sessions: state.snapshot.sessions,
    more: state.snapshot.more,
    known: state.known,
    busy,
    startNew,
    continueFrom,
    reload,
  };
}
