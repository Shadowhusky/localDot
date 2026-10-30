import type { AgentRunner } from "../agent/runner.ts";
import type { EventLog } from "../event-log.ts";
import type { LiveSessions } from "../gateway/live.ts";
import type { RoutineRunnerPort } from "./launch.ts";

export function agentRunnerPort(
  runner: Pick<AgentRunner, "start" | "end" | "get">,
  live: Pick<LiveSessions, "sessionsOn" | "settled" | "lease">,
  log: Pick<EventLog, "listSessions">,
): RoutineRunnerPort {
  return {
    start: (cellId, task, options) => runner.start(cellId, task, undefined, options),
    end: (id) => runner.end(id),
    live: (cellId) => live.sessionsOn(cellId),
    busy: (cellId) => live.lease(cellId).userHolds,
    parked: (id) => {
      const session = runner.get(id);
      return (
        !!session &&
        !session.stopped &&
        (session.pendingAsk !== undefined ||
          session.pendingTakeover !== undefined ||
          session.pendingApproval !== undefined)
      );
    },
    post: (id, text) => {
      const session = runner.get(id);
      if (!session || session.stopped || session.status !== "idle") return false;
      session.post("followup", text);
      return true;
    },
    settled: (id) => live.settled(id),
    title: (id) => log.listSessions().find((row) => row.id === id)?.title ?? undefined,
  };
}
