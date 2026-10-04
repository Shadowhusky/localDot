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
// Presentation labels, screenshot IDs and motion speed cannot disguise the same input.
// Observations/waits do not dispatch input and cannot reset a repeated-action streak.
export class RepeatGuard {
  #digest: string | undefined;
  #streak = 0;
  admit(action: GuiAction, identity: NativeActionIdentity): boolean {
    const input = effect(action, identity);
    if (input === undefined) return true;
    const digest = createHash("sha256")
      .update(JSON.stringify(canonical({ input, identity })))
      .digest("hex");
    if (digest === this.#digest) this.#streak++;
    else {
      this.#digest = digest;
      this.#streak = 1;
    }
    return this.#streak < 3;
  }
  reset(): void {
    this.#digest = undefined;
    this.#streak = 0;
  }
}
