import { closeSync, fstatSync, openSync, readFileSync, readSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { MAIN_DOT_ID } from "../../../packages/protocol/src/dots.ts";
import { DockerClient } from "../../daemon/src/cells/docker.ts";
import { displayLogLine } from "../../daemon/src/daemon-log.ts";
import { findDockerSocket } from "../../daemon/src/doctor-socket.ts";
import { dotName, instanceOf } from "../../daemon/src/dots/instance.ts";
import { DotsRegistry, registryPath } from "../../daemon/src/dots/registry.ts";
import { parsePublicOrigins } from "../../daemon/src/guard.ts";
import { readInstallToken } from "../../daemon/src/install-token-reader.ts";
import { KeydClient, keydSocketPath } from "../../daemon/src/keyd/client.ts";
import { lockHolder } from "../../daemon/src/lock.ts";
import { runOpenLink } from "../../daemon/src/open-link.ts";
import { startDockerDesktop } from "../../daemon/src/platform/docker-start.ts";
import { terminalText } from "./chat.ts";
import { type DotServices, exec, hostServices } from "./dots/services.ts";
import { resolveCommandContext } from "./install/command-context.ts";
import { runDown } from "./install/down.ts";
import { runUp } from "./install/up.ts";
import type { CommandContextInput, ConsoleIO } from "./runtime.ts";
import { runStopComputers } from "./stop-computers.ts";

// A failure whose message says what happened and the next step; printed as it is.
export class CommandError extends Error {}
export function fail(message: string): never {
  throw new CommandError(message);
}

export class LocalApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type LocalApi = <T = unknown>(
  method: "GET" | "POST" | "PUT",
  path: string,
  body?: unknown,
  timeoutMs?: number,
) => Promise<T>;

// Whether the app on this port answers: stopped when nothing listens there at all.
export type AppState = "running" | "not-answering" | "stopped";

export async function appState(port: number, fetchImpl: typeof fetch = fetch): Promise<AppState> {
  try {
    const reply = await fetchImpl(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(3000),
      redirect: "error",
      cache: "no-store",
    });
    return reply.ok && (await reply.text()) === "ok" ? "running" : "not-answering";
  } catch (error) {
    return (error as { cause?: { code?: unknown } }).cause?.code === "ECONNREFUSED"
      ? "stopped"
      : "not-answering";
  }
}

const REPLY_LIMIT = 1024 * 1024;

async function replyText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > REPLY_LIMIT) throw new Error("Reply too large");
      chunks.push(part.value);
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

// The app's own API on loopback, with the install token read from its private home.
export function localApi(
  home: string,
  port: number,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): LocalApi {
  const token = readInstallToken(home);
  return async <T>(
    method: "GET" | "POST" | "PUT",
    path: string,
    body?: unknown,
    timeoutMs = 15_000,
  ) => {
    const response = await fetchImpl(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
    });
    const text = await replyText(response);
    if (!response.ok)
      throw new LocalApiError(
        response.status,
        terminalText(text).trim().slice(0, 240) || `The app answered ${response.status}.`,
      );
    return (text ? JSON.parse(text) : undefined) as T;
  };
}

export type KeydState = "ready" | "locked" | "down";
export type LockName = "daemon" | "keyd";

// One localDot (one dot) on this computer, as the commands see and act on it.
export interface LocalDot {
  home: string;
  port: number;
  signal: AbortSignal;
  // The dot's id, which names its services; "main" for the installation's own.
  dot: string;
  // What messages call it: localDot, or another dot's own name.
  name: string;
  // " --dot <id>" for another dot, so a suggested command acts on the same one.
  dotFlag: string;
  // A release-managed installation, whose services the install journal owns.
  managed: boolean;
  // launchd agents or systemd user units; absent where localdot can't manage either.
  services?: DotServices;
  publicOrigins: readonly URL[];
  app(): Promise<AppState>;
  api(): LocalApi;
  lockHolder(lock: LockName): number | undefined;
  removeLock(lock: LockName): void;
  command(pid: number): Promise<string | undefined>;
  // The program listening on the app's port on loopback, when one is.
  listener(): Promise<{ pid: number; command: string } | undefined>;
  kill(pid: number, signal: NodeJS.Signals): void;
  keyd(): Promise<KeydState>;
  docker(): Promise<boolean>;
  startDocker(): Promise<boolean>;
  // A packaged installer at work right now: its process id.
  installer(): number | undefined;
  stopComputers(): Promise<boolean>;
  managedDown(io: ConsoleIO): Promise<number>;
  managedUp(io: ConsoleIO): Promise<number>;
  signIn(io: ConsoleIO): Promise<number>;
  logTail(log: LockName): string[];
  sleep(ms: number): Promise<void>;
  now(): number;
}

export function notRunning(l: LocalDot, state: AppState): string {
  return state === "stopped"
    ? `${l.name} isn't running. Start it with: localdot up${l.dotFlag}`
    : `${l.name} isn't answering on port ${l.port}. Restart it with: localdot restart${l.dotFlag}`;
}

// The app's API, once it answers; otherwise the step that gets it answering.
export async function connect(l: LocalDot): Promise<LocalApi> {
  const state = await l.app();
  if (state !== "running") fail(notRunning(l, state));
  try {
    return l.api();
  } catch {
    return fail(
      `localdot couldn't read ${l.name}'s access token in ${l.home}. That folder must be yours and private (chmod 700).`,
    );
  }
}

const silent: ConsoleIO = { out: () => {}, err: () => {} };

async function processCommand(pid: number): Promise<string | undefined> {
  const result = await exec("ps", ["-o", "command=", "-p", String(pid)]);
  const command = terminalText(result.stdout).trim();
  return result.code === 0 && command ? command.slice(0, 200) : undefined;
}

// The last lines of one of a dot's service logs, made safe to show.
function tail(file: string, lines = 8): string[] {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const size = fstatSync(fd).size;
    const length = Math.min(size, 16 * 1024);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer
      .toString("utf8")
      .split("\n")
      .slice(length < size ? 1 : 0)
      .filter((line) => line.trim())
      .slice(-lines)
      .map(displayLogLine);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function packageInstaller(env: NodeJS.ProcessEnv): number | undefined {
  try {
    const location = readFileSync(
      join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "localdot", "install-location"),
      "utf8",
    );
    const prefix = /^LOCALDOT_PREFIX="([^"\n]+)"$/m.exec(location)?.[1];
    return prefix ? lockHolder(join(prefix, ".package-install.lock", "pid")) : undefined;
  } catch {
    return undefined;
  }
}

export async function hostLocalDot(input: CommandContextInput): Promise<LocalDot> {
  const context = await resolveCommandContext(input);
  const { home, env, signal, port } = context;
  let services: DotServices | undefined;
  try {
    services = hostServices(process.platform, env);
  } catch {}
  let dot = MAIN_DOT_ID;
  try {
    dot =
      new DotsRegistry(registryPath(env), home).read().find((entry) => entry.home === home)?.id ??
      MAIN_DOT_ID;
  } catch {}
  let publicOrigins: URL[] = [];
  try {
    publicOrigins = parsePublicOrigins(env.LOCALDOT_PUBLIC_ORIGIN || undefined);
  } catch {}
  const locks = { daemon: join(home, "daemon.lock"), keyd: join(home, "keyd", "keyd.lock") };
  return {
    home,
    port,
    signal,
    dot,
    name: dot === MAIN_DOT_ID ? "localDot" : dotName(home, instanceOf(home).name),
    dotFlag: dot === MAIN_DOT_ID ? "" : ` --dot ${dot}`,
    managed: !!context.installed,
    services,
    publicOrigins,
    app: () => appState(port),
    api: () => localApi(home, port, signal),
    lockHolder: (lock) => lockHolder(locks[lock]),
    removeLock: (lock) => rmSync(locks[lock], { force: true }),
    command: processCommand,
    async listener() {
      const result = await exec("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpn"]);
      let pid: number | undefined;
      for (const line of result.stdout.split("\n")) {
        if (line.startsWith("p")) pid = Number(line.slice(1));
        else if (
          pid &&
          /^n(?:\*|127\.\d+\.\d+\.\d+|\[::1?\]|localhost):\d+$/.test(line) &&
          Number.isSafeInteger(pid)
        )
          return { pid, command: (await processCommand(pid)) ?? "another program" };
      }
      return undefined;
    },
    kill(pid, name) {
      try {
        process.kill(pid, name);
      } catch {}
    },
    async keyd() {
      try {
        const state = (await new KeydClient(keydSocketPath(home), 3000).status()).vault?.state;
        return state === undefined || state === "ready" ? "ready" : "locked";
      } catch {
        return "down";
      }
    },
    async docker() {
      try {
        await new DockerClient(findDockerSocket(env).path).checkReady(3000);
        return true;
      } catch {
        return false;
      }
    },
    async startDocker() {
      try {
        return await startDockerDesktop(findDockerSocket(env).path);
      } catch {
        return false;
      }
    },
    installer: () => packageInstaller(env),
    stopComputers: async () => (await runStopComputers({ home, port, env, signal }, silent)) === 0,
    managedDown: (io) => runDown({ home, signal }, io),
    managedUp: (io) => runUp({ home, signal }, io),
    signIn: (io) => runOpenLink({ home, port, signal, publicOrigins }, io),
    logTail: (log) => tail(join(home, "logs", `${log}.log`)),
    sleep: (ms) => delay(ms, undefined, { signal }),
    now: Date.now,
  };
}
