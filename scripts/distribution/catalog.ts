import { createPublicKey, verify } from "node:crypto";

export const TARGETS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"] as const;
export type Target = (typeof TARGETS)[number];
export const ROLES = ["desktop", "gate", "brain", "browser"] as const;
export interface Artifact {
  url: string;
  sha512: string;
  bytes: number;
  files: Record<string, { sha256: string; bytes: number; mode: number }>;
}
export interface Catalog {
  v: 1;
  version: string;
  commit: string;
  platforms: Partial<Record<Target, Artifact>>;
  images: Record<"arm64" | "x64", Record<(typeof ROLES)[number], string>>;
}
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid release metadata.");
  return value as Record<string, unknown>;
};
const hex = (value: unknown, size: number) =>
  typeof value === "string" && new RegExp(`^[0-9a-f]{${size}}$`).test(value);
const bounded = (n: unknown, max: number): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && n <= max;
export function validateCatalog(input: unknown): Catalog {
  const value = object(input);
  if (
    value.v !== 1 ||
    typeof value.version !== "string" ||
    value.version.length > 64 ||
    !/^\d+\.\d+\.\d+(?:-rc\.\d+)?$/.test(value.version) ||
    !hex(value.commit, 40)
  )
    throw new Error("Invalid release identity.");
  const platforms = object(value.platforms),
    images = object(value.images);
  if (
    !Object.keys(platforms).length ||
    Object.keys(platforms).some((p) => !TARGETS.includes(p as Target))
  )
    throw new Error("Unsupported release platform.");
  if (Object.keys(images).some((arch) => !["arm64", "x64"].includes(arch)))
    throw new Error("Unsupported release image platform.");
  for (const [target, input] of Object.entries(platforms)) {
    const artifact = object(input);
    if (
      typeof artifact.url !== "string" ||
      !["localdot", "localdot-downloads"].some(
        (repo) =>
          artifact.url ===
          `https://github.com/Shadowhusky/${repo}/releases/download/v${value.version}/localdot-${value.version}-${target}.tgz`,
      ) ||
      !hex(artifact.sha512, 128) ||
      !bounded(artifact.bytes, 256 * 1024 * 1024) ||
      artifact.bytes < 18
    )
      throw new Error("Invalid release download.");
    const files = object(artifact.files);
    if (!Object.keys(files).length || Object.keys(files).length > 4096)
      throw new Error("Invalid release inventory.");
    const folded = new Set<string>();
    let bytes = 0;
    for (const [path, input] of Object.entries(files)) {
      const file = object(input);
      if (
        !/^[A-Za-z0-9_@+-][A-Za-z0-9._@+-]*(\/[A-Za-z0-9_@+-][A-Za-z0-9._@+-]*)*$/.test(path) ||
        path.split("/").some((p) => p === ".." || p === ".") ||
        folded.has(path.toLowerCase()) ||
        !hex(file.sha256, 64) ||
        !bounded(file.bytes, 64 * 1024 * 1024) ||
        ![0o600, 0o700].includes(file.mode as number)
      )
        throw new Error("Invalid release file.");
      folded.add(path.toLowerCase());
      bytes += file.bytes;
    }
    if (bytes > 256 * 1024 * 1024) throw new Error("Release is too large.");
    for (const required of [
      "dist/daemon.mjs",
      "dist/cli.mjs",
      "web/dist/index.html",
      "keyd",
      "install.sh",
      "node_modules/sharp/package.json",
    ])
      if (!files[required]) throw new Error("Release is incomplete.");
    const arch = target.endsWith("arm64") ? "arm64" : "x64";
    const pins = object(images[arch]);
    if (Object.keys(pins).length !== ROLES.length) throw new Error("Invalid release image roles.");
    for (const role of ROLES)
      if (
        typeof pins[role] !== "string" ||
        !new RegExp(`^ghcr\\.io/shadowhusky/localdot-${role}@sha256:[0-9a-f]{64}$`).test(
          pins[role] as string,
        )
      )
        throw new Error("Release image is not immutable.");
  }
  return input as Catalog;
}
export function authenticatedCatalog(text: string, publicKey: string): Catalog {
  if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error("Release metadata is too large.");
  const envelope = object(JSON.parse(text));
  if (typeof envelope.payload !== "string" || typeof envelope.signature !== "string")
    throw new Error("Release signature is missing.");
  const key = createPublicKey(publicKey);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Unsupported release signing key.");
  const bytes = Buffer.from(envelope.payload, "base64"),
    signature = Buffer.from(envelope.signature, "base64");
  if (
    bytes.toString("base64") !== envelope.payload ||
    signature.length !== 64 ||
    !verify(null, bytes, key, signature)
  )
    throw new Error("Release signature did not verify. Nothing was installed.");
  return validateCatalog(JSON.parse(bytes.toString("utf8")));
}
