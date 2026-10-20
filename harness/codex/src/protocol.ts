import { isAbsolute, normalize } from "node:path";
import { z } from "zod";

// The part of Codex app-server 0.154.0's protocol localDot sends and reads (from
// `codex app-server generate-json-schema`; schema/contract-0.154.0.json pins it, Task 13). The
// envelope has no `jsonrpc` field: {id, method, params}, {id, result}, {id, error}, {method, params}.
// Objects are loose: a field localDot does not read may come and go between builds.

// The only requests localDot ever sends. Never command/exec, fs/*, thread/shellCommand, config
// writes, plugin installs or feedback uploads (P5c-R20).
export const CLIENT_METHODS = Object.freeze([
  "initialize",
  "account/read",
  "account/login/start",
  "account/login/cancel",
  "account/logout",
  "account/rateLimits/read",
  "model/list",
  "thread/start",
  "turn/start",
  "turn/steer",
  "turn/interrupt",
  "mcpServerStatus/list",
] as const);
export type ClientMethod = (typeof CLIENT_METHODS)[number];

// thread/start for a task (spec "Thread"): approvals go to localDot (never Codex's auto-reviewer),
// Codex's own sandbox is read-only so every file change needs an approval localDot declines, and
// the thread is never written to disk.
export function threadStartParams(input: {
  cwd: string;
  model: string;
  developerInstructions: string;
}) {
  if (
    !isAbsolute(input.cwd) ||
    normalize(input.cwd) !== input.cwd ||
    /[\\\0\r\n]/.test(input.cwd) ||
    !input.model ||
    !input.developerInstructions
  )
    throw new Error("Invalid Codex thread parameters.");
  return {
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandbox: "read-only",
    ephemeral: true,
    cwd: input.cwd,
    model: input.model,
    developerInstructions: input.developerInstructions,
  } as const;
}

const id = z.string().min(1);

export const TurnError = z.looseObject({
  message: z.string(),
  codexErrorInfo: z.unknown().optional(),
});
export type TurnError = z.infer<typeof TurnError>;

export const Turn = z.looseObject({
  id,
  status: z.enum(["completed", "interrupted", "failed", "inProgress"]),
  error: TurnError.nullish(),
});
export type Turn = z.infer<typeof Turn>;

export const ThreadStartResult = z.looseObject({
  thread: z.looseObject({ id }),
  model: z.string(),
  approvalsReviewer: z.string(),
});

export const TurnStarted = z.looseObject({ threadId: id, turn: Turn });
export const TurnCompleted = z.looseObject({ threadId: id, turn: Turn });

export const ThreadItem = z.looseObject({ id, type: z.string() });
export const ItemNotification = z.looseObject({ threadId: id, turnId: id, item: ThreadItem });
export const AgentMessageItem = z.looseObject({
  id,
  type: z.literal("agentMessage"),
  text: z.string(),
  phase: z.enum(["commentary", "final_answer"]).nullish(),
});
export const McpToolCallItem = z.looseObject({
  id,
  type: z.literal("mcpToolCall"),
  server: z.string(),
  tool: z.string(),
  status: z.enum(["inProgress", "completed", "failed"]),
});

export const TextDelta = z.looseObject({ threadId: id, turnId: id, itemId: id, delta: z.string() });

export const TokenUsageUpdated = z.looseObject({
  threadId: id,
  turnId: id,
  tokenUsage: z.looseObject({
    last: z.looseObject({
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
      reasoningOutputTokens: z.number().int().nonnegative(),
    }),
  }),
});

export const ErrorNotification = z.looseObject({
  threadId: id,
  turnId: id,
  willRetry: z.boolean(),
  error: TurnError,
});

export const RateLimitWindow = z.looseObject({
  usedPercent: z.number().finite().min(0).max(100),
  windowDurationMins: z.number().int().positive().nullish(),
  resetsAt: z.number().int().nonnegative().nullish(),
});
export const RateLimitSnapshot = z.looseObject({
  planType: z.string().nullish(),
  primary: RateLimitWindow.nullish(),
  secondary: RateLimitWindow.nullish(),
  rateLimitReachedType: z.string().nullish(),
});
export type RateLimitSnapshot = z.infer<typeof RateLimitSnapshot>;
export const RateLimitsRead = z.looseObject({ rateLimits: RateLimitSnapshot });
export const RateLimitsUpdated = z.looseObject({ rateLimits: RateLimitSnapshot });

export const AccountRead = z.looseObject({
  account: z
    .union([
      z.looseObject({
        type: z.literal("chatgpt"),
        email: z.string().nullable(),
        planType: z.string(),
      }),
      z.looseObject({ type: z.string() }).refine((a) => a.type !== "chatgpt"),
    ])
    .nullable(),
  requiresOpenaiAuth: z.boolean(),
});
export type AccountRead = z.infer<typeof AccountRead>;

export const LoginStarted = z.discriminatedUnion("type", [
  z.looseObject({ type: z.literal("chatgpt"), loginId: id, authUrl: z.url() }),
  z.looseObject({
    type: z.literal("chatgptDeviceCode"),
    loginId: id,
    verificationUrl: z.url(),
    userCode: z.string().min(1),
  }),
]);
export type LoginStarted = z.infer<typeof LoginStarted>;

export const LoginCompleted = z.looseObject({
  loginId: z.string().nullish(),
  success: z.boolean(),
  error: z.string().nullish(),
});

export const ModelList = z.looseObject({
  data: z.array(
    z.looseObject({
      id,
      displayName: z.string(),
      isDefault: z.boolean(),
      hidden: z.boolean(),
      defaultReasoningEffort: z.string(),
      supportedReasoningEfforts: z.array(z.looseObject({ reasoningEffort: z.string() })).optional(),
      serviceTiers: z.array(z.looseObject({ id: z.string() })).optional(),
      additionalSpeedTiers: z.array(z.string()).optional(),
      inputModalities: z.array(z.string()).optional(),
    }),
  ),
});

// What a finished turn means for the task (P5c-R10, R11, R12). CodexErrorInfo is a string or a
// one-key object (camelCase), per 0.154's schema.
export type TurnOutcome =
  | { kind: "completed" }
  | { kind: "in_progress" }
  | { kind: "interrupted" }
  | { kind: "signed_out"; message: string }
  | { kind: "plan_limit"; message: string }
  | { kind: "retry"; message: string }
  | { kind: "failed"; message: string };

const RETRYABLE = new Set([
  "serverOverloaded",
  "internalServerError",
  "rateLimitExceeded",
  "httpConnectionFailed",
  "responseStreamConnectionFailed",
  "responseStreamDisconnected",
  "responseTooManyFailedAttempts",
]);

export function codexErrorKind(info: unknown): string | undefined {
  if (typeof info === "string") return info;
  if (typeof info === "object" && info !== null && !Array.isArray(info)) {
    const keys = Object.keys(info);
    return keys.length === 1 ? keys[0] : undefined;
  }
  return undefined;
}

export function turnOutcome(turn: Turn): TurnOutcome {
  if (turn.status === "completed") return { kind: "completed" };
  if (turn.status === "inProgress") return { kind: "in_progress" };
  if (turn.status === "interrupted") return { kind: "interrupted" };
  const kind = codexErrorKind(turn.error?.codexErrorInfo);
  if (kind === "unauthorized") return { kind: "signed_out", message: "Sign in to ChatGPT again." };
  if (kind === "usageLimitExceeded")
    return { kind: "plan_limit", message: "The ChatGPT plan limit was reached." };
  if (kind !== undefined && RETRYABLE.has(kind))
    return { kind: "retry", message: "The ChatGPT connection was interrupted. Try again." };
  return { kind: "failed", message: "The ChatGPT turn failed." };
}
