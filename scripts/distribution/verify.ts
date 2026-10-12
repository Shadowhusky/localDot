import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { withExtractedDependency } from "../../apps/cli/src/install/extract-release.ts";

/** Verify the exact archive inventory and boot its bundled app with a new isolated home.
 * This smoke test never connects to the user's Docker engine, creates computers or registers services.
 * It complements, and does not stand in for, real-machine installer acceptance.
 */
export async function verifyDistribution(directory: string) {
  const receipt = JSON.parse(await readFile(join(directory, "artifact.json"), "utf8"));
  if (receipt.target !== `${process.platform}-${process.arch}`)
    throw new Error("Run package verification on its target platform.");
  const work = await realpath(await mkdtemp(join(tmpdir(), "localdot-release-verify-")));
  try {
    const archive = join(work, "app.tgz"),
      artifact = receipt.artifact;
    const bytes = await readFile(join(directory, basename(new URL(artifact.url).pathname)));
    if (
      bytes.length !== artifact.bytes ||
      createHash("sha512").update(bytes).digest("hex") !== artifact.sha512
    )
      throw new Error("Package download identity differs from its receipt.");
    await copyFile(join(directory, basename(new URL(artifact.url).pathname)), archive);
    await chmod(archive, 0o400);
    await withExtractedDependency(
      work,
      { archive, sha512: artifact.sha512 },
      AbortSignal.timeout(120_000),
      async (extracted) => {
        if (Object.keys(extracted.files).length !== Object.keys(artifact.files).length)
          throw new Error("Unexpected archive members.");
        for (const [path, file] of Object.entries(extracted.files)) {
          const expected = artifact.files[path];
          if (
            !expected ||
            file.sha256 !== expected.sha256 ||
            file.bytes !== expected.bytes ||
            file.mode !== expected.mode
          )
            throw new Error(`Archive inventory differs: ${path}`);
        }
        const cwd = extracted.root;
        const environment = {
          HOME: join(work, "home"),
          PATH: process.env.PATH,
          LOCALDOT_HOME: join(work, "state"),
          LOCALDOT_NOTIFY_MAC: "off",
          DOCKER_HOST: `unix://${join(work, "no-docker.sock")}`,
        };
        const run = (entry: string, args: string[] = []) =>
          execFileSync(process.execPath, [entry, ...args], {
            cwd,
            env: environment,
            timeout: 30_000,
            stdio: ["ignore", "pipe", "pipe"],
            encoding: "utf8",
          });
        const version = run("dist/cli.mjs", ["--version"]).trim();
        if (!version.includes(receipt.version)) throw new Error("Packaged CLI version differs.");
        run("--input-type=module", [
          "-e",
          "import sharp from 'sharp'; await sharp({create:{width:1,height:1,channels:3,background:'white'}}).png().toBuffer();",
        ]);
        // Execute the native helper far enough to check OS/architecture and its linked runtime.
        const helper = spawnSync(join(cwd, "keyd"), ["-h"], {
          env: environment,
          timeout: 10_000,
          encoding: "utf8",
        });
        if (
          helper.error ||
          ![0, 2].includes(helper.status ?? -1) ||
          !`${helper.stdout}${helper.stderr}`.includes("Usage of keyd:")
        )
          throw new Error("Packaged native helper could not execute.");
        // Recovery depends on this exact packaged helper, not merely a runnable older keyd.
        const native = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
          detached: true,
          stdio: "ignore",
          env: environment,
        });
        const nativeStopped = new Promise<void>((r) => native.once("close", () => r()));
        const observe = (args: string[]) =>
          JSON.parse(
            execFileSync(join(cwd, "keyd"), ["native-process", ...args], {
              env: environment,
              timeout: 5000,
              encoding: "utf8",
            }),
          );
        let identity: { state: string; start: string };
        try {
          await new Promise<void>((resolve, reject) => {
            native.once("spawn", resolve);
            native.once("error", reject);
          });
          identity = observe(["identity", String(native.pid)]);
          if (
            identity.state !== "owned" ||
            !identity.start ||
            observe(["status", String(native.pid), identity.start]).state !== "alive"
          )
            throw new Error("Packaged helper cannot identify an owned native task.");
        } finally {
          native.kill("SIGKILL");
          await nativeStopped;
        }
        if (observe(["status", String(native.pid), identity.start]).state !== "exited")
          throw new Error("Packaged helper cannot verify native task exit.");
        const probe = createServer();
        await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
        const address = probe.address();
        if (!address || typeof address === "string") throw new Error("Test port unavailable.");
        const port = address.port;
        await new Promise<void>((r) => probe.close(() => r()));
        const child = spawn(process.execPath, ["dist/daemon.mjs"], {
          cwd,
          env: { ...environment, LOCALDOT_PORT: String(port) },
          stdio: "ignore",
        });
        const stopped = new Promise<void>((r) => child.once("close", () => r()));
        try {
          const deadline = Date.now() + 20_000;
          let healthy = false;
          while (!healthy && Date.now() < deadline && child.exitCode === null) {
            healthy = await fetch(`http://127.0.0.1:${port}/healthz`).then(
              (r) => r.status === 200,
              () => false,
            );
            if (!healthy) await new Promise((r) => setTimeout(r, 100));
          }
          if (!healthy) throw new Error("Packaged daemon failed its startup check.");
          const page = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.text());
          const assets = [...page.matchAll(/(?:src|href)="(\/assets\/[^"?#]+)"/g)].map((m) => m[1]);
          if (!assets.length) throw new Error("Packaged web entrypoint has no assets.");
          for (const asset of assets) {
            const response = await fetch(`http://127.0.0.1:${port}${asset}`);
            if (!response.ok || response.headers.get("content-type")?.includes("text/html"))
              throw new Error("A packaged web asset failed to load.");
          }
        } finally {
          child.kill("SIGTERM");
          const timer = setTimeout(() => child.kill("SIGKILL"), 17_000);
          await stopped;
          clearTimeout(timer);
        }
      },
    );
    const verified = {
      v: 1,
      target: receipt.target,
      version: receipt.version,
      sha512: receipt.artifact.sha512,
      inventory: true,
      cli: true,
      nativeImageModule: true,
      helper: true,
      nativeRecovery: true,
      daemon: true,
      webAssets: true,
      testedAt: new Date().toISOString(),
      node: process.version,
    };
    await writeFile(join(directory, "verification.json"), JSON.stringify(verified, null, 2), {
      mode: 0o600,
    });
    console.log(`Verified packaged runtime for ${receipt.target}.`);
    return verified;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directory = process.argv[2];
  if (!directory) throw new Error("Usage: verify.ts candidate-directory");
  await verifyDistribution(directory);
}
