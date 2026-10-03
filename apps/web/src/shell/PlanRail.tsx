import type { AgentModel } from "../agent/model.ts";
import type { ApiClient } from "../lib/api.ts";
import type { TimelineRow } from "../session/key-uses.ts";
import type { StepRowView } from "../session/session-view.ts";
import { KeyUseRow } from "./KeyUseRow.tsx";
import { StepRow } from "./StepRow.tsx";

export interface PlanRailProps {
  rows: TimelineRow<StepRowView>[];
  sessionId: string | null;
  scale: number;
  api: ApiClient;
  title: string | null;
  agent?: AgentModel;
}

export function PlanRail({ rows, sessionId, scale, api, title, agent }: PlanRailProps) {
  const lastStep = rows.findLastIndex((row) => row.kind === "step");
  return (
    <aside className="rail r" aria-label="Plan and steps">
      <div className="rail-h">
        <h2>Activity</h2>
      </div>
      {agent?.plan.length ? (
        <ol className="task-plan" aria-label="Task plan">
          {agent.plan.map((item) => (
            <li key={item.id} className={`plan-${item.status}`}>
              <span className="plan-state">
                {item.status === "doing"
                  ? "In progress"
                  : item.status === "done"
                    ? "Done"
                    : item.status === "skipped"
                      ? "Skipped"
                      : "Next"}
              </span>
              <span>{item.text}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="say empty">{title ?? "No plan yet."}</p>
      )}
      {agent?.results.map((result) => (
        <section key={result.id} className="result-preview" aria-label="Task result">
          <h3>Result</h3>
          <p>{result.summary}</p>
          {result.files.length > 0 && (
            <p className="history-note">
              {result.files.length} {result.files.length === 1 ? "file" : "files"} in this result.
            </p>
          )}
        </section>
      ))}
      <div className="rail-h">
        <span>Steps</span>
        {sessionId && <span>Following live</span>}
      </div>
      {sessionId && rows.length > 0 ? (
        <div className="steps">
          {rows.map((row, i) =>
            row.kind === "key" ? (
              <KeyUseRow key={`key-${row.id}`} row={row} />
            ) : (
              <StepRow
                key={`step-${row.id}`}
                row={row}
                sessionId={sessionId}
                scale={scale}
                api={api}
                current={i === lastStep && row.status === "doing"}
              />
            ),
          )}
        </div>
      ) : (
        <p className="say empty">Steps appear here as dot works.</p>
      )}
    </aside>
  );
}
