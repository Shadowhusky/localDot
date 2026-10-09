import type { ReactNode } from "react";
import type { AgentQuestion } from "./model.ts";

const UNANSWERED = {
  timeout: "No answer in time, so dot carried on.",
  stop: "The task stopped before an answer.",
  pause: "The task paused before an answer.",
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
  return (
    <article className="thread-question" aria-label="Question">
      <p className="thread-question-text">{question.question}</p>
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
