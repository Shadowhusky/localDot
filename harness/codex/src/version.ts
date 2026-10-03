import { createHash } from "node:crypto";
import { z } from "zod";
import measured from "../releases/0.154.0.json" with { type: "json" };

export const CODEX_VERSION = "0.154.0";
export const MAX_COMPRESSED_BYTES = 256 * 1024 * 1024;
export const MAX_EXPANDED_BYTES = 512 * 1024 * 1024;
export const MAX_ARCHIVE_ENTRIES = 4096;
const platforms = ["darwin-arm64", "linux-x64"] as const;
const triples = {
  "darwin-arm64": "aarch64-apple-darwin",
  "linux-x64": "x86_64-unknown-linux-musl",
} as const;
const digests = {
  "darwin-arm64": [
    "4f85982624b3898c8991cb80c0981b2aa71070e3537046c9a95950318a95afcc",
    "426d73aaeb2aeef45e98b5add99e8ef9594a31673d281489bb2cb06b38c27423",
  ],
  "linux-x64": [
    "3188814c35471432d4123203e0eb38e5bddc60226e3d7ddf0e59e649ea140022",
    "0c57be435e73b70d9106c850d751cd259a7f04da958a453d7ef59090d82b70f1",
  ],
} as const;
const binary = z
  .object({
    member: z.string().max(255),
    installedName: z.enum(["codex", "codex-code-mode-host"]),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z.number().int().positive().max(MAX_EXPANDED_BYTES),
  })
  .strict();
const schema = z
  .object({
    version: z.literal(CODEX_VERSION),
    platform: z.enum(platforms),
    archive: z
      .object({
        url: z.string(),
        sha512: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
        compressedBytes: z.number().int().positive().max(MAX_COMPRESSED_BYTES),
      })
      .strict(),
    binaries: z.tuple([binary, binary]),
  })
  .strict();
export type CodexReleaseManifest = z.infer<typeof schema>;

// The production factory reads only the committed measured manifest. Dependency-injected
// fixtures use this same shape/URL/member validation without pretending their bytes are a pin.
export function validateReleaseManifest(value: unknown): CodexReleaseManifest {
  const release = schema.parse(value);
  if (
    release.archive.url !==
      `https://registry.npmjs.org/@openai/codex/-/codex-${CODEX_VERSION}-${release.platform}.tgz` ||
    Buffer.from(release.archive.sha512, "base64").toString("base64") !== release.archive.sha512
  )
    throw new Error("Invalid Codex release manifest");
  const names = ["codex", "codex-code-mode-host"] as const;
  for (const [index, file] of release.binaries.entries()) {
    if (
      file.installedName !== names[index] ||
      file.member !== `package/vendor/${triples[release.platform]}/bin/${file.installedName}`
    )
      throw new Error("Invalid Codex executable manifest");
    Object.freeze(file);
  }
  Object.freeze(release.archive);
  Object.freeze(release.binaries);
  return Object.freeze(release);
}

const bundle = z
  .object({ version: z.literal(CODEX_VERSION), releases: z.array(schema).length(2) })
  .strict()
  .parse(measured);
const releases = bundle.releases.map(validateReleaseManifest);
if (new Set(releases.map((release) => release.platform)).size !== 2)
  throw new Error("Missing Codex platform manifest");
for (const release of releases) {
  if (release.binaries.some((file, index) => file.sha256 !== digests[release.platform][index]))
    throw new Error("Codex executable pin changed");
}

export function codexRelease(
  platform: string = process.platform,
  arch: string = process.arch,
): CodexReleaseManifest | undefined {
  return releases.find((release) => release.platform === `${platform}-${arch}`);
}

export function releaseInstallKey(release: CodexReleaseManifest): string {
  return `${CODEX_VERSION}-${createHash("sha256").update(JSON.stringify(release)).digest("hex")}`;
}

export interface CodexBuild {
  readonly pkg: string;
  readonly triple: string;
  readonly codex: string;
  readonly codeModeHost: string;
  readonly release: CodexReleaseManifest;
}
export const CODEX_BUILDS: Readonly<Record<string, CodexBuild>> = Object.freeze(
  Object.fromEntries(
    releases.map((release) => [
      release.platform,
      Object.freeze({
        pkg: `@openai/codex-${release.platform}`,
        triple: triples[release.platform],
        codex: release.binaries[0].sha256,
        codeModeHost: release.binaries[1].sha256,
        release,
      }),
    ]),
  ),
);
export function codexBuild(
  platform: string = process.platform,
  arch: string = process.arch,
): CodexBuild | undefined {
  return CODEX_BUILDS[`${platform}-${arch}`];
}
