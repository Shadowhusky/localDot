import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  AssemblyReceipt,
  InstalledReleaseRecord,
} from "../../../../packages/protocol/src/install-receipts.ts";
import { ReleaseIdentity } from "../../../../packages/protocol/src/install-update.ts";
import {
  KEYD_IDENTIFIER,
  KEYD_NATIVE_IDENTIFIER,
  KEYD_PACKAGE,
} from "../../../../packages/protocol/src/release.ts";
import type { AssembledRelease } from "./assemble-release.ts";
import { copyDependencyInventory, copyInventory, privateDirectory } from "./copy-inventory.ts";
import { hashedFile, verifyInstalledPayload } from "./installed-release.ts";
import { verifyReleaseKeyd, verifyReleaseKeydNative } from "./keyd-verification.ts";
import { privateRecordStore } from "./private-record.ts";
import { createPromotionScratch, recoverPromotionScratch } from "./promotion-scratch.ts";
import { type InstalledReleaseVerifier, releaseDirectoryName } from "./release-layout.ts";
import { KEYD_RELEASE_TEAM_ID } from "./release-trust.ts";

const fail = () => new Error("Release promotion requires verified installation state.");
const missing = (e: unknown) => e instanceof Error && "code" in e && e.code === "ENOENT";
const same = (a: InstalledReleaseRecord, b: InstalledReleaseRecord) =>
  JSON.stringify(a) === JSON.stringify(b);
async function exists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (e) {
    if (missing(e)) return false;
    throw e;
  }
}
async function syncDirectory(path: string) {
  const before = await privateDirectory(path);
  const fd = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const after = await fd.stat({ bigint: true });
    if (before.ino !== after.ino || before.dev !== after.dev) throw fail();
    await fd.sync();
  } finally {
    await fd.close();
  }
}
async function ensureDirectory(path: string) {
  await privateDirectory(dirname(path));
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (e) {
    if (!(e instanceof Error) || !("code" in e) || e.code !== "EEXIST") throw e;
  }
  await privateDirectory(path);
  await syncDirectory(dirname(path));
}
async function syncTree(root: string) {
  let count = 0;
  async function walk(path: string) {
    if (++count > 65536) throw fail();
    for (const entry of await readdir(path, { withFileTypes: true }))
      if (entry.isDirectory()) await walk(join(path, entry.name));
    await syncDirectory(path);
  }
  await walk(root);
}
function anchorDirectory(state: string, identity: ReleaseIdentity) {
  return join(state, "release-records", releaseDirectoryName(identity));
}
async function anchorStore(state: string, identity: ReleaseIdentity, create: boolean) {
  await privateDirectory(state);
  const records = join(state, "release-records"),
    directory = anchorDirectory(state, identity);
  if (create) {
    await ensureDirectory(records);
    await ensureDirectory(directory);
  } else {
    await privateDirectory(records);
    await privateDirectory(directory);
  }
  return privateRecordStore(directory, "trusted.json", InstalledReleaseRecord);
}

/** Reopening never derives authority from the payload itself or creates missing trust records. */
export async function readInstalledRelease(
  state: string,
  input: ReleaseIdentity,
  signal: AbortSignal,
  verifyKeyd = verifyReleaseKeyd,
  verifyNative = verifyReleaseKeydNative,
) {
  signal.throwIfAborted();
  const identity = ReleaseIdentity.parse(input);
  const directory = join(state, "releases", releaseDirectoryName(identity));
  await privateDirectory(join(state, "releases"));
  const record = await (await anchorStore(state, identity, false)).read();
  if (!record || JSON.stringify(record.identity) !== JSON.stringify(identity)) throw fail();
  return {
    directory,
    ...(await verifyInstalledPayload(directory, record, signal, verifyKeyd, verifyNative)),
  };
}

/** Offline recovery verifies the helper against the independent private trust anchor. Damage to
 * the app, Node or native dependency tree must not prevent shutdown. This does not authorize app
 * startup or certify the rest of the release. It never executes the helper itself.
 */
export async function readInstalledLockHelper(
  state: string,
  input: ReleaseIdentity,
  signal: AbortSignal,
  verifyKeyd = verifyReleaseKeyd,
) {
  signal.throwIfAborted();
  const identity = ReleaseIdentity.parse(input),
    name = releaseDirectoryName(identity);
  const record = await (await anchorStore(state, identity, false)).read();
  if (!record || JSON.stringify(record.identity) !== JSON.stringify(identity)) throw fail();
  const releases = join(state, "releases"),
    directory = join(releases, name);
  await privateDirectory(releases);
  await privateDirectory(directory);
  const bytes = await hashedFile(
    join(directory, "assembly.json"),
    record.assemblySha256,
    4 * 1024 * 1024,
    signal,
  );
  const assembly = AssemblyReceipt.parse(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
  );
  if (
    JSON.stringify(assembly.identity) !== JSON.stringify(identity) ||
    assembly.metadataDigests.releaseJson !== identity.manifestSha256
  )
    throw fail();
  const binary = assembly.keydFiles["bin/keyd"],
    launcher = assembly.keydFiles["bin/keyd-native"];
  if (binary?.mode !== 0o700 || !binary.bytes || !launcher) throw fail();
  await privateDirectory(join(directory, "keyd"));
  await privateDirectory(join(directory, "keyd", "bin"));
  const path = join(directory, "keyd", "bin", "keyd");
  await verifyKeyd(
    path,
    {
      package: KEYD_PACKAGE,
      path: "bin/keyd",
      sha256: binary.sha256,
      identifier: KEYD_IDENTIFIER,
      teamId: KEYD_RELEASE_TEAM_ID,
      native: {
        path: "bin/keyd-native",
        sha256: launcher.sha256,
        identifier: KEYD_NATIVE_IDENTIFIER,
      },
    },
    signal,
  );
  signal.throwIfAborted();
  return Object.freeze({ keydPath: path, identity: Object.freeze(identity) });
}

export function installedReleaseVerifier(
  state: string,
  verifyKeyd = verifyReleaseKeyd,
  verifyNative = verifyReleaseKeydNative,
): InstalledReleaseVerifier {
  return async (directory, input, signal) => {
    signal.throwIfAborted();
    const identity = ReleaseIdentity.parse(input);
    if (directory !== join(state, "releases", releaseDirectoryName(identity))) throw fail();
    await readInstalledRelease(state, identity, signal, verifyKeyd, verifyNative);
  };
}

/** Hold the install lock throughout. Expectations must be the results of authenticated assembly
 * and native installation. Copies preserve candidate ownership/disposal; selected.json is untouched.
 * After a crash between rename and anchor publication, a fresh authenticated preparation can
 * recover the identical payload. Unknown or conflicting destinations are never overwritten.
 */
export async function promotePreparedRelease(
  state: string,
  candidate: AssembledRelease,
  native: Readonly<{ receiptSha256: string }>,
  signal: AbortSignal,
  verifyKeyd = verifyReleaseKeyd,
  verifyNative = verifyReleaseKeydNative,
) {
  signal.throwIfAborted();
  const source = candidate.directory;
  const expected = InstalledReleaseRecord.parse({
    v: 1,
    identity: candidate.identity,
    assemblySha256: candidate.assemblySha256,
    nativeSha256: native.receiptSha256,
  });
  const verified = await verifyInstalledPayload(source, expected, signal, verifyKeyd, verifyNative);
  await privateDirectory(state);
  const releases = join(state, "releases");
  await ensureDirectory(releases);
  await recoverPromotionScratch(releases, signal);
  const destination = join(releases, releaseDirectoryName(expected.identity));
  const store = await anchorStore(state, expected.identity, true);
  const previous = await store.read();
  if (previous && !same(previous, expected)) throw fail();
  if (await exists(destination)) {
    await verifyInstalledPayload(destination, expected, signal, verifyKeyd, verifyNative);
    signal.throwIfAborted();
    // Also makes a prior rename durable when recovering its lost acknowledgement.
    await syncDirectory(releases);
    await store.save(expected);
    return { directory: destination, identity: Object.freeze(expected.identity), recovered: true };
  }
  const scratch = await createPromotionScratch(releases, signal);
  const temporary = scratch.directory;
  try {
    await copyInventory(
      join(source, "app"),
      join(temporary, "app"),
      verified.assembly.appFiles,
      signal,
    );
    await copyInventory(
      join(source, "keyd"),
      join(temporary, "keyd"),
      verified.assembly.keydFiles,
      signal,
    );
    const modules = join(temporary, "node_modules");
    await mkdir(modules, { mode: 0o700 });
    for (const pkg of verified.native.packages) {
      signal.throwIfAborted();
      const prefix = `${pkg.name}/`;
      const files = Object.fromEntries(
        Object.entries(verified.native.files)
          .filter(([p]) => p.startsWith(prefix))
          .map(([p, file]) => [p.slice(prefix.length), file]),
      );
      const target = join(modules, pkg.name);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await copyDependencyInventory(join(source, "node_modules", pkg.name), target, files, signal);
    }
    for (const [name, bytes] of [
      ["assembly.json", verified.assemblyBytes],
      ["native.json", verified.nativeBytes],
    ] as const) {
      const handle = await open(
        join(temporary, name),
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    await verifyInstalledPayload(temporary, expected, signal, verifyKeyd, verifyNative);
    await syncTree(temporary);
    signal.throwIfAborted();
    if (await exists(destination)) throw fail();
    await scratch.assertOwned();
    await rename(temporary, destination);
    await syncDirectory(releases);
    signal.throwIfAborted();
    await store.save(expected);
    await scratch.dispose();
    return { directory: destination, identity: Object.freeze(expected.identity), recovered: false };
  } catch (error) {
    try {
      await scratch.dispose();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Release promotion failed; temporary cleanup requires inspection.",
      );
    }
    throw error;
  }
}
