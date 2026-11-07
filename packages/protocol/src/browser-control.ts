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

// Tasks hold the browser side by side, each with its own window; the user's control revokes them
// all. `front` is the task whose window the user takes the browser in. A task at rest asks for the
// user's control only `alone`: with other tasks at work it just lets go of its own grant, and the
// reply says it still is the agents'. A release ends one task's grant: with `keep` its window waits
// for the task to come back to the browser, without it the task is over and its window is free.
export const BrowserControlRequest = schema.discriminatedUnion("holder", [
  schema.strictObject({
    ...controlIdentity,
    holder: schema.literal("user"),
    front: schema.string().regex(ULID_PATTERN).optional(),
    alone: schema.literal(true).optional(),
  }),
  schema.strictObject({
    ...controlIdentity,
    holder: schema.literal("agent"),
    owner: BrowserAgentOwner,
  }),
  schema.strictObject({
    ...controlIdentity,
    holder: schema.literal("release"),
    owner: BrowserAgentOwner,
    keep: schema.literal(true).optional(),
  }),
]);
export type BrowserControlRequest = schema.infer<typeof BrowserControlRequest>;

export const BrowserActionPermit = schema.strictObject({
  ...controlIdentity,
  owner: BrowserAgentOwner,
});
export type BrowserActionPermit = schema.infer<typeof BrowserActionPermit>;

// A task's window in front, for its turn on the browser's one display. `continues` names the task
// whose window it takes up when it has none of its own, and `fresh` that it is a new conversation's
// and may take a finished task's window; `opened` says it got a new, blank one.
export const BrowserWindowEntry = schema.strictObject({
  permit: BrowserActionPermit,
  continues: schema.string().regex(ULID_PATTERN).optional(),
  fresh: schema.literal(true).optional(),
});
export type BrowserWindowEntry = schema.infer<typeof BrowserWindowEntry>;
export const BrowserWindowTab = schema.strictObject({ id: schema.uuid(), ready: schema.boolean() });
export const BrowserWindowReply = schema.strictObject({
  tabs: schema.array(BrowserWindowTab).max(256),
  opened: schema.boolean(),
});
export type BrowserWindowReply = schema.infer<typeof BrowserWindowReply>;

const browserIdentity = {
  browserCellId: controlIdentity.browserCellId,
  parentCellId: controlIdentity.parentCellId,
  instance: controlIdentity.instance,
};
// Pages nobody uses are frozen: those of every window but the windows of the tasks in `keep`. A
// thaw wakes every page; the window on screen shows again at once, the others as they come forward.
export const BrowserLifecycleRequest = schema.discriminatedUnion("frozen", [
  schema.strictObject({
    ...browserIdentity,
    frozen: schema.literal(true),
    keep: schema.array(schema.string().regex(ULID_PATTERN)).max(256),
  }),
  schema.strictObject({ ...browserIdentity, frozen: schema.literal(false) }),
]);
export type BrowserLifecycleRequest = schema.infer<typeof BrowserLifecycleRequest>;
export const BrowserLifecycleReply = schema.strictObject({
  frozen: schema.number().int().nonnegative().max(256),
});
export type BrowserLifecycleReply = schema.infer<typeof BrowserLifecycleReply>;

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
