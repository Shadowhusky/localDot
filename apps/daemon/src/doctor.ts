import { createServer } from "node:net";
import type { HairpinGuard, KeydStatus } from "@localdot/protocol";
import {
  compareApiVersions,
  DOCKER_API,
  type DockerClient,
  DockerError,
  type DockerVersion,
} from "./cells/docker.ts";
import type { Images } from "./cells/images.ts";
import { imageVerdict } from "./doctor-image.ts";
import { runDoctorNetworkProbe } from "./doctor-network.ts";
import type { DockerSocket } from "./doctor-socket.ts";
import type { KeydClient } from "./keyd/client.ts";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}

export interface DoctorDeps {
  docker: DockerClient;
  images: Images;
  port: number;
  // How docker.socketPath was found, for the docker-socket check.
  socket?: DockerSocket;
  // Docker tests name their probe localdot-test-*.
  probeNetwork?: string;
  signal?: AbortSignal;
  // How long the first /version may take before the socket counts as not answering.
  versionDeadlineMs?: number;
  keyd?: Pick<KeydClient, "status">;
}

// Isolated gateway mode for internal networks shipped with Engine 28; S3 verified it on 29.2.
export const MIN_ENGINE_MAJOR = 28;
const ENGINE_CHECKS = ["docker-engine", "isolated-gateway-mode", "image-desktop", "image-gate"];
const TIMED_OUT = Symbol("timed out");

export async function runDoctor(deps: DoctorDeps): Promise<DoctorReport> {
  if (deps.signal?.aborted)
    return {
      ok: false,
      checks: [{ name: "interrupted", ok: false, detail: "Diagnostics interrupted." }],
    };
  const checks = await dockerChecks(deps);
  if (deps.signal?.aborted) return { ok: false, checks };
  checks.push(await portCheck(deps.port), ...(deps.keyd ? await keydChecks(deps.keyd) : []));
  return { ok: !deps.signal?.aborted && checks.every((c) => c.ok), checks };
}

async function keydChecks(keyd: Pick<KeydClient, "status">): Promise<DoctorCheck[]> {
  let status: KeydStatus;
  try {
    status = await keyd.status();
  } catch (err) {
    return [
      { name: "keyd", ok: false, detail: `${messageOf(err)}; start keyd (pnpm keyd)` },
      ...skipped(["hairpin-guard"]),
    ];
  }
  const { audit } = status;
  const held = `; its audit log fails, so it holds every key back: ${audit.error ?? "no reason given"}`;
  return [
    {
      name: "keyd",
      ok: audit.ok,
      detail: `boot ${status.bootId}, version ${status.version}${audit.ok ? "" : held}`,
    },
    hairpinCheck(status.hairpin ?? { state: "unknown", addresses: 0 }),
  ];
}

// Hairpin NAT: a computer that can reach this network's public address reaches the router's own
// services through it, unless keyd knows that address and denies it.
function hairpinCheck(guard: HairpinGuard): DoctorCheck {
  const name = "hairpin-guard";
  if (guard.state === "active") {
    const source = guard.source ?? "an unnamed source";
    return {
      name,
      ok: true,
      detail: `active: keyd denies this network's public address (from ${source})`,
    };
  }
  if (guard.state === "off") {
    return {
      name,
      ok: false,
      detail:
        "off: keyd asks neither the router nor STUN for the public address (-natpmp off -stun off)",
    };
  }
  const why = guard.error ? `: ${guard.error}` : "";
  return {
    name,
    ok: false,
    detail: `unknown: keyd has not learned this network's public address and keeps asking${why}`,
  };
}

async function dockerChecks({
  docker,
  images,
  socket,
  probeNetwork,
  signal,
  versionDeadlineMs = 10_000,
}: DoctorDeps): Promise<DoctorCheck[]> {
  let v: DockerVersion;
  try {
    const answer = await withDeadline(docker.version(), versionDeadlineMs);
    if (answer === TIMED_OUT) {
      const detail = `not answering on ${located(docker, socket)} after ${versionDeadlineMs / 1000} s`;
      return [{ name: "docker-socket", ok: false, detail }, ...skipped(ENGINE_CHECKS)];
    }
    v = answer;
  } catch (err) {
    if (!(err instanceof DockerError && err.status === 400)) {
      const detail = `${located(docker, socket)}: ${messageOf(err)}`;
      return [{ name: "docker-socket", ok: false, detail }, ...skipped(ENGINE_CHECKS)];
    }
    // Docker Desktop answers /version at an API version the engine refuses with a 400 and no
    // message; the unversioned path still says which versions the engine serves.
    const served = await docker.engineVersion().catch(() => undefined);
    const engine = served?.ApiVersion
      ? `Engine ${served.Version}, API ${served.MinAPIVersion}–${served.ApiVersion}`
      : "answered with HTTP 400";
    return [
      socketCheck(docker, socket, engine),
      { name: "docker-engine", ok: false, detail: refusedApi(served) },
      ...skipped(ENGINE_CHECKS.slice(1)),
    ];
  }
  const major = Number(v.Version.split(".")[0]);
  const checks = [
    socketCheck(docker, socket, `Engine ${v.Version}, API ${v.ApiVersion}`),
    {
      name: "docker-engine",
      ok: major >= MIN_ENGINE_MAJOR,
      detail:
        major >= MIN_ENGINE_MAJOR
          ? `Engine ${v.Version}`
          : `Engine ${v.Version}; ${MIN_ENGINE_MAJOR}+ is required`,
    },
    {
      name: "isolated-gateway-mode",
      ...(await runDoctorNetworkProbe(docker.socketPath, probeNetwork, signal)),
    },
  ];
  if (signal?.aborted) return [...checks, ...skipped(["image-desktop", "image-gate"])];
  return [
    ...checks,
    await imageCheck(docker, "image-desktop", images.desktop, "cells/desktop/build.sh", v),
    await imageCheck(docker, "image-gate", images.gate, "cells/gate/build.sh", v),
  ];
}

// The daemon finds its socket the same way (findDockerSocket), so any socket that answers will do.
function socketCheck(
  docker: DockerClient,
  socket: DockerSocket | undefined,
  engine: string,
): DoctorCheck {
  return { name: "docker-socket", ok: true, detail: located(docker, socket, engine) };
}

function located(docker: DockerClient, socket?: DockerSocket, engine?: string): string {
  const notes = [socket?.source, engine].filter((note) => note !== undefined);
  return notes.length > 0 ? `${docker.socketPath} (${notes.join("; ")})` : docker.socketPath;
}

function refusedApi(served: DockerVersion | undefined): string {
  const api = DOCKER_API.slice(1);
  if (served?.ApiVersion && served.MinAPIVersion) {
    const serves = `it serves API ${served.MinAPIVersion}–${served.ApiVersion} and localdot speaks ${api}`;
    if (compareApiVersions(served.ApiVersion, api) < 0) {
      return `Docker Engine ${served.Version} is too old: ${serves}; update Docker Desktop (Engine ${MIN_ENGINE_MAJOR}+)`;
    }
    if (compareApiVersions(served.MinAPIVersion, api) > 0) {
      return `Docker Engine ${served.Version} is too new: ${serves}; update localdot`;
    }
  }
  return `Docker refused API ${api}, the version localdot speaks (HTTP 400 on /version)`;
}

function skipped(names: string[]): DoctorCheck[] {
  return names.map((name) => ({ name, ok: false, detail: "skipped" }));
}

async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

async function imageCheck(
  docker: DockerClient,
  name: string,
  image: string,
  buildScript: string,
  engine: DockerVersion,
): Promise<DoctorCheck> {
  try {
    const inspection = await docker.request<unknown>({
      method: "GET",
      path: `/images/${encodeURIComponent(image)}/json`,
    });
    return { name, ...imageVerdict(image, engine, inspection) };
  } catch (err) {
    if (err instanceof DockerError && err.status === 404) {
      return { name, ok: false, detail: `${image} is missing: build it with ${buildScript}` };
    }
    return { name, ok: false, detail: messageOf(err) };
  }
}

function portCheck(port: number): Promise<DoctorCheck> {
  const name = `port-${port}`;
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", (err: NodeJS.ErrnoException) => {
      resolve({
        name,
        ok: false,
        detail:
          err.code === "EADDRINUSE"
            ? `127.0.0.1:${port} is in use (a localdot daemon may be running)`
            : err.message,
      });
    });
    probe.listen(port, "127.0.0.1", () =>
      probe.close(() => resolve({ name, ok: true, detail: `127.0.0.1:${port} is free` })),
    );
  });
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
