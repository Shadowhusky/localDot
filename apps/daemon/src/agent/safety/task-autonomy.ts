import type { ActionClass, RuleChange, ScreenName } from "@localdot/protocol";
import {
  ALWAYS_SCOPES,
  type Place,
  type PlacedOption,
  type RulesStore,
  ruleChange,
} from "./rules.ts";

// Per-task autonomy state, never persisted. The browser screen holds the user's logins; the
// desktop's browser starts empty each task, so it counts as signed in only after the user
// signed in on it during this task. Allowances for this task end with it.
export class TaskAutonomy {
  #desktopSignedIn = false;
  // Allowances for this task, by class, or by class and place for one given on a card.
  readonly #allowed = new Map<string, RuleChange>();
  // Connections allowed for this task, by destination: one yes never opens every port.
  readonly #destinations = new Map<string, RuleChange>();
  // Connected apps' tools allowed for this task, by dot's name for each.
  readonly #tools = new Map<string, RuleChange>();
  constructor(
    private readonly rules?: Pick<RulesStore, "matches" | "add"> &
      Partial<Pick<RulesStore, "trusts">>,
  ) {}
  signedIn(screen: ScreenName): boolean {
    return screen === "browser" || this.#desktopSignedIn;
  }
  signIn(screen: ScreenName): void {
    if (screen === "desktop") this.#desktopSignedIn = true;
  }
  trusts(host: string): boolean {
    return this.rules?.trusts?.(host) === true;
  }
  relaxes(actionClass: ActionClass, place: Place): boolean {
    if (place.tool !== undefined)
      return ALWAYS_SCOPES[actionClass].includes("task") && this.#tools.has(place.tool);
    const scopes = ALWAYS_SCOPES[actionClass];
    const forTask =
      actionClass === "network"
        ? place.destination !== undefined && this.#destinations.has(place.destination)
        : this.#allowed.has(actionClass) || this.#allowed.has(placed(actionClass, place));
    return (
      (scopes.includes("task") && forTask) ||
      (scopes.some((scope) => scope !== "task") && this.rules?.matches(actionClass, place) === true)
    );
  }
  grant(
    actionClass: ActionClass,
    option: PlacedOption,
    approvalId: string,
  ): RuleChange | undefined {
    if (!ALWAYS_SCOPES[actionClass].includes(option.scope)) return undefined;
    if (option.tool !== undefined) {
      if (option.scope !== "task" || this.#tools.has(option.tool)) return undefined;
      const change = { scope: option.scope, actionClass, label: option.label, tool: option.tool };
      this.#tools.set(option.tool, change);
      return change;
    }
    if (option.scope === "task" && actionClass === "network") {
      if (option.destination === undefined || this.#destinations.has(option.destination))
        return undefined;
      const change = {
        scope: option.scope,
        actionClass,
        label: option.label,
        destination: option.destination,
      };
      this.#destinations.set(option.destination, change);
      return change;
    }
    if (option.scope === "task") {
      const key = option.place === undefined ? actionClass : placed(actionClass, option.place);
      if (this.#allowed.has(key)) return undefined;
      const change = { scope: option.scope, actionClass, label: option.label };
      this.#allowed.set(key, change);
      return change;
    }
    const rule = this.rules?.add(actionClass, option, approvalId);
    return rule && ruleChange(rule);
  }
  // A connection's allowance ends for its own destination only; any other class's, everywhere.
  revoke(actionClass: ActionClass, destination?: string): RuleChange | undefined {
    if (actionClass === "network") {
      const change = destination === undefined ? undefined : this.#destinations.get(destination);
      if (change && destination !== undefined) this.#destinations.delete(destination);
      return change;
    }
    let change: RuleChange | undefined;
    for (const [key, allowed] of this.#allowed)
      if (allowed.actionClass === actionClass) {
        change ??= allowed;
        this.#allowed.delete(key);
      }
    return change;
  }
}

// A yes for this task on a class the user may also allow per site covers steps in the same place:
// on that site, else in that app, else neither, and a deletion inside the computer apart from one
// of online data.
function placed(actionClass: ActionClass, place: Place): string {
  if (!ALWAYS_SCOPES[actionClass].includes("site")) return actionClass;
  return JSON.stringify([
    actionClass,
    place.site ?? null,
    place.site === undefined ? (place.app ?? null) : null,
    place.inside ?? null,
  ]);
}
