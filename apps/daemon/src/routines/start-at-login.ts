import { execFile, spawn as nodeSpawn } from "node:child_process";
import { constants } from "node:fs";
import { type FileHandle, lstat, open, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
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

/** The daemon never edits the LaunchAgent or systemd unit itself: it runs the installed release's
 * own CLI with a fixed command, which takes the install lock, verifies the recorded configuration
 * and touches only the login job, so the running daemon cannot stop itself this way.
 */
export function startAtLoginPort(deps: StartAtLoginDeps): StartAtLoginPort {
  const identity = deps.identity;
  const platform = deps.platform ?? process.platform;
  if (!identity || (platform !== "darwin" && platform !== "linux")) return unavailableStartAtLogin;
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

// Public shell/package installs have install.env rather than the managed-release journal.
// Invoke their own installed command, with fixed arguments and no credentials in its environment.
export async function shellStartAtLoginPort(
  home: string,
  prefix: string | undefined,
  env: NodeJS.ProcessEnv,
  execute = promisify(execFile),
): Promise<StartAtLoginPort> {
  if (!prefix) return unavailableStartAtLogin;
  try {
    if ((await realpath(prefix)) !== prefix) return unavailableStartAtLogin;
    const file = join(prefix, "install.env");
    const stat = await lstat(file);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > 8192 ||
      stat.uid !== process.getuid?.() ||
      stat.mode & 0o022
    )
      return unavailableStartAtLogin;
    const text = await readFile(file, "utf8");
    if (
      !text.startsWith("# Managed by localDot's install.sh\n") ||
      !text.split("\n").includes(`LOCALDOT_HOME="${home}"`)
    )
      return unavailableStartAtLogin;
    const command = join(prefix, "bin", "localdot");
    const script = await lstat(command);
    if (
      !script.isFile() ||
      script.isSymbolicLink() ||
      script.uid !== process.getuid?.() ||
      script.mode & 0o022
    )
      return unavailableStartAtLogin;
    const run = async (operation: "status" | "on" | "off"): Promise<StartAtLoginState> => {
      try {
        const { stdout } = await execute(command, ["start-at-login", operation], {
          cwd: "/",
          timeout: 15_000,
          maxBuffer: 4096,
          env: { HOME: env.HOME ?? "", PATH: env.PATH ?? "/usr/bin:/bin", LOCALDOT_HOME: home },
        });
        const value = stdout.trim();
        if (value !== "on" && value !== "off") throw new Error("Unexpected startup state");
        return value;
      } catch {
        throw new StartAtLoginError(operation === "status" ? UNREADABLE : CHANGE_FAILED);
      }
    };
    return { status: () => run("status"), set: (enabled) => run(enabled ? "on" : "off") };
  } catch {
    return unavailableStartAtLogin;
  }
}

/** Development LaunchAgents have no installer receipt. Support only the two known jobs, after
 * verifying that their files belong to this user and actually launch this source daemon/home.
 * Changing disabled state affects the next login; it never stops the current task. */
export async function sourceStartAtLoginPort(
  home: string,
  env: NodeJS.ProcessEnv,
  node: string,
  cwd: string,
  execute = promisify(execFile),
): Promise<StartAtLoginPort> {
  if (process.platform !== "darwin" || env.XPC_SERVICE_NAME !== "dev.localdot.daemon" || !env.HOME)
    return unavailableStartAtLogin;
  const uid = process.getuid?.();
  if (uid === undefined) return unavailableStartAtLogin;
  const labels = ["dev.localdot.daemon", "dev.localdot.keyd"];
  const verify = async () => {
    for (const label of labels) {
      const file = join(env.HOME ?? "", "Library/LaunchAgents", `${label}.plist`);
      const stat = await lstat(file);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.uid !== uid ||
        stat.mode & 0o022 ||
        stat.size > 16384
      )
        throw new Error("Invalid login job");
      const { stdout } = await execute("/usr/bin/plutil", ["-convert", "json", "-o", "-", file], {
        timeout: 5000,
        maxBuffer: 16384,
      });
      const job = JSON.parse(stdout);
      if (
        job.Label !== label ||
        job.RunAtLoad !== true ||
        job.KeepAlive !== true ||
        !Array.isArray(job.ProgramArguments)
      )
        throw new Error("Invalid login job");
      if (label === labels[0]) {
        if (job.ProgramArguments[0] !== node || job.WorkingDirectory !== cwd)
          throw new Error("Different source installation");
      } else {
        const at = job.ProgramArguments.indexOf("-home");
        if (at < 0 || job.ProgramArguments[at + 1] !== home)
          throw new Error("Different key service");
      }
    }
  };
  try {
    await verify();
  } catch {
    return unavailableStartAtLogin;
  }
  const status = async (): Promise<StartAtLoginState> => {
    try {
      await verify();
      const { stdout } = await execute("/bin/launchctl", ["print-disabled", `gui/${uid}`], {
        timeout: 5000,
        maxBuffer: 65536,
      });
      if (!/disabled services\s*=\s*\{/.test(stdout)) throw new Error("Unrecognized launchd reply");
      return labels.some(
        (label) =>
          stdout.includes(`"${label}" => true`) || stdout.includes(`"${label}" => disabled`),
      )
        ? "off"
        : "on";
    } catch {
      throw new StartAtLoginError(UNREADABLE);
    }
  };
  return {
    status,
    async set(enabled) {
      try {
        await verify();
        for (const label of labels)
          await execute("/bin/launchctl", [enabled ? "enable" : "disable", `gui/${uid}/${label}`], {
            timeout: 5000,
            maxBuffer: 4096,
          });
        const actual = await status();
        if (actual !== (enabled ? "on" : "off")) throw new Error("Unconfirmed login state");
        return actual;
      } catch {
        throw new StartAtLoginError(CHANGE_FAILED);
      }
    },
  };
}
