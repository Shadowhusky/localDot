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
        mods: action.mods ?? [],
      };
    case "type":
      return { verb: action.verb, text: action.text, masked: action.masked === true };
    case "scroll":
      return {
        verb: action.verb,
        point: identity.point,
        dx: action.dx,
        dy: action.dy,
        mods: action.mods ?? [],
      };
    case "drag":
      return {
        verb: action.verb,
        path: action.path,
        button: action.button ?? "left",
        mods: action.mods ?? [],
      };
    case "move":
      return { verb: action.verb, point: identity.point };
    case "down":
    case "up":
      return {
        verb: action.verb,
        point: identity.point,
        button: action.button ?? "left",
        mods: action.mods ?? [],
      };
    case "wait":
      return undefined;
  }
}
// One private task owner, checked immediately before each actual native dispatch.
// Presentation labels, screenshot IDs and motion speed cannot disguise the same input, nor can a
// repeat count or a hold: a combo is the same input however often or long it is pressed.
// Observations/waits alone cannot reset a repeated-action streak. A changed, daemon-observed
// screen can: the immediate post-input capture sometimes fails and a later read recovers it.
// An identical input repeats the last one only if that one changed nothing on the screen (settle);
// an input whose settle never reported counts as one without effect. One tool call's own repeat
// counts once. `call` is the daemon's id for that call: a model's call ids can repeat across
// separate calls.
function digestOf(action: GuiAction, identity: NativeActionIdentity): string | undefined {
  const input = effect(action, identity);
  if (input === undefined) return undefined;
  return createHash("sha256")
    .update(JSON.stringify(canonical({ input, identity })))
    .digest("hex");
}
export class RepeatGuard {
  #digest: string | undefined;
  #call: string | undefined;
  #streak = 0;
  #changed = false;
  #frame: string | undefined;
  #blocked = 0;
  // Two rejected calls return recovery evidence to the model. Only ignoring both closes the
  // task's admission. Changing labels or making an unrelated read cannot replenish this budget.
  get recoveryExhausted(): boolean {
    return this.#blocked >= 3;
  }
  admit(action: GuiAction, identity: NativeActionIdentity, call: string, frame?: string): boolean {
    const digest = digestOf(action, identity);
    if (digest === undefined) return true;
    const changed = this.#changed || (!!frame && !!this.#frame && frame !== this.#frame);
    if (changed) this.#blocked = 0;
    if (digest !== this.#digest || changed) {
      this.#digest = digest;
      this.#streak = 1;
    } else if (call !== this.#call) this.#streak++;
    if (this.#streak >= 3 && call !== this.#call) this.#blocked++;
    this.#call = call;
    this.#changed = false;
    if (this.#streak < 3) this.#frame = frame;
    return this.#streak < 3;
  }
  // An admitted input's outcome: whether the screen changed after it. Only the last admitted input
  // counts; a late report about an earlier one (another screen's) is ignored.
  settle(action: GuiAction, identity: NativeActionIdentity, changed: boolean): void {
    if (digestOf(action, identity) === this.#digest) {
      this.#changed = changed;
      if (changed) this.#blocked = 0;
    }
  }
  reset(): void {
    this.#digest = undefined;
    this.#call = undefined;
    this.#streak = 0;
    this.#changed = false;
    this.#frame = undefined;
    this.#blocked = 0;
  }
}
