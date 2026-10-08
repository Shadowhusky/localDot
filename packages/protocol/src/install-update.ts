import { z } from "zod";
import { RELEASE_VERSION, SHA256_HEX } from "./release.ts";

export const ReleaseIdentity = z.strictObject({
  version: z.string().max(64).regex(RELEASE_VERSION),
  packageSha256: z.string().regex(SHA256_HEX),
  manifestSha256: z.string().regex(SHA256_HEX),
});
export type ReleaseIdentity = z.infer<typeof ReleaseIdentity>;
export const UpdateJournal = z.strictObject({
  v: z.literal(1),
  id: z.string().uuid(),
  previous: ReleaseIdentity.nullable(),
  candidate: ReleaseIdentity,
  phase: z.enum([
    "prepared",
    "quiescing",
    "activating",
    "validating",
    "committed",
    "rolling-back",
    "rolled-back",
  ]),
});
export type UpdateJournal = z.infer<typeof UpdateJournal>;

const TufRoleVersion = z.strictObject({
  version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  sha256: z.string().regex(SHA256_HEX),
});
export const TufVersions = z.strictObject({
  root: TufRoleVersion,
  timestamp: TufRoleVersion,
  snapshot: TufRoleVersion,
  targets: TufRoleVersion,
});
export type TufVersions = z.infer<typeof TufVersions>;
