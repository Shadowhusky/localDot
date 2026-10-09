import { z } from "zod";
import { CONNECTOR_TOOL_NAME_PATTERN } from "./connectors.ts";
import { DesktopUploadFile } from "./desktop-uploads.ts";
import { ULID_PATTERN } from "./ids.ts";
import { UPLOAD_BYTES } from "./quarantine.ts";
import { BrowserUploadDestination } from "./upload-metadata.ts";
export const AutonomyMode = z.enum(["act", "ask", "handoff"]);
export type AutonomyMode = z.infer<typeof AutonomyMode>;
export const ActionClass = z.enum([
  "reading",
  "browsing",
  "computer",
  "purchase",
  "send",
  "post",
  "delete",
  "download_execute",
  "system_settings",
  "memory",
  "upload",
  "credentials",
  "unknown",
  "network",
]);
export type ActionClass = z.infer<typeof ActionClass>;
export const EDITABLE_ACTION_CLASSES = [
  "reading",
  "browsing",
  "computer",
  "purchase",
  "send",
  "post",
  "delete",
  "download_execute",
  "system_settings",
  "memory",
] as const;
const LEGACY_ACTION_CLASSES = EDITABLE_ACTION_CLASSES.filter(
  (key) => key !== "computer" && key !== "memory",
);
const policyObject = z.strictObject({
  reading: AutonomyMode,
  browsing: AutonomyMode,
  computer: AutonomyMode,
  purchase: AutonomyMode,
  send: AutonomyMode,
  post: AutonomyMode,
  delete: AutonomyMode,
  download_execute: AutonomyMode,
  system_settings: AutonomyMode,
  memory: AutonomyMode,
});
// Policies saved before `computer` and `memory` existed must keep parsing, or one old safety.json
// fences every computer. They take `computer` from the saved browsing choice.
const legacyPolicyObject = policyObject
  .omit({ computer: true, memory: true })
  .transform(({ reading, browsing, ...rest }) => ({
    reading,
    browsing,
    computer: browsing,
    ...rest,
    memory: "ask" as const,
  }));
// HTTP JSON and daemon-produced dictionaries have own data properties only. Refuse
// inherited values/accessors before Zod can read them as authority.
const ownPolicy = z.custom<Record<string, unknown>>((value) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  const shape =
    keys.length === LEGACY_ACTION_CLASSES.length ? LEGACY_ACTION_CLASSES : EDITABLE_ACTION_CLASSES;
  return (
    keys.length === shape.length &&
    shape.every((key) => {
      const descriptor = descriptors[key];
      return descriptor !== undefined && Object.hasOwn(descriptor, "value");
    })
  );
}, "autonomy must contain exactly the editable action classes as own data properties");
export const AutonomyPolicy = ownPolicy
  .pipe(z.union([policyObject, legacyPolicyObject]))
  .readonly();
export type AutonomyPolicy = z.infer<typeof AutonomyPolicy>;
// Balanced asks only before acting as the user; the purpose check covers everything else.
export const BALANCED_AUTONOMY: Readonly<AutonomyPolicy> = Object.freeze({
  reading: "act",
  browsing: "act",
  computer: "act",
  purchase: "ask",
  send: "ask",
  post: "ask",
  delete: "ask",
  download_execute: "act",
  system_settings: "ask",
  memory: "act",
});
export const CAREFUL_AUTONOMY: Readonly<AutonomyPolicy> = Object.freeze({
  ...BALANCED_AUTONOMY,
  computer: "ask",
  download_execute: "ask",
  memory: "ask",
});
export const DEFAULT_AUTONOMY = BALANCED_AUTONOMY;
// Balanced as saved before the purpose check, when it also asked before running downloaded
// programs and saving to memory. A policy saved as that preset reads as today's Balanced.
const EARLIER_BALANCED: Readonly<AutonomyPolicy> = Object.freeze({
  ...BALANCED_AUTONOMY,
  download_execute: "ask",
  memory: "ask",
});
export function currentAutonomy(policy: AutonomyPolicy): AutonomyPolicy {
  const same = EDITABLE_ACTION_CLASSES.every((key) => policy[key] === EARLIER_BALANCED[key]);
  return same ? BALANCED_AUTONOMY : policy;
}
export const ACTION_CLASS_LABELS: Readonly<Record<ActionClass, string>> = Object.freeze({
  reading: "Read and look",
  browsing: "Browse websites",
  computer: "Work in its computer",
  download_execute: "Run downloaded programs",
  memory: "Save to its memory",
  send: "Send as you",
  post: "Post or publish as you",
  delete: "Delete your online data",
  system_settings: "Change account settings",
  purchase: "Buy or pay",
  upload: "Upload your files",
  credentials: "Passwords, codes and card details",
  unknown: "Unclear steps on signed-in sites",
  network: "Connections beyond websites",
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
// A card waits for the user; the ceiling matches the Codex path's 24-hour tool timeout.
export const APPROVAL_TIMEOUT_MS = 86_400_000;
export const AlwaysScope = z.enum(["task", "site", "app", "always", "destination"]);
export type AlwaysScope = z.infer<typeof AlwaysScope>;
const Origin = z
  .string()
  .max(300)
  .refine(
    (value) =>
      URL.canParse(value) &&
      ["http:", "https:"].includes(new URL(value).protocol) &&
      new URL(value).origin === value,
    "site must be an exact http(s) origin",
  );
// A connection's host and port as one text, an IPv6 address in brackets: what a network rule names.
export const DESTINATION_PATTERN =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+|\[[0-9a-f:.]+\]):(?:[1-9]\d{0,4})$/;
const Destination = z
  .string()
  .max(262)
  .regex(DESTINATION_PATTERN)
  .refine((value) => Number(value.slice(value.lastIndexOf(":") + 1)) <= 65535, "port");
const placed = (value: {
  scope: AlwaysScope;
  site?: string;
  app?: string;
  destination?: string;
  tool?: string;
}) =>
  (value.scope === "site") === (value.site !== undefined) &&
  // A yes for one connector tool lasts the task, and covers that tool only.
  (value.tool === undefined || value.scope === "task") &&
  // A connection's rule may name the program as well as its destination.
  (value.scope === "app"
    ? value.app !== undefined
    : value.app === undefined || value.scope === "destination") &&
  // A connection allowed for the task names its destination too.
  (value.scope === "destination"
    ? value.destination !== undefined
    : value.destination === undefined || value.scope === "task");
export const AlwaysOption = z
  .strictObject({
    scope: AlwaysScope,
    label: safeText(200),
    site: Origin.optional(),
    app: safeText(128).optional(),
    destination: Destination.optional(),
    tool: z.string().regex(CONNECTOR_TOOL_NAME_PATTERN).optional(),
  })
  .refine(placed, "a site, app or destination goes only with its own scope");
export type AlwaysOption = z.infer<typeof AlwaysOption>;
export const AutonomyRule = z
  .strictObject({
    id: Id,
    behavior: z.literal("act"),
    actionClass: ActionClass,
    scope: AlwaysScope.exclude(["task"]),
    site: Origin.optional(),
    app: safeText(128).optional(),
    destination: Destination.optional(),
    label: safeText(200),
    createdAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    createdFrom: Id,
  })
  .refine(placed, "a site, app or destination goes only with its own scope");
export type AutonomyRule = z.infer<typeof AutonomyRule>;
// The answer names a scope only; the site, app and class come from the card the daemon wrote.
export const ApprovalAnswer = z
  .strictObject({
    approvalId: Id,
    generation: Counter,
    revision: Counter,
    decision: z.enum(["approve", "deny", "take_control"]),
    always: AlwaysScope.optional(),
  })
  .refine(
    (value) => value.always === undefined || value.decision === "approve",
    "only an approval can always allow",
  );
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
// A card carries each value whole up to APPROVAL_FIELD_CHARS. A longer value (at most a whole
// files write) carries its start, is listed in `partial` with its full length, and Approve needs
// the rest to have been read from the daemon first.
export const APPROVAL_FIELD_CHARS = 16_384;
export const APPROVAL_VALUE_CHARS = 1_000_000;
const approvalFields = (limit: number) => z.array(z.tuple([safeText(80), safeText(limit)])).max(16);
export const ApprovalCardDraft = z.strictObject({
  actionClass: ActionClass,
  risk: z.enum(["medium", "high"]),
  title: safeText(200),
  // One sentence on why this asks.
  why: safeText(300).optional(),
  // A purpose check's ask: the hosts the step would send what dot read to.
  destinations: z.array(z.string().min(1).max(253)).min(1).max(64).optional(),
  fields: approvalFields(APPROVAL_FIELD_CHARS),
  partial: z
    .array(
      z.strictObject({
        field: z.number().int().min(0).max(15),
        length: z
          .number()
          .int()
          .min(APPROVAL_FIELD_CHARS + 1)
          .max(APPROVAL_VALUE_CHARS),
      }),
    )
    .min(1)
    .max(16)
    .optional(),
  upload: UploadApproval.optional(),
  always: z
    .array(AlwaysOption)
    .max(4)
    .refine((options) => new Set(options.map((option) => option.scope)).size === options.length)
    .optional(),
});
export type ApprovalCardDraft = z.infer<typeof ApprovalCardDraft>;
export const ApprovalRequestDraft = ApprovalCardDraft.omit({ partial: true }).extend({
  fields: approvalFields(APPROVAL_VALUE_CHARS),
});
export type ApprovalRequestDraft = z.infer<typeof ApprovalRequestDraft>;
export const ApprovalFieldText = z.strictObject({ text: safeText(APPROVAL_VALUE_CHARS) });
export const ApprovalCard = ApprovalCardDraft.extend({
  approvalId: Id,
  generation: Counter,
  revision: Counter,
  expiresAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export type ApprovalCard = z.infer<typeof ApprovalCard>;
export const PauseReason = z.enum(["user", "repeated_action"]);
// The brain's own paused state while it waits for Resume of the session's Pause.
export const RESUME_WAIT_REASON = "Waiting for explicit Resume";
// Reasons on the paused states a session or its brain publishes for the session's own Pause,
// approval or question. None is a recovery pause such as the spending limit, so none may stand in
// for one.
export const SESSION_PAUSE_REASONS: readonly string[] = [
  ...PauseReason.options,
  "approval",
  "question",
  RESUME_WAIT_REASON,
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
