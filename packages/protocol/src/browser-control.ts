import { z as schema } from "zod";
import { InputResult, TypeResult } from "./desktopd.ts";
import { ULID_PATTERN } from "./ids.ts";

export const BROWSER_CONTROL_TIMEOUT_MS = 5000;
// Transport deadlines must leave room for navigation to finish or return its own refusal.
export const BROWSER_NAVIGATION_TIMEOUT_MS = 30_000;

export const BrowserAgentOwner = schema.strictObject({
  sessionId: schema.string().regex(ULID_PATTERN),
  generation: schema.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
export type BrowserAgentOwner = schema.infer<typeof BrowserAgentOwner>;

const controlIdentity = {
  browserCellId: schema.string().regex(ULID_PATTERN),
  parentCellId: schema.string().regex(ULID_PATTERN),
  instance: schema.uuid(),
  revision: schema.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  requestId: schema.string().regex(ULID_PATTERN),
};

export const BrowserControlRequest = schema.discriminatedUnion("holder", [
  schema.strictObject({
    ...controlIdentity,
    holder: schema.literal("user"),
  }),
  schema.strictObject({
    ...controlIdentity,
    holder: schema.literal("agent"),
    owner: BrowserAgentOwner,
  }),
]);
export type BrowserControlRequest = schema.infer<typeof BrowserControlRequest>;

export const BrowserActionPermit = schema.strictObject({
  ...controlIdentity,
  owner: BrowserAgentOwner,
});
export type BrowserActionPermit = schema.infer<typeof BrowserActionPermit>;

// Only the daemon retains this receipt from a completed user-control transition.
// It carries no model owner and cannot be used by agent action endpoints.
export const BrowserManualPermit = schema.strictObject(controlIdentity);
export type BrowserManualPermit = schema.infer<typeof BrowserManualPermit>;
export const BrowserManualReply = schema.discriminatedUnion("kind", [
  schema.strictObject({ kind: schema.literal("input"), receipt: InputResult.strict() }),
  schema.strictObject({ kind: schema.literal("text"), receipt: TypeResult.strict() }),
]);
export type BrowserManualReply = schema.infer<typeof BrowserManualReply>;

export const BrowserControlReply = schema.strictObject({
  ...controlIdentity,
  holder: schema.enum(["agent", "user"]),
  reloaded: schema.number().int().nonnegative().max(256),
  selectionsCleared: schema.boolean(),
});
export type BrowserControlReply = schema.infer<typeof BrowserControlReply>;

// A user-owned browser can temporarily run without a debugging transport. This is
// distinct from ordinary takeover, which only revokes the agent's input permit.
export const BrowserSignInMode = schema.enum(["standard", "signin"]);
export type BrowserSignInMode = schema.infer<typeof BrowserSignInMode>;
export const BrowserSignInState = schema.strictObject({
  mode: BrowserSignInMode,
  changing: schema.boolean(),
});
// browserd's supervision of its Chromium: what last failed and whether it restarts in place.
// Details are fixed phrases such as an exit status, never page data.
export const BrowserFailureKind = schema.enum([
  "tab_crashed",
  "browser_exited",
  "control_lost",
  "unresponsive",
]);
export type BrowserFailureKind = schema.infer<typeof BrowserFailureKind>;
export const BrowserSupervisorState = schema.strictObject({
  state: schema.enum(["starting", "running", "restarting", "stopped"]),
  restarts: schema.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  lastFailure: schema
    .strictObject({
      kind: BrowserFailureKind,
      detail: schema.string().max(200),
      recovered: schema.boolean(),
      at: schema.iso.datetime(),
    })
    .optional(),
});
export type BrowserSupervisorState = schema.infer<typeof BrowserSupervisorState>;
// Why the web browser is not fully usable. Every state but "ready" carries one; a ready browser
// carries only "keys-locked": it browses, but saved passwords and sites bound to saved keys are
// refused until the user unlocks the saved keys.
export const BrowserStatusReason = schema.enum([
  "keys-locked",
  "key-service-offline",
  "computer-paused",
  "computer-stopped",
  "recovering",
  "starting",
  "restarting",
  "failed",
  "shutting-down",
]);
export type BrowserStatusReason = schema.infer<typeof BrowserStatusReason>;
// The web browser as the daemon reports it to the app, the CLI and dot: "off" while its computer or
// key service is unavailable, "failed" after a start that failed. `clears` says what makes it usable
// again; `retryAt` is when localDot next starts it by itself (none once it has given up), and
// `readyBy` when a start under way is ready or has failed.
export const BrowserStatus = schema.strictObject({
  state: schema.enum(["off", "starting", "ready", "restarting", "failed", "stopped"]),
  reason: BrowserStatusReason.optional(),
  problem: schema.string().max(600).optional(),
  problemAt: schema.iso.datetime().optional(),
  clears: schema.string().max(300).optional(),
  retryAt: schema.iso.datetime().optional(),
  readyBy: schema.iso.datetime().optional(),
  restarts: schema.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
});
export type BrowserStatus = schema.infer<typeof BrowserStatus>;
export const BrowserSignInRequest = schema.strictObject({
  permit: BrowserManualPermit,
  mode: BrowserSignInMode,
});
