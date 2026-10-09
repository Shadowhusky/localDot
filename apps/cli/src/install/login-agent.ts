import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  type ServiceConfiguration,
  StartAtLoginRecord,
} from "../../../../packages/protocol/src/install-services.ts";
import { privateRecordStore } from "./private-record.ts";
import { runLoginAgentBootout, runLoginUnit } from "./service-command.ts";
import {
  defineLoginService,
  loginServiceLocation,
  type ServiceManager,
  serviceManager,
} from "./service-definition.ts";

const unsafe = () => new Error("Start at login could not be changed safely.");
const missing = (e: unknown) => e instanceof Error && "code" in e && e.code === "ENOENT";

export interface LoginAgentHost {
  readonly manager: ServiceManager;
  read(path: string): Promise<string | null>;
  write(directory: string, path: string, contents: string): Promise<void>;
  remove(path: string): Promise<void>;
  // launchd finds a written agent at the next login by itself; systemd needs the unit enabled.
  activate(target: string, signal: AbortSignal): Promise<void>;
  bootout(target: string, signal: AbortSignal): Promise<void>;
}

export function startAtLoginStore(state: string) {
  return privateRecordStore(state, "start-at-login.json", StartAtLoginRecord);
}

export function nodeLoginAgentHost(
  uid: number,
  manager: ServiceManager = serviceManager(),
): LoginAgentHost {
  const owned = async (path: string) => {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== uid || info.nlink !== 1)
      throw unsafe();
  };
  const directoryReady = async (directory: string) => {
    try {
      const info = await lstat(directory);
      const real = info.isSymbolicLink() ? await lstat(await realpath(directory)) : info;
      if (!real.isDirectory() || real.uid !== uid || (real.mode & 0o022) !== 0) throw unsafe();
    } catch (e) {
      if (!missing(e)) throw e;
      await mkdir(directory, { recursive: true, mode: 0o755 });
    }
  };
  return {
    manager,
    async read(path) {
      try {
        await owned(path);
      } catch (e) {
        if (missing(e)) return null;
        throw e;
      }
      const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        return await fd.readFile("utf8");
      } finally {
        await fd.close();
      }
    },
    async write(directory, path, contents) {
      await directoryReady(directory);
      try {
        await owned(path);
      } catch (e) {
        if (!missing(e)) throw unsafe();
      }
      const temporary = join(directory, `.${process.pid}.${Date.now()}.localdot-login.tmp`);
      const fd = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await fd.writeFile(contents, "utf8");
        await fd.sync();
      } finally {
        await fd.close();
      }
      await rename(temporary, path);
    },
    async remove(path) {
      try {
        await owned(path);
      } catch (e) {
        if (missing(e)) return;
        throw e;
      }
      await rm(path);
    },
    async activate(target, signal) {
      if (manager === "systemd" && (await runLoginUnit("enable", target, uid, signal)).code !== 0)
        throw unsafe();
    },
    async bootout(target, signal) {
      if (manager === "systemd") {
        if ((await runLoginUnit("disable", target, uid, signal)).code !== 0) throw unsafe();
        return;
      }
      const result = await runLoginAgentBootout(target, signal);
      if (![0, 3, 113].includes(result.code)) throw unsafe();
    },
  };
}

export async function syncLoginAgent(
  configuration: ServiceConfiguration,
  host: LoginAgentHost,
  signal: AbortSignal,
): Promise<"on" | "off"> {
  signal.throwIfAborted();
  const record = await startAtLoginStore(configuration.settings.state).read();
  if (!record?.enabled) {
    const location = loginServiceLocation(configuration.settings, host.manager);
    if ((await host.read(location.file)) !== null) {
      // systemd disables a unit only while its file is there; launchd unloads by label.
      if (host.manager === "systemd") await host.bootout(location.target, signal);
      await host.remove(location.file);
      if (host.manager === "launchd") await host.bootout(location.target, signal);
    }
    return "off";
  }
  const login = defineLoginService(configuration.settings, configuration.release, host.manager);
  try {
    if ((await host.read(login.file)) !== login.contents)
      await host.write(login.directory, login.file, login.contents);
  } catch {
    throw unsafe();
  }
  signal.throwIfAborted();
  await host.activate(login.target, signal);
  return "on";
}

/** Only writes (and on systemd enables) the login job; it runs at the next login. Starting it now
 * would run `up --from-login` at once and contend for the install lock the caller holds.
 */
export async function setStartAtLogin(
  configuration: ServiceConfiguration,
  enabled: boolean,
  host: LoginAgentHost,
  signal: AbortSignal,
  now: () => Date = () => new Date(),
): Promise<"on" | "off"> {
  signal.throwIfAborted();
  await startAtLoginStore(configuration.settings.state).save({
    v: 1,
    enabled,
    changedAt: now().toISOString(),
  });
  return syncLoginAgent(configuration, host, signal);
}
