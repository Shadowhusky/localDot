import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";
import { promisify } from "node:util";
import { KEYD_IDENTIFIER, ReleaseManifest } from "../../../../packages/protocol/src/release.ts";
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

/** Only this build's trusted signing identity may supply teamId, never staged release metadata.
 * Apple TN3127: Developer ID CA + Developer ID Application leaf, Apple anchor, team, identifier.
 */
export function keydRequirement(teamId: string): string {
  if (typeof teamId !== "string" || !TEAM_ID.test(teamId)) throw fail();
  return [
    "anchor apple generic",
    `identifier "${KEYD_IDENTIFIER}"`,
    "certificate 1[field.1.2.840.113635.100.6.2.6] exists",
    "certificate leaf[field.1.2.840.113635.100.6.1.13] exists",
    `certificate leaf[subject.OU] = "${teamId}"`,
  ].join(" and ");
}

/** Verify only: never sign, execute, notarize, or modify the candidate. */
export const systemKeydSignatureCheck: KeydSignatureCheck = async (path, requirement, signal) => {
  signal.throwIfAborted();
  try {
    await execute(
      "/usr/bin/codesign",
      ["--verify", "--strict", "--all-architectures", "-R", `=${requirement}`, path],
      {
        cwd: "/",
        env: { PATH: "/usr/bin:/bin" },
        signal,
        timeout: 15_000,
        killSignal: "SIGKILL",
        maxBuffer: 64 * 1024,
        encoding: "utf8",
      },
    );
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
export async function verifyKeydExecutable(
  path: string,
  expectedInput: ReleaseManifest["keyd"],
  trustedTeamId: string | null,
  signal: AbortSignal,
  signatureCheck: KeydSignatureCheck = systemKeydSignatureCheck,
): Promise<{ path: string; sha256: string; teamId: string; identifier: string }> {
  signal.throwIfAborted();
  if (typeof trustedTeamId !== "string" || !TEAM_ID.test(trustedTeamId))
    throw new Error("This build has no trusted release signing identity configured.");
  try {
    const expected = ReleaseManifest.shape.keyd.parse(expectedInput);
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
        hash.digest("hex") !== expected.sha256 ||
        !same(before, await handle.stat({ bigint: true })) ||
        !same(before, await lstat(path, { bigint: true }))
      )
        throw fail();
      await signatureCheck(path, keydRequirement(trustedTeamId), signal);
      signal.throwIfAborted();
      if (
        !same(before, await handle.stat({ bigint: true })) ||
        !same(before, await lstat(path, { bigint: true }))
      )
        throw fail();
      return { path, sha256: expected.sha256, teamId: trustedTeamId, identifier: KEYD_IDENTIFIER };
    } finally {
      await handle.close();
    }
  } catch {
    signal.throwIfAborted();
    throw fail();
  }
}
