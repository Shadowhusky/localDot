import { z } from "zod";
import { ReleaseIdentity } from "./install-update.ts";
import { PackagePath, SHA256_HEX } from "./release.ts";

const hash = z.string().regex(SHA256_HEX);
const file = z.strictObject({
  sha256: hash,
  bytes: z
    .number()
    .int()
    .min(0)
    .max(64 * 1024 * 1024),
  mode: z.union([z.literal(0o600), z.literal(0o700)]),
});
const inventory = (max: number) =>
  z
    .record(z.string().max(1024), file)
    .refine((value) => Object.keys(value).length > 0 && Object.keys(value).length <= max);

/** Installer-owned anchor. Payload-local receipts cannot replace these expectations. */
export const InstalledReleaseRecord = z.strictObject({
  v: z.literal(1),
  identity: ReleaseIdentity,
  assemblySha256: hash,
  nativeSha256: hash,
});
export type InstalledReleaseRecord = z.infer<typeof InstalledReleaseRecord>;

export const AssemblyReceipt = z.strictObject({
  v: z.literal(1),
  phase: z.literal("assembled"),
  identity: ReleaseIdentity,
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  metadataDigests: z.strictObject({ packageJson: hash, releaseJson: hash }),
  appFiles: inventory(4098).refine((files) =>
    Object.keys(files).every((p) => PackagePath.safeParse(p).success),
  ),
  keydPackageSha256: hash,
  keydFiles: inventory(64).refine((files) =>
    Object.keys(files).every((p) => PackagePath.safeParse(p).success),
  ),
});
export const NativeReceipt = z.strictObject({
  v: z.literal(1),
  packages: z
    .array(
      z.strictObject({
        name: z.string().max(214),
        version: z.string().max(128),
        integrity: z.string().regex(/^sha512-[A-Za-z0-9+/]{86}==$/),
      }),
    )
    .min(1)
    .max(128),
  files: inventory(32768),
  health: z.strictObject({
    sharp: z.string().max(128),
    vips: z.string().regex(/^[0-9A-Za-z.+-]{1,64}$/),
  }),
});
