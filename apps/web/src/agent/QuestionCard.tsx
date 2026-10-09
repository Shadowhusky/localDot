import { type ReactNode, useMemo } from "react";
import { RevealedText } from "./ApprovalValue.tsx";
import { markdownToPlain } from "./markdown.ts";
import type { AgentQuestion } from "./model.ts";
import { hiddenWarning, revealText } from "./reveal-text.ts";

const UNANSWERED = {
  timeout: "No answer in time, so dot carried on.",
  stop: "The task stopped before an answer.",
  pause: "The task paused before an answer.",
  control: "You took the computer instead. dot will ask again if it still needs to know.",
} as const;

// dot's question in the thread, with its fields under it while dot waits; your answer then shows
// as your own message under it.
export function QuestionCard({
  question,
  pending,
  form,
}: {
  question: AgentQuestion;
  pending: boolean;
  form?: ReactNode;
}) {
  const answer = question.answer;
  const plain = useMemo(() => markdownToPlain(question.question), [question.question]);
  const asked = useMemo(() => revealText(plain), [plain]);
  return (
    <article className="thread-question" aria-label="Question">
      <p
        className="thread-question-text"
        {...(form ? { id: `ask-${question.askId}`, tabIndex: -1 } : {})}
      >
        <RevealedText text={plain} />
      </p>
      {asked.hidden && <p className="decision-warning">{hiddenWarning(asked)}</p>}
      {answer && answer.by !== "user" ? (
        <p className="thread-note">{UNANSWERED[answer.by]}</p>
      ) : !answer && !pending ? (
        <p className="thread-note">dot stopped waiting for an answer.</p>
      ) : (
        !answer && form
      )}
    </article>
  );
}
