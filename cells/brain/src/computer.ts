import { ComputerAction, type CoordSpaceName } from "@localdot/protocol";
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
}

const CLICKS: Record<string, { button: "left" | "right" | "middle"; count: 1 | 2 | 3 }> = {
  left_click: { button: "left", count: 1 },
  right_click: { button: "right", count: 1 },
  middle_click: { button: "middle", count: 1 },
  double_click: { button: "left", count: 2 },
  triple_click: { button: "left", count: 3 },
};

const NOT_YET = new Set([
  "mouse_move",
  "left_click_drag",
  "left_mouse_down",
  "left_mouse_up",
  "hold_key",
]);

// xdotool-style combos ("ctrl+shift+t", "Return"): the gateway's key names (Part 3's keys.ts maps
// the aliases onto X keysyms).
export function keyCombo(text: string): string[] | undefined {
  const keys = text.split("+").map((k) => k.trim());
  return keys.length >= 1 && keys.length <= 8 && keys.every((k) => k.length > 0 && k.length <= 32)
    ? keys
    : undefined;
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
    case "type":
      return input.text ? { action: "type", text: input.text } : "type needs text";
    case "key": {
      const keys = input.text ? keyCombo(input.text) : undefined;
      return keys
        ? {
            action: "key",
            keys,
            ...(input.repeat && input.repeat > 1 ? { repeat: Math.min(20, input.repeat) } : {}),
          }
        : 'key needs text such as "ctrl+s"';
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

// Provider output is untrusted even when an SDK validates its advertised tool schema. Refuse
// malformed fields before coercion, and validate the normalized daemon wire shape as a final fence.
export function toComputerAction(
  input: ProviderComputerInput,
  coords: CoordSpaceName,
  basedOn: string | undefined,
): ComputerAction | string {
  if (!input || typeof input !== "object" || typeof input.action !== "string")
    return "Invalid computer action";
  if (input.text !== undefined && typeof input.text !== "string") return "Invalid computer text";
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
  const result = normalizeComputerAction(input, coords, basedOn);
  if (typeof result === "string") return result;
  const parsed = ComputerAction.safeParse(result);
  return parsed.success ? parsed.data : "Invalid computer action fields";
}
