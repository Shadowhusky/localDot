import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, realpath, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AssembledRelease } from "./assemble-release.ts";
import { copyDependencyInventory, privateDirectory } from "./copy-inventory.ts";
import { type ExtractedFile, withExtractedDependency } from "./extract-release.ts";
import { verifyNativeInventory } from "./native-inventory.ts";
import { nativeDependencyPlan } from "./native-plan.ts";
import { probeNativeDependencies } from "./native-probe.ts";
import { verifyStagedRelease } from "./staged-release.ts";

const fail = () => new Error("Native dependency installation failed verification.");
async function verifiedJSON(
  path: string,
  expected: string | undefined,
  max: number,
  signal: AbortSignal,
) {
  if (typeof expected !== "string" || !/^[0-9a-f]{64}$/.test(expected)) throw fail();
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = await handle.stat();
    if (!st.isFile() || st.nlink !== 1 || st.size > max) throw fail();
    const buffer = Buffer.alloc(st.size);
    let offset = 0;
    while (offset < buffer.length) {
      signal.throwIfAborted();
      const r = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!r.bytesRead) throw fail();
      offset += r.bytesRead;
    }
    if (createHash("sha256").update(buffer).digest("hex") !== expected) throw fail();
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } finally {
    await handle.close();
  }
}

/** Read the native plan only after rechecking the app against its authenticated metadata. */
export async function verifiedNativePlan(candidate: AssembledRelease, signal: AbortSignal) {
  signal.throwIfAborted();
  const directory = candidate.directory,
    app = candidate.app;
  const metadata = { ...candidate.metadataDigests },
    identity = { ...candidate.identity };
  if (app !== join(directory, "app") || metadata.releaseJson !== identity.manifestSha256)
    throw fail();
  await privateDirectory(directory);
  await privateDirectory(app);
  const inventory = await verifyStagedRelease(app, metadata, signal);
  if (inventory.manifest.version !== identity.version) throw fail();
  const packageJSON = await verifiedJSON(
    join(app, "package.json"),
    metadata.packageJson,
    1024 * 1024,
    signal,
  );
  const lockJSON = await verifiedJSON(
    join(app, "npm-shrinkwrap.json"),
    inventory.manifest.files["npm-shrinkwrap.json"],
    4 * 1024 * 1024,
    signal,
  );
  return nativeDependencyPlan(packageJSON, lockJSON, identity.version);
}

/** Archive hashes come exclusively from the authenticated app lock, never the supplied path map.
 * No npm or lifecycle scripts run. Installation is preparation; selection/services are separate.
 */
export async function installNativeDependencies(
  candidate: AssembledRelease,
  archivesInput: Readonly<Record<string, string>>,
  signal: AbortSignal,
  probe = probeNativeDependencies,
) {
  const archives = { ...archivesInput },
    directory = candidate.directory;
  const plan = await verifiedNativePlan(candidate, signal);
  if (
    Object.keys(archives).length !== plan.length ||
    plan.some((pkg) => typeof archives[pkg.name] !== "string")
  )
    throw fail();
  const destination = join(directory, "node_modules");
  const receiptPath = join(directory, "native.json");
  for (const path of [destination, receiptPath])
    try {
      await lstat(path);
      throw fail();
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
  const temporary = await realpath(await mkdtemp(join(directory, ".native-")));
  let installed = false,
    receiptInstalled = false;
  try {
    const modules = join(temporary, "node_modules");
    await mkdir(modules, { mode: 0o700 });
    const files: Record<string, ExtractedFile> = Object.create(null);
    let total = 0,
      count = 0;
    for (const pkg of plan) {
      signal.throwIfAborted();
      await withExtractedDependency(
        temporary,
        { archive: archives[pkg.name] ?? "", sha512: pkg.sha512 },
        signal,
        async (extracted) => {
          if (
            !extracted.files["package.json"] ||
            Object.keys(extracted.files).some((path) => path.split("/").includes("node_modules"))
          )
            throw fail();
          const json = await verifiedJSON(
            join(extracted.root, "package.json"),
            extracted.files["package.json"].sha256,
            1024 * 1024,
            signal,
          );
          const manifest: unknown = JSON.parse(json);
          if (
            !manifest ||
            typeof manifest !== "object" ||
            Array.isArray(manifest) ||
            !("name" in manifest) ||
            manifest.name !== pkg.name ||
            !("version" in manifest) ||
            manifest.version !== pkg.version
          )
            throw fail();
          for (const file of Object.values(extracted.files)) {
            total += file.bytes;
            count++;
            if (total > 512 * 1024 * 1024 || count > 32768) throw fail();
          }
          const target = join(modules, pkg.name);
          await mkdir(dirname(target), { recursive: true, mode: 0o700 });
          await copyDependencyInventory(extracted.root, target, extracted.files, signal);
          for (const [path, file] of Object.entries(extracted.files))
            files[`${pkg.name}/${path}`] = file;
        },
      );
    }
    const sharp = plan.find((pkg) => pkg.name === "sharp");
    if (!sharp) throw fail();
    await verifyNativeInventory(modules, files, signal);
    const health = await probe(modules, sharp.version, signal);
    signal.throwIfAborted();
    await verifyNativeInventory(modules, files, signal);
    const receipt = {
      v: 1,
      packages: plan.map(({ name, version, integrity }) => ({ name, version, integrity })),
      files,
      health,
    };
    const body = Buffer.from(`${JSON.stringify(receipt)}\n`);
    if (body.length > 8 * 1024 * 1024) throw fail();
    const handle = await open(
      join(temporary, "native.json"),
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(body);
      await handle.sync();
    } finally {
      await handle.close();
    }
    signal.throwIfAborted();
    await rename(modules, destination);
    installed = true;
    // The receipt follows the files; an interrupted installation without its receipt is incomplete.
    await rename(join(temporary, "native.json"), receiptPath);
    receiptInstalled = true;
    const dirHandle = await open(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await dirHandle.sync();
    } finally {
      await dirHandle.close();
    }
    signal.throwIfAborted();
    return Object.freeze({
      ...receipt,
      receiptSha256: createHash("sha256").update(body).digest("hex"),
    });
  } catch (error) {
    if (installed) await rm(destination, { recursive: true, force: true });
    if (receiptInstalled) await rm(receiptPath);
    signal.throwIfAborted();
    throw error;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
