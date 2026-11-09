import { execFile, spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, open, readdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import {
  AppUpdateAttempt,
  AppUpdateRecord,
  type ReleaseNote,
} from "../../../../packages/protocol/src/app-update.ts";
import { IMAGE_ROLES, type PlatformImagePin } from "../../../../packages/protocol/src/release.ts";
import { privateDirectory } from "../../../cli/src/install/copy-inventory.ts";
import { installImageClient } from "../../../cli/src/install/image-client.ts";
import { imageShare } from "../../../cli/src/install/image-share.ts";
import {
  type ImagePreparationProgress,
  prepareImages,
} from "../../../cli/src/install/prepare-images.ts";
import { privateRecordStore } from "../../../cli/src/install/private-record.ts";
import { SetupFailure } from "../../../cli/src/install/setup-failure.ts";
import { findDockerSocket } from "../doctor-socket.ts";
import { freeBytes } from "../recorder/disk.ts";
import { AppUpdater } from "./app-updater.ts";
import { installerStatus, installerStatusFile } from "./installer-status.ts";
import { runPreparation, stallGuard, UpdateFailure } from "./progress.ts";
import { pickNotes, readReleaseNotes, releaseNote, versionsBetween } from "./release-notes.ts";

const exec = promisify(execFile);
// Free space wanted before the computer's images are fetched ahead of an install.
export const IMAGE_ROOM = 10 * 1024 ** 3;
type Pins = Record<(typeof IMAGE_ROLES)[number], PlatformImagePin>;
const ARCHITECTURE = process.arch === "arm64" ? "arm64" : "amd64";
// A package's own download has its stall timer in the verifier; this one is for Docker's pulls,
// whose layers can be quiet while they extract.
const VERIFIER_STALL_MS = 5 * 60_000;
const IMAGE_STALL_MS = 5 * 60_000;
// A download older than this is what a crash left behind. A fresher one may be another dot's.
const ABANDONED_MS = 24 * 3_600_000;
// The engine the app itself uses, which on a Mac may not be the default socket.
export const imageSocket = (...args: Parameters<typeof findDockerSocket>) =>
  findDockerSocket(...args).path;
const pullImages = (
  pins: Pins,
  signal: AbortSignal,
  report: (p: ImagePreparationProgress) => void,
) =>
  prepareImages(
    pins,
    installImageClient(imageSocket(), ARCHITECTURE, { anyEngine: true }),
    signal,
    report,
  );
const IMAGE_PROBLEMS = {
  "network-unavailable": "network",
  "storage-read-only": "disk",
  "permission-denied": "docker",
  "docker-unavailable": "docker",
} as const;

export async function packageAppUpdater(
  home: string,
  prefix: string,
  installWait: (hold?: boolean) => string | null | Promise<string | null>,
  settled: () => void,
  deps = { exec, spawn, platform: process.platform, freeBytes, images: pullImages },
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
    const installer = installerStatus(home);
    const attempts = privateRecordStore(
      home,
      "app-update-attempt.json",
      AppUpdateAttempt.nullable(),
    );
    // A successful install restarts this daemon before the old install() can clean up.
    // Remove only its recorded staging directory once that exact version is running.
    const removeInstalled = async () => {
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
    };
    // Until the installer's last checks pass it can still roll back, and retry from this download.
    const state = await installer.read();
    if (!state?.running) {
      await removeInstalled();
      // A daemon is running, so a swap the installer never got to finish needs no undoing.
      await rm(join(prefix, ".package-swap"), { force: true }).catch(() => {});
    }
    await removeAbandoned(downloads, (await prepared.read())?.directory);
    const preparedDirectory = async (version: string) => {
      const saved = await prepared.read();
      if (saved?.version !== version) return null;
      try {
        const directory = join(downloads, saved.directory);
        const st = await lstat(join(directory, "app", "package-release.json"));
        return st.isFile() && !st.isSymbolicLink() && st.uid === process.getuid?.()
          ? directory
          : null;
      } catch {
        return null;
      }
    };
    // The signed catalog's notes, from the last check: an update not yet downloaded shows them.
    let catalogNotes: ReleaseNote[] = [];
    // The staged app's pins, written by the verifier from the signed catalog. A pin is a digest,
    // so the worst a changed file could do is fetch an image nothing uses.
    const stagedPins = async (staging: string): Promise<Pins> => {
      const { images } = JSON.parse(
        await readFile(join(staging, "app", "package-release.json"), "utf8"),
      );
      return Object.fromEntries(
        IMAGE_ROLES.map((role) => {
          const reference = images?.[role];
          const [repository = "", digest = ""] =
            typeof reference === "string" ? reference.split("@") : [];
          if (!repository.endsWith(`/localdot-${role}`)) throw new Error("Invalid image pin");
          return [role, { repository, digest, platforms: [`linux/${ARCHITECTURE}`] }];
        }),
      ) as Pins;
    };
    return new AppUpdater({
      version: record.version,
      ...privateRecordStore(home, "package-app-update.json", AppUpdateRecord),
      attempts,
      installOnLaunchSupported: false,
      installWait,
      installer,
      installed: removeInstalled,
      async latest(signal) {
        const { stdout } = await deps.exec(
          process.execPath,
          [bootstrap, "check", channel, target, downloads],
          { signal, timeout: 30_000, maxBuffer: 64 * 1024 },
        );
        // This app's verifier answers with JSON; one that predates notes, with the version alone.
        const answer = stdout.trim().startsWith("{")
          ? JSON.parse(stdout)
          : { version: stdout.trim(), notes: [] };
        const version = answer?.version;
        if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-rc\.\d+)?$/.test(version))
          throw new Error("Update version unavailable");
        catalogNotes = pickNotes(
          (Array.isArray(answer.notes) ? answer.notes : []).map((note: unknown) =>
            note &&
            typeof note === "object" &&
            "version" in note &&
            typeof note.version === "string"
              ? releaseNote(note.version, "markdown" in note ? note.markdown : null)
              : null,
          ),
          () => true,
        );
        return version;
      },
      async prepare(version, signal, progress) {
        await mkdir(downloads, { recursive: true, mode: 0o700 });
        const staging = await mkdtemp(join(downloads, ".prepare-"));
        let imagesDeferred = false;
        try {
          await mkdir(join(home, "logs"), { recursive: true, mode: 0o700 });
          const log = await open(join(home, "logs", "package-update.log"), "a", 0o600);
          try {
            // The verifier keeps the checked archive in staging, so installing reuses it.
            await runPreparation(
              deps.spawn,
              {
                command: process.execPath,
                args: [
                  bootstrap,
                  "prepare",
                  channel,
                  target,
                  staging,
                  join(staging, "app"),
                  version,
                ],
                env: { ...process.env, LOCALDOT_DOWNLOAD_DIR: join(home, "update-download") },
                output: log.fd,
                timeoutMs: 60 * 60_000,
                stallMs: VERIFIER_STALL_MS,
              },
              signal,
              progress,
            );
          } finally {
            await log.close();
          }
          const pins = await stagedPins(staging);
          if (Math.min(deps.freeBytes(homedir()), deps.freeBytes(prefix)) < IMAGE_ROOM)
            imagesDeferred = true;
          else {
            const images = imageShare();
            progress({ step: "images", share: 0 });
            try {
              await stallGuard(signal, IMAGE_STALL_MS, (active, touch) =>
                deps.images(pins, active, (report) => {
                  touch();
                  const share = images(report);
                  if (share) progress({ step: "images", ...share });
                }),
              );
            } catch (error) {
              if (!(error instanceof SetupFailure)) throw error;
              if (error.code !== "storage-full") throw new UpdateFailure(IMAGE_PROBLEMS[error.code]);
              imagesDeferred = true;
            }
          }
          const previous = await prepared.read();
          await prepared.save({ version, directory: staging.slice(downloads.length + 1) });
          if (previous)
            await rm(join(downloads, previous.directory), { recursive: true, force: true });
        } catch (error) {
          await rm(staging, { recursive: true, force: true });
          throw error;
        }
        return { imagesDeferred };
      },
      prepared: async (version) => !!(await preparedDirectory(version)),
      async notes(after, upTo) {
        const wanted = versionsBetween(after, upTo);
        if (upTo === record.version) return readReleaseNotes(join(app, "release-notes"), wanted);
        const staging = await preparedDirectory(upTo);
        const staged = staging
          ? await readReleaseNotes(join(staging, "app", "release-notes"), wanted)
          : [];
        return staged.length ? staged : pickNotes(catalogNotes, wanted);
      },
      async install(version) {
        // The installer authenticates the catalog and full package again at activation. It must
        // install this exact version even if the testing channel changes in the meantime.
        let log: Awaited<ReturnType<typeof open>> | undefined;
        try {
          const staging = await preparedDirectory(version);
          if (!staging) throw new Error("Download the update again before installing.");
          await mkdir(join(home, "logs"), { recursive: true, mode: 0o700 });
          log = await open(join(home, "logs", "package-update.log"), "a", 0o600);
          const environment = {
            HOME: process.env.HOME ?? "",
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            LOCALDOT_UPDATE_SHUTDOWN: "1",
            LOCALDOT_UPDATE_STATUS: installerStatusFile(home),
            // Checked again against the signed catalog; a mismatch is downloaded afresh.
            LOCALDOT_PACKAGE_ARCHIVE: join(staging, "app.tgz"),
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
              code === 0 ? resolve() : reject(new Error("Package update failed.")),
            );
          });
        } finally {
          await log?.close();
          settled();
        }
      },
    });
  } catch {
    return new AppUpdater(null, "install-record");
  }
}

async function removeAbandoned(downloads: string, keep: string | undefined) {
  try {
    for (const name of await readdir(downloads)) {
      if (!name.startsWith(".prepare-") || name === keep) continue;
      const path = join(downloads, name);
      const st = await lstat(path);
      if (st.isDirectory() && Date.now() - st.mtimeMs > ABANDONED_MS)
        await rm(path, { recursive: true, force: true });
    }
  } catch {}
}
