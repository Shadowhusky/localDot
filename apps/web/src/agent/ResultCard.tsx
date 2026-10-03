import type { ReactNode } from "react";
import type { AgentResult } from "./model.ts";

export function ResultCard({
  result,
  latest,
  ended,
  idle,
  children,
}: {
  result: AgentResult;
  latest: boolean;
  ended: boolean;
  idle: boolean;
  children?: ReactNode;
}) {
  return (
    <section className="result-preview" aria-label="Task result">
      <div className="activity-heading">
        <h3>Result</h3>
        <span>{latest ? "Latest" : "Earlier result"}</span>
      </div>
      <p className="result-summary">{result.summary}</p>
      <p className="history-note">
        {!result.files.length
          ? "No files attached to this result."
          : `${result.files.length} ${result.files.length === 1 ? "file" : "files"} attached.`}
      </p>
      {latest && (
        <p className="history-note">
          {ended
            ? "This task has ended. Its history remains available."
            : idle
              ? "Ready for a follow-up in Conversation."
              : "Result received. The task may continue."}
        </p>
      )}
      {children}
    </section>
  );
}
