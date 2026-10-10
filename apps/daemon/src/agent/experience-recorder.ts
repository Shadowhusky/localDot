import { clipText, type LocalDotEvent } from "@localdot/protocol";
import type { LearnedExperience } from "../../../../packages/protocol/src/experience.ts";
import type { MemoryChangeRecord, MemoryStore } from "./memory.ts";

type Trace = {
  steps: Map<string, { title: string; ok?: boolean; evidence?: string }>;
  saved: boolean;
};
export class ExperienceRecorder {
  readonly #traces = new Map<string, Trace>();
  constructor(
    private readonly deps: {
      memory: Pick<MemoryStore, "learn">;
      task(id: string): string | undefined;
      allowed?(id: string): boolean;
      changed(id: string, change: MemoryChangeRecord): void;
    },
  ) {}

  event(id: string, event: LocalDotEvent): void {
    if (event.type === "session.end") {
      this.#traces.delete(id);
      return;
    }
    if (event.type === "step.start" && ["shell", "file"].includes(event.data.kind)) {
      if (!this.#traces.has(id)) this.#traces.set(id, { steps: new Map(), saved: false });
      if (this.#traces.size > 128) this.#traces.delete(this.#traces.keys().next().value as string);
      const trace = this.#traces.get(id);
      if (trace && event.step) {
        trace.steps.set(event.step, { title: event.data.intent ?? "" });
        if (trace.steps.size > 24) trace.steps.delete(trace.steps.keys().next().value as string);
      }
    }
    const trace = this.#traces.get(id);
    if (!trace) return;
    const step = event.step ? trace.steps.get(event.step) : undefined;
    if (step && event.type === "tool.start") step.title = event.data.title ?? event.data.tool;
    if (step && event.type === "tool.end") {
      step.ok = event.data.ok;
      step.evidence = event.id;
    }
    if (event.type !== "task.result" || trace.saved) return;
    const steps = [...trace.steps.values()];
    const passed = steps.filter((s) => s.ok === true && s.title);
    const failed = steps.filter((s) => s.ok === false && s.title);
    const task = this.deps.task(id);
    // Avoid a diary of trivial actions. This fallback preserves an observed route;
    // a concise explicit lesson supplied in done is preferred when there is one.
    if (!task || !passed.length || (!failed.length && passed.length < 3)) return;
    this.save(id, {
      scope: clipText(task, 100),
      when: "Same project and environment; confirm versions and current state first.",
      procedure: clipText(
        `Observed successful steps: ${passed
          .slice(-3)
          .map((s) => s.title)
          .join(
            " → ",
          )}.${failed.length ? ` Earlier failed attempt: ${failed.at(-1)?.title}.` : ""}`,
        400,
      ),
      recheck:
        "Inspect the current project instructions and environment, then verify the result. Exit success alone is not proof of correctness.",
    });
  }

  save(id: string, experience: LearnedExperience): boolean {
    const trace = this.#traces.get(id);
    const evidence =
      trace && [...trace.steps.values()].findLast((step) => step.ok && step.evidence)?.evidence;
    if (!trace || !evidence || this.deps.allowed?.(id) === false) return false;
    try {
      const change = this.deps.memory.learn(id, experience, evidence);
      trace.saved = true;
      if (change) this.deps.changed(id, change);
      return true;
    } catch {
      // Memory failure must not turn successful work into a stuck task.
      return false;
    }
  }
}
