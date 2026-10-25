import { execFile, spawn } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { AppUpdateAttempt, AppUpdateRecord } from "../../../../packages/protocol/src/app-update.ts";
import { RELEASE_VERSION } from "../../../../packages/protocol/src/release.ts";
import { privateRecordStore } from "../../../cli/src/install/private-record.ts";
import { AppUpdater } from "./app-updater.ts";
import { packageAppUpdater, userManagerEnvironment } from "./package-updater.ts";
import { pickNotes, releaseNote } from "./release-notes.ts";

const exec = promisify(execFile);
const Commit = z.string().regex(/^[0-9a-f]{40}$/);
const Prepared = z.strictObject({
  v: z.literal(1),
  previous: Commit,
  candidate: Commit.nullable(),
});
/** The shell installer follows the user's existing source channel. This is HTTPS Git source,
 * not a signed packaged release. Download only adds Git objects; never checkout/build/restart. */
export async function sourceAppUpdater(
  home: string,
  prefix: string | undefined,
  installWait: () => string | null | Promise<string | null>,
  settled: () => void,
  deps = { exec, spawn, platform: process.platform },
): Promise<AppUpdater> {
  if (!prefix) return new AppUpdater(null);
  try {
    if ((await realpath(prefix)) !== prefix) throw new Error("Invalid installation");
    const file = join(prefix, "install.env"),
      stat = await lstat(file);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > 8192 ||
      stat.uid !== process.getuid?.() ||
      stat.mode & 0o022
    )
      throw new Error("Invalid installation");
    const text = await readFile(file, "utf8");
    if (!text.startsWith("# Managed by localDot's install.sh\n"))
      throw new Error("Unknown installation");
    const settings = new Map(
      [...text.matchAll(/^([A-Z_]+)="([^"\n]*)"$/gm)].map((match) => [match[1], match[2]]),
    );
    if (settings.get("LOCALDOT_PACKAGE_CHANNEL")) {
      if (settings.get("LOCALDOT_HOME") !== home) throw new Error("Installation home changed");
      return packageAppUpdater(home, prefix, installWait, settled);
    }
    const version = Commit.parse(settings.get("LOCALDOT_COMMIT"));
    const ref = settings.get("LOCALDOT_REF"),
      repo = settings.get("LOCALDOT_REPO");
    if (
      settings.get("LOCALDOT_HOME") !== home ||
      !ref ||
      !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref) ||
      !repo?.startsWith("https://")
    )
      throw new Error("Invalid source channel");
    const app = join(prefix, "app");
    const git = async (args: string[], signal?: AbortSignal) =>
      (
        await deps.exec("git", ["-C", app, ...args], {
          signal,
          timeout: 120_000,
          maxBuffer: 64 * 1024,
          env: {
            HOME: process.env.HOME,
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            GIT_TERMINAL_PROMPT: "0",
          },
        })
      ).stdout.trim();
    if (
      (await git(["remote", "get-url", "origin"])) !== repo ||
      (await git(["rev-parse", "HEAD"])) !== version
    )
      throw new Error("Source checkout changed");
    const records = privateRecordStore(home, "source-app-update.json", AppUpdateRecord);
    const prepared = privateRecordStore(home, "prepared-source-update.json", Prepared);
    const notesIn = async (commit: string) =>
      new Set(
        (await git(["ls-tree", "--name-only", Commit.parse(commit), "docs/releases/"]))
          .split("\n")
          .map((path) => path.match(/^docs\/releases\/(.+)\.md$/)?.[1])
          .filter((name): name is string => !!name && RELEASE_VERSION.test(name)),
      );
    return new AppUpdater({
      version,
      ...records,
      attempts: privateRecordStore(home, "app-update-attempt.json", AppUpdateAttempt.nullable()),
      // A commit's notes are the release notes files it adds; a commit alone says nothing new.
      async notes(after, upTo) {
        if (!after) return [];
        const before = await notesIn(after);
        const added = [...(await notesIn(upTo))].filter((name) => !before.has(name));
        return pickNotes(
          await Promise.all(
            added.map(async (name) =>
              releaseNote(
                name,
                await git(["cat-file", "blob", `${upTo}:docs/releases/${name}.md`]),
              ),
            ),
          ),
          () => true,
        );
      },
      async read() {
        const record = await records.read();
        const pending = await prepared.read();
        // A manual upgrade may have overtaken a cached commit. Git hashes are not sortable.
        if (record && pending && pending.previous !== version)
          return { ...record, availableVersion: null, dismissedVersion: null, nextCheckAt: 0 };
        return record;
      },
      installOnLaunchSupported: false,
      compare: (a, b) => (a === b ? 0 : 1),
      installWait,
      async latest(signal) {
        // Exact tags/commits remain pinned. A missing branch is not an update or an error.
        const branch = ref.startsWith("refs/heads/") ? ref : `refs/heads/${ref}`;
        const answer = await git(["ls-remote", "origin", branch], signal);
        if (!answer) return version;
        const [commit, name] = answer.split(/\s+/);
        if (name !== branch) throw new Error("Unexpected channel");
        return Commit.parse(commit);
      },
      async prepare(candidate, signal) {
        // Git reports no progress here, so the bar shows work of unknown length.
        Commit.parse(candidate);
        if ((await git(["rev-parse", "HEAD"], signal)) !== version)
          throw new Error("Installation changed");
        await git(
          [
            "fetch",
            "--quiet",
            "--no-tags",
            "--no-write-fetch-head",
            "--depth",
            "1",
            "origin",
            candidate,
          ],
          signal,
        );
        if ((await git(["rev-parse", `${candidate}^{commit}`], signal)) !== candidate)
          throw new Error("Source mismatch");
        await prepared.save({ v: 1, previous: version, candidate });
        return undefined;
      },
      async prepared(candidate) {
        const saved = await prepared.read();
        return saved?.previous === version && saved.candidate === candidate;
      },
      async install(candidate) {
        try {
          const saved = await prepared.read();
          if (saved?.previous !== version || saved.candidate !== candidate)
            throw new Error("Update changed");
          // Consume before dispatch; failure cannot accidentally repeat a restart.
          await prepared.save({ ...saved, candidate: null });
          await new Promise<void>((resolve, reject) => {
            const command = join(prefix, "bin", "localdot");
            const environment = {
              HOME: process.env.HOME ?? "",
              PATH: process.env.PATH ?? "/usr/bin:/bin",
              LOCALDOT_UPDATE_COMMIT: Commit.parse(candidate),
              LOCALDOT_UPDATE_SHUTDOWN: "1",
            };
            // A detached child is still in systemd's daemon cgroup. A transient user service
            // survives StopUnit; otherwise updating would kill its own installer halfway through.
            const executable = deps.platform === "linux" ? "/usr/bin/systemd-run" : command;
            const args =
              deps.platform === "linux"
                ? [
                    "--user",
                    "--wait",
                    "--collect",
                    "--property=Type=exec",
                    "--",
                    "/usr/bin/env",
                    ...Object.entries(environment).map(([key, value]) => `${key}=${value}`),
                    command,
                    "update",
                  ]
                : ["update"];
            const child = deps.spawn(executable, args, {
              detached: true,
              stdio: "ignore",
              cwd: "/",
              env: {
                HOME: process.env.HOME,
                PATH: process.env.PATH ?? "/usr/bin:/bin",
                LOCALDOT_UPDATE_COMMIT: Commit.parse(candidate),
                LOCALDOT_UPDATE_SHUTDOWN: "1",
                ...(deps.platform === "linux" ? userManagerEnvironment() : {}),
              },
            });
            child.unref();
            child.once("error", reject);
            child.once("close", (code) =>
              code === 0 ? resolve() : reject(new Error("Source update failed")),
            );
          });
        } finally {
          settled();
        }
      },
    });
  } catch {
    return new AppUpdater(null);
  }
}
