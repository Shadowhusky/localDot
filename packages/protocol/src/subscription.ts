import { z } from "zod";

// Rate-limit windows describe subscription usage; they do not imply dollar spend.
export const SubscriptionWindow = z
  .object({
    window: z.enum(["primary", "secondary"]),
    usedPercent: z.number().min(0).max(100),
    windowMinutes: z.number().int().positive().optional(),
    resetsAt: z.number().int().nonnegative().optional(),
  })
  .strict();
export type SubscriptionWindow = z.infer<typeof SubscriptionWindow>;

export const PlanProvider = z.enum(["chatgpt", "claude-code"]);
export type PlanProvider = z.infer<typeof PlanProvider>;

const distinctWindows = (data: { windows: readonly { window: string }[] }) =>
  new Set(data.windows.map((window) => window.window)).size === data.windows.length;

export const SubscriptionUsageData = z
  .object({
    provider: PlanProvider,
    plan: z.string().max(64).optional(),
    windows: z.array(SubscriptionWindow).max(2),
    limitReached: z.boolean(),
    // When the reached limit lifts, if the provider said; seconds since the epoch, like resetsAt.
    limitResetsAt: z.number().int().nonnegative().optional(),
  })
  .strict()
  .refine(distinctWindows, { message: "subscription windows must be distinct" });
export type SubscriptionUsageData = z.infer<typeof SubscriptionUsageData>;

// A plan's latest known usage, kept across tasks and restarts. A reading need not carry every
// window, so each keeps the time it was read (milliseconds since the epoch).
export const PlanUsageWindow = SubscriptionWindow.extend({
  observedAt: z.number().int().nonnegative(),
}).strict();
export type PlanUsageWindow = z.infer<typeof PlanUsageWindow>;

export const PlanUsage = z
  .object({
    provider: PlanProvider,
    plan: z.string().max(64).optional(),
    windows: z.array(PlanUsageWindow).max(2),
    limitReached: z.boolean(),
    limitResetsAt: z.number().int().nonnegative().optional(),
    observedAt: z.number().int().nonnegative(),
  })
  .strict()
  .refine(distinctWindows, { message: "plan windows must be distinct" });
export type PlanUsage = z.infer<typeof PlanUsage>;

export const PlanUsageReply = z
  .object({
    plans: z.array(PlanUsage).max(2),
    // Plans whose usage is being read from their own app now.
    checking: z.array(PlanProvider).max(2),
  })
  .strict()
  .refine(
    (reply) => new Set(reply.plans.map((plan) => plan.provider)).size === reply.plans.length,
    {
      message: "plans must be distinct",
    },
  );
export type PlanUsageReply = z.infer<typeof PlanUsageReply>;

export const CodexInstallFailure = z.enum([
  "unsupported_platform",
  "download_failed",
  "integrity_failed",
  "unsafe_archive",
  "storage_failed",
  "cancelled",
]);
export type CodexInstallFailure = z.infer<typeof CodexInstallFailure>;

const download = z
  .object({
    state: z.literal("downloading"),
    receivedBytes: z
      .number()
      .int()
      .min(0)
      .max(256 * 1024 * 1024),
    totalBytes: z
      .number()
      .int()
      .positive()
      .max(256 * 1024 * 1024)
      .optional(),
  })
  .strict()
  .refine((state) => state.totalBytes === undefined || state.receivedBytes <= state.totalBytes, {
    message: "download progress exceeds total size",
  });

export const CodexInstallState = z.discriminatedUnion("state", [
  z.object({ state: z.literal("not_installed") }).strict(),
  download,
  z.object({ state: z.literal("verifying") }).strict(),
  z.object({ state: z.literal("ready"), version: z.literal("0.154.0") }).strict(),
  z.object({ state: z.literal("failed"), code: CodexInstallFailure }).strict(),
]);
export type CodexInstallState = z.infer<typeof CodexInstallState>;

// This Mac's own check that Codex's sandbox holds, run after installation and on version changes.
export const ChatgptSandbox = z.enum(["unchecked", "checking", "passed", "failed"]);
export type ChatgptSandbox = z.infer<typeof ChatgptSandbox>;

// ChatGPT ships device code sign-in switched off for personal accounts.
export const CHATGPT_DEVICE_CODE_OFF =
  "Turn on device code sign-in in ChatGPT under Settings → Security first.";
