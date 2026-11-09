import { spawn } from "node:child_process";
import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual as equal } from "node:util";
import {
  AppUpdateAttempt,
  AppUpdateRecord,
  PreparedAppUpdate,
} from "../../../../packages/protocol/src/app-update.ts";
import type { ManagedServiceIdentity } from "../../../../packages/protocol/src/install-services.ts";
import type { ReleaseIdentity } from "../../../../packages/protocol/src/install-update.ts";
import { privateRecordStore } from "../../../cli/src/install/private-record.ts";
import { latestReleaseVersion } from "../../../cli/src/install/registry-download.ts";
import { AppUpdater } from "./app-updater.ts";
import { runPreparation } from "./progress.ts";
import { readReleaseNotes, versionsBetween } from "./release-notes.ts";

export function installedAppUpdater(
  home: string,
  identity: ManagedServiceIdentity | null,
  installWait: (hold?: boolean) => string | null | Promise<string | null>,
  installSettled: () => void,
  deps = { spawn },
) {
  if (!identity) return new AppUpdater(null, "install-record");
  const state = join(home, "install");
  const records = privateRecordStore(state, "app-update.json", AppUpdateRecord);
  const prepared = privateRecordStore(state, "prepared-app-update.json", PreparedAppUpdate);
  const app = (release: ReleaseIdentity) =>
    join(state, "releases", `${release.packageSha256}-${release.manifestSha256}`, "app");
  const cli = join(app(identity.release), "bin", "localdot.mjs");
  const environment = {
    HOME: process.env.HOME ?? "",
    PATH: "/usr/bin:/bin",
    LANG: "en_US.UTF-8",
    LOCALDOT_HOME: home,
  };
  return new AppUpdater({
    version: identity.release.version,
    ...records,
    attempts: privateRecordStore(state, "app-update-attempt.json", AppUpdateAttempt.nullable()),
    latest: latestReleaseVersion,
    installWait,
    async install(version) {
      await mkdir(join(home, "logs"), { recursive: true, mode: 0o700 });
      const log = await open(join(home, "logs", "app-update.log"), "a", 0o600);
      try {
        await new Promise<void>((resolve, reject) => {
          const child = deps.spawn(
            process.execPath,
            [cli, "update", "--install-prepared", version],
            {
              cwd: "/",
              env: environment,
              stdio: ["ignore", log.fd, log.fd],
              detached: true,
            },
          );
          child.unref();
          child.once("error", () => {
            installSettled();
            reject(new Error("Update couldn't start"));
          });
          child.once("close", (code) => {
            installSettled();
            if (code === 0) resolve();
            else reject(new Error("Update failed"));
          });
        });
      } finally {
        await log.close();
      }
    },
    async prepared(version) {
      const candidate = await prepared.read();
      return (
        !!candidate?.candidate &&
        candidate.candidate.version === version &&
        equal(candidate.previous, identity.release)
      );
    },
    async prepare(version, signal, progress) {
      // Finite argv and clean environment; no shell, PATH-resolved executable or registry URL.
      await runPreparation(
        deps.spawn,
        {
          command: process.execPath,
          args: [cli, "update", "--prepare", version],
          env: environment,
          output: "ignore",
          timeoutMs: 30 * 60_000,
        },
        signal,
        progress,
      );
      return undefined;
    },
    // The installed release, and a downloaded one, carry the notes of their recent releases.
    async notes(after, upTo) {
      if (upTo === identity.release.version)
        return readReleaseNotes(
          join(app(identity.release), "release-notes"),
          versionsBetween(after, upTo),
        );
      const candidate = (await prepared.read())?.candidate;
      if (candidate?.version !== upTo) return [];
      return readReleaseNotes(join(app(candidate), "release-notes"), versionsBetween(after, upTo));
    },
  });
}
