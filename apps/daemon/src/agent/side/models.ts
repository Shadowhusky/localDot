import type { KeydRecord, ModelOptions } from "@localdot/protocol";
import { type Catalog, modelControls } from "@localdot/providers";
import { BindingError, CHATGPT, CLAUDE_CODE, type ResolvedRole, resolveRole } from "../bindings.ts";
import { leastEffort } from "../first-look.ts";
import type { AgentSettings, RoleChoice } from "../settings.ts";
import type { SideModel } from "./agent.ts";

const SPARES = 2;

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
  settings: AgentSettings;
  keys(): Promise<KeydRecord[]>;
  catalog(): Catalog | undefined;
  // Claude Code is there and signed in.
  claudeReady(): Promise<boolean>;
  api(role: ResolvedRole, side: SideModel["role"]): SideModel;
  plan?(quick: { model: string; options?: ModelOptions }, side: SideModel["role"]): SideModel;
}

const leastOf = (model: string) => {
  const least = leastEffort(modelControls(CLAUDE_CODE, model).efforts);
  return { model, ...(least ? { options: { reasoningEffort: least } } : {}) };
};

// Who answers: the task's fast model, then its main one. After them, or instead of them on the
// ChatGPT plan, whose one Codex process is the task's, any other model the user has set up: the
// question doesn't have to run inside the task's own harness.
export async function sideModels(
  selection: SideSelection,
  deps: SideModelDeps,
): Promise<SideModel[]> {
  const own: SideModel[] = [];
  if (selection.kind === "api") {
    const fast = selection.roles.find((role) => role.role === "fast");
    const main = selection.roles.find((role) => role.role === "main");
    if (fast) own.push(deps.api(fast, "fast"));
    if (main) own.push(deps.api(main, "main"));
    for (const role of selection.roles.filter((each) => each.role === "local"))
      own.push(deps.api(role, "other"));
  } else if (selection.kind === "claude-code" && deps.plan) {
    selection.quick.forEach((quick, at) => {
      const isFast = !!selection.fast && at === 0;
      const model = deps.plan?.(quick, isFast ? "fast" : "main");
      if (model) own.push(model);
    });
  }
  const { fast, local, main, models } = deps.settings;
  const known = (provider: string, model: string) =>
    own.some((each) => each.provider === provider && each.model === model);
  const spares: SideModel[] = [];
  let keys: KeydRecord[] | undefined;
  for (const choice of [fast, local, main, ...(models ?? [])]) {
    if (spares.length >= SPARES) break;
    if (!choice || choice.provider === CHATGPT || known(choice.provider, choice.model)) continue;
    if (spares.some((each) => each.provider === choice.provider && each.model === choice.model))
      continue;
    const spare = await spareOf(choice, deps, async () => {
      keys ??= await deps.keys().catch(() => []);
      return keys;
    });
    if (spare) spares.push(spare);
  }
  return [...own, ...spares];
}

async function spareOf(
  choice: RoleChoice,
  deps: SideModelDeps,
  keys: () => Promise<KeydRecord[]>,
): Promise<SideModel | undefined> {
  if (choice.provider === CLAUDE_CODE)
    return (await deps.claudeReady().catch(() => false))
      ? deps.plan?.(leastOf(choice.model), "other")
      : undefined;
  try {
    return deps.api(resolveRole("fast", choice, deps.catalog(), await keys()), "other");
  } catch (error) {
    if (error instanceof BindingError) return undefined;
    throw error;
  }
}
