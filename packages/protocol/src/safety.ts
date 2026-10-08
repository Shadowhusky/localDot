import { z } from "zod";
import { DesktopUploadFile } from "./desktop-uploads.ts";
import { ULID_PATTERN } from "./ids.ts";
import { UPLOAD_BYTES } from "./quarantine.ts";
import { BrowserUploadDestination } from "./upload-metadata.ts";
export const AutonomyMode = z.enum(["act", "ask", "handoff"]);
export type AutonomyMode = z.infer<typeof AutonomyMode>;
export const ActionClass = z.enum([
  "reading",
  "browsing",
  "purchase",
  "send",
  "post",
  "delete",
  "download_execute",
  "system_settings",
  "credentials",
  "unknown",
]);
export type ActionClass = z.infer<typeof ActionClass>;
export const EDITABLE_ACTION_CLASSES = [
  "reading",
  "browsing",
  "purchase",
  "send",
  "post",
  "delete",
  "download_execute",
  "system_settings",
] as const;
const policyObject = z.strictObject({
  reading: AutonomyMode,
  browsing: AutonomyMode,
  purchase: AutonomyMode,
  send: AutonomyMode,
  post: AutonomyMode,
  delete: AutonomyMode,
  download_execute: AutonomyMode,
  system_settings: AutonomyMode,
});
// HTTP JSON and daemon-produced dictionaries have own data properties only. Refuse
// inherited values/accessors before Zod can read them as authority.
const ownPolicy = z.custom<Record<string, unknown>>((value) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  return (
    keys.length === EDITABLE_ACTION_CLASSES.length &&
    EDITABLE_ACTION_CLASSES.every((key) => {
      const descriptor = descriptors[key];
      return descriptor !== undefined && Object.hasOwn(descriptor, "value");
    })
  );
}, "autonomy must contain exactly the editable action classes as own data properties");
export const AutonomyPolicy = ownPolicy.pipe(policyObject).readonly();
export type AutonomyPolicy = z.infer<typeof AutonomyPolicy>;
export const DEFAULT_AUTONOMY: Readonly<AutonomyPolicy> = Object.freeze({
  reading: "act",
  browsing: "act",
  purchase: "ask",
  send: "ask",
  post: "ask",
  delete: "ask",
  download_execute: "ask",
  system_settings: "ask",
});
export function freezeAutonomy(value: unknown = DEFAULT_AUTONOMY): Readonly<AutonomyPolicy> {
  return AutonomyPolicy.parse(value);
}
const safeText = (limit: number) =>
  z
    .string()
    .max(limit)
    .refine(
      (value) => value.isWellFormed() && !value.includes("\0"),
      "text must be well-formed without null characters",
    );
const Id = z.string().regex(ULID_PATTERN);
const Counter = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const APPROVAL_TIMEOUT_MS = 600000;
export const ApprovalAnswer = z.strictObject({
  approvalId: Id,
  generation: Counter,
  revision: Counter,
  decision: z.enum(["approve", "deny", "take_control"]),
});
export type ApprovalAnswer = z.infer<typeof ApprovalAnswer>;
export const UploadApproval = z.strictObject({
  destination: BrowserUploadDestination,
  files: DesktopUploadFile.omit({ identity: true })
    .array()
    .min(1)
    .max(10)
    .refine((files) => files.reduce((total, file) => total + file.bytes, 0) <= UPLOAD_BYTES)
    .refine((files) => new Set(files.map((file) => file.path)).size === files.length),
});
export type UploadApproval = z.infer<typeof UploadApproval>;
export const ApprovalCardDraft = z.strictObject({
  actionClass: ActionClass,
  risk: z.enum(["medium", "high"]),
  title: safeText(200),
  fields: z.array(z.tuple([safeText(80), safeText(512)])).max(16),
  upload: UploadApproval.optional(),
});
export type ApprovalCardDraft = z.infer<typeof ApprovalCardDraft>;
export const ApprovalCard = ApprovalCardDraft.extend({
  approvalId: Id,
  generation: Counter,
  revision: Counter,
  expiresAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export type ApprovalCard = z.infer<typeof ApprovalCard>;
export const PauseReason = z.enum(["user", "repeated_action"]);
// Reasons on the paused states a session publishes for its own Pause, approval or question. None is
// a recovery pause such as the spending limit, so none may stand in for one.
export const SESSION_PAUSE_REASONS: readonly string[] = [
  ...PauseReason.options,
  "approval",
  "question",
];
export const PauseSnapshot = z
  .strictObject({
    requestId: Id,
    revision: Counter,
    phase: z.enum(["pausing", "paused", "resuming", "uncertain"]),
    reason: PauseReason,
    atStepBoundary: z.boolean(),
    resumeAvailable: z.boolean(),
  })
  .refine(
    (value) => !value.resumeAvailable || (value.phase === "paused" && value.atStepBoundary),
    "Resume requires a confirmed settled Pause",
  );
export type PauseSnapshot = z.infer<typeof PauseSnapshot>;
export const PauseRequest = z.strictObject({ requestId: Id });
export type PauseRequest = z.infer<typeof PauseRequest>;
export const ResumeSafetyRequest = z.strictObject({ requestId: Id, revision: Counter });
export type ResumeSafetyRequest = z.infer<typeof ResumeSafetyRequest>;
export const ModelAdmissionSnapshot = z.strictObject({
  taskId: Id,
  generationId: z.string().regex(/^[0-9a-f]{32}$/),
  epoch: Counter,
  paused: z.boolean(),
  active: z.number().int().nonnegative().max(64),
  retired: z.boolean(),
});
export type ModelAdmissionSnapshot = z.infer<typeof ModelAdmissionSnapshot>;
export const ModelAdmissionWrite = z
  .strictObject({
    taskId: Id,
    generationId: z.string().regex(/^[0-9a-f]{32}$/),
    state: z.enum(["paused", "open"]),
    expectedEpoch: Counter.optional(),
  })
  .refine(
    (value) => value.state !== "open" || value.expectedEpoch !== undefined,
    "opening model admission requires its current epoch",
  );
export type ModelAdmissionWrite = z.infer<typeof ModelAdmissionWrite>;
export const ReplacementRequest = z.strictObject({
  requestId: Id,
  oldRevision: Counter,
  home: z.literal("fresh"),
});
export type ReplacementRequest = z.infer<typeof ReplacementRequest>;

export const ReplacementRecord = z
  .strictObject({
    requestId: Id,
    oldCellId: Id,
    revision: Counter,
    phase: z.enum(["fenced", "retiring", "retired", "allocating", "ready", "blocked"]),
    newCellId: Id.optional(),
    reason: z.enum(["old_retirement", "new_creation", "record_unavailable"]).optional(),
  })
  .refine((value) => value.oldCellId !== value.newCellId, "replacement requires a fresh identity")
  .refine(
    (value) => !["allocating", "ready"].includes(value.phase) || !!value.newCellId,
    "candidate required",
  )
  .refine(
    (value) => (value.phase === "blocked") === (value.reason !== undefined),
    "blocked reason required",
  );
export type ReplacementRecord = z.infer<typeof ReplacementRecord>;
export const ComputerFence = z.strictObject({ revision: Counter });
export type ComputerFence = z.infer<typeof ComputerFence>;
