import type { LocalDotEvent } from "@localdot/protocol";
import type { LearnedExperience } from "../../../../packages/protocol/src/experience.ts";
import type { MemoryChangeRecord, MemoryStore } from "./memory.ts";

type Trace = {
  steps: Map<string, { kind: string; tool?: string; ok?: boolean; evidence?: string }>;
};
const internal = new Set([
  "recall",
  "remember",
  "done",
  "update_plan",
  "ask_user",
  "request_takeover",
]);

export class ExperienceRecorder {
  readonly #traces = new Map<string, Trace>();
  constructor(
    private readonly deps: {
      memory: Pick<MemoryStore, "learn">;
      allowed?(id: string): boolean;
      changed(id: string, change: MemoryChangeRecord): void;
    },
  ) {}

  event(id: string, event: LocalDotEvent): void {
    if (event.type === "session.end") {
      this.#traces.delete(id);
      return;
    }
    if (event.type === "step.start" && event.data.kind !== "ask") {
      if (!this.#traces.has(id)) this.#traces.set(id, { steps: new Map() });
      if (this.#traces.size > 128) this.#traces.delete(this.#traces.keys().next().value as string);
      const trace = this.#traces.get(id);
      if (trace && event.step) {
        trace.steps.set(event.step, { kind: event.data.kind });
        if (trace.steps.size > 64) trace.steps.delete(trace.steps.keys().next().value as string);
      }
    }
    const trace = this.#traces.get(id);
    const step = event.step ? trace?.steps.get(event.step) : undefined;
    if (!step) return;
    if (event.type === "tool.start") step.tool = event.data.tool;
    if (event.type === "tool.end" || event.type === "action.result") {
      step.ok = event.data.ok;
      step.evidence = event.id;
    }
    // A later failed/cancelled verification must not leave a successful receipt eligible.
    if (
      (event.type === "step.end" && event.data.status !== "ok") ||
      (event.type === "step.verify" && event.data.status !== "success")
    ) {
      step.ok = false;
      step.evidence =
        event.type === "step.end" && event.data.status !== "failed"
          ? undefined
          : step.evidence
            ? event.id
            : undefined;
    }
  }

  #steps(id: string) {
    return [...(this.#traces.get(id)?.steps.values() ?? [])].filter(
      (step) =>
        !!step.evidence && !internal.has(step.tool ?? "") && (step.kind !== "think" || step.tool),
    );
  }

  save(id: string, experience: LearnedExperience): boolean {
    const trace = this.#traces.get(id);
    const evidence = this.#steps(id).findLast(
      (step) =>
        step.evidence && (experience.outcome === "failed" ? step.ok === false : step.ok === true),
    )?.evidence;
    if (!trace || !evidence || this.deps.allowed?.(id) === false) return false;
    try {
      const change = this.deps.memory.learn(id, experience, evidence);
      if (change) this.deps.changed(id, change);
      return true;
    } catch {
      // Memory failure must not turn successful work into a stuck task.
      return false;
    }
  }
}
