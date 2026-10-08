import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SELFTEST_CHECKS } from "@localdot/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { LiveSessions } from "../gateway/live.ts";
import type { DiagnosticSelfTest } from "./diagnostic-selftest.ts";
import { DockerClient, DockerError, type DockerRequest } from "./docker.ts";
import { CellOrchestrator } from "./orchestrator.ts";
import { GATE_PORTS } from "./spec.ts";
import { CellStore } from "./store.ts";
import { sampleRecord } from "./testing/sample-record.ts";
import type { DesktopdHealth } from "./types.ts";

const roots: string[] = [],
  owners: CellOrchestrator[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const good = (): DiagnosticSelfTest => ({
  ok: true,
  checks: SELFTEST_CHECKS.map(({ id }) => ({ id, ok: true })),
});
async function fixture() {
  const home = mkdtempSync(join(tmpdir(), "localdot-diagnostic-scope-"));
  roots.push(home);
  const store = new CellStore(home),
    live = new LiveSessions();
  const record = {
    ...sampleRecord(),
    ownership: {
      gate: "a".repeat(64),
      desktop: "b".repeat(64),
      internalNetwork: "c".repeat(64),
      egressNetwork: "d".repeat(64),
    },
  };
  store.save(record);
  const container = (role: "gate" | "desktop") => ({
    Id: record.ownership[role],
    Config: { Labels: { "localdot.cell": record.id, "localdot.role": role } },
    State: { Running: true, Paused: false, ExitCode: 0, Error: "" },
    NetworkSettings: {
      Ports: {
        [GATE_PORTS.desktopd]: [{ HostIp: "127.0.0.1", HostPort: "4887" }],
        [GATE_PORTS.stream]: [{ HostIp: "127.0.0.1", HostPort: "4888" }],
      },
      Networks: {},
    },
  });
  const containers = { gate: container("gate"), desktop: container("desktop") };
  const docker = new DockerClient("/nonexistent/diagnostic-fixture.sock");
  const request = vi
    .spyOn(docker, "request")
    .mockImplementation(async <T>(req: DockerRequest): Promise<T> => {
      for (const role of ["gate", "desktop"] as const) {
        const paths = [record.docker[role], record.ownership[role]];
        if (req.method === "GET" && paths.some((name) => req.path === `/containers/${name}/json`))
          return structuredClone(containers[role]) as T;
        if (
          req.method === "POST" &&
          paths.some((name) => req.path === `/containers/${name}/stop`)
        ) {
          containers[role].State.Running = false;
          return undefined as T;
        }
      }
      throw new DockerError(404, "fixture only", req.path);
    });
  const keyd = {
    isWired: vi.fn(async () => true),
    close: vi.fn(async () => {}),
    wire: vi.fn(async () => {}),
    refresh: vi.fn(async () => []),
    revoke: vi.fn(async () => 0),
  };
  const browser = { stop: vi.fn(async () => {}), remove: vi.fn(async () => {}) };
  const diagnosticProbe = vi.fn(async (_endpoint: unknown, _signal: AbortSignal) => good()),
    verifyRuntime = vi.fn(async () => {});
  let held = false;
  const owner = new CellOrchestrator({
    docker,
    store,
    images: { gate: "gate:fixture", desktop: "desktop:fixture" },
    keyd,
    browser,
    verifyRuntime,
    diagnosticAdmission: (id) => live.admitIdleOperation(id),
    diagnosticProbe,
    runtimeHold: () => held,
    probeDesktopd: async () =>
      ({
        ok: true,
        selftest: {
          ok: true,
          ms: 1,
          checks: SELFTEST_CHECKS.map((c) => ({ ...c, ok: true, detail: "ok" })),
        },
      }) as DesktopdHealth,
    probeStream: async () => true,
    sleep: () => new Promise<void>(() => {}),
  });
  owners.push(owner);
  await owner.reconcile();
  await vi.waitFor(() => expect(owner.get(record.id)?.state).toBe("ready"));
  request.mockClear();
  browser.stop.mockClear();
  keyd.close.mockClear();
  verifyRuntime.mockClear();
  return {
    owner,
    live,
    record,
    store,
    request,
    containers,
    keyd,
    browser,
    diagnosticProbe,
    verifyRuntime,
    hold: () => {
      held = true;
    },
    run: (signal = new AbortController().signal) => owner.diagnoseSelfTest(record.id, signal),
  };
}
it("runs a fresh probe under idle admission without stopping the browser or changing containers", async () => {
  const f = await fixture();
  f.diagnosticProbe.mockImplementation(async (_endpoint, _signal) => {
    expect(f.live.idleOperationPending(f.record.id)).toBe(true);
    expect(() => f.live.start(f.record.id, "new", async () => {})).toThrow();
    return good();
  });
  expect(await f.run()).toEqual(good());
  expect(f.diagnosticProbe).toHaveBeenCalledWith(
    { baseUrl: "http://127.0.0.1:4887", token: f.record.tokens.desktopd },
    expect.any(AbortSignal),
  );
  expect(f.verifyRuntime).toHaveBeenCalledTimes(2);
  expect(f.browser.stop).not.toHaveBeenCalled();
  expect(f.request.mock.calls.every(([r]) => r.method === "GET")).toBe(true);
  expect(f.live.idleOperationPending(f.record.id)).toBe(false);
});
it.each([
  "task",
  "held",
  "cancelled",
  "runtime",
  "ownership",
  "public-port",
  "port-changed",
  "paused",
  "keyd",
])("refuses %s before transmitting a cell token", async (fault) => {
  const f = await fixture();
  let finish: (() => void) | undefined;
  if (fault === "task")
    f.live.start(
      f.record.id,
      "active",
      () =>
        new Promise<void>((r) => {
          finish = r;
        }),
    );
  if (fault === "held") f.hold();
  if (fault === "runtime") f.verifyRuntime.mockRejectedValue(new Error("private detail"));
  if (fault === "ownership") f.containers.gate.Id = "f".repeat(64);
  if (fault === "public-port")
    f.containers.gate.NetworkSettings.Ports[GATE_PORTS.desktopd][0] = {
      HostIp: "0.0.0.0",
      HostPort: "4887",
    };
  if (fault === "port-changed")
    f.containers.gate.NetworkSettings.Ports[GATE_PORTS.desktopd][0] = {
      HostIp: "127.0.0.1",
      HostPort: "4999",
    };
  if (fault === "paused") f.containers.desktop.State.Paused = true;
  if (fault === "keyd") f.keyd.isWired.mockResolvedValue(false);
  await expect(f.run(fault === "cancelled" ? AbortSignal.abort() : undefined)).rejects.toThrow(
    "diagnostics are unavailable",
  );
  expect(f.diagnosticProbe).not.toHaveBeenCalled();
  expect(f.live.idleOperationPending(f.record.id)).toBe(false);
  finish?.();
  await f.live.settled("active");
});
it.each(["record", "runtime", "ports", "hold"])(
  "does not publish success after a %s change during probing",
  async (fault) => {
    const f = await fixture();
    f.diagnosticProbe.mockImplementation(async () => {
      if (fault === "record")
        f.store.save({ ...f.record, tokens: { ...f.record.tokens, desktopd: "x".repeat(43) } });
      if (fault === "runtime") f.verifyRuntime.mockRejectedValue(new Error("changed"));
      if (fault === "ports")
        f.containers.gate.NetworkSettings.Ports[GATE_PORTS.desktopd][0] = {
          HostIp: "127.0.0.1",
          HostPort: "4999",
        };
      if (fault === "hold") f.hold();
      return good();
    });
    await expect(f.run()).rejects.toThrow();
    expect(f.live.idleOperationPending(f.record.id)).toBe(false);
  },
);
it("preempts a running probe for Stop but retains idle ownership until transport settlement", async () => {
  const f = await fixture();
  let finish: (() => void) | undefined, signal: AbortSignal | undefined;
  f.diagnosticProbe.mockImplementation(async (_endpoint, active) => {
    signal = active;
    await new Promise<void>((r) => {
      finish = r;
    });
    return good();
  });
  const work = f.run().catch((error) => error);
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  const stopped = f.owner.stop(f.record.id);
  expect(signal?.aborted).toBe(true);
  expect(f.live.idleOperationPending(f.record.id)).toBe(true);
  expect(f.request.mock.calls.filter(([r]) => r.method === "POST")).toHaveLength(0);
  finish?.();
  expect(await work).toBeInstanceOf(Error);
  await stopped;
  expect(f.owner.get(f.record.id)?.state).toBe("stopped");
  expect(f.live.idleOperationPending(f.record.id)).toBe(false);
});
it("preempts before the diagnostic callback starts when Stop is queued synchronously", async () => {
  const f = await fixture(),
    work = f.run().catch((error) => error),
    stopped = f.owner.stop(f.record.id);
  expect(await work).toBeInstanceOf(Error);
  await stopped;
  expect(f.diagnosticProbe).not.toHaveBeenCalled();
});
it("rejects a concurrent diagnostic instead of queuing another probe", async () => {
  const f = await fixture();
  let finish: (() => void) | undefined;
  f.diagnosticProbe.mockImplementation(async () => {
    await new Promise<void>((r) => {
      finish = r;
    });
    return good();
  });
  const first = f.run();
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  await expect(f.run()).rejects.toThrow();
  finish?.();
  await first;
  expect(f.diagnosticProbe).toHaveBeenCalledOnce();
});
it("closes key access and stops captured full IDs after a failed fresh self-test", async () => {
  const f = await fixture(),
    failed = good();
  failed.ok = false;
  failed.checks[0] = { id: "route", ok: false };
  f.diagnosticProbe.mockResolvedValue(failed);
  expect(await f.run()).toEqual(failed);
  expect(f.owner.get(f.record.id)?.state).toBe("failed");
  expect(f.owner.endpoints(f.record.id)).toBeUndefined();
  expect(f.keyd.close).toHaveBeenCalledWith(f.record.id);
  expect(f.browser.stop).toHaveBeenCalled();
  expect(f.request.mock.calls.filter(([r]) => r.method === "POST").map(([r]) => r.path)).toEqual([
    `/containers/${f.record.ownership.gate}/stop`,
    `/containers/${f.record.ownership.desktop}/stop`,
  ]);
});
it("attempts desktop containment even when gate stop fails and withholds a completion receipt", async () => {
  const f = await fixture(),
    original = f.request.getMockImplementation();
  f.diagnosticProbe.mockResolvedValue({ ...good(), ok: false });
  f.request.mockImplementation(async <T>(req: DockerRequest): Promise<T> => {
    if (req.method === "POST" && req.path.includes(f.record.ownership.gate))
      throw new Error("private failure");
    if (!original) throw new Error();
    return original(req) as Promise<T>;
  });
  await expect(f.run()).rejects.toThrow("diagnostics are unavailable");
  expect(f.containers.desktop.State.Running).toBe(false);
  expect(f.owner.get(f.record.id)?.state).toBe("failed");
});
