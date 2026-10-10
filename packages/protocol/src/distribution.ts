import { z } from "zod";
import { IMAGE_DIGEST, ImagePin, RELEASE_VERSION, SHA256_HEX } from "./release.ts";

// Distribution v2 is an outer catalog, not a replacement for a package's v1 release.json.
// Parsing establishes structure only. The bootstrap must authenticate the catalog before use.
export const DistributionPlatform = z.enum([
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
]);
export type DistributionPlatform = z.infer<typeof DistributionPlatform>;
const bytes = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const hash = z.string().regex(SHA256_HEX);
const version = z.string().max(64).regex(RELEASE_VERSION);
const Artifact = z.strictObject({
  file: z.string().regex(/^localdot-[a-z0-9.-]+\.tgz$/),
  sha256: hash,
  downloadBytes: bytes,
  installedBytes: bytes,
});
export const DistributionBundle = z.strictObject({
  app: Artifact,
  helper: Artifact,
  nodeVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  // Measured peak ADDITIONAL storage for installation/upgrading with rollback retained.
  installPeakBytes: bytes,
  dockerPeakBytes: bytes,
});
export const DistributionManifest = z
  .strictObject({
    v: z.literal(2),
    version,
    commit: z.string().regex(/^[a-f0-9]{40}$/),
    bundles: z.partialRecord(DistributionPlatform, DistributionBundle),
    images: z.strictObject({
      desktop: ImagePin,
      gate: ImagePin,
      brain: ImagePin,
      browser: ImagePin,
    }),
  })
  .superRefine((manifest, ctx) => {
    if (!Object.keys(manifest.bundles).length)
      ctx.addIssue({ code: "custom", message: "No bundles" });
    for (const [role, image] of Object.entries(manifest.images)) {
      if (!image.repository.endsWith(`/localdot-${role}`))
        ctx.addIssue({ code: "custom", message: "Image repository role mismatch" });
      for (const platform of Object.keys(manifest.bundles)) {
        const architecture = platform.endsWith("x64") ? "amd64" : "arm64";
        if (!image.platforms.includes(`linux/${architecture}`))
          ctx.addIssue({ code: "custom", message: "An image is missing a bundle's architecture" });
      }
    }
    for (const [platform, bundle] of Object.entries(manifest.bundles)) {
      for (const role of ["app", "helper"] as const) {
        if (bundle[role].file !== `localdot-${role}-${manifest.version}-${platform}.tgz`)
          ctx.addIssue({
            code: "custom",
            message: "Artifact name does not match release and platform",
          });
      }
      if (bundle.installPeakBytes < bundle.app.installedBytes + bundle.helper.installedBytes)
        ctx.addIssue({ code: "custom", message: "Peak storage is smaller than installed payload" });
    }
  });
export type DistributionManifest = z.infer<typeof DistributionManifest>;

export const ACCEPTANCE_CHECKS = [
  "cleanInstall",
  "signIn",
  "stream",
  "command",
  "filePersistence",
  "restart",
  "upgrade",
  "failedUpgradeRecovery",
  "interruptedDownload",
  "storageFailure",
  "cancel",
] as const;
export const DistributionAcceptance = z.strictObject({
  v: z.literal(1),
  version,
  commit: z.string().regex(/^[a-f0-9]{40}$/),
  manifestSha256: hash,
  platform: DistributionPlatform,
  host: z.enum(["macos", "windows-wsl2", "linux"]),
  osVersion: z.string().min(1).max(128),
  engineVersion: z.string().min(1).max(128),
  hardware: z.string().min(1).max(256),
  testedAt: z.iso.datetime(),
  checks: z.strictObject(
    Object.fromEntries(ACCEPTANCE_CHECKS.map((key) => [key, z.literal(true)])) as Record<
      (typeof ACCEPTANCE_CHECKS)[number],
      z.ZodLiteral<true>
    >,
  ),
  rebootContinuation: z.boolean(),
  // Hash of redacted logs/screenshots kept with the acceptance record, not a reusable secret.
  evidenceSha256: hash,
  images: z.strictObject({
    desktop: z.string().regex(IMAGE_DIGEST),
    gate: z.string().regex(IMAGE_DIGEST),
    brain: z.string().regex(IMAGE_DIGEST),
    browser: z.string().regex(IMAGE_DIGEST),
  }),
});

export function distributionPlatform(os: string, arch: string): DistributionPlatform {
  return DistributionPlatform.parse(`${os}-${arch}`);
}
