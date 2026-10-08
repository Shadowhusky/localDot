import { createHash } from "node:crypto";
import type { GuiAction, NativeActionIdentity } from "../../gateway/gateway.ts";

function canonical(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonical);
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, canonical(item)]),
  );
}
function effect(action: GuiAction, identity: NativeActionIdentity): unknown {
  switch (action.verb) {
    case "key":
      return { verb: action.verb, combo: action.combo };
    case "click":
      return {
        verb: action.verb,
        point: identity.point,
        button: action.button ?? "left",
        count: action.count ?? 1,
      };
    case "type":
      return { verb: action.verb, text: action.text, masked: action.masked === true };
    case "scroll":
      return { verb: action.verb, point: identity.point, dx: action.dx, dy: action.dy };
    case "wait":
      return undefined;
  }
}
// One private task owner, checked immediately before each actual native dispatch.
// Presentation labels, screenshot IDs and motion speed cannot disguise the same input, nor can a
// repeat count or a hold: a combo is the same input however often or long it is pressed.
// Observations/waits do not dispatch input and cannot reset a repeated-action streak.
// An identical input repeats the last one only if that one changed nothing on the screen (settle);
// an input whose settle never reported counts as one without effect.
function digestOf(action: GuiAction, identity: NativeActionIdentity): string | undefined {
  const input = effect(action, identity);
  if (input === undefined) return undefined;
  return createHash("sha256")
    .update(JSON.stringify(canonical({ input, identity })))
    .digest("hex");
}
export class RepeatGuard {
  #digest: string | undefined;
  #streak = 0;
  #changed = false;
  admit(action: GuiAction, identity: NativeActionIdentity): boolean {
    const digest = digestOf(action, identity);
    if (digest === undefined) return true;
    if (digest === this.#digest && !this.#changed) this.#streak++;
    else {
      this.#digest = digest;
      this.#streak = 1;
    }
    this.#changed = false;
    return this.#streak < 3;
  }
  // An admitted input's outcome: whether the screen changed after it. Only the last admitted input
  // counts; a late report about an earlier one (another screen's) is ignored.
  settle(action: GuiAction, identity: NativeActionIdentity, changed: boolean): void {
    if (digestOf(action, identity) === this.#digest) this.#changed = changed;
  }
  reset(): void {
    this.#digest = undefined;
    this.#streak = 0;
    this.#changed = false;
  }
}
