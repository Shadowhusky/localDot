import type { AgentModel } from "./model.ts";

export type PlanPhase =
  | "working"
  | "waiting"
  | "paused"
  | "finished"
  | "stopped"
  | "blocked"
  | "error";

// Plan entries are the model's reported checklist, not the owner of the task lifecycle.
// Keep unfinished work honest while making it impossible for an ended plan to keep spinning.
export function planPhase(model: AgentModel): PlanPhase {
  if (model.ended)
    return model.ended.reason === "done"
      ? "finished"
      : model.ended.reason === "error"
        ? "error"
        : model.completion === "blocked"
          ? "blocked"
          : "stopped";
  if (model.completion) return model.completion === "complete" ? "finished" : "blocked";
  if (model.safetyPause || model.state?.state === "paused") return "paused";
  if (model.pendingAsk || model.pendingTakeover || model.approval || model.connection)
    return "waiting";
  if (model.state?.state === "waiting_user") return "waiting";
  if (model.state?.state === "done") return "finished";
  if (model.state?.state === "idle") return "stopped";
  if (model.state?.state === "error") return "error";
  return "working";
}
