import {
  type AskUserInput,
  type BrowserActInput,
  type BrowserAction,
  ComputerAction,
  type ComputerStep,
  type CoordSpaceName,
  MAX_BATCH_ACTIONS,
  MAX_BATCH_STEPS,
  MAX_DRAG_MS,
  type Point,
} from "@localdot/protocol";
import { checkCombo, checkModifiers, keyCombo } from "@localdot/protocol/keys";
import { modelPoint, toModelSpace } from "@localdot/providers";

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
  path?: number[][];
  button?: "left" | "right" | "middle";
  steps?: ProviderComputerInput[];
  intent?: string;
}

const CLICKS: Record<string, { button: "left" | "right" | "middle"; count: 1 | 2 | 3 }> = {
  left_click: { button: "left", count: 1 },
  right_click: { button: "right", count: 1 },
  middle_click: { button: "middle", count: 1 },
  double_click: { button: "left", count: 2 },
  triple_click: { button: "left", count: 3 },
};

const MAX_HOLD_S = 30;
const BUTTONS = new Set(["left", "right", "middle"]);

// A combo the model wrote, or the message it gets instead: unreadable, or a key with no X name.
function comboOf(action: string, text: string | undefined): string[] | string {
  const keys = text ? keyCombo(text) : undefined;
  if (!keys) return `${action} needs text such as "ctrl+s"`;
  return checkCombo(keys) ?? keys;
}

// The modifier keys `text` holds down through a pointer action (the native tools' convention),
// none without text, or the message for the model.
function modsOf(action: string, text: string | undefined): { mods?: string[] } | string {
  if (!text) return {};
  const keys = keyCombo(text);
  if (!keys) return `${action}: text names the keys to hold down, such as "shift" or "ctrl+shift"`;
  const refused = checkModifiers(keys);
  return refused ? `${action}: ${refused}` : { mods: keys };
}

// A pointer action's optional coordinate: none acts where the cursor is.
function pointOf(
  action: string,
  input: ProviderComputerInput,
  coords: CoordSpaceName,
): { point?: Point } | string {
  if (input.coordinate === undefined) return {};
  const p = modelPoint(input.coordinate, coords);
  return p.ok ? { point: p.point } : `${action}: ${p.error}`;
}

function dragOf(
  input: ProviderComputerInput,
  coords: CoordSpaceName,
  frame: { basedOn?: string },
): ComputerAction | string {
  const mods = modsOf("left_click_drag", input.text);
  if (typeof mods === "string") return mods;
  const way =
    input.path ??
    (input.start_coordinate && input.coordinate
      ? [input.start_coordinate, input.coordinate]
      : undefined);
  if (!way)
    return "left_click_drag needs start_coordinate and coordinate, or a path of [x, y] points";
  if (way.length < 2 || way.length > 64) return "left_click_drag: a path has 2 to 64 points";
  const path: Point[] = [];
  for (const [i, c] of way.entries()) {
    const p = modelPoint(c, coords);
    if (!p.ok) return `left_click_drag: point ${i + 1}: ${p.error}`;
    path.push(p.point);
  }
  const ms = input.duration === undefined ? undefined : Math.round(input.duration * 1000);
  if (ms !== undefined && (ms <= 0 || ms > MAX_DRAG_MS))
    return `left_click_drag: a duration is more than 0 and at most ${MAX_DRAG_MS / 1000} seconds`;
  return {
    action: "drag",
    path,
    button: input.button ?? "left",
    ...mods,
    ...(ms === undefined ? {} : { ms }),
    ...frame,
  };
}

// A provider's computer action as the daemon's ComputerAction, in model pixels; a string is the
// error the model gets back instead. basedOn is the screenshot the model was looking at.
function normalizeComputerAction(
  input: ProviderComputerInput,
  coords: CoordSpaceName,
  basedOn: string | undefined,
): ComputerAction | string {
  const action = input.action ?? "";
  if (action === "maximize_window" || action === "restore_window" || action === "minimize_window")
    return { action };
  const at = () => modelPoint(input.coordinate, coords);
  const frame = basedOn ? { basedOn } : {};
  const click = Object.hasOwn(CLICKS, action) ? CLICKS[action] : undefined;
  if (click) {
    const mods = modsOf(action, input.text);
    if (typeof mods === "string") return mods;
    const point = pointOf(action, input, coords);
    if (typeof point === "string") return point;
    return {
      action: "click",
      ...point,
      button: click.button,
      count: click.count,
      ...mods,
      ...frame,
    };
  }
  switch (action) {
    case "screenshot":
      return { action: "screenshot", ...frame };
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
        ...frame,
      };
    }
    case "hold_key": {
      const keys = comboOf("hold_key", input.text);
      if (typeof keys === "string") return keys;
      const seconds = input.duration ?? 0;
      if (seconds <= 0 || seconds > MAX_HOLD_S)
        return `hold_key needs a duration of more than 0 and at most ${MAX_HOLD_S} seconds`;
      return { action: "hold_key", keys, ms: Math.round(seconds * 1000), ...frame };
    }
    case "scroll": {
      const mods = modsOf(action, input.text);
      if (typeof mods === "string") return mods;
      const point = pointOf(action, input, coords);
      if (typeof point === "string") return point;
      const n = Math.max(1, Math.min(30, Math.round(input.scroll_amount ?? 3)));
      const d = input.scroll_direction ?? "down";
      return {
        action: "scroll",
        ...point,
        dx: d === "left" ? -n : d === "right" ? n : 0,
        dy: d === "up" ? -n : d === "down" ? n : 0,
        ...mods,
        ...frame,
      };
    }
    case "left_click_drag":
      return dragOf(input, coords, frame);
    case "mouse_move": {
      const p = at();
      if (!p.ok) return `mouse_move: ${p.error}`;
      return { action: "move", point: p.point, ...frame };
    }
    case "left_mouse_down":
    case "left_mouse_up": {
      const down = action === "left_mouse_down";
      if (!down && input.text)
        return "left_mouse_up takes no keys: the keys held with left_mouse_down come up with it";
      const mods = modsOf(action, input.text);
      if (typeof mods === "string") return mods;
      const point = pointOf(action, input, coords);
      if (typeof point === "string") return point;
      return {
        action: down ? "mouse_down" : "mouse_up",
        ...point,
        button: input.button ?? "left",
        ...mods,
        ...frame,
      };
    }
    case "wait":
      return {
        action: "wait",
        ms: Math.round(Math.max(0, Math.min(30, input.duration ?? 1)) * 1000),
        ...frame,
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
  return `Unknown computer action ${JSON.stringify(action).slice(0, 40)}.`;
}

// `type` with its options is several daemon actions, each authorized and shown on its own: a
// click at `coordinate`, select all and delete (`clear`), the text, then Return (`submit`).
function typeSteps(
  input: ProviderComputerInput,
  coords: CoordSpaceName,
  basedOn: string | undefined,
): ComputerAction[] | string {
  const frame = basedOn ? { basedOn } : {};
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
    steps.push(
      { action: "key", keys: ["ctrl", "a"], ...frame },
      { action: "key", keys: ["BackSpace"], ...frame },
    );
  if (input.text) steps.push({ action: "type", text: input.text, ...frame });
  else if (!input.clear) return "type needs text";
  if (input.submit) steps.push({ action: "key", keys: ["Return"], ...frame });
  return steps;
}

// Provider output is untrusted even when an SDK validates its advertised tool schema. Refuse
// malformed fields before coercion, and validate the normalized daemon wire shape as a final fence.
// One provider action is one daemon action, except `type` with its options (typeSteps).
// ask_user's secret targets, from the model's coordinate space to model pixels; the message for
// the model when one is off the screen.
export function askInModelSpace(
  input: AskUserInput,
  coords: CoordSpaceName,
): AskUserInput | string {
  if (!input.fields?.some((field) => field.target)) return input;
  const fields: NonNullable<AskUserInput["fields"]> = [];
  for (const field of input.fields) {
    if (!field.target) {
      fields.push(field);
      continue;
    }
    const p = modelPoint(field.target, coords);
    if (!p.ok) return `ask_user: the target of ${field.id}: ${p.error}`;
    fields.push({ ...field, target: [p.point.x, p.point.y] });
  }
  return { ...input, fields };
}

const NOT_STEPS = new Set(["batch", "screenshot", "zoom", "cursor_position"]);

// A batch as one daemon action: its steps in daemon form, sharing the batch's screenshot.
function batchOf(
  input: ProviderComputerInput,
  coords: CoordSpaceName,
  basedOn: string | undefined,
): ComputerAction | string {
  const steps = input.steps;
  if (!Array.isArray(steps) || steps.length === 0)
    return `batch needs steps: 1 to ${MAX_BATCH_STEPS} actions`;
  if (steps.length > MAX_BATCH_STEPS) return `batch takes at most ${MAX_BATCH_STEPS} steps`;
  const inputs: ComputerStep[] = [];
  for (const [i, step] of steps.entries()) {
    if (step && typeof step === "object" && NOT_STEPS.has(String(step.action)))
      return `batch step ${i + 1}: ${String(step.action).slice(0, 40)} cannot be a step; the batch returns a screenshot at its end`;
    const actions = toComputerActions(step, coords, undefined);
    if (typeof actions === "string") return `batch step ${i + 1}: ${actions}`;
    for (const { basedOn: _basis, ...action } of actions) inputs.push(action as ComputerStep);
  }
  if (inputs.length > MAX_BATCH_ACTIONS) return "batch: too many inputs; split it in two";
  return { action: "batch", steps: inputs, ...(basedOn ? { basedOn } : {}) };
}

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
  for (const field of ["coordinate", "start_coordinate", "region"] as const)
    if (input[field] !== undefined && !Array.isArray(input[field])) return `Invalid ${field}`;
  if (
    input.path !== undefined &&
    (!Array.isArray(input.path) || !input.path.every((point) => Array.isArray(point)))
  )
    return "Invalid path";
  if (input.button !== undefined && !BUTTONS.has(input.button)) return "Invalid button";
  if (input.steps !== undefined && input.action !== "batch") return "steps are only for a batch";
  const result =
    input.action === "batch"
      ? batchOf(input, coords, basedOn)
      : input.action === "type"
        ? typeSteps(input, coords, basedOn)
        : normalizeComputerAction(input, coords, basedOn);
  if (typeof result === "string") return result;
  // The call's line for the user goes with its first daemon action, which starts its first step.
  const intent = typeof input.intent === "string" ? input.intent.trim().slice(0, 500) : "";
  const actions: ComputerAction[] = [];
  for (const action of Array.isArray(result) ? result : [result]) {
    const parsed = ComputerAction.safeParse(
      intent && !actions.length ? { ...action, intent } : action,
    );
    if (!parsed.success) return "Invalid computer action fields";
    actions.push(parsed.data);
  }
  return actions;
}

// Whether an action chooses a point on the screen, which needs a screenshot to choose it on.
export function pointsAtScreen(action: ComputerAction): boolean {
  const at = (a: { action: string }) => a.action === "click" || a.action === "scroll";
  return at(action) || (action.steps?.some(at) ?? false);
}

// browser_act's fallback coordinate, from the model's space to model pixels, with the screenshot it
// was chosen on; a coordinate needs one, and is left out beside a ref when there is none.
export function actInModelSpace(
  input: BrowserActInput,
  coords: CoordSpaceName,
  basedOn: string | undefined,
): BrowserAction | string {
  if (!input || typeof input !== "object") return "Invalid browser_act input";
  const { coordinate, ...rest } = input;
  if (coordinate === undefined) return input;
  if (!basedOn) {
    if (input.ref !== undefined) return rest;
    return "Take a full screenshot before choosing a point on the screen.";
  }
  const p = modelPoint(coordinate, coords);
  if (!p.ok) return `browser_act: ${p.error}`;
  return { ...rest, coordinate: [p.point.x, p.point.y], basedOn };
}

const ELEMENT_BOX = /\[(\d+), (\d+), (\d+), (\d+)\]$/;
const CONTROL_AT = / at \((\d+), (\d+)\) \[(\d+), (\d+), (\d+), (\d+)\]$/;

// The element lines browser_read and find answer in model pixels, on the 0-1000 grid.
export function elementsOnGrid(text: string): string {
  const grid = (x: string, y: string) => toModelSpace({ x: Number(x), y: Number(y) }, "per1000");
  const box = (a: string, b: string, c: string, d: string) => {
    const [x0, y0] = grid(a, b);
    const [x1, y1] = grid(c, d);
    return `[${x0}, ${y0}, ${x1}, ${y1}]`;
  };
  return text
    .split("\n")
    .map((line) => {
      if (/^e\d+ /.test(line))
        return line.replace(ELEMENT_BOX, (_m, a, b, c, d) => box(a, b, c, d));
      if (line.startsWith("- "))
        return line.replace(CONTROL_AT, (_m, x, y, a, b, c, d) => {
          const [gx, gy] = grid(x, y);
          return ` at (${gx}, ${gy}) ${box(a, b, c, d)}`;
        });
      return line;
    })
    .join("\n");
}
