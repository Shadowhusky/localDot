import { z } from "zod";

// release.json describes one localdot version. Schema validation establishes structure; install
// and update must separately verify staged contents and provenance before executing a release.
// Every version, file hash and image digest here is exact, never a range or tag.

export const RELEASE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-rc\.(0|[1-9]\d*))?$/;
export const SHA256_HEX = /^[0-9a-f]{64}$/;
export const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;
export const IMAGE_ROLES = ["desktop", "gate", "brain", "browser"] as const;
export const KEYD_PACKAGE = "@localdot/keyd-darwin-arm64";
export const KEYD_IDENTIFIER = "dev.localdot.keyd";
// keyd-native, the daemon's task launcher, ships in the keyd package, signed apart from keyd.
export const KEYD_NATIVE_IDENTIFIER = "dev.localdot.keyd.native";

// A path inside the package: relative, forward slashes, no empty, "." or ".." segment.
export const PackagePath = z
  .string()
  .max(512)
  .regex(/^[A-Za-z0-9_@+-][A-Za-z0-9._@+-]*(\/[A-Za-z0-9_@+-][A-Za-z0-9._@+-]*)*$/)
  .refine((p) => p.split("/").length <= 16, "package paths have at most16 segments")
  .refine((p) => !p.split("/").some((s) => s === "." || s === ".."), "no . or .. segments");

export const ImagePin = z.strictObject({
  repository: z.string().regex(/^ghcr\.io\/[a-z0-9-]+\/localdot-(desktop|gate|brain|browser)$/),
  digest: z.string().regex(IMAGE_DIGEST),
  platforms: z
    .array(z.enum(["linux/arm64", "linux/amd64"]))
    .min(1)
    .max(2)
    .refine((p) => p.includes("linux/arm64"), "every image must have linux/arm64")
    .refine((p) => new Set(p).size === p.length, "no repeated platform"),
});
export type ImagePin = z.infer<typeof ImagePin>;

export const ReleaseManifest = z
  .strictObject({
    v: z.literal(1),
    name: z.literal("localdot"),
    version: z.string().max(64).regex(RELEASE_VERSION),
    commit: z.string().regex(/^[0-9a-f]{40}$/),
    // Every file of the localdot package but package.json and release.json, with its SHA-256.
    files: z
      .record(PackagePath, z.string().regex(SHA256_HEX))
      .refine(
        (f) => Object.keys(f).length > 0 && Object.keys(f).length <= 4096,
        "bounded file map required",
      )
      .refine(
        (f) => !Object.hasOwn(f, "package.json") && !Object.hasOwn(f, "release.json"),
        "metadata is not self-hashed",
      )
      .refine(
        (f) =>
          new Set(Object.keys(f).map((path) => path.toLowerCase())).size === Object.keys(f).length,
        "no case-colliding paths",
      ),
    keyd: z.strictObject({
      package: z.literal(KEYD_PACKAGE),
      path: z.literal("bin/keyd"),
      sha256: z.string().regex(SHA256_HEX),
      identifier: z.literal(KEYD_IDENTIFIER),
      teamId: z.string().regex(/^[A-Z0-9]{10}$/),
      native: z.strictObject({
        path: z.literal("bin/keyd-native"),
        sha256: z.string().regex(SHA256_HEX),
        identifier: z.literal(KEYD_NATIVE_IDENTIFIER),
      }),
    }),
    images: z.strictObject({
      desktop: ImagePin,
      gate: ImagePin,
      brain: ImagePin,
      browser: ImagePin,
    }),
  })
  .refine(
    (manifest) =>
      IMAGE_ROLES.every((role) => manifest.images[role].repository.endsWith(`/localdot-${role}`)),
    "image repository must match its role",
  );
export type ReleaseManifest = z.infer<typeof ReleaseManifest>;

// The reference a cell is created from: never a tag.
export function imageRef(pin: ImagePin): string {
  return `${pin.repository}@${pin.digest}`;
}
