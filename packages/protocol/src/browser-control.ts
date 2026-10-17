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
export const BrowserSignInRequest = schema.strictObject({
  permit: BrowserManualPermit,
  mode: BrowserSignInMode,
});
