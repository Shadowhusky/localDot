import { describe, expect, it, vi } from "vitest";
import type { DockerClient, DockerRequest } from "./cells/docker.ts";
import { runDoctor } from "./doctor.ts";
import { runDoctorNetworkProbe } from "./doctor-network.ts";

vi.mock("./doctor-network.ts", () => ({
  runDoctorNetworkProbe: vi.fn(async () => ({ ok: true, detail: "verified isolated fixture" })),
}));

// This wiring test deliberately has no sockets or Docker. Existing real fake-engine
// and CLI tests must also pass before release acceptance.
vi.mock("node:net", () => ({
  createServer: () => {
    const probe = {
      once() {
        return probe;
      },
      listen(_port: number, _host: string, ready: () => void) {
        ready();
        return probe;
      },
      close(done: () => void) {
        done();
        return probe;
      },
    };
    return probe;
  },
}));

const desktop = `ghcr.io/localdot/desktop@sha256:${"a".repeat(64)}`;
const gate = `ghcr.io/localdot/gate@sha256:${"b".repeat(64)}`;

it("does not begin development diagnostics after prior cancellation", async () => {
  const controller = new AbortController();
  controller.abort();
  const version = vi.fn();
  const result = await runDoctor({
    docker: { version } as unknown as DockerClient,
    images: { desktop, gate },
    port: 4750,
    signal: controller.signal,
  });
  expect(result.ok).toBe(false);
  expect(version).not.toHaveBeenCalled();
});

it("passes cancellation into the owned probe and waits for cleanup before skipping later checks", async () => {
  const controller = new AbortController();
  let drain: (() => void) | undefined,
    active: AbortSignal | undefined,
    settled = false;
  vi.mocked(runDoctorNetworkProbe).mockImplementationOnce(async (_socket, _name, signal) => {
    active = signal;
    await new Promise<void>((resolve) => {
      drain = resolve;
    });
    return { ok: false, detail: "interrupted; cleanup awaited" };
  });
  const request = vi.fn();
  const docker = {
    socketPath: "/synthetic/no-socket",
    version: async () => ({
      Version: "29.2.0",
      ApiVersion: "1.53",
      MinAPIVersion: "1.44",
      Os: "linux",
      Arch: "arm64",
    }),
    request,
  } as unknown as DockerClient;
  const work = runDoctor({
    docker,
    images: { desktop, gate },
    port: 4750,
    signal: controller.signal,
  }).then((v) => {
    settled = true;
    return v;
  });
  await vi.waitFor(() => expect(drain).toBeTypeOf("function"));
  controller.abort();
  await Promise.resolve();
  expect(active?.aborted).toBe(true);
  expect(settled).toBe(false);
  drain?.();
  expect((await work).ok).toBe(false);
  expect(request).not.toHaveBeenCalled();
});

async function report(arch: string, altered?: unknown) {
  const calls: DockerRequest[] = [];
  const docker = {
    socketPath: "/synthetic/no-socket",
    version: async () => ({
      Version: "29.2.0",
      ApiVersion: "1.53",
      MinAPIVersion: "1.44",
      Os: "linux",
      Arch: arch,
    }),
    request: async (request: DockerRequest) => {
      calls.push(request);
      for (const ref of [desktop, gate])
        if (request.method === "GET" && request.path === `/images/${encodeURIComponent(ref)}/json`)
          return ref === desktop && altered !== undefined
            ? altered
            : { Os: "linux", Architecture: arch, RepoDigests: [ref] };
      throw new Error(`Unexpected fixture request: ${request.method} ${request.path}`);
    },
  } as unknown as DockerClient;
  const result = await runDoctor({
    docker,
    images: { desktop, gate },
    port: 4750,
    probeNetwork: "localdot-test-image-platform",
  });
  expect(
    calls.filter((value) => value.method === "GET" && value.path.startsWith("/images/")),
  ).toHaveLength(2);
  expect(runDoctorNetworkProbe).toHaveBeenCalledWith(
    "/synthetic/no-socket",
    "localdot-test-image-platform",
    undefined,
  );
  return result;
}

describe("doctor uses image inspection metadata", () => {
  it.each(["arm64", "amd64"])("accepts matching pinned %s images", async (arch) => {
    expect((await report(arch)).ok).toBe(true);
  });
  it("fails the full report when only the desktop has the wrong architecture", async () => {
    const result = await report("arm64", {
      Os: "linux",
      Architecture: "amd64",
      RepoDigests: [desktop],
    });
    expect(result.ok).toBe(false);
    expect(result.checks.find((value) => value.name === "image-desktop")).toMatchObject({
      ok: false,
    });
    expect(result.checks.find((value) => value.name === "image-gate")).toMatchObject({ ok: true });
  });
  it("fails the full report when the requested repository digest is missing", async () => {
    const result = await report("arm64", { Os: "linux", Architecture: "arm64", RepoDigests: [] });
    expect(result.ok).toBe(false);
    expect(result.checks.find((value) => value.name === "image-desktop")?.detail).toContain(
      "repository digest",
    );
  });
});
