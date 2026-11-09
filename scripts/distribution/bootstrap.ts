import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, mkdir, open, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { withExtractedDependency } from "../../apps/cli/src/install/extract-release.ts";
import { updateProgressReporter } from "../../apps/cli/src/install/update-progress.ts";
import {
  type Artifact,
  authenticatedCatalog,
  catalogNotes,
  TARGETS,
  type Target,
} from "./catalog.ts";
import { downloadPackage, PackageProblem, PROBLEM_EXIT } from "./package-download.ts";

declare const __LOCALDOT_DISTRIBUTION_KEY__: string;
const progress = updateProgressReporter();
const METADATA_MS = 30_000;
// The signed catalog. Its size is bounded, and it stays silent so `check` answers only the version.
async function readCatalog(url: string, signal: AbortSignal): Promise<string> {
  const max = 2 * 1024 * 1024;
  let response: Response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(METADATA_MS)]),
      redirect: "follow",
    });
  } catch {
    throw new PackageProblem("network", "Couldn't reach the update channel.");
  }
  if (!response.ok || !response.url.startsWith("https://") || !response.body)
    throw new PackageProblem(
      "network",
      `Download unavailable (${response.status}). Your existing installation is unchanged.`,
    );
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > max) throw new Error("Download exceeds the release size limit.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
// The app's exact byte count is authenticated by the catalog.
function progressLog(max: number) {
  let size = 0,
    last = 0;
  const started = Date.now();
  const report = () => {
    const elapsed = Math.max(1, (Date.now() - started) / 1000);
    const percent = Math.floor((size / max) * 100);
    const text = `Downloading localDot: ${(size / 1048576).toFixed(1)} / ${(max / 1048576).toFixed(1)} MB (${percent}%) · ${(size / 1048576 / elapsed).toFixed(1)} MB/s · ${Math.floor(elapsed)}s elapsed`;
    process.stderr.write(process.stderr.isTTY ? `\r\x1b[2K${text}` : `${text}\n`);
  };
  return (done: number, total: number) => {
    size = done;
    progress?.({ step: "download", done, total });
    const now = Date.now();
    if (now - last >= (process.stderr.isTTY ? 1000 : 5000) || done === total) {
      last = now;
      report();
      if (done === total && process.stderr.isTTY) process.stderr.write("\n");
    }
  };
}
// An archive this verifier kept from an earlier download, used when it is still the signed one.
async function kept(path: string | undefined, artifact: Artifact): Promise<Buffer | undefined> {
  if (!path) return;
  try {
    const handle = await open(resolve(path), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const st = await handle.stat();
      if (!st.isFile() || st.size !== artifact.bytes || st.uid !== process.getuid?.()) return;
      const body = await handle.readFile();
      return createHash("sha512").update(body).digest("hex") === artifact.sha512 ? body : undefined;
    } finally {
      await handle.close();
    }
  } catch {
    return;
  }
}
// What unpacking the package takes, on top of the package itself.
const unpackedBytes = (artifact: Artifact) =>
  Object.values(artifact.files).reduce((sum, file) => sum + file.bytes, 0);
const ROOM_MARGIN = 64 * 1024 * 1024;
async function main() {
  const [command, channel, target, workspace, destination, expectedVersion, keptArchive] =
    process.argv.slice(2);
  if (
    !command ||
    !channel ||
    !target ||
    !["prepare", "check"].includes(command) ||
    !/^https:\/\/downloads\.localdot\.dev\/channels\/[a-z]+\.json$/.test(channel) ||
    !TARGETS.includes(target as Target) ||
    !workspace ||
    (command === "prepare" && !destination)
  )
    throw new Error("Invalid packaged installation request.");
  const signal = AbortSignal.timeout(60 * 60_000);
  const signed = await readCatalog(channel, signal);
  const catalog = authenticatedCatalog(signed, __LOCALDOT_DISTRIBUTION_KEY__);
  if (expectedVersion && catalog.version !== expectedVersion)
    throw new PackageProblem(
      "channel",
      "The update channel changed. Check for updates again before installing.",
    );
  const artifact = catalog.platforms[target as Target];
  if (!artifact)
    throw new Error(
      `A tested download for ${target} has not been published yet. No source checkout or build will be attempted.`,
    );
  if (command === "check") {
    console.log(JSON.stringify({ version: catalog.version, notes: catalogNotes(catalog) }));
    return;
  }
  if (!destination) throw new Error("A package staging directory is required.");
  const work = resolve(workspace),
    stage = resolve(destination);
  await mkdir(work, { recursive: true, mode: 0o700 });
  const archive = join(work, "app.tgz");
  const reused = await kept(keptArchive, artifact);
  if (reused) {
    console.error("Using the app package downloaded earlier.");
    await writeFile(archive, reused, { flag: "wx", mode: 0o400 });
  } else
    await downloadPackage({
      url: artifact.url,
      bytes: artifact.bytes,
      sha512: artifact.sha512,
      to: archive,
      partials: process.env.LOCALDOT_DOWNLOAD_DIR ?? dirname(work),
      needs: artifact.bytes + unpackedBytes(artifact) + ROOM_MARGIN,
      signal,
      report: progressLog(artifact.bytes),
    });
  progress?.({ step: "verify" });
  console.error("Download complete. Verifying the signed app package...");
  console.error("Extracting and checking app files...");
  await withExtractedDependency(
    work,
    { archive, sha512: artifact.sha512 },
    signal,
    async (extracted) => {
      if (Object.keys(extracted.files).length !== Object.keys(artifact.files).length)
        throw new Error("Unexpected files in the app package.");
      for (const [path, actual] of Object.entries(extracted.files)) {
        const expected = artifact.files[path];
        if (
          !expected ||
          actual.sha256 !== expected.sha256 ||
          actual.bytes !== expected.bytes ||
          actual.mode !== expected.mode
        )
          throw new Error("App file inventory did not verify.");
      }
      console.error(`Verified ${Object.keys(extracted.files).length} files. Preparing the app...`);
      await mkdir(stage, { mode: 0o700 });
      for (const [path, file] of Object.entries(extracted.files)) {
        const to = join(stage, path);
        await mkdir(dirname(to), { recursive: true, mode: 0o700 });
        await copyFile(join(extracted.root, path), to);
        await chmod(to, file.mode);
      }
      await writeFile(
        join(stage, "package-release.json"),
        JSON.stringify({
          version: catalog.version,
          commit: catalog.commit,
          channel,
          images: catalog.images[target.endsWith("arm64") ? "arm64" : "x64"],
        }),
        { flag: "wx", mode: 0o600 },
      );
      // Keep the authenticated bootstrap with the installation for future checks/updates.
      await copyFile(new URL(import.meta.url), join(stage, "bootstrap.mjs"));
    },
  );
  // The checked archive stays beside the staged app, so installing it later needs no download.
  console.log(`Prepared localDot ${catalog.version}.`);
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Release download failed.");
  const full = !!error && typeof error === "object" && "code" in error && error.code === "ENOSPC";
  const problem = full ? "disk" : error instanceof PackageProblem ? error.problem : undefined;
  if (problem) progress?.({ step: "download", problem });
  process.exitCode = problem ? PROBLEM_EXIT[problem] : 1;
});
