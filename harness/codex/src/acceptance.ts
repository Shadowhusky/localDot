import { createHash } from "node:crypto";
import { z } from "zod";
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
const pinned = (record: Record<string, unknown>, platform: string, arch: string) =>
  record.format === 1 &&
  record.codexVersion === CODEX_VERSION &&
  record.platform === `${platform}-${arch}` &&
  record.manifestSha256 === CODEX_MANIFEST_SHA256;
// The committed record is release evidence: the full native suite passed for this exact pin and
// platform. Neither installation state nor an environment flag is consulted.
export function codexReleased(
  record: unknown = committed,
  platform: string = process.platform,
  arch: string = process.arch,
): boolean {
  return object(record) && pinned(record, platform, arch) && passed(record.nativeSandbox);
}

// The release sources the committed native run covered, localDot's sandbox profile, its launch
// arguments and the patched sandbox runtime among them.
function releaseInput(release: unknown): string | undefined {
  const native = object(release) ? release.nativeSandbox : undefined;
  return object(native) && typeof native.inputSha256 === "string" ? native.inputSha256 : undefined;
}

// This Mac's own record, written by the daemon: its sandbox self-check for this pin, release
// sources, macOS build and sandbox runtime, and the user's first verified sign-in with this pin.
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const label = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/);
const unstamped = z.strictObject({ passed: z.literal(false) });
export const LocalAcceptance = z.strictObject({
  format: z.literal(1),
  codexVersion: label,
  platform: label,
  manifestSha256: hex,
  nativeSandbox: z.union([
    unstamped,
    z.strictObject({
      passed: z.literal(true),
      inputSha256: hex,
      system: label,
      runtime: label,
      reportSha256: hex,
      checkedAt: time,
    }),
  ]),
  realAccount: z.union([unstamped, z.strictObject({ passed: z.literal(true), checkedAt: time })]),
});
export type LocalAcceptance = z.infer<typeof LocalAcceptance>;
// Besides the pin and the release sources, a native stamp is bound to the macOS build and the
// sandbox runtime.
export interface AcceptanceHost {
  readonly system: string;
  readonly runtime: string;
}
const current = (record: unknown, platform: string, arch: string): record is LocalAcceptance =>
  LocalAcceptance.safeParse(record).success &&
  pinned(record as Record<string, unknown>, platform, arch);
export function nativeStamped(
  record: unknown,
  host: AcceptanceHost,
  release: unknown = committed,
  platform: string = process.platform,
  arch: string = process.arch,
): boolean {
  const input = releaseInput(release);
  return (
    current(record, platform, arch) &&
    record.nativeSandbox.passed &&
    input !== undefined &&
    record.nativeSandbox.inputSha256 === input &&
    record.nativeSandbox.system === host.system &&
    record.nativeSandbox.runtime === host.runtime
  );
}
export function accountStamped(
  record: unknown,
  platform: string = process.platform,
  arch: string = process.arch,
): boolean {
  return current(record, platform, arch) && record.realAccount.passed;
}
// The ChatGPT plan opens only with the release evidence and both of this Mac's stamps.
export function codexAccepted(
  record: unknown,
  host: AcceptanceHost,
  release: unknown = committed,
  platform: string = process.platform,
  arch: string = process.arch,
): boolean {
  return (
    codexReleased(release, platform, arch) &&
    nativeStamped(record, host, release, platform, arch) &&
    accountStamped(record, platform, arch)
  );
}
// Another pin starts a fresh record: both stamps are taken again.
function base(previous: unknown, platform: string, arch: string): LocalAcceptance {
  if (current(previous, platform, arch)) return previous;
  return {
    format: 1,
    codexVersion: CODEX_VERSION,
    platform: `${platform}-${arch}`,
    manifestSha256: CODEX_MANIFEST_SHA256,
    nativeSandbox: { passed: false },
    realAccount: { passed: false },
  };
}
export function stampNative(
  previous: unknown,
  host: AcceptanceHost,
  reportSha256: string,
  checkedAt: number,
  release: unknown = committed,
  platform: string = process.platform,
  arch: string = process.arch,
): LocalAcceptance {
  return LocalAcceptance.parse({
    ...base(previous, platform, arch),
    nativeSandbox: {
      passed: true,
      inputSha256: releaseInput(release),
      system: host.system,
      runtime: host.runtime,
      reportSha256,
      checkedAt,
    },
  });
}
// A sign-in never stands in for the sandbox check: the account stamp needs this Mac's stamp first.
export function stampAccount(
  previous: unknown,
  host: AcceptanceHost,
  checkedAt: number,
  release: unknown = committed,
  platform: string = process.platform,
  arch: string = process.arch,
): LocalAcceptance {
  if (!nativeStamped(previous, host, release, platform, arch))
    throw new Error("The sandbox check must pass before the account is recorded.");
  return LocalAcceptance.parse({
    ...LocalAcceptance.parse(previous),
    realAccount: { passed: true, checkedAt },
  });
}
