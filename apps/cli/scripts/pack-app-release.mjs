import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { MAX_PACKAGE_BYTES } from "../../../scripts/check-pack.mjs";
import { checkPackArchive } from "../../../scripts/check-pack-archive.mjs";
import { buildAppPackage } from "./build-app-package.mjs";

const execute = promisify(execFile);
const fail = () => new Error("App archive build failed verification.");

async function boundedBytes(path, max) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(max))
      throw fail();
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let count = 0;
    while (count < bytes.length) {
      const { bytesRead } = await file.read(bytes, count, bytes.length - count, count);
      if (!bytesRead) break;
      count += bytesRead;
    }
    const after = await file.stat({ bigint: true });
    if (
      count !== Number(before.size) ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    )
      throw fail();
    return bytes.subarray(0, count);
  } finally {
    await file.close();
  }
}
const json = (bytes) => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const inventory = (files) =>
  files
    .map(({ path, size, sha256 }) => [path, size, sha256])
    .sort(([a], [b]) => a.localeCompare(b));

/** Offline build tooling, not an installer trust decision. The optional builder is a test seam;
 * the command always calls the production builder and its compiled signing requirement.
 */
export async function packAppRelease({ inputFile, output }, build = buildAppPackage) {
  const inputPath = resolve(inputFile);
  const inputBytes = await boundedBytes(inputPath, 64 * 1024);
  const config = json(inputBytes);
  const fields = [
    "commit",
    "images",
    "keydBinary",
    "keydNativeBinary",
    "runtimeDirectory",
    "runtimeReceipt",
  ];
  if (
    !config ||
    typeof config !== "object" ||
    JSON.stringify(Object.keys(config).sort()) !== JSON.stringify(fields) ||
    ["keydBinary", "keydNativeBinary", "runtimeDirectory", "runtimeReceipt"].some(
      (key) => typeof config[key] !== "string" || !config[key] || config[key].includes("\0"),
    )
  )
    throw fail();
  const sourcePath = (path) => resolve(dirname(inputPath), path);
  const runtimeBytes = await boundedBytes(sourcePath(config.runtimeReceipt), 8 * 1024 * 1024);
  const runtimeReceipt = json(runtimeBytes);
  // Refuse existing output. A failed build is diagnostic material, never a candidate to resume.
  const out = resolve(output);
  if ((await realpath(dirname(out))) !== dirname(out)) throw fail();
  await mkdir(out, { mode: 0o700 });
  const work = join(out, "work"),
    artifacts = join(out, "artifacts");
  await mkdir(work, { mode: 0o700 });
  try {
    const built = await build({
      output: join(out, "app"),
      runtimeDirectory: sourcePath(config.runtimeDirectory),
      runtimeReceipt,
      keydBinary: sourcePath(config.keydBinary),
      keydNativeBinary: sourcePath(config.keydNativeBinary),
      commit: config.commit,
      images: config.images,
    });
    await mkdir(artifacts, { mode: 0o700 });
    const home = join(work, "home"),
      userConfig = join(work, "user.npmrc"),
      globalConfig = join(work, "global.npmrc");
    await mkdir(home, { mode: 0o700 });
    await writeFile(userConfig, "", { flag: "wx", mode: 0o600 });
    await writeFile(globalConfig, "", { flag: "wx", mode: 0o600 });
    const { stdout } = await execute(
      "npm",
      ["pack", "--offline", "--ignore-scripts", "--json", "--pack-destination", artifacts],
      {
        cwd: built.output,
        encoding: "utf8",
        timeout: 30000,
        killSignal: "SIGKILL",
        maxBuffer: 4 * 1024 * 1024,
        // Do not inherit npm tokens, custom registries, NODE_OPTIONS, hooks or the user's home.
        env: {
          PATH: process.env.PATH,
          HOME: home,
          npm_config_cache: join(work, "cache"),
          npm_config_userconfig: userConfig,
          npm_config_globalconfig: globalConfig,
          npm_config_update_notifier: "false",
          npm_config_audit: "false",
          npm_config_fund: "false",
        },
      },
    );
    const packed = JSON.parse(stdout);
    if (
      !Array.isArray(packed) ||
      packed.length !== 1 ||
      packed[0].name !== "localdot" ||
      packed[0].version !== built.version ||
      packed[0].filename !== `localdot-${built.version}.tgz`
    )
      throw fail();
    const archive = join(artifacts, packed[0].filename);
    const audit = checkPackArchive(archive, { temporaryParent: work });
    if (
      audit.problems.length ||
      audit.integrity !== packed[0].integrity ||
      JSON.stringify(inventory(audit.files)) !== JSON.stringify(inventory(built.files))
    )
      throw fail();
    const bytes = await boundedBytes(archive, MAX_PACKAGE_BYTES);
    if (`sha512-${createHash("sha512").update(bytes).digest("base64")}` !== audit.integrity)
      throw fail();
    const result = {
      ...built,
      inputSHA256: sha256(inputBytes),
      runtimeReceiptSHA256: sha256(runtimeBytes),
      archive: {
        path: archive,
        bytes: bytes.length,
        sha256: sha256(bytes),
        integrity: audit.integrity,
        files: audit.files,
      },
      archiveAllFileHashesVerified: true,
      sourceCommitVerified: false,
      releaseProvenanceVerified: false,
      imageAvailabilityVerified: false,
      cleanInstallVerified: false,
      completeRelease: false,
      published: false,
    };
    // The only successful receipt is written after archive verification and work-tree cleanup.
    await rm(work, { recursive: true });
    const receipt = join(out, "receipt.json");
    await writeFile(receipt, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    return { receipt, result };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [inputFile, output, ...extra] = process.argv.slice(2);
  if (!inputFile || !output || extra.length) {
    console.error("Usage: pack-app-release.mjs <input.json> <new-output-directory>");
    process.exitCode = 2;
  } else {
    try {
      const { receipt, result } = await packAppRelease({ inputFile, output });
      console.log(
        JSON.stringify({
          receipt,
          archive: result.archive.path,
          version: result.version,
          completeRelease: false,
        }),
      );
    } catch {
      console.error("App archive build failed. Partial output is not a verified release.");
      process.exitCode = 1;
    }
  }
}
