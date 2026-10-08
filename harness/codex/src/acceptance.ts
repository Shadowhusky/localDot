import { createHash } from "node:crypto";
import committed from "../acceptance/record.json" with { type: "json" };
import { CODEX_RELEASE_BUNDLE, CODEX_VERSION } from "./version.ts";

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (object(value))
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
export const canonicalDigest = (value: unknown): string =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
export const CODEX_MANIFEST_SHA256 = canonicalDigest(CODEX_RELEASE_BUNDLE);
export const CHATGPT_SWITCHED_OFF = "ChatGPT plan support isn't switched on in this version yet.";
const passed = (stamp: unknown) => object(stamp) && stamp.passed === true;
// Only the committed record opens the ChatGPT plan, and only for this exact pin and platform.
// Neither installation state nor an environment flag is consulted.
export function codexAccepted(
  record: unknown = committed,
  platform: string = process.platform,
  arch: string = process.arch,
): boolean {
  return (
    object(record) &&
    record.format === 1 &&
    record.codexVersion === CODEX_VERSION &&
    record.platform === `${platform}-${arch}` &&
    record.manifestSha256 === CODEX_MANIFEST_SHA256 &&
    passed(record.nativeSandbox) &&
    passed(record.realAccount)
  );
}
