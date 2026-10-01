import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { dockerSocketPath } from "./cells/docker.ts";

export interface DockerSocket {
  path: string;
  source: string;
  // Set when the daemon, which reads only DOCKER_HOST and the default path, would not find Docker.
  fix?: string;
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
): DockerSocket {
  const path = dockerSocketPath(env);
  const fromEnv = path !== dockerSocketPath({});
  const source = fromEnv ? "DOCKER_HOST" : "the default socket";
  if (probes.exists(path)) return { path, source };
  // With Docker Desktop's "Allow the default Docker socket to be used" off, /var/run/docker.sock is
  // missing and only the CLI's context knows where the engine listens.
  for (const found of otherSockets(env, probes)) {
    if (found.path === path || !probes.exists(found.path)) continue;
    const set = `set DOCKER_HOST=unix://${found.path}`;
    const remedy = fromEnv
      ? set
      : `turn on "Allow the default Docker socket to be used" in Docker Desktop's Settings › Advanced, or ${set}`;
    return { ...found, fix: `localdot looks for ${path} (${source}), which is missing: ${remedy}` };
  }
  return { path, source };
}

function otherSockets(env: NodeJS.ProcessEnv, probes: SocketProbes): DockerSocket[] {
  const context = probes.context();
  const fromContext = context?.host.startsWith("unix://")
    ? [{ path: context.host.slice("unix://".length), source: `the docker context ${context.name}` }]
    : [];
  const userSocket = join(env.HOME || homedir(), ".docker", "run", "docker.sock");
  return [...fromContext, { path: userSocket, source: "Docker Desktop's user socket" }];
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
