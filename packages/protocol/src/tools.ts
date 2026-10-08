import { z } from "zod";
import { DesktopUploadPath } from "./desktop-uploads.ts";
import { ULID_PATTERN } from "./ids.ts";
import { SwitchScreenInput } from "./screens.ts";

// The v1 tool table (spec "The agent"): the only tools a brain may declare and the only ones the
// daemon's tool API runs, including M7's isolated browser screen.
export const TOOL_NAMES = [
  "computer",
  "shell",
  "files",
  "browser_read",
  "browser_navigate",
  "browser_upload",
  "switch_screen",
  "update_plan",
  "ask_user",
  "request_takeover",
  "remember",
  "done",
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
const COMPUTER_ACTIONS = [
  "screenshot",
  "left_click",
  "right_click",
  "middle_click",
  "double_click",
  "triple_click",
  "type",
  "key",
  "scroll",
  "wait",
  "zoom",
  "cursor_position",
  "mouse_move",
  "left_click_drag",
  "left_mouse_down",
  "left_mouse_up",
  "hold_key",
] as const;
export const ComputerActionName = z.enum(COMPUTER_ACTIONS);
export type ComputerActionName = z.infer<typeof ComputerActionName>;

// localDot's generic computer tool (spec "Catalog"): Anthropic-style actions, a coordinate that is
// a length-2 number array (Gemini rejects z.tuple), in the space the tool's description declares.
export const GenericComputerInput = z.object({
  action: ComputerActionName,
  coordinate: z.array(z.number()).length(2).optional(),
  start_coordinate: z.array(z.number()).length(2).optional(),
  text: z.string().max(4000).optional(),
  scroll_direction: z.enum(["up", "down", "left", "right"]).optional(),
  scroll_amount: z.number().int().min(1).max(30).optional(),
  duration: z.number().min(0).max(30).optional(),
  region: z.array(z.number()).length(4).optional(),
  repeat: z.number().int().min(1).max(20).optional(),
});
export type GenericComputerInput = z.infer<typeof GenericComputerInput>;

// What the brain sends the daemon for one computer action, whatever the provider said: points in
// model pixels (MODEL_SCREEN), keys as X-style names.
export const ComputerAction = z.object({
  action: z.enum([
    "screenshot",
    "click",
    "type",
    "key",
    "hold_key",
    "scroll",
    "wait",
    "zoom",
    "cursor_position",
  ]),
  point: z.object({ x: z.number().int(), y: z.number().int() }).optional(),
  button: z.enum(["left", "right", "middle"]).optional(),
  count: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
  text: z.string().min(1).max(4000).optional(),
  keys: z.array(z.string().min(1).max(32)).min(1).max(8).optional(),
  // key: presses of the combo, as one input. hold_key: `ms` is how long the keys stay down.
  repeat: z.number().int().min(1).max(100).optional(),
  dx: z.number().int().min(-30).max(30).optional(),
  dy: z.number().int().min(-30).max(30).optional(),
  ms: z.number().int().min(0).max(30_000).optional(),
  region: z
    .object({ x: z.number().int(), y: z.number().int(), w: z.number().int(), h: z.number().int() })
    .optional(),
  // The screenshot the model based this action on (the freshness check, spec "Harness rules").
  basedOn: z.string().regex(ULID_PATTERN).optional(),
});
export type ComputerAction = z.infer<typeof ComputerAction>;

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

export const PlanItemStatus = z.enum(["todo", "doing", "done", "skipped"]);
export const UpdatePlanInput = z.object({
  items: z
    .array(z.object({ text: z.string().min(1).max(200), status: PlanItemStatus }))
    .min(1)
    .max(30),
});
export type UpdatePlanInput = z.infer<typeof UpdatePlanInput>;

export const AskUserInput = z.object({
  question: z.string().min(1).max(1000),
  options: z.array(z.string().min(1).max(200)).max(6).optional(),
  allow_text: z.boolean().optional(),
});
export type AskUserInput = z.infer<typeof AskUserInput>;

export const RequestTakeoverInput = z.object({
  reason: z.enum(["login", "2fa", "captcha", "payment", "other"]),
  note: z.string().min(1).max(500),
});
export type RequestTakeoverInput = z.infer<typeof RequestTakeoverInput>;

export const RememberInput = z.object({
  file: z.enum(["USER.md", "MEMORY.md"]),
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
  switch_screen: SwitchScreenInput,
  update_plan: UpdatePlanInput,
  ask_user: AskUserInput,
  request_takeover: RequestTakeoverInput,
  remember: RememberInput,
  done: DoneInput,
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
