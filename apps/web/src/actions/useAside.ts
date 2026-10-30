import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient } from "../lib/api.ts";
import { announce } from "../ui/Announcer.tsx";
import { askSideQuestion, type SideAnswer, SideQuestionFailure } from "./side-question.ts";

// What shows at the end of the thread for the user alone: a side question and its answer, or the
// plans' usage. dot never sees either.
export type Aside =
  | {
      readonly kind: "question";
      readonly id: number;
      readonly sessionId: string;
      readonly question: string;
      readonly phase: "asking" | "answered" | "failed";
      readonly answer?: SideAnswer;
      readonly problem?: string;
      // The fix is choosing a Fast model.
      readonly setup?: boolean;
    }
  | { readonly kind: "usage"; readonly id: number };

export interface AsideControl {
  readonly aside: Aside | null;
  ask(question: string): void;
  retry(): void;
  showUsage(): void;
  dismiss(): void;
}

export function useAside(api: ApiClient, sessionId: string | null): AsideControl {
  const [aside, setAside] = useState<Aside | null>(null);
  const asking = useRef<AbortController | null>(null);
  const ids = useRef(0);
  const latest = useRef({ api, sessionId });
  latest.current = { api, sessionId };
  const stop = useCallback(() => {
    asking.current?.abort();
    asking.current = null;
  }, []);
  // Another task's side question goes with it.
  useEffect(() => {
    setAside((shown) =>
      shown?.kind === "question" && shown.sessionId !== sessionId ? null : shown,
    );
    return stop;
  }, [sessionId, stop]);
  const ask = useCallback(
    (question: string) => {
      const { api, sessionId } = latest.current;
      if (!sessionId) return;
      stop();
      const abort = new AbortController();
      asking.current = abort;
      const id = ++ids.current;
      const shown = { kind: "question", id, sessionId, question } as const;
      setAside({ ...shown, phase: "asking" });
      askSideQuestion(api, sessionId, question, abort.signal).then(
        (answer) => {
          if (abort.signal.aborted) return;
          asking.current = null;
          setAside({ ...shown, phase: "answered", answer });
          announce("aside", "Your side question has an answer.");
        },
        (error: unknown) => {
          if (abort.signal.aborted) return;
          asking.current = null;
          const failure =
            error instanceof SideQuestionFailure
              ? error
              : new SideQuestionFailure("Your Fast model didn't answer. Try again.");
          setAside({ ...shown, phase: "failed", problem: failure.message, setup: failure.setup });
        },
      );
    },
    [stop],
  );
  return {
    aside,
    ask,
    retry: () => {
      if (aside?.kind === "question") ask(aside.question);
    },
    showUsage: () => {
      stop();
      setAside({ kind: "usage", id: ++ids.current });
    },
    dismiss: () => {
      stop();
      setAside(null);
    },
  };
}
