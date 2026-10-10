import { spawn } from "node:child_process";
import { join } from "node:path";
import { isDeepStrictEqual as equal } from "node:util";
import {
  AppUpdateRecord,
  PreparedAppUpdate,
} from "../../../../packages/protocol/src/app-update.ts";
import type { ManagedServiceIdentity } from "../../../../packages/protocol/src/install-services.ts";
import { privateRecordStore } from "../../../cli/src/install/private-record.ts";
import { latestReleaseVersion } from "../../../cli/src/install/registry-download.ts";
import { AppUpdater } from "./app-updater.ts";

export function installedAppUpdater(
  home: string,
  identity: ManagedServiceIdentity | null,
  installWait: () => string | null,
  installSettled: () => void,
) {
  if (!identity) return new AppUpdater(null);
  const state = join(home, "install");
  const records = privateRecordStore(state, "app-update.json", AppUpdateRecord);
  const prepared = privateRecordStore(state, "prepared-app-update.json", PreparedAppUpdate);
  const cli = join(
    state,
    "releases",
    `${identity.release.packageSha256}-${identity.release.manifestSha256}`,
    "app",
    "bin",
    "localdot.mjs",
  );
  return new AppUpdater({
    version: identity.release.version,
    ...records,
    latest: latestReleaseVersion,
    installWait,
    install(version) {
      return new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, [cli, "update", "--install-prepared", version], {
          cwd: "/",
          env: {
            HOME: process.env.HOME ?? "",
            PATH: "/usr/bin:/bin",
            LANG: "en_US.UTF-8",
            LOCALDOT_HOME: home,
          },
          stdio: "ignore",
          detached: true,
        });
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
    },
    async prepared(version) {
      const candidate = await prepared.read();
      return (
        !!candidate?.candidate &&
        candidate.candidate.version === version &&
        equal(candidate.previous, identity.release)
      );
    },
    prepare(version, signal) {
      // Finite argv and clean environment; no shell, PATH-resolved executable or registry URL.
      return new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, [cli, "update", "--prepare", version], {
          cwd: "/",
          env: {
            HOME: process.env.HOME ?? "",
            PATH: "/usr/bin:/bin",
            LANG: "en_US.UTF-8",
            LOCALDOT_HOME: home,
          },
          stdio: "ignore",
        });
        let kill: ReturnType<typeof setTimeout> | undefined;
        const cancel = () => {
          child.kill("SIGTERM");
          kill ??= setTimeout(() => child.kill("SIGKILL"), 15_000).unref();
        };
        signal.addEventListener("abort", cancel, { once: true });
        const timeout = setTimeout(cancel, 30 * 60_000).unref();
        if (signal.aborted) cancel();
        const clean = () => {
          clearTimeout(timeout);
          clearTimeout(kill);
          signal.removeEventListener("abort", cancel);
        };
        child.once("error", () => {
          clean();
          reject(new Error("Update preparation failed"));
        });
        child.once("close", (code) => {
          clean();
          if (code === 0 && !signal.aborted) resolve();
          else reject(new Error("Update preparation failed"));
        });
      });
    },
  });
}
