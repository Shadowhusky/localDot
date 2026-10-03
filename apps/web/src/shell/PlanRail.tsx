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
}

export function PlanRail({ rows, sessionId, scale, api, title }: PlanRailProps) {
  const lastStep = rows.findLastIndex((row) => row.kind === "step");
  return (
    <aside className="rail r" aria-label="Plan and steps">
      <div className="rail-h">
        <span>Plan</span>
      </div>
      <p className="say empty">{title ?? "No plan yet."}</p>
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
