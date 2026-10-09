import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  AssemblyReceipt,
  InstalledReleaseRecord,
  NativeReceipt,
} from "../../../../packages/protocol/src/install-receipts.ts";
import { privateDirectory } from "./copy-inventory.ts";
import { verifyReleaseKeyd, verifyReleaseKeydNative } from "./keyd-verification.ts";
import { verifyNativeInventory } from "./native-inventory.ts";
import { nativeDependencyPlan } from "./native-plan.ts";
import { KEYD_EXECUTABLES } from "./stage-keyd.ts";
import { verifyStagedRelease } from "./staged-release.ts";

const fail = () => new Error("Installed release failed verification.");
export const payloadEntries = ["app", "assembly.json", "keyd", "native.json", "node_modules"];

export async function hashedFile(
  path: string,
  expected: string,
  max: number,
  signal: AbortSignal,
): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size > BigInt(max) ||
      before.uid !== BigInt(process.getuid?.() ?? -1) ||
      (before.mode & 0o7777n) !== 0o600n
    )
      throw fail();
    const body = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < body.length) {
      signal.throwIfAborted();
      const { bytesRead } = await handle.read(body, offset, body.length - offset, offset);
      if (!bytesRead) throw fail();
      offset += bytesRead;
    }
    for (const st of [await handle.stat({ bigint: true }), await lstat(path, { bigint: true })])
      if (
        st.dev !== before.dev ||
        st.ino !== before.ino ||
        st.size !== before.size ||
        st.mtimeNs !== before.mtimeNs ||
        st.ctimeNs !== before.ctimeNs ||
        st.mode !== before.mode ||
        st.uid !== before.uid ||
        st.nlink !== 1n
      )
        throw fail();
    if (createHash("sha256").update(body).digest("hex") !== expected) throw fail();
    return body;
  } finally {
    await handle.close();
  }
}
const json = (bytes: Buffer): unknown =>
  JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));

/** Expectations come from an authenticated preparation result or the private installer record,
 * never from payload-local JSON. This checks bytes/signature only; it executes no native package.
 */
export async function verifyInstalledPayload(
  directory: string,
  expected: InstalledReleaseRecord,
  signal: AbortSignal,
  verifyKeyd = verifyReleaseKeyd,
  verifyNative = verifyReleaseKeydNative,
) {
  signal.throwIfAborted();
  const record = InstalledReleaseRecord.parse(expected);
  const before = await privateDirectory(directory);
  if (JSON.stringify((await readdir(directory)).sort()) !== JSON.stringify(payloadEntries))
    throw fail();
  const assemblyBytes = await hashedFile(
    join(directory, "assembly.json"),
    record.assemblySha256,
    4 * 1024 * 1024,
    signal,
  );
  const nativeBytes = await hashedFile(
    join(directory, "native.json"),
    record.nativeSha256,
    8 * 1024 * 1024,
    signal,
  );
  const assembly = AssemblyReceipt.parse(json(assemblyBytes)),
    native = NativeReceipt.parse(json(nativeBytes));
  if (
    JSON.stringify(assembly.identity) !== JSON.stringify(record.identity) ||
    assembly.metadataDigests.releaseJson !== record.identity.manifestSha256
  )
    throw fail();
  const app = join(directory, "app"),
    keyd = join(directory, "keyd"),
    modules = join(directory, "node_modules");
  const { manifest } = await verifyStagedRelease(app, assembly.metadataDigests, signal);
  if (
    manifest.version !== record.identity.version ||
    manifest.commit !== assembly.commit ||
    assembly.keydFiles[manifest.keyd.path]?.sha256 !== manifest.keyd.sha256 ||
    assembly.keydFiles[manifest.keyd.native.path]?.sha256 !== manifest.keyd.native.sha256
  )
    throw fail();
  await verifyNativeInventory(app, assembly.appFiles, signal);
  await verifyNativeInventory(keyd, assembly.keydFiles, signal);
  const helperRequired = ["package.json", ...KEYD_EXECUTABLES, "LICENSE", "THIRD-PARTY.md"];
  if (
    helperRequired.some((name) => !assembly.keydFiles[name]?.bytes) ||
    Object.entries(assembly.keydFiles).some(
      ([name, file]) =>
        (!helperRequired.includes(name) && !/^licenses\/[A-Za-z0-9_-]+\.txt$/.test(name)) ||
        (!KEYD_EXECUTABLES.includes(name) && (file.bytes > 1024 * 1024 || file.mode !== 0o600)),
    )
  )
    throw fail();
  const helper = json(
    await hashedFile(
      join(keyd, "package.json"),
      assembly.keydFiles["package.json"]?.sha256 ?? "",
      1024 * 1024,
      signal,
    ),
  );
  if (
    !helper ||
    typeof helper !== "object" ||
    Array.isArray(helper) ||
    !("name" in helper) ||
    helper.name !== manifest.keyd.package ||
    !("version" in helper) ||
    helper.version !== manifest.version ||
    !("os" in helper) ||
    JSON.stringify(helper.os) !== '["darwin"]' ||
    !("cpu" in helper) ||
    JSON.stringify(helper.cpu) !== '["arm64"]' ||
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
    ].some((field) => field in helper)
  )
    throw fail();
  const pkg = await hashedFile(
    join(app, "package.json"),
    assembly.metadataDigests.packageJson,
    1024 * 1024,
    signal,
  );
  const lockHash = manifest.files["npm-shrinkwrap.json"];
  if (!lockHash) throw fail();
  const lock = await hashedFile(
    join(app, "npm-shrinkwrap.json"),
    lockHash,
    4 * 1024 * 1024,
    signal,
  );
  const plan = nativeDependencyPlan(
    pkg.toString("utf8"),
    lock.toString("utf8"),
    record.identity.version,
  );
  if (
    JSON.stringify(native.packages) !==
      JSON.stringify(plan.map(({ name, version, integrity }) => ({ name, version, integrity }))) ||
    native.health.sharp !== plan.find((p) => p.name === "sharp")?.version
  )
    throw fail();
  for (const path of Object.keys(native.files)) {
    const name = path.startsWith("@") ? path.split("/").slice(0, 2).join("/") : path.split("/")[0];
    if (!plan.some((pkg) => pkg.name === name)) throw fail();
  }
  for (const pkg of plan) if (!native.files[`${pkg.name}/package.json`]) throw fail();
  await verifyNativeInventory(modules, native.files, signal);
  await verifyKeyd(join(keyd, manifest.keyd.path), manifest.keyd, signal);
  await verifyNative(join(keyd, manifest.keyd.native.path), manifest.keyd, signal);
  signal.throwIfAborted();
  const after = await privateDirectory(directory);
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    JSON.stringify((await readdir(directory)).sort()) !== JSON.stringify(payloadEntries)
  )
    throw fail();
  // The caller may copy these already verified receipts, then reverify the copy before promotion.
  return { record, manifest, assembly, native, assemblyBytes, nativeBytes };
}
