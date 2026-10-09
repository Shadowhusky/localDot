import { spawn as nodeSpawn } from "node:child_process";
import { constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { join } from "node:path";
import type { StartAtLoginState } from "@localdot/protocol";
import {
  type ManagedServiceIdentity,
  StartAtLoginRecord,
} from "../../../../packages/protocol/src/install-services.ts";

export class StartAtLoginError extends Error {}
export interface StartAtLoginPort {
  status(): Promise<StartAtLoginState>;
  set(enabled: boolean): Promise<StartAtLoginState>;
}
export const unavailableStartAtLogin: StartAtLoginPort = {
  status: async () => "unavailable",
  set: async () => "unavailable",
};
export interface StartAtLoginDeps {
  home: string;
  // Null outside the installed app: start at login is then unavailable.
  identity: ManagedServiceIdentity | null;
  // The recorded runtime (process.execPath).
  node: string;
  // Only HOME and PATH are passed on.
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  spawn?: typeof nodeSpawn;
  timeoutMs?: number;
}
const CHANGE_FAILED = "Start at login couldn't be changed. Try again in a minute.";
const UNREADABLE = "Start at login can't be read.";

/** The daemon never edits the LaunchAgent itself: it runs the installed release's own CLI with a
 * fixed command, which takes the install lock, verifies the recorded configuration and touches
 * only the login agent, so the running daemon cannot stop itself this way.
 */
export function startAtLoginPort(deps: StartAtLoginDeps): StartAtLoginPort {
  const identity = deps.identity;
  if (!identity || (deps.platform ?? process.platform) !== "darwin") return unavailableStartAtLogin;
  const state = join(deps.home, "install");
  const cli = join(
    state,
    "releases",
    `${identity.release.packageSha256}-${identity.release.manifestSha256}`,
    "app",
    "bin",
    "localdot.mjs",
  );
  const status = async (): Promise<StartAtLoginState> => {
    let handle: FileHandle;
    try {
      handle = await open(
        join(state, "start-at-login.json"),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return "off";
      throw new StartAtLoginError(UNREADABLE);
    }
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 16 * 1024) throw new StartAtLoginError(UNREADABLE);
      return StartAtLoginRecord.parse(JSON.parse(await handle.readFile("utf8"))).enabled
        ? "on"
        : "off";
    } catch {
      throw new StartAtLoginError(UNREADABLE);
    } finally {
      await handle.close();
    }
  };
  const run = (operation: "on" | "off") =>
    new Promise<void>((resolve, reject) => {
      const child = (deps.spawn ?? nodeSpawn)(deps.node, [cli, "start-at-login", operation], {
        cwd: "/",
        env: {
          HOME: deps.env.HOME ?? "",
          PATH: deps.env.PATH ?? "/usr/bin:/bin",
          LANG: "en_US.UTF-8",
          LOCALDOT_HOME: deps.home,
        },
        stdio: "ignore",
      });
      const timer = setTimeout(() => child.kill("SIGKILL"), deps.timeoutMs ?? 30_000);
      child.once("error", () => {
        clearTimeout(timer);
        reject(new StartAtLoginError(CHANGE_FAILED));
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new StartAtLoginError(CHANGE_FAILED));
      });
    });
  return {
    status,
    async set(enabled) {
      await run(enabled ? "on" : "off");
      return status();
    },
  };
}
