import type { AgentQuestion } from "./model.ts";

const UNANSWERED = {
  timeout: "No answer in time, so dot carried on.",
  stop: "The task stopped before an answer.",
  pause: "The task paused before an answer.",
  control: "You took the computer instead. dot will ask again if it still needs to know.",
} as const;

// dot's question in the thread. The answer panel takes the composer's place while it waits; the
// user's reply then shows as their own message under it.
export function QuestionCard({ question, pending }: { question: AgentQuestion; pending: boolean }) {
  const answer = question.answer;
  return (
    <article className="thread-question" aria-label="Question">
      <p className="thread-question-text">{question.question}</p>
      {answer && answer.by !== "user" ? (
        <p className="thread-note">{UNANSWERED[answer.by]}</p>
      ) : !answer && !pending ? (
        <p className="thread-note">dot stopped waiting for an answer.</p>
      ) : null}
    </article>
  );
}

export function answerText(question: AgentQuestion): string {
  const answer = question.answer;
  const chosen = question.options.find((option) => option.key === answer?.option);
  return [chosen?.text ?? answer?.option, answer?.text].filter(Boolean).join("\n\n");
}
