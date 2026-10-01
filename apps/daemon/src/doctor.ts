import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import {
  compareApiVersions,
  DOCKER_API,
  type DockerClient,
  DockerError,
  type DockerVersion,
} from "./cells/docker.ts";
import type { Images } from "./cells/images.ts";
import { ISOLATED_GATEWAY_OPTION, isolatedNetworkSpec } from "./cells/spec.ts";
import type { DockerSocket } from "./doctor-socket.ts";

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
}

// Isolated gateway mode for internal networks shipped with Engine 28; S3 verified it on 29.2.
export const MIN_ENGINE_MAJOR = 28;
const PROBE_NETWORK = "localdot-doctor-probe";
const ENGINE_CHECKS = ["docker-engine", "isolated-gateway-mode", "image-desktop", "image-gate"];

export async function runDoctor(deps: DoctorDeps): Promise<DoctorReport> {
  const checks = [...(await dockerChecks(deps)), await portCheck(deps.port)];
  return { ok: checks.every((c) => c.ok), checks };
}

async function dockerChecks({
  docker,
  images,
  socket,
  probeNetwork,
}: DoctorDeps): Promise<DoctorCheck[]> {
  let v: DockerVersion;
  try {
    v = await docker.version();
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
  return [
    socketCheck(docker, socket, `Engine ${v.Version}, API ${v.ApiVersion}`),
    {
      name: "docker-engine",
      ok: major >= MIN_ENGINE_MAJOR,
      detail:
        major >= MIN_ENGINE_MAJOR
          ? `Engine ${v.Version}`
          : `Engine ${v.Version}; ${MIN_ENGINE_MAJOR}+ is required`,
    },
    await isolatedGatewayCheck(
      docker,
      // A random suffix: a probe left behind by a crashed run must not make every later run a 409.
      probeNetwork ?? `${PROBE_NETWORK}-${randomBytes(4).toString("hex")}`,
    ),
    await imageCheck(docker, "image-desktop", images.desktop, "cells/desktop/build.sh"),
    await imageCheck(docker, "image-gate", images.gate, "cells/gate/build.sh"),
  ];
}

function socketCheck(
  docker: DockerClient,
  socket: DockerSocket | undefined,
  engine: string,
): DoctorCheck {
  const detail = located(docker, socket, engine);
  return socket?.fix
    ? { name: "docker-socket", ok: false, detail: `${detail}, but ${socket.fix}` }
    : { name: "docker-socket", ok: true, detail };
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

async function isolatedGatewayCheck(docker: DockerClient, probe: string): Promise<DoctorCheck> {
  const name = "isolated-gateway-mode";
  let result: DoctorCheck;
  try {
    // No localdot.cell label, so nothing that looks for cells ever finds the probe.
    const created = await docker.request<{ Id: string }>({
      method: "POST",
      path: "/networks/create",
      body: isolatedNetworkSpec(probe),
    });
    const info = await docker.request<{
      Options?: Record<string, string>;
      IPAM: { Config: { Gateway?: string }[] };
    }>({ method: "GET", path: `/networks/${encodeURIComponent(created.Id)}` });
    // The API serializes an unset gateway as "" (or leaves it out); the CLI prints "invalid IP".
    const raw = info.IPAM.Config[0]?.Gateway;
    const gateway = raw && raw !== "invalid IP" ? raw : undefined;
    const honoured = info.Options?.[ISOLATED_GATEWAY_OPTION] === "isolated" && !gateway;
    result = {
      name,
      ok: honoured,
      detail: honoured
        ? "internal networks get no gateway address"
        : `the engine still assigns a gateway (${gateway ?? "option dropped"}) to an isolated internal network`,
    };
  } catch (err) {
    result = { name, ok: false, detail: messageOf(err) };
  }
  // By name, and whatever happened above: a create whose reply was lost may still have made it.
  const leftover = await docker
    .request({ method: "DELETE", path: `/networks/${encodeURIComponent(probe)}` })
    .then(
      () => undefined,
      (err: unknown) => (err instanceof DockerError && err.status === 404 ? undefined : err),
    );
  if (leftover === undefined) return result;
  return {
    name,
    ok: false,
    detail: `${result.detail}; could not remove the probe network (docker network rm ${probe}): ${messageOf(leftover)}`,
  };
}

async function imageCheck(
  docker: DockerClient,
  name: string,
  image: string,
  buildScript: string,
): Promise<DoctorCheck> {
  try {
    await docker.request({ method: "GET", path: `/images/${encodeURIComponent(image)}/json` });
    return { name, ok: true, detail: image };
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
