import { execFile, spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { AppUpdateRecord } from "../../../../packages/protocol/src/app-update.ts";
import { privateDirectory } from "../../../cli/src/install/copy-inventory.ts";
import { privateRecordStore } from "../../../cli/src/install/private-record.ts";
import { AppUpdater } from "./app-updater.ts";

const exec = promisify(execFile);
export async function packageAppUpdater(
  home: string,
  prefix: string,
  installWait: () => string | null,
  settled: () => void,
  deps = { exec, spawn, platform: process.platform },
): Promise<AppUpdater> {
  try {
    const app = join(prefix, "app"),
      recordFile = join(app, "package-release.json");
    const st = await lstat(recordFile);
    if (
      !st.isFile() ||
      st.isSymbolicLink() ||
      st.mode & 0o022 ||
      st.uid !== process.getuid?.() ||
      st.size > 8192
    )
      throw new Error("Invalid installed package record");
    const record = JSON.parse(await readFile(recordFile, "utf8"));
    if (
      !/^\d+\.\d+\.\d+(?:-rc\.\d+)?$/.test(record.version) ||
      !/^https:\/\/downloads\.localdot\.dev\/channels\/(testing|releases|stable)\.json$/.test(
        record.channel,
      )
    )
      throw new Error("Invalid package channel");
    // The signed app carries its verifier; the root bootstrap may predate this release.
    const channel = record.channel.replace("/channels/testing.json", "/channels/releases.json");
    const bootstrap = join(app, "dist", "package-bootstrap.mjs"),
      target = `${process.platform}-${process.arch}`;
    const downloads = join(prefix, "runtime", "package-updates");
    const Prepared = z
      .strictObject({
        version: z.string().regex(/^\d+\.\d+\.\d+(?:-rc\.\d+)?$/),
        directory: z.string().regex(/^\.prepare-[A-Za-z0-9]+$/),
      })
      .nullable();
    const prepared = privateRecordStore(home, "prepared-package-update.json", Prepared);
    // A successful install restarts this daemon before the old install() can clean up.
    // Remove only its recorded staging directory once that exact version is running.
    try {
      const saved = await prepared.read();
      if (saved && saved.version === record.version) {
        await privateDirectory(downloads);
        const staging = join(downloads, saved.directory);
        await privateDirectory(staging);
        await rm(staging, { recursive: true, force: true });
        await prepared.save(null);
      }
    } catch {
      console.warn("The completed update's temporary download could not be removed.");
    }
    const hasPrepared = async (version: string) => {
      const saved = await prepared.read();
      if (saved?.version !== version) return false;
      try {
        const st = await lstat(join(downloads, saved.directory, "app", "package-release.json"));
        return st.isFile() && !st.isSymbolicLink() && st.uid === process.getuid?.();
      } catch {
        return false;
      }
    };
    return new AppUpdater({
      version: record.version,
      ...privateRecordStore(home, "package-app-update.json", AppUpdateRecord),
      installOnLaunchSupported: false,
      installWait,
      async latest(signal) {
        const { stdout } = await deps.exec(
          process.execPath,
          [bootstrap, "check", channel, target, downloads],
          { signal, timeout: 30_000, maxBuffer: 1024 },
        );
        const version = stdout.trim();
        if (!/^\d+\.\d+\.\d+(?:-rc\.\d+)?$/.test(version))
          throw new Error("Update version unavailable");
        return version;
      },
      async prepare(version, signal) {
        await mkdir(downloads, { recursive: true, mode: 0o700 });
        const staging = await mkdtemp(join(downloads, ".prepare-"));
        try {
          await deps.exec(
            process.execPath,
            [bootstrap, "prepare", channel, target, staging, join(staging, "app"), version],
            { signal, timeout: 10 * 60_000, maxBuffer: 8192 },
          );
          const previous = await prepared.read();
          await prepared.save({ version, directory: staging.slice(downloads.length + 1) });
          if (previous)
            await rm(join(downloads, previous.directory), { recursive: true, force: true });
        } catch (error) {
          await rm(staging, { recursive: true, force: true });
          throw error;
        }
      },
      prepared: hasPrepared,
      async install(version) {
        // The installer authenticates the catalog and full package again at activation. It must
        // install this exact version even if the testing channel changes in the meantime.
        let log: Awaited<ReturnType<typeof open>> | undefined;
        try {
          if (!(await hasPrepared(version)))
            throw new Error("Download the update again before installing.");
          await mkdir(join(home, "logs"), { recursive: true, mode: 0o700 });
          log = await open(join(home, "logs", "package-update.log"), "a", 0o600);
          const environment = {
            HOME: process.env.HOME ?? "",
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            LOCALDOT_UPDATE_SHUTDOWN: "1",
          };
          const args = [
            join(app, "install.sh"),
            "--prefix",
            prefix,
            "--package-channel",
            channel,
            "--package-version",
            version,
            "--no-prerequisites",
          ];
          // Escape the daemon's systemd cgroup so StopUnit cannot kill the installer itself.
          const executable = deps.platform === "linux" ? "/usr/bin/systemd-run" : "/bin/bash";
          const commandArgs =
            deps.platform === "linux"
              ? [
                  "--user",
                  "--wait",
                  "--collect",
                  "--property=Type=exec",
                  "--pipe",
                  "--",
                  "/usr/bin/env",
                  ...Object.entries(environment).map(([key, value]) => `${key}=${value}`),
                  "/bin/bash",
                  ...args,
                ]
              : args;
          const logFd = log.fd;
          await new Promise<void>((resolve, reject) => {
            const child = deps.spawn(executable, commandArgs, {
              detached: true,
              cwd: "/",
              stdio: ["ignore", logFd, logFd],
              env: environment,
            });
            child.unref();
            child.once("error", reject);
            child.once("close", (code) =>
              code === 0
                ? resolve()
                : reject(new Error("Package update failed. Check the update log, then try again.")),
            );
          });
        } finally {
          await log?.close();
          settled();
        }
      },
    });
  } catch {
    return new AppUpdater(null);
  }
}
