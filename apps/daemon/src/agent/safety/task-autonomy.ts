import type { ActionClass, AlwaysOption, RuleChange, ScreenName } from "@localdot/protocol";
import { ALWAYS_SCOPES, type Place, type RulesStore, ruleChange } from "./rules.ts";

// Per-task autonomy state, never persisted. The browser screen holds the user's logins; the
// desktop's browser starts empty each task, so it counts as signed in only after the user
// signed in on it during this task. Allowances for this task end with it.
export class TaskAutonomy {
  #desktopSignedIn = false;
  readonly #allowed = new Map<ActionClass, RuleChange>();
  // Connections allowed for this task, by destination: one yes never opens every port.
  readonly #destinations = new Map<string, RuleChange>();
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
    const scopes = ALWAYS_SCOPES[actionClass];
    const forTask =
      actionClass === "network"
        ? place.destination !== undefined && this.#destinations.has(place.destination)
        : this.#allowed.has(actionClass);
    return (
      (scopes.includes("task") && forTask) ||
      (scopes.some((scope) => scope !== "task") && this.rules?.matches(actionClass, place) === true)
    );
  }
  grant(
    actionClass: ActionClass,
    option: AlwaysOption,
    approvalId: string,
  ): RuleChange | undefined {
    if (!ALWAYS_SCOPES[actionClass].includes(option.scope)) return undefined;
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
      if (this.#allowed.has(actionClass)) return undefined;
      const change = { scope: option.scope, actionClass, label: option.label };
      this.#allowed.set(actionClass, change);
      return change;
    }
    const rule = this.rules?.add(actionClass, option, approvalId);
    return rule && ruleChange(rule);
  }
  // A connection's allowance ends for its own destination only.
  revoke(actionClass: ActionClass, destination?: string): RuleChange | undefined {
    if (actionClass === "network") {
      const change = destination === undefined ? undefined : this.#destinations.get(destination);
      if (change && destination !== undefined) this.#destinations.delete(destination);
      return change;
    }
    const change = this.#allowed.get(actionClass);
    this.#allowed.delete(actionClass);
    return change;
  }
}
