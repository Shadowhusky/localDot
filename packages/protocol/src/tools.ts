import { z } from "zod";
import { ASK_FIELD_ID, AskFieldKind, MAX_ASK_FIELDS } from "./ask.ts";
import { DesktopUploadPath } from "./desktop-uploads.ts";
import { ULID_PATTERN } from "./ids.ts";
import { SwitchScreenInput } from "./screens.ts";
import { PeopleInput } from "./tools/people.ts";
import { RecallInput } from "./tools/recall.ts";
import { FollowUpAtInput, RoutineToolInput } from "./tools/routine.ts";

// The v1 tool table (spec "The agent"): the only tools a brain may declare and the only ones the
// daemon's tool API runs, including M7's isolated browser screen.
export const TOOL_NAMES = [
  "computer",
  "shell",
  "files",
  "browser_read",
  "browser_navigate",
  "browser_upload",
  "browser_act",
  "find",
  "switch_screen",
  "update_plan",
  "ask_user",
  "request_takeover",
  "remember",
  "recall",
  "people",
  "done",
  "routine",
  "follow_up_at",
] as const;
export const ToolName = z.enum(TOOL_NAMES);
export type ToolName = z.infer<typeof ToolName>;

export function isToolName(name: string): name is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(name);
}

// The model's screen: every screenshot is 1280×800 and every model point is in these pixels once
// the brain has converted it from the provider's space (D9).
export const MODEL_SCREEN = { width: 1280, height: 800 } as const;

// Schemas are flat objects with optional fields, never unions: Gemini refuses some JSON Schema
// shapes (S5: draft-07 tuples), and one shape per tool keeps every provider on the same wire.
const STEP_ACTIONS = [
  "left_click",
  "right_click",
  "middle_click",
  "double_click",
  "triple_click",
  "type",
  "key",
  "scroll",
  "wait",
  "mouse_move",
  "left_click_drag",
  "left_mouse_down",
  "left_mouse_up",
  "hold_key",
] as const;
const COMPUTER_ACTIONS = [
  ...STEP_ACTIONS,
  "screenshot",
  "zoom",
  "cursor_position",
  "batch",
] as const;
export const ComputerActionName = z.enum(COMPUTER_ACTIONS);
export type ComputerActionName = z.infer<typeof ComputerActionName>;

// A batch is at most this many steps as the model writes them; a type with its options is several
// daemon actions, so the daemon takes twice as many.
export const MAX_BATCH_STEPS = 8;
export const MAX_BATCH_ACTIONS = 2 * MAX_BATCH_STEPS;

const genericFields = {
  coordinate: z.array(z.number()).length(2).optional(),
  start_coordinate: z.array(z.number()).length(2).optional(),
  text: z.string().max(4000).optional(),
  scroll_direction: z.enum(["up", "down", "left", "right"]).optional(),
  scroll_amount: z.number().int().min(1).max(30).optional(),
  duration: z.number().min(0).max(30).optional(),
  repeat: z.number().int().min(1).max(100).optional(),
  // type only: click `coordinate` first, select all and delete before typing, press Return after.
  clear: z.boolean().optional(),
  submit: z.boolean().optional(),
  // left_click_drag: the whole way, start first (instead of start_coordinate and coordinate).
  path: z.array(z.array(z.number()).length(2)).min(2).max(64).optional(),
  // left_click_drag, left_mouse_down and left_mouse_up: another button than the left one.
  button: z.enum(["left", "right", "middle"]).optional(),
};

const GenericComputerStep = z.object({ action: z.enum(STEP_ACTIONS), ...genericFields });

// localDot's generic computer tool (spec "Catalog"): Anthropic-style actions, a coordinate that is
// a length-2 number array (Gemini rejects z.tuple), in the space the tool's description declares.
export const GenericComputerInput = z.object({
  action: ComputerActionName,
  ...genericFields,
  region: z.array(z.number()).length(4).optional(),
  // batch: these steps in order, with one screenshot at the end.
  steps: z.array(GenericComputerStep).min(1).max(MAX_BATCH_STEPS).optional(),
});
export type GenericComputerInput = z.infer<typeof GenericComputerInput>;

const ModelPoint = z.object({ x: z.number().int(), y: z.number().int() });
export const MAX_DRAG_MS = 10_000;

const INPUT_ACTIONS = [
  "click",
  "type",
  "key",
  "hold_key",
  "scroll",
  "move",
  "drag",
  "mouse_down",
  "mouse_up",
  "wait",
] as const;

const computerFields = {
  point: ModelPoint.optional(),
  // drag: the whole way, start first.
  path: z.array(ModelPoint).min(2).max(64).optional(),
  button: z.enum(["left", "right", "middle"]).optional(),
  count: z.literal([1, 2, 3]).optional(),
  // Modifier keys held down through a click, scroll or drag, or a button press until its release.
  mods: z.array(z.string().min(1).max(32)).min(1).max(4).optional(),
  text: z.string().min(1).max(4000).optional(),
  keys: z.array(z.string().min(1).max(32)).min(1).max(8).optional(),
  // key: presses of the combo, as one input. hold_key: `ms` is how long the keys stay down.
  repeat: z.number().int().min(1).max(100).optional(),
  dx: z.number().int().min(-30).max(30).optional(),
  dy: z.number().int().min(-30).max(30).optional(),
  // wait and hold_key: how long. drag: how long the motion takes, up to MAX_DRAG_MS.
  ms: z.number().int().min(0).max(30_000).optional(),
};

// One input of a batch: it shares the batch's screenshot basis.
export const ComputerStep = z.object({ action: z.enum(INPUT_ACTIONS), ...computerFields });
export type ComputerStep = z.infer<typeof ComputerStep>;

// What the brain sends the daemon for one computer action, whatever the provider said: points in
// model pixels (MODEL_SCREEN), keys as X-style names. A click, scroll or button press without a
// point acts where the cursor is.
export const ComputerAction = z.object({
  action: z.enum([...INPUT_ACTIONS, "screenshot", "zoom", "cursor_position", "batch"]),
  ...computerFields,
  region: z
    .object({ x: z.number().int(), y: z.number().int(), w: z.number().int(), h: z.number().int() })
    .optional(),
  // batch: the inputs, run in order until one fails, changed under its point or needs the user.
  steps: z.array(ComputerStep).min(1).max(MAX_BATCH_ACTIONS).optional(),
  // The screenshot the model based this action on (the freshness check, spec "Harness rules").
  basedOn: z.string().regex(ULID_PATTERN).optional(),
});
export type ComputerAction = z.infer<typeof ComputerAction>;

const WORK_MS = 120_000;
// How long one call's own work may take, approvals and questions aside: a batch gets a share for
// each step.
export function computerWorkMs(action: Pick<ComputerAction, "steps">): number {
  return WORK_MS + (action.steps ? 30_000 * (action.steps.length - 1) : 0);
}

export const ShellInput = z.object({
  command: z.string().min(1).max(8000),
  cwd: z.string().max(1024).optional(),
  timeout_sec: z.number().int().min(1).max(600).optional(),
});
export type ShellInput = z.infer<typeof ShellInput>;

export const FilesInput = z.object({
  op: z.enum(["read", "write", "edit", "list"]),
  path: z.string().min(1).max(1024),
  content: z.string().max(1_000_000).optional(),
  old_text: z.string().max(100_000).optional(),
  new_text: z.string().max(100_000).optional(),
});
export type FilesInput = z.infer<typeof FilesInput>;

export const BrowserReadInput = z.object({
  max_chars: z.number().int().min(500).max(100_000).optional(),
});
export type BrowserReadInput = z.infer<typeof BrowserReadInput>;

export const BrowserNavigateInput = z.object({ url: z.string().min(1).max(2048) });
export type BrowserNavigateInput = z.infer<typeof BrowserNavigateInput>;

export const BrowserUploadInput = z.strictObject({
  files: z
    .array(DesktopUploadPath)
    .min(1)
    .max(10)
    .refine((files) => new Set(files).size === files.length),
});
export type BrowserUploadInput = z.infer<typeof BrowserUploadInput>;

// browser_act: one element of the page browser_read listed, by its ref ("e12"). Its coordinate,
// in the computer tool's space, is where to act instead when the ref is stale or not given.
export const BrowserActInput = z.object({
  action: z.enum(["click", "fill", "select", "check", "uncheck", "press", "scroll"]),
  ref: z.string().min(2).max(24).optional(),
  coordinate: z.array(z.number()).length(2).optional(),
  // fill: the text. select: the option's text. press: keys such as "Return" or "ctrl+a".
  text: z.string().max(4000).optional(),
  // fill: press Return after typing.
  submit: z.boolean().optional(),
  scroll_direction: z.enum(["up", "down", "left", "right"]).optional(),
  scroll_amount: z.number().int().min(1).max(30).optional(),
});
export type BrowserActInput = z.infer<typeof BrowserActInput>;
// What the daemon runs: the coordinate in model pixels, and the screenshot it was chosen on.
export const BrowserAction = BrowserActInput.extend({
  basedOn: z.string().regex(ULID_PATTERN).optional(),
});
export type BrowserAction = z.infer<typeof BrowserAction>;

// find: the desktop's controls whose names contain the text, from the apps' accessibility trees.
export const FindInput = z.object({
  text: z.string().min(1).max(200),
  // A role such as "push button", "menu item" or "check box" narrows the search.
  role: z.string().min(1).max(64).optional(),
});
export type FindInput = z.infer<typeof FindInput>;

export const PlanItemStatus = z.enum(["todo", "doing", "done", "skipped"]);
export const UpdatePlanInput = z.object({
  items: z
    .array(z.object({ text: z.string().min(1).max(200), status: PlanItemStatus }))
    .min(1)
    .max(30),
});
export type UpdatePlanInput = z.infer<typeof UpdatePlanInput>;

// The id's pattern is checked below, not declared: some providers refuse `pattern` in a schema.
export const AskField = z.object({
  id: z.string().min(1).max(32),
  kind: AskFieldKind,
  label: z.string().min(1).max(200),
  hint: z.string().min(1).max(300).optional(),
  // choice and multichoice.
  options: z.array(z.string().min(1).max(200)).min(1).max(6).optional(),
  // secret: the field to type the answer into, as [x, y] in the computer tool's coordinates;
  // without it, the field that has keyboard focus.
  target: z.array(z.number()).length(2).optional(),
  // code: how many characters the code has.
  length: z.number().int().min(4).max(12).optional(),
  // qr: the text or link the QR code holds.
  value: z.string().min(1).max(2000).optional(),
});
export type AskField = z.infer<typeof AskField>;

const FIELD_ONLY = {
  options: ["choice", "multichoice"],
  target: ["secret"],
  length: ["code"],
  value: ["qr"],
} as const satisfies Record<string, readonly AskFieldKind[]>;

export const AskUserInput = z
  .object({
    question: z.string().min(1).max(1000),
    options: z.array(z.string().min(1).max(200)).max(6).optional(),
    allow_text: z.boolean().optional(),
    fields: z.array(AskField).min(1).max(MAX_ASK_FIELDS).optional(),
    // The answer buttons: dot's verb ("Sign in") and the way out ("Not now").
    submit: z.string().min(1).max(40).optional(),
    decline: z.string().min(1).max(40).optional(),
  })
  .superRefine((input, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: "custom", message });
    if (!input.fields) return;
    if (input.options || input.allow_text !== undefined)
      issue("fields replace options and allow_text");
    const ids = new Set<string>();
    for (const field of input.fields) {
      if (!ASK_FIELD_ID.test(field.id))
        issue(`field id ${JSON.stringify(field.id)} must be lowercase letters, digits or _`);
      if (ids.has(field.id)) issue(`field id ${field.id} is used twice`);
      ids.add(field.id);
      for (const [key, kinds] of Object.entries(FIELD_ONLY))
        if (
          field[key as keyof typeof FIELD_ONLY] !== undefined &&
          !kinds.includes(field.kind as never)
        )
          issue(`${key} is only for ${kinds.join(" and ")} fields`);
      if ((field.kind === "choice" || field.kind === "multichoice") && !field.options)
        issue(`${field.kind} fields need options`);
      if (field.kind === "qr" && !field.value) issue("qr fields need the value the code holds");
    }
  });
export type AskUserInput = z.infer<typeof AskUserInput>;

export const RequestTakeoverInput = z.object({
  reason: z.enum(["login", "2fa", "captcha", "payment", "other"]),
  note: z.string().min(1).max(500),
});
export type RequestTakeoverInput = z.infer<typeof RequestTakeoverInput>;

export const RememberInput = z.object({
  file: z.enum(["USER.md", "MEMORY.md", "notes"]),
  op: z.enum(["append", "replace"]),
  text: z.string().max(4000),
  old_text: z.string().max(4000).optional(),
});
export type RememberInput = z.infer<typeof RememberInput>;

export const DoneInput = z.object({
  summary: z.string().min(1).max(8000),
  files: z.array(z.string().min(1).max(1024)).max(16).optional(),
});
export type DoneInput = z.infer<typeof DoneInput>;

// The daemon validates a call's input with these; the brain declares the same schemas (the
// computer tool's own shape differs per provider and is normalized to ComputerAction first).
export const TOOL_INPUTS = {
  computer: ComputerAction,
  shell: ShellInput,
  files: FilesInput,
  browser_read: BrowserReadInput,
  browser_navigate: BrowserNavigateInput,
  browser_upload: BrowserUploadInput,
  browser_act: BrowserAction,
  find: FindInput,
  switch_screen: SwitchScreenInput,
  update_plan: UpdatePlanInput,
  ask_user: AskUserInput,
  request_takeover: RequestTakeoverInput,
  remember: RememberInput,
  recall: RecallInput,
  people: PeopleInput,
  done: DoneInput,
  routine: RoutineToolInput,
  follow_up_at: FollowUpAtInput,
} as const satisfies Record<ToolName, z.ZodType>;

// A tool's answer to the brain. Images are screenshots the daemon stored (by frameId) and sends
// as PNG, which keyd can size for the budget (P4a-R27).
export const ToolContent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("image"),
    frameId: z.string().regex(ULID_PATTERN),
    // A zoom: this region of the frame (model pixels), scaled up.
    region: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).optional(),
    mediaType: z.literal("image/png"),
    data: z.string(),
  }),
]);
export type ToolContent = z.infer<typeof ToolContent>;

export const ToolResult = z.object({
  ok: z.boolean(),
  content: z.array(ToolContent),
  // The task is over (done) or the user stopped it: the brain ends its loop.
  final: z.boolean().optional(),
  // Only the authenticated daemon tool result may install this control directive.
  pause: z.boolean().optional(),
  // Trusted gateway cancellation metadata; text or a result image cannot establish this cause.
  cancelled: z.literal("stale").optional(),
});
export type ToolResult = z.infer<typeof ToolResult>;

export const ToolCallRequest = z.object({
  callId: z.string().min(1).max(128),
  input: z.unknown(),
});
export type ToolCallRequest = z.infer<typeof ToolCallRequest>;
