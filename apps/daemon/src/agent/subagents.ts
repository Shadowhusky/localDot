import { existsSync, readFileSync } from "node:fs";
import {
  type EventOf,
  MAX_SUBAGENT_BRIEFS,
  RESUMABLE_STOPS,
  type SubagentBrief,
  type SubagentResume,
} from "@localdot/protocol";
import { parseLine } from "../event-file.ts";

type Run = EventOf<"subagent.state">["data"];
const LEDGER_LINES = /"type":"(?:subagent\.state|task\.result|session\.end)"/;

// Each delegated agent's latest run in one task. A run a limit, an error, a restart or the user
// taking the computer left unfinished resumes when dot continues; a completed task settles what
// its agents left, and a stopped task leaves them stopped.
export class SubagentLedger {
  readonly #latest = new Map<string, Run>();
  #ended = false;
  fold(type: string, data: unknown): void {
    if (type === "subagent.state") {
      const run = data as Run;
      this.#latest.delete(run.id);
      this.#latest.set(run.id, run);
    } else if (type === "task.result" && (data as { outcome?: string }).outcome !== "blocked") {
      for (const [id, run] of this.#latest) if (run.state !== "running") this.#latest.delete(id);
    } else if (type === "session.end") this.#ended = true;
  }
  has(id: string): boolean {
    return this.#latest.has(id);
  }
  running(): Run[] {
    return [...this.#latest.values()].filter((run) => run.state === "running");
  }
  unfinished(): Run[] {
    const left = [...this.#latest.values()].filter(
      (run) => run.state === "interrupted" && !!run.reason && RESUMABLE_STOPS.has(run.reason),
    );
    // A log without its end belongs to a daemon that stopped with its agents still running.
    return this.#ended
      ? left
      : [
          ...left,
          ...this.running().map((run) => ({
            ...run,
            state: "interrupted" as const,
            reason: "restarted" as const,
          })),
        ];
  }
}

// Only the agents with a brief can be handed on: one-shot children keep none, as their result
// belongs to dot's own call.
export function resumable(
  runs: readonly Run[],
  briefs: readonly SubagentBrief[],
): SubagentResume[] {
  return runs
    .flatMap((run) => {
      const brief = briefs.find((b) => b.id === run.id);
      return brief && run.reason
        ? [{ ...brief, label: run.label, runId: run.runId, reason: run.reason }]
        : [];
    })
    .slice(-MAX_SUBAGENT_BRIEFS);
}

// The delegated agents an earlier task's log shows it left unfinished.
export function unfinishedIn(logFile: string): Run[] {
  const ledger = new SubagentLedger();
  if (!existsSync(logFile)) return [];
  const text = readFileSync(logFile, "utf8");
  for (const line of text.slice(0, text.lastIndexOf("\n") + 1).split("\n")) {
    if (!LEDGER_LINES.test(line)) continue;
    const event = parseLine(line);
    if (event) ledger.fold(event.type, event.data);
  }
  return ledger.unfinished();
}
