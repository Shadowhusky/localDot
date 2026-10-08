import { constants } from "node:fs";
import { access, lstat, realpath, statfs } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { readHostCommand } from "./host-command.ts";
import { readHostDockerFacts } from "./host-docker-facts.ts";
import type { DockerFacts, InstallPreflightProbes } from "./preflight.ts";

const containsControl = (value: string): boolean =>
  [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);

/** Check an existing parent without creating the app home or following a user-controlled link. */
export async function availableInstallDisk(home: string, signal: AbortSignal): Promise<bigint> {
  signal.throwIfAborted();
  if (!isAbsolute(home) || normalize(home) !== home || home === "/" || containsControl(home))
    throw new Error("Invalid install home");
  let parent = home;
  for (;;) {
    try {
      const value = await lstat(parent);
      if (
        !value.isDirectory() ||
        value.isSymbolicLink() ||
        value.uid !== process.getuid?.() ||
        (value.mode & 0o022) !== 0
      )
        throw new Error("Unsafe install parent");
      // /var is an OS alias on macOS; canonicalize only before callers form a persistent layout.
      // User-controlled ancestor links are rejected by inspecting every lexical component below.
      let ancestor = parent;
      while (ancestor !== dirname(ancestor)) {
        const st = await lstat(ancestor);
        if (
          st.isSymbolicLink() &&
          !(ancestor === "/var" && (await realpath(ancestor)) === "/private/var")
        )
          throw new Error("Linked install ancestor");
        ancestor = dirname(ancestor);
      }
      await access(parent, constants.W_OK | constants.X_OK);
      const disk = await statfs(parent, { bigint: true });
      signal.throwIfAborted();
      return disk.bavail * disk.bsize;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const next = dirname(parent);
      if (next === parent) throw new Error("Missing install parent");
      parent = next;
    }
  }
}

function unixSocket(host: string): string {
  if (!host.startsWith("unix:///")) throw new Error("Remote Docker host unsupported");
  const path = host.slice(7);
  if (!isAbsolute(path) || normalize(path) !== path || containsControl(path) || /[?#]/.test(path))
    throw new Error("Invalid Docker socket");
  return path;
}
async function socketExists(path: string): Promise<boolean> {
  try {
    return (await lstat(await realpath(path))).isSocket();
  } catch {
    return false;
  }
}
export async function installDockerSocket(
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  if (env.DOCKER_HOST !== undefined) {
    const path = unixSocket(env.DOCKER_HOST);
    if (!(await socketExists(path))) throw new Error("Configured Docker socket unavailable");
    return path;
  }
  try {
    const result = await readHostCommand({ kind: "docker-context", env }, signal);
    const contexts: unknown = JSON.parse(result);
    if (!Array.isArray(contexts) || contexts.length !== 1)
      throw new Error("Invalid Docker context");
    const host: unknown = contexts[0]?.Endpoints?.docker?.Host;
    if (typeof host !== "string") throw new Error("Missing Docker context endpoint");
    const path = unixSocket(host);
    if (!(await socketExists(path))) throw new Error("Docker context socket unavailable");
    return path;
  } catch (error) {
    signal.throwIfAborted();
    // A valid context selecting a remote or absent endpoint must never fall back to another engine.
    if (
      !(error && typeof error === "object" && "code" in error && error.code === "ENOENT") ||
      env.DOCKER_CONTEXT
    )
      throw error;
  }
  for (const path of [join(homedir(), ".docker/run/docker.sock"), "/var/run/docker.sock"])
    if (await socketExists(path)) return path;
  throw new Error("Docker Desktop is not available");
}

export function installHostProbes(
  env: NodeJS.ProcessEnv = process.env,
  onDockerSocket?: (socket: string) => void,
): InstallPreflightProbes {
  return {
    async host(signal) {
      signal.throwIfAborted();
      const base = {
        platform: process.platform,
        architecture: process.arch,
        nodeVersion: process.versions.node,
      };
      if (base.platform !== "darwin") return base;
      const result = await readHostCommand({ kind: "macos" }, signal);
      return { ...base, macOSVersion: result.trim() };
    },
    availableDisk: availableInstallDisk,
    async docker(signal): Promise<DockerFacts> {
      const socket = await installDockerSocket(env, signal);
      const facts = await readHostDockerFacts(socket, signal);
      signal.throwIfAborted();
      onDockerSocket?.(socket);
      return facts;
    },
  };
}
