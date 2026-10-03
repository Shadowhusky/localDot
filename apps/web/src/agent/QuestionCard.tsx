import type { ReactNode } from "react";
import type { AgentQuestion } from "./model.ts";

// The answer controller is separate. History cards never submit an answer or infer ownership.
export function QuestionCard({
  question,
  pending,
  children,
}: {
  question: AgentQuestion;
  pending: boolean;
  children?: ReactNode;
}) {
  const answer = question.answer;
  const selected = question.options.find((option) => option.key === answer?.option);
  return (
    <section className="question-card" aria-label="Question">
      <div className="activity-heading">
        <h3>Question</h3>
        <span>
          {answer
            ? answer.by === "stop"
              ? "Stopped"
              : answer.by === "timeout"
                ? "Timed out"
                : "Answered"
            : pending
              ? "Waiting for you"
              : "No longer waiting"}
        </span>
      </div>
      <p>{question.question}</p>
      {answer?.option && <p>Answer: {selected?.text ?? answer.option}</p>}
      {answer?.text && <p>{answer.text}</p>}
      {children}
    </section>
  );
}
