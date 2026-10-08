import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { KEYD_PACKAGE, ReleaseManifest } from "../../../../packages/protocol/src/release.ts";
import { type ExtractedRelease, withExtractedRelease } from "./extract-release.ts";
import { verifyReleaseKeyd } from "./keyd-verification.ts";
import { withVerifiedDownload } from "./verified-download.ts";

export interface StagedKeyd extends ExtractedRelease {
  executable: string;
  packageSha256: string;
}
const fail = () => new Error("The helper package does not match this release.");
const REQUIRED = ["package.json", "bin/keyd", "LICENSE", "THIRD-PARTY.md"];

/** expected is the app's already authenticated manifest. Only the compiled Apple identity and
 * release publisher may authorize the helper; package metadata cannot select either identity.
 */
export function withStagedKeyd<T>(
  parent: string,
  expectedInput: ReleaseManifest,
  signal: AbortSignal,
  work: (release: StagedKeyd, signal: AbortSignal) => Promise<T>,
  scratchParent = parent,
): Promise<T> {
  const expected = ReleaseManifest.parse(expectedInput);
  return withVerifiedDownload(
    parent,
    { name: KEYD_PACKAGE, version: expected.version },
    signal,
    (release, abort) => {
      if (
        release.name !== KEYD_PACKAGE ||
        release.version !== expected.version ||
        release.commit !== expected.commit
      )
        throw fail();
      return withExtractedRelease(scratchParent, release, abort, async (extracted) => {
        const names = Object.keys(extracted.files);
        if (
          names.length > 64 ||
          REQUIRED.some((name) => !extracted.files[name]?.bytes) ||
          names.some(
            (name) => !REQUIRED.includes(name) && !/^licenses\/[A-Za-z0-9_-]+\.txt$/.test(name),
          )
        )
          throw fail();
        for (const [name, file] of Object.entries(extracted.files)) {
          if (name !== "bin/keyd" && (file.bytes > 1024 * 1024 || file.mode !== 0o600))
            throw fail();
        }
        if (extracted.files["bin/keyd"]?.sha256 !== expected.keyd.sha256) throw fail();
        const json = await readFile(join(extracted.root, "package.json"));
        const pkg: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(json));
        if (
          !pkg ||
          typeof pkg !== "object" ||
          Array.isArray(pkg) ||
          !("name" in pkg) ||
          pkg.name !== KEYD_PACKAGE ||
          !("version" in pkg) ||
          pkg.version !== expected.version ||
          !("os" in pkg) ||
          JSON.stringify(pkg.os) !== '["darwin"]' ||
          !("cpu" in pkg) ||
          JSON.stringify(pkg.cpu) !== '["arm64"]' ||
          [
            "scripts",
            "dependencies",
            "optionalDependencies",
            "devDependencies",
            "peerDependencies",
            "bundledDependencies",
            "bundleDependencies",
            "bin",
            "gypfile",
          ].some((key) => key in pkg)
        )
          throw fail();
        abort.throwIfAborted();
        const executable = join(extracted.root, "bin/keyd");
        await verifyReleaseKeyd(executable, expected.keyd, abort);
        abort.throwIfAborted();
        return work(
          Object.freeze({ ...extracted, executable, packageSha256: release.sha256 }),
          abort,
        );
      });
    },
    scratchParent,
  );
}
