import { microsToMs } from "@localdot/protocol";
import type { KeyUseState } from "@localdot/stage";
import { type TimelineRow, timelineRows } from "../session/key-uses.ts";
import type { StepRowView } from "../session/session-view.ts";
import type { AgentChange, AgentModel, AgentStep } from "./model.ts";

export type ActivityFilter = "all" | "computer" | "tools";
export interface ActivityStep {
  id: string;
  startT: number;
  computer?: StepRowView;
  agent?: AgentStep;
}

// Both event projections describe the same GUI step. Join by envelope ID, never by title.
// The raw audit events allow grouping only after tools have joined the ordered history.
export function activityRows(
  rows: readonly TimelineRow<StepRowView>[],
  model?: AgentModel,
  keyUses?: readonly KeyUseState[],
): TimelineRow<ActivityStep>[] {
  const steps = new Map<string, ActivityStep>();
  for (const row of rows) {
    if (row.kind === "step")
      steps.set(row.id, {
        id: row.id,
        startT: row.startT,
        computer: row,
        agent: model?.steps.get(row.id),
      });
  }
  for (const row of model?.steps.values() ?? []) {
    if (steps.has(row.id)) continue;
    const at = row.startedAt ?? row.firstSeenAt;
    steps.set(row.id, {
      id: row.id,
      startT: at === undefined ? Number.POSITIVE_INFINITY : microsToMs(at),
      agent: row,
    });
  }
  if (keyUses) return timelineRows([...steps.values()], keyUses);
  return [
    ...[...steps.values()].map((row) => ({ ...row, kind: "step" as const })),
    ...rows.filter((row) => row.kind === "key"),
  ].sort((a, b) => (a.kind === "key" ? a.t : a.startT) - (b.kind === "key" ? b.t : b.startT));
}
export function matchesFilter(row: TimelineRow<ActivityStep>, filter: ActivityFilter): boolean {
  if (filter === "all") return true;
  const computer = row.kind === "step" && (row.computer || row.agent?.kind === "gui");
  return filter === "computer" ? !!computer : !computer;
}
export function stepStatus(step: AgentStep, ended: boolean): string {
  if (step.status)
    return { ok: "Completed", failed: "Failed", blocked: "Blocked", cancelled: "Cancelled" }[
      step.status
    ];
  if (ended) return "Completion not confirmed";
  if (step.tool?.ok !== undefined) return "Step completion not confirmed";
  return "Running";
}
export function memoryUndoEligible(change: AgentChange, changes: readonly AgentChange[]): boolean {
  return (
    change.type === "memory" &&
    !!change.changeId &&
    !change.undoes &&
    !changes.some((row) => row.type === "memory" && row.undoes === change.changeId)
  );
}
