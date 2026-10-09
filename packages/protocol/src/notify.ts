import { z } from "zod";
import { AttentionLevel } from "./attention.ts";
import { ULID_PATTERN } from "./ids.ts";

const Id = z.string().regex(ULID_PATTERN);
const ClockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a time like 22:00.");
const base64url = (length: number) =>
  z
    .string()
    .length(length)
    .regex(/^[A-Za-z0-9_-]+$/, "base64url without padding");

export const MAX_PUSH_DEVICES = 10;

// The browsers' push services; keyd refuses every other host too (keyd/internal/webpush).
export const PUSH_SERVICES = [
  { suffix: "push.apple.com", name: "Apple" },
  { suffix: "fcm.googleapis.com", name: "Google" },
  { suffix: "push.services.mozilla.com", name: "Mozilla" },
  { suffix: "notify.windows.com", name: "Microsoft" },
] as const;

export function pushServiceOf(endpoint: string): (typeof PUSH_SERVICES)[number]["name"] | null {
  if (!URL.canParse(endpoint)) return null;
  const url = new URL(endpoint);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) return null;
  if (url.port !== "" && url.port !== "443") return null;
  const host = url.hostname.toLowerCase();
  return (
    PUSH_SERVICES.find(({ suffix }) => host === suffix || host.endsWith(`.${suffix}`))?.name ?? null
  );
}

export const NotifyEvent = z.enum(["needs_you", "done", "failed", "routine"]);
export type NotifyEvent = z.infer<typeof NotifyEvent>;
const Channels = z.strictObject({ mac: z.boolean(), phone: z.boolean() });
export const QuietHours = z
  .strictObject({
    enabled: z.boolean(),
    start: ClockTime,
    end: ClockTime,
    allowNeedsYou: z.boolean(),
  })
  .refine((quiet) => quiet.start !== quiet.end, "Quiet hours need different start and end times.");
export type QuietHours = z.infer<typeof QuietHours>;
export const NotifySettings = z.strictObject({
  events: z.strictObject({
    needs_you: Channels,
    done: Channels,
    failed: Channels,
    routine: Channels,
  }),
  quietHours: QuietHours,
  showTaskText: z.boolean(),
});
export type NotifySettings = z.infer<typeof NotifySettings>;
export const DEFAULT_NOTIFY_SETTINGS: NotifySettings = Object.freeze({
  events: {
    needs_you: { mac: true, phone: true },
    done: { mac: true, phone: true },
    failed: { mac: true, phone: true },
    routine: { mac: true, phone: true },
  },
  quietHours: { enabled: false, start: "22:00", end: "07:00", allowNeedsYou: true },
  showTaskText: false,
});

export const AttentionReason = z.enum([
  "approval",
  "ask",
  "takeover",
  "budget",
  "done",
  "gave_up",
  "error",
  "routine",
  "working",
  "cleared",
]);
export type AttentionReason = z.infer<typeof AttentionReason>;
// task is the task's own title (the user's words), for signed-in clients only.
export const AttentionItem = z.strictObject({
  key: z.string().min(1).max(200),
  sessionId: Id.nullable(),
  level: AttentionLevel,
  reason: AttentionReason,
  task: z.string().max(80).nullable(),
  at: z.number().int().nonnegative(),
});
export type AttentionItem = z.infer<typeof AttentionItem>;
// page asks a signed-in tab on this Mac that is open but hidden to show the notification itself.
export const AttentionChangeEvent = z.strictObject({
  type: z.literal("attention.change"),
  item: AttentionItem,
  page: z.boolean(),
});
export type AttentionChangeEvent = z.infer<typeof AttentionChangeEvent>;
export const AttentionSnapshot = z.strictObject({ items: z.array(AttentionItem).max(64) });
export type AttentionSnapshot = z.infer<typeof AttentionSnapshot>;
export const NotifySeenRequest = z.strictObject({ sessionId: Id });
// A client tells the daemon whether a person is looking at it (only tabs on this Mac count), and
// confirms each notification it showed when the daemon asked it to.
export const ClientPresence = z.strictObject({
  type: z.literal("presence"),
  visible: z.boolean(),
  canNotify: z.boolean(),
});
export type ClientPresence = z.infer<typeof ClientPresence>;
export const ClientShown = z.strictObject({
  type: z.literal("shown"),
  key: z.string().min(1).max(200),
});
export const ClientMessage = z.discriminatedUnion("type", [ClientPresence, ClientShown]);
export type ClientMessage = z.infer<typeof ClientMessage>;

export const PushKind = z.enum(["needs_you", "blocked", "done", "failed", "routine", "test"]);
export type PushKind = z.infer<typeof PushKind>;
// What a phone receives, encrypted. title is the task's title, present only when the user turned
// on "Show task text in notifications". Model text never travels.
export const PushPayload = z.strictObject({
  kind: PushKind,
  sessionId: Id.nullable(),
  title: z.string().min(1).max(80).optional(),
});
export type PushPayload = z.infer<typeof PushPayload>;
const ROUTES: Partial<Record<AttentionReason, { event: NotifyEvent; kind: PushKind }>> = {
  approval: { event: "needs_you", kind: "needs_you" },
  ask: { event: "needs_you", kind: "needs_you" },
  takeover: { event: "needs_you", kind: "needs_you" },
  budget: { event: "failed", kind: "blocked" },
  done: { event: "done", kind: "done" },
  gave_up: { event: "failed", kind: "failed" },
  error: { event: "failed", kind: "failed" },
};
// Which Settings row an attention reason belongs to, and what a notification calls it. Working and
// cleared states notify nobody.
export function notifyRouteOf(
  reason: AttentionReason,
): { event: NotifyEvent; kind: PushKind } | null {
  return ROUTES[reason] ?? null;
}
export const NOTIFY_COPY: Readonly<Record<PushKind, { title: string; body: string }>> =
  Object.freeze({
    needs_you: { title: "dot needs you", body: "Open localDot to answer." },
    blocked: { title: "Task paused: budget reached", body: "Open localDot to raise it or stop." },
    done: { title: "Task done", body: "Open localDot to see the result." },
    failed: { title: "Task failed", body: "Open localDot to see what happened." },
    routine: { title: "Routine update", body: "Open localDot to see the result." },
    test: { title: "Notifications are on", body: "This is a test from localDot." },
  });

export const PushSubscriptionInput = z.strictObject({
  endpoint: z
    .string()
    .max(1024)
    .refine((endpoint) => pushServiceOf(endpoint) !== null, "This is not a browser push service."),
  keys: z.strictObject({ p256dh: base64url(87), auth: base64url(22) }),
  label: z.string().trim().min(1).max(40),
});
export type PushSubscriptionInput = z.infer<typeof PushSubscriptionInput>;
export const PushDeviceId = z.string().regex(/^[0-9a-f]{16}$/);
export const PushDevice = z.strictObject({
  id: PushDeviceId,
  label: z.string().max(40),
  service: z.string().max(16),
  createdAt: z.string(),
  lastSentAt: z.string().nullable(),
  lastResult: z.enum(["sent", "failed"]).nullable(),
});
export type PushDevice = z.infer<typeof PushDevice>;
export const PushDeviceList = z.strictObject({
  devices: z.array(PushDevice).max(MAX_PUSH_DEVICES),
});
export const NotifyKey = z.strictObject({ publicKey: base64url(87) });
export const NotifyTestResult = z.strictObject({
  mac: z.enum(["shown", "unavailable", "failed"]),
  phones: z
    .array(
      z.strictObject({
        id: PushDeviceId,
        label: z.string().max(40),
        result: z.enum(["sent", "gone", "failed"]),
      }),
    )
    .max(MAX_PUSH_DEVICES),
});
export type NotifyTestResult = z.infer<typeof NotifyTestResult>;
