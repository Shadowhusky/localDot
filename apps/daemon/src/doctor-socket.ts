import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { dockerSocketPath } from "./cells/docker.ts";

export interface DockerSocket {
  path: string;
  source: string;
}

export interface DockerContext {
  name: string;
  host: string;
}

export interface SocketProbes {
  exists(path: string): boolean;
  context(): DockerContext | undefined;
}

export function findDockerSocket(
  env: NodeJS.ProcessEnv = process.env,
  probes: SocketProbes = hostProbes(env),
  platform: NodeJS.Platform = process.platform,
): DockerSocket {
  const path = dockerSocketPath(env);
  const fromEnv = env.DOCKER_HOST !== undefined;
  const source = fromEnv ? "DOCKER_HOST" : "the default socket";
  // An installer-selected engine must remain selected even when its socket disappears. Falling
  // back could send cell tokens or lifecycle operations to an unrelated Docker engine.
  if (fromEnv) return { path, source };
  if (probes.exists(path)) return { path, source };
  // With Docker Desktop's "Allow the default Docker socket to be used" off, /var/run/docker.sock is
  // missing and only the CLI's context knows where the engine listens.
  for (const found of otherSockets(env, probes, platform)) {
    if (found.path !== path && probes.exists(found.path)) return found;
  }
  return { path, source };
}

function otherSockets(
  env: NodeJS.ProcessEnv,
  probes: SocketProbes,
  platform: NodeJS.Platform,
): DockerSocket[] {
  const context = probes.context();
  const fromContext = context?.host.startsWith("unix://")
    ? [{ path: context.host.slice("unix://".length), source: `the docker context ${context.name}` }]
    : [];
  const home = env.HOME || homedir();
  if (platform !== "linux")
    return [
      ...fromContext,
      { path: join(home, ".docker", "run", "docker.sock"), source: "Docker Desktop's user socket" },
    ];
  const runtime = env.XDG_RUNTIME_DIR;
  return [
    ...fromContext,
    ...(runtime && isAbsolute(runtime)
      ? [{ path: join(runtime, "docker.sock"), source: "rootless Docker's socket" }]
      : []),
    {
      path: join(home, ".docker", "desktop", "docker.sock"),
      source: "Docker Desktop's user socket",
    },
  ];
}

export function hostProbes(env: NodeJS.ProcessEnv): SocketProbes {
  return { exists: existsSync, context: () => cliContext(env) };
}

function cliContext(env: NodeJS.ProcessEnv): DockerContext | undefined {
  const r = spawnSync("docker", ["context", "inspect"], { env, encoding: "utf8", timeout: 5_000 });
  if (r.status !== 0) return undefined;
  try {
    const [context] = JSON.parse(r.stdout) as {
      Name?: unknown;
      Endpoints?: { docker?: { Host?: unknown } };
    }[];
    const name = context?.Name;
    const host = context?.Endpoints?.docker?.Host;
    return typeof name === "string" && typeof host === "string" ? { name, host } : undefined;
  } catch {
    return undefined;
  }
}
