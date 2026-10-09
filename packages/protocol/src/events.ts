import { z } from "zod";
import { AskFieldId, AskFieldKind, AskFieldRecord, MAX_ASK_FIELDS } from "./ask.ts";
import { Point, Rect } from "./geometry.ts";
import { ULID_PATTERN } from "./ids.ts";
import { Input } from "./input.ts";
import { TaintSource } from "./purpose.ts";
import { ActionClass, AlwaysOption, ApprovalCard, PauseSnapshot } from "./safety.ts";
import { ScreenName, ScreenSwitchData } from "./screens.ts";
import { SubscriptionUsageData } from "./subscription.ts";
import { Target } from "./target.ts";
import { boundedText } from "./text.ts";

const envelope = {
  v: z.literal(1),
  id: z.string().regex(ULID_PATTERN),
  seq: z.number().int().nonnegative(),
  t: z.number().int().nonnegative(),
  agent: z.string().min(1),
  step: z.string().min(1).optional(),
};

const event = <T extends string, D extends z.ZodType>(type: T, data: D) =>
  z.object({ ...envelope, type: z.literal(type), data });

export const Risk = z.enum(["none", "low", "medium", "high"]);
const PlanStatus = z.enum(["todo", "doing", "done", "skipped"]);

export const PointerPlan = z.object({
  from: Point,
  to: Point,
  startsAt: z.number().int().nonnegative(),
  durationMs: z.number().nonnegative(),
  seed: z.number().int().nonnegative(),
  curve: z.literal("minjerk-bow-v1"),
});
export type PointerPlan = z.infer<typeof PointerPlan>;
export const Injector = z.enum(["xtest", "driver"]);
export type Injector = z.infer<typeof Injector>;

export const SessionStart = event(
  "session.start",
  z.object({
    screen: z.object({
      w: z.number().int().positive(),
      h: z.number().int().positive(),
      scale: z.number().positive(),
    }),
    os: z.enum(["linux", "macos"]),
    title: z.string().max(200).optional(),
    // The earlier task this one continues, in the same conversation.
    continues: z.string().regex(ULID_PATTERN).optional(),
  }),
);
export const SessionEnd = event(
  "session.end",
  z.object({ reason: z.enum(["done", "stopped", "error"]) }),
);
export const ScreenSwitch = event("screen.switch", ScreenSwitchData);
export const AgentState = event(
  "agent.state",
  z.object({
    state: z.enum([
      "idle",
      "thinking",
      "acting",
      "observing",
      "waiting_user",
      "paused",
      "error",
      "done",
    ]),
    reason: z.string().max(200).optional(),
    // What the model's provider said, for a reason that has more to tell.
    detail: z.string().max(200).optional(),
  }),
);
// Why a task waits on something other than its own Pause, question or approval. The app gives
// each one a status, a line from dot and the one action that fixes it.
export const STALL = {
  budget: "budget",
  keyd: "keyd unavailable",
  modelBusy: "model busy",
  modelUnavailable: "model unavailable",
  modelRefused: "model refused",
  actionLimit: "action limit",
} as const;
export const Heartbeat = event(
  "heartbeat",
  z.object({ ongoing: z.boolean(), everyMs: z.number().int().positive() }),
);
export const ThoughtDelta = event("thought.delta", z.object({ text: z.string() }));
export const PlanSet = event(
  "plan.set",
  z.object({
    items: z.array(z.object({ id: z.string(), text: z.string().max(200), status: PlanStatus })),
  }),
);
export const PlanUpdate = event("plan.update", z.object({ id: z.string(), status: PlanStatus }));
export const StepStart = event(
  "step.start",
  z.object({
    kind: z.enum(["gui", "shell", "file", "browser", "ask", "think"]),
    planItem: z.string().optional(),
  }),
);
export const StepEnd = event(
  "step.end",
  z.object({
    status: z.enum(["ok", "failed", "blocked", "cancelled"]),
    note: z.string().max(500).optional(),
  }),
);
export const ActionIntent = event(
  "action.intent",
  z.object({
    verb: z.enum(["click", "move", "drag", "scroll", "type", "key", "wait"]),
    label: boundedText(80).refine((text) => text.length > 0),
    point: Point.optional(),
    risk: Risk,
    pointer: PointerPlan.optional(),
  }),
);
export const ActionTarget = event("action.target", z.object({ target: Target }));
export const ActionCancel = event(
  "action.cancel",
  z.object({
    reason: z.enum(["preflight", "policy", "user", "model", "timeout", "stale"]),
    detail: z.string().max(500).optional(),
  }),
);
// Session microseconds: raw press time and the measured onset of its delivery ring.
export const ActionDispatch = event(
  "action.dispatch",
  z.object({
    input: Input,
    pressT: z.number().int().nonnegative(),
    ringAt: z.number().int().nonnegative(),
    injector: Injector,
  }),
);
export const ActionResult = event(
  "action.result",
  z.object({ ok: z.boolean(), error: z.string().max(500).optional() }),
);
export const TextProgress = event(
  "text.progress",
  z
    .object({
      chunk: z.string().optional(),
      count: z.number().int().nonnegative(),
      masked: z.boolean(),
      caret: Rect.optional(),
    })
    .refine((d) => !(d.masked && d.chunk !== undefined), {
      message: "masked text.progress must not carry the typed chunk",
    }),
);
export const ScreenSettle = event(
  "screen.settle",
  z.object({
    frameT: z.number().int().nonnegative(),
    changed: z.array(Rect),
    noVisibleChange: z.boolean(),
  }),
);
export const Observe = event(
  "observe",
  z.object({
    frameId: z.string().regex(ULID_PATTERN),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
);
export const StepVerify = event(
  "step.verify",
  z.object({
    status: z.enum(["success", "unexpected", "failed"]),
    evidence: z.string().max(500).optional(),
  }),
);
export const ToolStart = event(
  "tool.start",
  z.object({ tool: z.string(), title: z.string().max(200) }),
);
export const ToolOutput = event(
  "tool.output",
  z.object({ stream: z.enum(["stdout", "stderr"]), chunk: z.string() }),
);
export const ToolEnd = event(
  "tool.end",
  z.object({ ok: z.boolean(), exitCode: z.number().int().optional() }),
);
export const FileChange = event(
  "file.change",
  z.object({
    path: z.string(),
    op: z.enum(["create", "modify", "delete"]),
    patch: z.string().optional(),
  }),
);
export const ApprovalKind = z.enum([
  "purchase",
  "send",
  "post",
  "delete",
  "login",
  "captcha",
  "download",
  "install",
  "permission",
  "other",
]);
export const ApprovalRequest = event(
  "approval.request",
  ApprovalCard.omit({ fields: true })
    .extend({
      kind: ApprovalKind,
      preview: z.strictObject({ fields: ApprovalCard.shape.fields }),
      target: Target.optional(),
    })
    .strict(),
);
export const ApprovalResolve = event(
  "approval.resolve",
  z.object({
    approvalId: z.string(),
    decision: z.enum(["approve", "deny", "take_control"]),
    by: z.enum(["user", "timeout"]),
    note: z.string().max(500).optional(),
  }),
);
// A task allowance has no id; a saved rule carries the id that removes it.
export const RuleChange = z
  .object({
    ...AlwaysOption.shape,
    actionClass: ActionClass,
    id: z.string().regex(ULID_PATTERN).optional(),
  })
  .refine(
    ({ actionClass, id, ...option }) => AlwaysOption.safeParse(option).success,
    "a site or app goes only with its own scope",
  );
export type RuleChange = z.infer<typeof RuleChange>;
export const RuleCreated = event("rule.created", RuleChange);
export const RuleRemoved = event("rule.removed", RuleChange);
export const ControlChange = event(
  "control.change",
  z.object({
    holder: z.enum(["agent", "user"]),
    reason: z.enum(["user_takeover", "handoff_request", "resume"]),
  }),
);
export const PauseChange = event(
  "pause.change",
  z.object({ paused: z.boolean(), atStepBoundary: z.boolean() }),
);
// changeId names the change so the UI can undo it; undoes names the change an undo reverted.
export const MemoryChange = event(
  "memory.change",
  z.object({
    file: z.enum(["USER.md", "MEMORY.md"]),
    patch: z.string(),
    changeId: z.string().regex(ULID_PATTERN).optional(),
    undoes: z.string().regex(ULID_PATTERN).optional(),
  }),
);
// From keyd's audit: host, method and path are text the cell's request chose, cut to these
// limits by the daemon and shown as plain text, never markup.
export const KeyUse = event(
  "key.use",
  z.object({
    secretId: z.string().max(64),
    host: z.string().max(255),
    method: z.string().max(16),
    path: z.string().max(512),
    decision: z.enum(["allow", "deny", "ask"]),
  }),
);
export const BudgetExceeded = event(
  "budget.exceeded",
  z.object({
    scope: z.enum(["task", "day"]),
    taskId: z.string().max(128).optional(),
    limitUSD: z.number().nonnegative(),
    spentUSD: z.number().nonnegative(),
    needUSD: z.number().nonnegative().optional(),
  }),
);
export const CameraHint = event(
  "camera.hint",
  z.object({
    focus: Rect,
    zoom: z.number().positive().optional(),
    reason: z.enum(["typing", "small-target", "approval"]),
  }),
);

// The agent (Part 5a): the conversation, the brain's questions and hand-offs, its result and what
// its models used. Message text is the user's or the model's own; nothing here carries a secret.
const MessageId = z.string().regex(ULID_PATTERN);
export const MessageUser = event(
  "message.user",
  z.object({
    messageId: MessageId,
    text: z.string().min(1).max(8000),
    kind: z.enum(["task", "steer", "followup"]),
    files: z.array(z.string().max(255)).max(16).optional(),
  }),
);
export const MessageDelta = event(
  "message.delta",
  z.object({ messageId: MessageId, text: z.string().max(4000) }),
);
export const MessageAssistant = event(
  "message.assistant",
  z.object({ messageId: MessageId, text: z.string().max(20_000) }),
);
export const AskRequestField = z.object({
  id: AskFieldId,
  kind: AskFieldKind,
  label: z.string().min(1).max(200),
  hint: z.string().min(1).max(300).optional(),
  options: z.array(z.string().min(1).max(200)).min(1).max(6).optional(),
  length: z.number().int().min(4).max(12).optional(),
  value: z.string().min(1).max(2000).optional(),
  // secret: where the field the answer is typed into was when dot asked, in the screen's pixels,
  // and the site whose page holds it.
  target: z
    .object({
      screen: ScreenName,
      point: Point,
      bbox: Rect.optional(),
      site: z.string().min(1).max(255).optional(),
    })
    .optional(),
});
export type AskRequestField = z.infer<typeof AskRequestField>;
// A request with `fields` answers per field (options is empty and allowText false); one without
// is a plain question with lettered options.
export const AskRequest = event(
  "ask.request",
  z.object({
    askId: z.string().regex(ULID_PATTERN),
    question: z.string().min(1).max(1000),
    options: z
      .array(z.object({ key: z.string().regex(/^[A-F]$/), text: z.string().min(1).max(200) }))
      .max(6),
    allowText: z.boolean(),
    fields: z.array(AskRequestField).min(1).max(MAX_ASK_FIELDS).optional(),
    submit: z.string().min(1).max(40).optional(),
    decline: z.string().min(1).max(40).optional(),
    // Only an answer ends it: there is no way out ("Not now").
    declinable: z.literal(false).optional(),
  }),
);
// The task read private data from here; what it read is never recorded.
export const SafetyTaint = event("safety.taint", TaintSource);
export const SafetyPause = event(
  "safety.pause",
  z.object({ revision: z.number().int().nonnegative(), pause: PauseSnapshot.optional() }).strict(),
);

export const AskAnswer = event(
  "ask.answer",
  z.object({
    askId: z.string().regex(ULID_PATTERN),
    option: z
      .string()
      .regex(/^[A-F]$/)
      .optional(),
    text: z.string().max(2000).optional(),
    // Per field id; a secret only as { provided: true }.
    fields: z.record(AskFieldId, AskFieldRecord).optional(),
    // The user chose the way out ("Not now").
    declined: z.literal(true).optional(),
    by: z.enum(["user", "timeout", "stop", "pause", "control"]),
  }),
);
export const TakeoverReason = z.enum(["login", "2fa", "captcha", "payment", "other"]);
export const TakeoverRequest = event(
  "takeover.request",
  z.object({
    requestId: z.string().regex(ULID_PATTERN),
    reason: TakeoverReason,
    note: z.string().max(500),
    // The user took the computer themselves; absent when dot handed it over.
    by: z.literal("user").optional(),
  }),
);
export const TakeoverEnd = event(
  "takeover.end",
  z.object({
    requestId: z.string().regex(ULID_PATTERN),
    note: z.string().max(1000).optional(),
    by: z.enum(["user", "stop"]),
    // The user typed on the computer while they had it. What they typed is never recorded.
    typed: z.literal(true).optional(),
  }),
);
export const TaskResult = event(
  "task.result",
  z.object({
    summary: z.string().max(8000),
    files: z
      .array(
        z.object({
          name: z.string().min(1).max(255),
          path: z.string().max(1024),
          bytes: z.number().int().nonnegative(),
        }),
      )
      .max(32),
  }),
);
export const ModelRole = z.enum(["main", "fast", "local"]);
export const ModelUsage = event(
  "model.usage",
  z.object({
    role: ModelRole,
    route: z.string().max(64),
    model: z.string().max(128),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    reasoningTokens: z.number().int().nonnegative().optional(),
  }),
);
export const ModelRetry = event(
  "model.retry",
  z.object({
    role: ModelRole,
    attempt: z.number().int().positive(),
    waitMs: z.number().int().nonnegative(),
    status: z.number().int().optional(),
    message: z.string().max(200),
    fallback: z.string().max(128).optional(),
  }),
);

// What keyd charged for one model call: billed when the provider's answer said what it cost,
// otherwise estimated from its token counts and the prices the task started with.
export const ModelSpendData = z.object({
  route: z.string().max(64),
  model: z.string().max(128),
  costUSD: z.number().nonnegative(),
  basis: z.enum(["billed", "estimated"]),
  taskSpentUSD: z.number().nonnegative(),
  daySpentUSD: z.number().nonnegative(),
  // Present only when the user set that limit.
  taskLimitUSD: z.number().positive().optional(),
  dayLimitUSD: z.number().positive().optional(),
});
export const ModelSpend = event("model.spend", ModelSpendData);

export const SubscriptionUsage = event("subscription.usage", SubscriptionUsageData);

export const LocalDotEvent = z.discriminatedUnion("type", [
  SessionStart,
  SessionEnd,
  ScreenSwitch,
  AgentState,
  Heartbeat,
  ThoughtDelta,
  PlanSet,
  PlanUpdate,
  StepStart,
  StepEnd,
  ActionIntent,
  ActionTarget,
  ActionCancel,
  ActionDispatch,
  ActionResult,
  TextProgress,
  ScreenSettle,
  Observe,
  StepVerify,
  ToolStart,
  ToolOutput,
  ToolEnd,
  FileChange,
  ApprovalRequest,
  ApprovalResolve,
  RuleCreated,
  RuleRemoved,
  ControlChange,
  PauseChange,
  MemoryChange,
  KeyUse,
  BudgetExceeded,
  CameraHint,
  MessageUser,
  MessageDelta,
  MessageAssistant,
  AskRequest,
  AskAnswer,
  SafetyPause,
  SafetyTaint,
  TakeoverRequest,
  TakeoverEnd,
  TaskResult,
  ModelUsage,
  ModelRetry,
  ModelSpend,
  SubscriptionUsage,
]);
export type LocalDotEvent = z.infer<typeof LocalDotEvent>;
export type EventType = LocalDotEvent["type"];
export type EventOf<T extends EventType> = Extract<LocalDotEvent, { type: T }>;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type EventDraft = DistributiveOmit<LocalDotEvent, "v" | "id" | "seq" | "t">;

export function parseEvent(value: unknown): LocalDotEvent {
  return LocalDotEvent.parse(value);
}
