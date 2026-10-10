import { z } from "zod";
import { ReleaseIdentity } from "./install-update.ts";
import { RELEASE_VERSION } from "./release.ts";

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
export const AppUpdateStatus = z.strictObject({
  supported: z.boolean(),
  installOnLaunchSupported: z.boolean().default(true),
  currentVersion: z.string().max(64),
  phase: z.enum(["idle", "checking", "downloading", "ready", "installing"]),
  preferences: AppUpdatePreferences,
  checkedAt: z.number().nullable(),
  availableVersion: Version.nullable(),
  dismissedVersion: Version.nullable(),
  error: z.string().max(240).nullable(),
});
export type AppUpdateStatus = z.infer<typeof AppUpdateStatus>;
