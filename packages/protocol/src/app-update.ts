import { z } from "zod";
import { ReleaseIdentity } from "./install-update.ts";
import { RELEASE_VERSION } from "./release.ts";
import { RELEASE_NOTES_MAX_BYTES } from "./release-notes.ts";

const ReleaseVersion = z.string().max(64).regex(RELEASE_VERSION);
const Version = z.union([ReleaseVersion, z.string().regex(/^[0-9a-f]{40}$/)]);
function valid(value: string) {
  return ReleaseVersion.parse(value);
}
/** Compare the deliberately small supported grammar without number precision loss. */
export function compareReleaseVersions(left: string, right: string): number {
  const parse = (value: string) =>
    valid(value)
      .split(/\.|-rc\./)
      .map(BigInt);
  const a = parse(left),
    b = parse(right);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return (a[i] ?? 0n) > (b[i] ?? 0n) ? 1 : -1;
  }
  if (a.length !== b.length) return a.length < b.length ? 1 : -1;
  return a[3] === b[3] ? 0 : (a[3] ?? 0n) > (b[3] ?? 0n) ? 1 : -1;
}

export const AppUpdatePreferences = z.strictObject({
  automaticChecks: z.boolean(),
  automaticDownloads: z.boolean(),
  installOnLaunch: z.boolean(),
});
export type AppUpdatePreferences = z.infer<typeof AppUpdatePreferences>;
export const DEFAULT_APP_UPDATES: AppUpdatePreferences = {
  automaticChecks: true,
  automaticDownloads: true,
  installOnLaunch: true,
};
// Informational cache only; a version from the registry is never execution authority.
export const AppUpdateRecord = z.strictObject({
  v: z.literal(1),
  installedVersion: Version.optional(),
  preferences: AppUpdatePreferences,
  checkedAt: z.number().nonnegative().nullable(),
  nextCheckAt: z.number().nonnegative(),
  failures: z.number().int().min(0).max(10),
  availableVersion: Version.nullable(),
  dismissedVersion: Version.nullable(),
});
export type AppUpdateRecord = z.infer<typeof AppUpdateRecord>;
// Written only by the verified preparation CLI. Startup re-verifies both identities under lock.
export const PreparedAppUpdate = z.strictObject({
  v: z.literal(1),
  previous: ReleaseIdentity,
  candidate: ReleaseIdentity.nullable(),
});
// The version an explicit install started for, kept until a daemon of either version starts:
// the old one starting again means the new one was rolled back.
export const AppUpdateAttempt = z.strictObject({ v: z.literal(1), version: Version });
export type AppUpdateAttempt = z.infer<typeof AppUpdateAttempt>;

export const UPDATE_STEPS = ["download", "verify", "images", "install", "restart"] as const;
export type UpdateStep = (typeof UPDATE_STEPS)[number];
export const AppUpdateProgress = z.strictObject({
  step: z.enum(UPDATE_STEPS),
  // The whole update's share done, 0–1, never lower than before; null while it can't be measured.
  value: z.number().min(0).max(1).nullable(),
  detail: z.string().max(120).nullable(),
});
export type AppUpdateProgress = z.infer<typeof AppUpdateProgress>;
// One line on a preparing updater's progress channel (newline-delimited JSON). Bytes are counts
// of what that step has done and knows of; share is its own 0–1 when it measures one.
export const UpdateProgressLine = z.strictObject({
  step: z.enum(["download", "verify", "images"]),
  share: z.number().min(0).max(1).optional(),
  done: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  total: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
});
export type UpdateProgressLine = z.infer<typeof UpdateProgressLine>;

export const MAX_RELEASE_NOTES = 10;
export const ReleaseNote = z.strictObject({
  version: ReleaseVersion,
  markdown: z.string().max(RELEASE_NOTES_MAX_BYTES),
});
export type ReleaseNote = z.infer<typeof ReleaseNote>;

// Not strict, so a page keeps reading the status when a newer daemon adds to it. Pages from
// 0.1.0-rc.31 and earlier parse it strictly; the route sends them only the fields they know.
export const AppUpdateStatus = z.object({
  supported: z.boolean(),
  installOnLaunchSupported: z.boolean().default(true),
  currentVersion: z.string().max(64),
  phase: z.enum(["idle", "checking", "downloading", "ready", "installing"]),
  preferences: AppUpdatePreferences,
  checkedAt: z.number().nullable(),
  availableVersion: Version.nullable(),
  dismissedVersion: Version.nullable(),
  error: z.string().max(240).nullable(),
  // Kept with error after a failed update: its step is the one that failed.
  progress: AppUpdateProgress.nullable().default(null),
  // Newest first: the versions the pending update brings, or else the installed one's.
  notes: z.array(ReleaseNote).max(MAX_RELEASE_NOTES).default([]),
});
export type AppUpdateStatus = z.infer<typeof AppUpdateStatus>;
