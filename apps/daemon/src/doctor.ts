import { createServer } from "node:net";
import { join } from "node:path";
import type { HairpinGuard, KeydStatus, KeydVault } from "@localdot/protocol";
import {
  compareApiVersions,
  DOCKER_API,
  type DockerClient,
  DockerError,
  type DockerVersion,
} from "./cells/docker.ts";
import type { Images } from "./cells/images.ts";
import { gateRelay } from "./cells/relay.ts";
import { imageVerdict } from "./doctor-image.ts";
import { runDoctorNetworkProbe } from "./doctor-network.ts";
import { type RelayProbeDeps, type RelayVerdict, runRelayProbe } from "./doctor-relay.ts";
import type { DockerSocket } from "./doctor-socket.ts";
import type { KeydClient } from "./keyd/client.ts";
import { lockHolder } from "./lock.ts";
import {
  dockerRuntime,
  dockerRuntimeChecks,
  isolationFix,
  socketFix,
} from "./platform/docker-runtime.ts";
import { detectHost, type HostPlatform, hostChecks } from "./platform/host.ts";

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
  // The daemon's home: when its own daemon is running, the port is in use by localDot itself.
  home?: string;
  // This machine; detected when absent.
  host?: HostPlatform;
  relayProbe?: (deps: RelayProbeDeps) => Promise<RelayVerdict>;
}

// Isolated gateway mode for internal networks shipped with Engine 28; S3 verified it on 29.2.
export const MIN_ENGINE_MAJOR = 28;
const ENGINE_CHECKS = ["docker-engine", "isolated-gateway-mode", "image-desktop", "image-gate"];
// Off macOS a test computer also checks that it can reach keyd, given a home to find it in.
const engineChecks = (host: HostPlatform, home: string | undefined) =>
  host.os === "macos" || !home ? ENGINE_CHECKS : [...ENGINE_CHECKS, "gate-relay"];
const TIMED_OUT = Symbol("timed out");

export async function runDoctor(deps: DoctorDeps): Promise<DoctorReport> {
  if (deps.signal?.aborted)
    return {
      ok: false,
      checks: [{ name: "interrupted", ok: false, detail: "Diagnostics interrupted." }],
    };
  const host = deps.host ?? detectHost();
  const checks = [...hostChecks(host), ...(await dockerChecks(deps, host))];
  if (deps.signal?.aborted) return { ok: false, checks };
  checks.push(
    await portCheck(deps.port, deps.home),
    ...(deps.keyd ? await keydChecks(deps.keyd) : []),
  );
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
    ...(status.vault && status.vault.backend !== "keychain" ? [vaultCheck(status.vault)] : []),
  ];
}

// Where saved keys live off macOS, and what to do when they wait for a passphrase.
export function vaultCheck(vault: KeydVault): DoctorCheck {
  const name = "key-vault";
  if (vault.state === "setup")
    return {
      name,
      ok: false,
      detail:
        "No keyring here, so saved keys go in an encrypted file. Choose its passphrase: localdot unlock",
    };
  if (vault.state === "locked")
    return {
      name,
      ok: false,
      detail: "Saved keys are locked since this machine restarted. Unlock them: localdot unlock",
    };
  if (vault.backend === "memory")
    return { name, ok: true, detail: "Saved keys are kept in memory only, until keyd stops." };
  if (vault.key === "passphrase")
    return {
      name,
      ok: true,
      detail:
        "Saved keys are kept in an encrypted file that only your passphrase opens: safe on disk and while locked, but not from a program already running as you once you unlock them.",
    };
  const where =
    vault.backend === "secret-service"
      ? "in your desktop keyring"
      : `in an encrypted file this machine opens by itself${vault.key === "tpm" ? " (with its TPM)" : ""}`;
  return {
    name,
    ok: true,
    detail: `Saved keys are kept ${where}: safe from other users and from the computers, but not from programs running as you. A passphrase vault keeps them from those until you unlock it; see docs/install.md.`,
  };
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

async function dockerChecks(deps: DoctorDeps, host: HostPlatform): Promise<DoctorCheck[]> {
  const { docker, images, socket, probeNetwork, signal, home, versionDeadlineMs = 10_000 } = deps;
  const pending = engineChecks(host, home);
  let v: DockerVersion;
  try {
    const answer = await withDeadline(docker.version(), versionDeadlineMs);
    if (answer === TIMED_OUT) {
      const detail = `not answering on ${located(docker, socket)} after ${versionDeadlineMs / 1000} s`;
      return [{ name: "docker-socket", ok: false, detail }, ...skipped(pending)];
    }
    v = answer;
  } catch (err) {
    if (!(err instanceof DockerError && err.status === 400)) {
      const fix = socketFix(err, host);
      const detail = `${located(docker, socket)}: ${fix ? sentences(messageOf(err), fix) : messageOf(err)}`;
      return [{ name: "docker-socket", ok: false, detail }, ...skipped(pending)];
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
      ...skipped(pending.slice(1)),
    ];
  }
  const major = Number(v.Version.split(".")[0]);
  const info =
    host.os === "macos"
      ? null
      : await docker.request<unknown>({ method: "GET", path: "/info" }).catch(() => null);
  const runtime = dockerRuntime(info);
  const isolated = await runDoctorNetworkProbe(docker.socketPath, probeNetwork, signal);
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
      ...isolated,
      ...(!isolated.ok && runtime
        ? { detail: `${isolated.detail} ${isolationFix(runtime.flavor)}` }
        : {}),
    },
    ...(runtime ? dockerRuntimeChecks(runtime, host) : []),
  ];
  if (signal?.aborted) return [...checks, ...skipped(pending.slice(2))];
  const gate = await imageCheck(docker, "image-gate", images.gate, "cells/gate/build.sh", v);
  checks.push(
    await imageCheck(docker, "image-desktop", images.desktop, "cells/desktop/build.sh", v),
    gate,
  );
  if (host.os === "macos" || !home) return checks;
  if (!runtime || !gate.ok || signal?.aborted) return [...checks, ...skipped(["gate-relay"])];
  const probe = deps.relayProbe ?? runRelayProbe;
  const relay = gateRelay(info, home, "linux");
  const verdict = await probe({ docker, relay, home, image: images.gate, snap: runtime.snap });
  return [...checks, { name: "gate-relay", ...verdict }];
}

// Joins two sentences, adding a full stop only where the first has none.
function sentences(first: string, second: string): string {
  return /[.!?]$/.test(first) ? `${first} ${second}` : `${first}. ${second}`;
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

function portCheck(port: number, home: string | undefined): Promise<DoctorCheck> {
  const name = `port-${port}`;
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", (err: NodeJS.ErrnoException) => {
      // A daemon that could not listen exits, so a live one for this home holds the port.
      if (err.code === "EADDRINUSE" && home && lockHolder(join(home, "daemon.lock"))) {
        resolve({ name, ok: true, detail: `localDot is running on 127.0.0.1:${port}` });
        return;
      }
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
