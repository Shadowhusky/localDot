import type { ModelOptions } from "@localdot/protocol";
import type { ResolvedRole } from "../bindings.ts";
import type { SideModel } from "./agent.ts";

export type SideSelection =
  | { readonly kind: "api"; readonly roles: readonly ResolvedRole[] }
  | {
      readonly kind: "claude-code";
      readonly fast?: unknown;
      readonly quick: readonly { readonly model: string; readonly options?: ModelOptions }[];
    }
  | { readonly kind: "chatgpt" }
  | { readonly kind: "none" };
export interface SideModelDeps {
  api(role: ResolvedRole, side: SideModel["role"]): SideModel;
  plan?(quick: { model: string; options?: ModelOptions }, side: SideModel["role"]): SideModel;
}

// Who answers: the models the user chose for this task, as its next message would run on them,
// and no other. The fast model goes first, then the main one, then a local one: the user chose to
// show the task to each. Any other model, even one set up in Settings, would take the task's record
// to a provider it never went to, so a task none of its own can answer is told why instead. The
// ChatGPT plan's one Codex process is the task's.
export function sideModels(selection: SideSelection, deps: SideModelDeps): SideModel[] {
  if (selection.kind === "api") {
    const fast = selection.roles.find((role) => role.role === "fast");
    const main = selection.roles.find((role) => role.role === "main");
    return [
      ...(fast ? [deps.api(fast, "fast")] : []),
      ...(main ? [deps.api(main, "main")] : []),
      ...selection.roles
        .filter((role) => role.role === "local")
        .map((role) => deps.api(role, "other")),
    ];
  }
  if (selection.kind !== "claude-code" || !deps.plan) return [];
  const plan = deps.plan;
  return selection.quick.map((quick, at) =>
    plan(quick, selection.fast && at === 0 ? "fast" : "main"),
  );
}
