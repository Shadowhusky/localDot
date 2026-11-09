import { z } from "zod";
import { SECRET_ID_PATTERN } from "./keyd.ts";

// Why a task waits on something other than its own Pause, question or approval. The app gives
// each one a status, a line from dot and the one action that fixes it.
export const STALL = {
  budget: "budget",
  keyd: "keyd unavailable",
  modelBusy: "model busy",
  modelUnavailable: "model unavailable",
  modelRefused: "model refused",
  providerLimit: "provider limit reached",
  actionLimit: "action limit",
  // The detail names the key whose value the user enters again.
  keyReenter: "key needs re-entering",
  // The detail names the key changed outside localDot, which the user removes and adds again.
  keyRebound: "key changed outside localDot",
  // The model's key is in the passphrase vault, which is locked; unlocking it resumes the task.
  keysLocked: "keys locked",
  // Docker stopped and took the brain with it; the task goes on once it is back.
  runtime: "docker unavailable",
} as const;

export const PLAN_LIMITS = [
  "chatgpt plan limit reached",
  "claude code plan limit reached",
] as const;
// A model's stalls the user gets past by choosing another: nothing else moves them along.
export const MODEL_BLOCKS = [
  STALL.modelRefused,
  STALL.modelUnavailable,
  STALL.providerLimit,
  ...PLAN_LIMITS,
] as const;
export function modelBlock(reason: string | undefined): boolean {
  return (MODEL_BLOCKS as readonly (string | undefined)[]).includes(reason);
}

export const KeyProblem = z.enum(["reenter", "rebound", "rejected"]);
export type KeyProblem = z.infer<typeof KeyProblem>;

// What stops dot that the user can fix right in the conversation, by kind. Each is strict and bounded:
// the card's words are localDot's own, chosen by kind, so neither a secret nor anything dot or a page
// wrote has a field to travel in. `detail` is the provider's own refusal, drawn as plain text.
export const Blocker = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("keys_locked") }),
  z.strictObject({
    kind: z.literal("key"),
    id: z.string().regex(SECRET_ID_PATTERN),
    problem: KeyProblem,
  }),
  z.strictObject({
    kind: z.literal("app"),
    connector: z.string().min(1).max(16),
    name: z.string().min(1).max(40),
    host: z.string().min(1).max(253),
  }),
  z.strictObject({
    kind: z.literal("model"),
    reason: z.enum(MODEL_BLOCKS),
    detail: z.string().max(200).optional(),
  }),
  z.strictObject({ kind: z.literal("computer"), state: z.enum(["stopped", "paused"]) }),
  z.strictObject({ kind: z.literal("runtime") }),
]);
export type Blocker = z.infer<typeof Blocker>;
export type BlockerKind = Blocker["kind"];
export const BLOCKER_KINDS = Blocker.options.map(
  (option) => option.shape.kind.value,
) as readonly BlockerKind[];

// One card per thing that is stopping dot, however many failures it causes.
export function blockerSubject(blocker: Blocker): string {
  switch (blocker.kind) {
    case "key":
      return `key:${blocker.id}`;
    case "app":
      return `app:${blocker.connector}`;
    default:
      return blocker.kind;
  }
}

// The kinds dot may raise itself. A model's own failure is known to the daemon alone, and every one
// here is checked against what is really so before a card shows.
export const RequestFixInput = z
  .object({
    kind: z
      .enum(["keys_locked", "key", "app", "computer", "runtime"])
      .describe(
        "keys_locked: saved keys are locked (HTTP 423 vault-locked). key: a saved key was refused. app: a connected app's sign-in ended. computer: the computer is off or paused. runtime: Docker isn't running.",
      ),
    key_id: z.string().min(1).max(64).optional().describe("kind key: the saved key's id."),
    app: z.string().min(1).max(64).optional().describe("kind app: the connected app's id or name."),
  })
  .superRefine((input, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: "custom", message });
    if (input.kind === "key" && !input.key_id) issue("kind key needs key_id");
    if (input.key_id !== undefined && !SECRET_ID_PATTERN.test(input.key_id))
      issue("key_id is a saved key's id");
    if (input.kind === "app" && !input.app) issue("kind app needs app");
  });
export type RequestFixInput = z.infer<typeof RequestFixInput>;

const INSTEAD = "you sent a message instead";
// How a card reads once it is history, in the thread and in Replay.
export function blockerLine(
  blocker: Blocker,
  outcome: "fixed" | "worked" | "dismissed" | "moved_on" | "open",
  movedTo?: string,
): string {
  switch (blocker.kind) {
    case "keys_locked":
      return {
        fixed: "Keys unlocked",
        worked: "Keys unlocked",
        dismissed: "You left your keys locked",
        moved_on: `Not unlocked: ${INSTEAD}`,
        open: "Saved keys were locked",
      }[outcome];
    case "key":
      return {
        fixed: `${blocker.id} key saved`,
        worked: `The ${blocker.id} key worked`,
        dismissed: `You left the ${blocker.id} key for now`,
        moved_on: `The ${blocker.id} key not saved: ${INSTEAD}`,
        open: `The ${blocker.id} key needed your attention`,
      }[outcome];
    case "app":
      return {
        fixed: `${blocker.name} connected`,
        worked: `${blocker.name} worked again`,
        dismissed: `You left ${blocker.name} for now`,
        moved_on: `${blocker.name} not connected: ${INSTEAD}`,
        open: `${blocker.name} needed signing in`,
      }[outcome];
    case "model":
      return {
        fixed: movedTo ? `Switched to ${movedTo}` : "The model answered again",
        worked: "The model answered again",
        dismissed: "You left the model for now",
        moved_on: `Model not changed: ${INSTEAD}`,
        open: "The model couldn't go on",
      }[outcome];
    case "computer":
      return {
        fixed: "Your computer is back on",
        worked: "Your computer is back on",
        dismissed: "You left your computer off",
        moved_on: `Your computer not turned on: ${INSTEAD}`,
        open: blocker.state === "paused" ? "Your computer was paused" : "Your computer was off",
      }[outcome];
    case "runtime":
      return {
        fixed: "Docker is running again",
        worked: "Docker is running again",
        dismissed: "You left Docker off",
        moved_on: `Docker not started: ${INSTEAD}`,
        open: "Docker wasn't running",
      }[outcome];
  }
}
