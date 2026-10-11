import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { withExtractedDependency } from "../../apps/cli/src/install/extract-release.ts";
import { authenticatedCatalog, TARGETS, type Target } from "./catalog.ts";

declare const __LOCALDOT_DISTRIBUTION_KEY__: string;
async function download(
  url: string,
  max: number,
  signal: AbortSignal,
  label?: string,
): Promise<Buffer> {
  let size = 0;
  const started = Date.now();
  const report = () => {
    const elapsed = Math.max(1, (Date.now() - started) / 1000);
    const percent = Math.floor((size / max) * 100);
    const text = `${label}: ${(size / 1048576).toFixed(1)} / ${(max / 1048576).toFixed(1)} MB (${percent}%) · ${(size / 1048576 / elapsed).toFixed(1)} MB/s · ${Math.floor(elapsed)}s elapsed`;
    process.stderr.write(process.stderr.isTTY ? `\r\x1b[2K${text}` : `${text}\n`);
  };
  // The app's exact byte count is authenticated by the catalog. Metadata checks
  // stay silent so `check` continues to return only the machine-readable version.
  if (label) report();
  const timer = label ? setInterval(report, process.stderr.isTTY ? 1000 : 5000) : undefined;
  timer?.unref();
  try {
    const response = await fetch(url, { signal, redirect: "follow" });
    if (!response.ok || !response.url.startsWith("https://") || !response.body)
      throw new Error(
        `Download unavailable (${response.status}). Your existing installation is unchanged.`,
      );
    const chunks: Uint8Array[] = [];
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > max) throw new Error("Download exceeds the release size limit.");
      chunks.push(chunk);
    }
    if (label) report();
    return Buffer.concat(chunks);
  } finally {
    clearInterval(timer);
    if (label && process.stderr.isTTY) process.stderr.write("\n");
  }
}
async function main() {
  const [command, channel, target, workspace, destination, expectedVersion] = process.argv.slice(2);
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
  const signal = AbortSignal.timeout(10 * 60_000);
  const signed = (await download(channel, 2 * 1024 * 1024, signal)).toString("utf8");
  const catalog = authenticatedCatalog(signed, __LOCALDOT_DISTRIBUTION_KEY__);
  if (expectedVersion && catalog.version !== expectedVersion)
    throw new Error("The update channel changed. Check for updates again before installing.");
  const artifact = catalog.platforms[target as Target];
  if (!artifact)
    throw new Error(
      `A tested download for ${target} has not been published yet. No source checkout or build will be attempted.`,
    );
  if (command === "check") {
    console.log(catalog.version);
    return;
  }
  if (!destination) throw new Error("A package staging directory is required.");
  const work = resolve(workspace),
    stage = resolve(destination);
  await mkdir(work, { recursive: true, mode: 0o700 });
  const archive = join(work, "app.tgz");
  const body = await download(artifact.url, artifact.bytes, signal, "Downloading localDot");
  console.error("Download complete. Verifying the signed app package...");
  if (
    body.length !== artifact.bytes ||
    createHash("sha512").update(body).digest("hex") !== artifact.sha512
  )
    throw new Error("App download did not match the signed release. Nothing was installed.");
  await writeFile(archive, body, { flag: "wx", mode: 0o400 });
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
  await rm(archive);
  console.log(`Prepared localDot ${catalog.version}.`);
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Release download failed.");
  process.exitCode = 1;
});
