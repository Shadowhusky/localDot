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

export const SubscriptionUsageData = z
  .object({
    provider: z.literal("chatgpt"),
    plan: z.string().max(64).optional(),
    windows: z.array(SubscriptionWindow).max(2),
    limitReached: z.boolean(),
  })
  .strict()
  .refine(
    (data) => new Set(data.windows.map((window) => window.window)).size === data.windows.length,
    {
      message: "subscription windows must be distinct",
    },
  );
export type SubscriptionUsageData = z.infer<typeof SubscriptionUsageData>;

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
