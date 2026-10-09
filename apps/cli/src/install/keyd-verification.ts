import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";
import { promisify } from "node:util";
import {
  KEYD_IDENTIFIER,
  KEYD_NATIVE_IDENTIFIER,
  ReleaseManifest,
} from "../../../../packages/protocol/src/release.ts";
import { KEYD_RELEASE_TEAM_ID } from "./release-trust.ts";

const execute = promisify(execFile);
const TEAM_ID = /^[A-Z0-9]{10}$/;
const MAX_KEYD_BYTES = 64 * 1024 * 1024;
export type KeydSignatureCheck = (
  path: string,
  requirement: string,
  signal: AbortSignal,
) => Promise<void>;
export class KeydVerificationError extends Error {
  constructor() {
    super("The staged keyd executable did not pass release verification.");
  }
}
const fail = () => new KeydVerificationError();

/** Production entry point: the candidate cannot supply its own trusted signing identity. */
export function verifyReleaseKeyd(
  path: string,
  expected: ReleaseManifest["keyd"],
  signal: AbortSignal,
) {
  return verifyKeydExecutable(path, expected, KEYD_RELEASE_TEAM_ID, signal);
}

/** Production entry point for keyd-native, the task launcher the keyd package carries. */
export function verifyReleaseKeydNative(
  path: string,
  expected: ReleaseManifest["keyd"],
  signal: AbortSignal,
) {
  return verifyKeydNativeExecutable(path, expected, KEYD_RELEASE_TEAM_ID, signal);
}

/** Only this build's trusted signing identity may supply teamId, never staged release metadata.
 * Apple TN3127: Developer ID CA + Developer ID Application leaf, Apple anchor, team, identifier.
 * The order is keyd's own (`keyd requirement`), since keyd's designated requirement must equal it.
 */
function developerIdRequirement(identifier: string, teamId: string): string[] {
  if (typeof teamId !== "string" || !TEAM_ID.test(teamId)) throw fail();
  return [
    `identifier "${identifier}"`,
    "anchor apple generic",
    "certificate 1[field.1.2.840.113635.100.6.2.6] exists",
    "certificate leaf[field.1.2.840.113635.100.6.1.13] exists",
    `certificate leaf[subject.OU] = "${teamId}"`,
  ];
}

/** keyd also carries its Keychain generation (keyd/internal/keydinfo); an earlier keyd, which
 * could start a program its caller named as keyd's child, does not meet this.
 */
export function keydRequirement(teamId: string): string {
  return [...developerIdRequirement(KEYD_IDENTIFIER, teamId), 'info [KeydGeneration] >= "2"'].join(
    " and ",
  );
}

export function keydNativeRequirement(teamId: string): string {
  return developerIdRequirement(KEYD_NATIVE_IDENTIFIER, teamId).join(" and ");
}

function tool(path: string, args: string[], signal: AbortSignal) {
  return execute(path, args, {
    cwd: "/",
    env: { PATH: "/usr/bin:/bin" },
    signal,
    timeout: 15_000,
    killSignal: "SIGKILL",
    maxBuffer: 64 * 1024,
    encoding: "utf8",
  });
}

/** Verify only: never sign, execute, notarize, or modify the candidate. */
export const systemKeydSignatureCheck: KeydSignatureCheck = async (path, requirement, signal) => {
  signal.throwIfAborted();
  try {
    await tool(
      "/usr/bin/codesign",
      ["--verify", "--strict", "--all-architectures", "-R", `=${requirement}`, path],
      signal,
    );
  } catch {
    signal.throwIfAborted();
    throw fail();
  }
  signal.throwIfAborted();
};

/** keyd's Keychain items trust its designated requirement, and keyd refuses to start unless that is
 * the generation requirement: meeting it is not enough. Both sides are compared in
 * Security.framework's text form, which keeps the clauses' order.
 */
export const systemKeydDesignatedCheck: KeydSignatureCheck = async (path, requirement, signal) => {
  signal.throwIfAborted();
  try {
    const [signed, expected] = await Promise.all([
      tool("/usr/bin/codesign", ["-d", "-r-", path], signal),
      tool("/usr/bin/csreq", ["-r", `=${requirement}`, "-t"], signal),
    ]);
    if (signed.stdout.trim() !== `designated => ${expected.stdout.trim()}`) throw fail();
  } catch {
    signal.throwIfAborted();
    throw fail();
  }
  signal.throwIfAborted();
};

function safe(stat: BigIntStats): boolean {
  return (
    stat.isFile() &&
    stat.nlink === 1n &&
    stat.uid === BigInt(process.getuid?.() ?? -1) &&
    (stat.mode & 0o7022n) === 0n &&
    (stat.mode & 0o100n) !== 0n &&
    stat.size >= 16n &&
    stat.size <= BigInt(MAX_KEYD_BYTES)
  );
}
function same(a: BigIntStats, b: BigIntStats): boolean {
  return (
    safe(b) &&
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mode === b.mode &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}

/** expected must come from authenticated release metadata. Holding the install lock and exclusive
 * staging ownership is required throughout verification and subsequent execution/copying. This
 * establishes the keyd check only; archive provenance, dependencies and image pins are separate.
 */
export function verifyKeydExecutable(
  path: string,
  expectedInput: ReleaseManifest["keyd"],
  trustedTeamId: string | null,
  signal: AbortSignal,
  signatureCheck: KeydSignatureCheck = systemKeydSignatureCheck,
  designatedCheck: KeydSignatureCheck = systemKeydDesignatedCheck,
) {
  return verifySignedExecutable(
    path,
    expectedInput,
    (expected) => ({ sha256: expected.sha256, identifier: KEYD_IDENTIFIER }),
    keydRequirement,
    trustedTeamId,
    signal,
    async (candidate, requirement, active) => {
      await signatureCheck(candidate, requirement, active);
      await designatedCheck(candidate, requirement, active);
    },
  );
}

/** The same checks for keyd-native, against its own pin and signing identifier. */
export function verifyKeydNativeExecutable(
  path: string,
  expectedInput: ReleaseManifest["keyd"],
  trustedTeamId: string | null,
  signal: AbortSignal,
  signatureCheck: KeydSignatureCheck = systemKeydSignatureCheck,
) {
  return verifySignedExecutable(
    path,
    expectedInput,
    (expected) => ({ sha256: expected.native.sha256, identifier: KEYD_NATIVE_IDENTIFIER }),
    keydNativeRequirement,
    trustedTeamId,
    signal,
    signatureCheck,
  );
}

async function verifySignedExecutable(
  path: string,
  expectedInput: ReleaseManifest["keyd"],
  pin: (expected: ReleaseManifest["keyd"]) => { sha256: string; identifier: string },
  requirement: (teamId: string) => string,
  trustedTeamId: string | null,
  signal: AbortSignal,
  signatureCheck: KeydSignatureCheck,
): Promise<{ path: string; sha256: string; teamId: string; identifier: string }> {
  signal.throwIfAborted();
  if (typeof trustedTeamId !== "string" || !TEAM_ID.test(trustedTeamId))
    throw new Error("This build has no trusted release signing identity configured.");
  try {
    const expected = ReleaseManifest.shape.keyd.parse(expectedInput);
    const { sha256, identifier } = pin(expected);
    if (
      expected.teamId !== trustedTeamId ||
      !isAbsolute(path) ||
      normalize(path) !== path ||
      (await realpath(path)) !== path
    )
      throw fail();
    const named = await lstat(path, { bigint: true });
    if (!safe(named)) throw fail();
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const before = await handle.stat({ bigint: true });
      if (!same(named, before)) throw fail();
      const buffer = Buffer.alloc(64 * 1024),
        hash = createHash("sha256");
      let position = 0;
      while (position < Number(before.size)) {
        signal.throwIfAborted();
        const count = Math.min(buffer.length, Number(before.size) - position);
        const read = await handle.read(buffer, 0, count, position);
        if (!read.bytesRead) throw fail();
        if (
          position === 0 &&
          (read.bytesRead < 16 ||
            buffer.readUInt32LE(0) !== 0xfeedfacf ||
            buffer.readUInt32LE(4) !== 0x0100000c ||
            buffer.readUInt32LE(12) !== 2)
        )
          throw fail();
        hash.update(buffer.subarray(0, read.bytesRead));
        position += read.bytesRead;
      }
      if (
        hash.digest("hex") !== sha256 ||
        !same(before, await handle.stat({ bigint: true })) ||
        !same(before, await lstat(path, { bigint: true }))
      )
        throw fail();
      await signatureCheck(path, requirement(trustedTeamId), signal);
      signal.throwIfAborted();
      if (
        !same(before, await handle.stat({ bigint: true })) ||
        !same(before, await lstat(path, { bigint: true }))
      )
        throw fail();
      return { path, sha256, teamId: trustedTeamId, identifier };
    } finally {
      await handle.close();
    }
  } catch {
    signal.throwIfAborted();
    throw fail();
  }
}
