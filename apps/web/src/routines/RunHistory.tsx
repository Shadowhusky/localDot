import type { RoutineRun } from "@localdot/protocol";
import { Button } from "../ui/Button.tsx";
import { Skeleton } from "../ui/Skeleton.tsx";
import { StatusGlyph } from "../ui/StatusGlyph.tsx";
import { OUTCOME_WORDS, outcomeGlyph, runLine, whenText } from "./routine-copy.ts";

// A routine's runs, newest first: how each went, in plain words, and its recording when it has one.
export function RunHistory({
  runs,
  tz,
  onOpen,
}: {
  // Undefined while they load.
  runs: readonly RoutineRun[] | undefined;
  tz: string;
  onOpen?(sessionId: string): void;
}) {
  if (runs === undefined) return <Skeleton loading shape="block" width="100%" height="132px" />;
  if (runs.length === 0) return <p className="routine-history-empty">It hasn't run yet.</p>;
  const now = Date.now();
  return (
    <ol className="routine-history" aria-label="Recent runs">
      {runs.map((run) => {
        const recorded = run.sessionId;
        return (
          <li key={run.id} className="routine-run" data-outcome={run.outcome}>
            <StatusGlyph state={outcomeGlyph(run.outcome)} label={OUTCOME_WORDS[run.outcome]} />
            <span className="routine-run-text">
              <span className="routine-run-line">{runLine(run, tz)}</span>
              <time className="routine-run-time num" dateTime={run.dueAt}>
                {whenText(Date.parse(run.startedAt ?? run.dueAt), tz, now)}
              </time>
            </span>
            {recorded && onOpen && run.outcome !== "running" && run.outcome !== "pending" && (
              <Button variant="quiet" size="sm" onClick={() => onOpen(recorded)}>
                Watch
              </Button>
            )}
          </li>
        );
      })}
    </ol>
  );
}
