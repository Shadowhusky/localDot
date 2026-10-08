import { ComputerAction, type CoordSpaceName } from "@localdot/protocol";
import { checkCombo } from "@localdot/protocol/keys";
import { modelPoint } from "@localdot/providers";

// What Anthropic's computer tools and localDot's generic tool send: the same Anthropic-style shape.
export interface ProviderComputerInput {
  action?: string;
  coordinate?: number[];
  start_coordinate?: number[];
  text?: string;
  scroll_direction?: "up" | "down" | "left" | "right";
  scroll_amount?: number;
  duration?: number;
  region?: number[];
  repeat?: number;
  clear?: boolean;
  submit?: boolean;
}

const CLICKS: Record<string, { button: "left" | "right" | "middle"; count: 1 | 2 | 3 }> = {
  left_click: { button: "left", count: 1 },
  right_click: { button: "right", count: 1 },
  middle_click: { button: "middle", count: 1 },
  double_click: { button: "left", count: 2 },
  triple_click: { button: "left", count: 3 },
};

const NOT_YET = new Set(["mouse_move", "left_click_drag", "left_mouse_down", "left_mouse_up"]);
const MAX_HOLD_S = 30;

// xdotool-style combos ("ctrl+shift+t", "Return"): the gateway's key names (protocol keys.ts maps
// them onto X keysyms). A trailing "+" is the plus key: "ctrl++", or "+" alone.
export function keyCombo(text: string): string[] | undefined {
  const trimmed = text.trim();
  const plus = trimmed === "+" || /\+\s*\+$/.test(trimmed);
  const rest = plus ? trimmed.replace(/\+?\s*\+$/, "") : trimmed;
  const keys = [...(rest ? rest.split("+").map((k) => k.trim()) : []), ...(plus ? ["+"] : [])];
  return keys.length >= 1 && keys.length <= 8 && keys.every((k) => k.length > 0 && k.length <= 32)
    ? keys
    : undefined;
}

// A combo the model wrote, or the message it gets instead: unreadable, or a key with no X name.
function comboOf(action: string, text: string | undefined): string[] | string {
  const keys = text ? keyCombo(text) : undefined;
  if (!keys) return `${action} needs text such as "ctrl+s"`;
  return checkCombo(keys) ?? keys;
}

// A provider's computer action as the daemon's ComputerAction, in model pixels; a string is the
// error the model gets back instead. basedOn is the screenshot the model was looking at.
function normalizeComputerAction(
  input: ProviderComputerInput,
  coords: CoordSpaceName,
  basedOn: string | undefined,
): ComputerAction | string {
  const action = input.action ?? "";
  const at = () => modelPoint(input.coordinate, coords);
  const frame = basedOn ? { basedOn } : {};
  const click = Object.hasOwn(CLICKS, action) ? CLICKS[action] : undefined;
  if (click) {
    if (input.text)
      return "Clicks with held keys are not supported yet; press the keys with the key action instead.";
    const p = at();
    if (!p.ok) return `${action}: ${p.error}`;
    return {
      action: "click",
      point: p.point,
      button: click.button,
      count: click.count,
      ...frame,
    };
  }
  switch (action) {
    case "screenshot":
      return { action: "screenshot" };
    case "cursor_position":
      return { action: "cursor_position" };
    case "key": {
      const keys = comboOf("key", input.text);
      if (typeof keys === "string") return keys;
      if ((input.repeat ?? 1) > 100) return "key repeats at most 100 times";
      return {
        action: "key",
        keys,
        ...(input.repeat && input.repeat > 1 ? { repeat: input.repeat } : {}),
      };
    }
    case "hold_key": {
      const keys = comboOf("hold_key", input.text);
      if (typeof keys === "string") return keys;
      const seconds = input.duration ?? 0;
      if (seconds <= 0 || seconds > MAX_HOLD_S)
        return `hold_key needs a duration of more than 0 and at most ${MAX_HOLD_S} seconds`;
      return { action: "hold_key", keys, ms: Math.round(seconds * 1000) };
    }
    case "scroll": {
      const p = at();
      if (!p.ok) return `scroll: ${p.error}`;
      const n = Math.max(1, Math.min(30, Math.round(input.scroll_amount ?? 3)));
      const d = input.scroll_direction ?? "down";
      return {
        action: "scroll",
        point: p.point,
        dx: d === "left" ? -n : d === "right" ? n : 0,
        dy: d === "up" ? -n : d === "down" ? n : 0,
        ...frame,
      };
    }
    case "wait":
      return {
        action: "wait",
        ms: Math.round(Math.max(0, Math.min(30, input.duration ?? 1)) * 1000),
      };
    case "zoom": {
      const r = input.region;
      if (r?.length !== 4) return "zoom needs a region [x0, y0, x1, y1]";
      const a = modelPoint([r[0] as number, r[1] as number], coords);
      const b = modelPoint([r[2] as number, r[3] as number], coords);
      if (!a.ok) return `zoom: ${a.error}`;
      if (!b.ok) return `zoom: ${b.error}`;
      if (b.point.x <= a.point.x || b.point.y <= a.point.y)
        return "zoom: the region's second corner must be below and right of the first";
      return {
        action: "zoom",
        region: {
          x: a.point.x,
          y: a.point.y,
          w: b.point.x - a.point.x,
          h: b.point.y - a.point.y,
        },
      };
    }
  }
  if (NOT_YET.has(action))
    return `${action} is not supported yet (drags arrive later); use clicks, keys and scrolling.`;
  return `Unknown computer action ${JSON.stringify(action).slice(0, 40)}.`;
}

// `type` with its options is several daemon actions, each authorized and shown on its own: a
// click at `coordinate`, select all and delete (`clear`), the text, then Return (`submit`).
function typeSteps(
  input: ProviderComputerInput,
  coords: CoordSpaceName,
  basedOn: string | undefined,
): ComputerAction[] | string {
  const steps: ComputerAction[] = [];
  if (input.coordinate !== undefined) {
    const click = normalizeComputerAction(
      { action: "left_click", coordinate: input.coordinate },
      coords,
      basedOn,
    );
    if (typeof click === "string") return click.replace(/^left_click/, "type");
    steps.push(click);
  }
  if (input.clear)
    steps.push({ action: "key", keys: ["ctrl", "a"] }, { action: "key", keys: ["BackSpace"] });
  if (input.text) steps.push({ action: "type", text: input.text });
  else if (!input.clear) return "type needs text";
  if (input.submit) steps.push({ action: "key", keys: ["Return"] });
  return steps;
}

// Provider output is untrusted even when an SDK validates its advertised tool schema. Refuse
// malformed fields before coercion, and validate the normalized daemon wire shape as a final fence.
// One provider action is one daemon action, except `type` with its options (typeSteps).
export function toComputerActions(
  input: ProviderComputerInput,
  coords: CoordSpaceName,
  basedOn: string | undefined,
): ComputerAction[] | string {
  if (!input || typeof input !== "object" || typeof input.action !== "string")
    return "Invalid computer action";
  if (input.text !== undefined && typeof input.text !== "string") return "Invalid computer text";
  for (const field of ["clear", "submit"] as const)
    if (input[field] !== undefined && typeof input[field] !== "boolean") return `Invalid ${field}`;
  for (const field of ["duration", "scroll_amount", "repeat"] as const) {
    const value = input[field];
    if (
      value !== undefined &&
      (!Number.isFinite(value) || value < 0 || (field !== "duration" && !Number.isInteger(value)))
    )
      return `Invalid ${field}`;
  }
  if (
    input.scroll_direction !== undefined &&
    !["up", "down", "left", "right"].includes(input.scroll_direction)
  )
    return "Invalid scroll direction";
  if (input.coordinate !== undefined && !Array.isArray(input.coordinate))
    return "Invalid coordinate";
  if (input.region !== undefined && !Array.isArray(input.region)) return "Invalid region";
  const result =
    input.action === "type"
      ? typeSteps(input, coords, basedOn)
      : normalizeComputerAction(input, coords, basedOn);
  if (typeof result === "string") return result;
  const actions: ComputerAction[] = [];
  for (const action of Array.isArray(result) ? result : [result]) {
    const parsed = ComputerAction.safeParse(action);
    if (!parsed.success) return "Invalid computer action fields";
    actions.push(parsed.data);
  }
  return actions;
}
