import { afterEach, expect, it, vi } from "vitest";
import { imageRef } from "../../../../packages/protocol/src/release.ts";
import { sampleManifest } from "../../../../packages/protocol/src/testing/sample-release.ts";
import type { CanaryOperationJournal } from "./canary-operation.ts";
import { type InstalledCanaryInput, runInstalledCanary } from "./installed-canary.ts";

const mock = vi.hoisted(() => ({
  context: vi.fn(),
  recover: vi.fn(),
  assets: vi.fn(),
  operation: vi.fn(),
  process: vi.fn(),
  prepare: vi.fn(),
  client: vi.fn(),
  topology: vi.fn(),
  ready: vi.fn(),
  logs: vi.fn(),
  scan: vi.fn(),
  artifacts: vi.fn(),
}));
vi.mock("./canary-context.ts", () => ({ installedCanaryOperationContext: mock.context }));
vi.mock("./canary-operation.ts", () => ({
  recoverCanaryOperation: mock.recover,
  withCanaryOperation: mock.operation,
}));
vi.mock("./canary-assets.ts", () => ({ readCanaryAssets: mock.assets }));
vi.mock("./canary-process.ts", () => ({ withCanaryProcess: mock.process }));
vi.mock("./canary-artifacts.ts", () => ({
  prepareCanaryArtifactControl: mock.prepare,
  verifyCanaryFinalArtifacts: mock.artifacts,
}));
vi.mock("./canary-topology-client.ts", () => ({ canaryTopologyClient: mock.client }));
vi.mock("./canary-topology.ts", () => ({ createCanaryTopology: mock.topology }));
vi.mock("./canary-readiness.ts", () => ({ waitCanaryReadiness: mock.ready }));
vi.mock("./canary-container-logs.ts", () => ({ withCanaryContainerLogs: mock.logs }));
vi.mock("./canary-execution.ts", () => ({ runCanaryDesktopScan: mock.scan }));
afterEach(() => {
  for (const fn of Object.values(mock)) fn.mockReset();
});
function fixture() {
  const controller = new AbortController(),
    active = new AbortController(),
    running = new AbortController();
  const events: string[] = [];
  const input = {
    configuration: { settings: { ownerId: "a".repeat(32), dockerSocket: "/recorded/docker.sock" } },
    verifiedKeydPath: "/verified/keyd",
    releaseDirectory: "/verified/release",
    manifest: sampleManifest(),
    engineId: "engine-fixture",
    imageIds: { desktop: `sha256:${"b".repeat(64)}`, gate: `sha256:${"c".repeat(64)}` },
  } as InstalledCanaryInput;
  const context = { fixture: "context" },
    journal = {
      snapshot: () => ({
        runId: "01234567-89ab-4cde-8fab-0123456789ab",
        cellId: "01JXYZ00000000000000000001",
        resources: {},
      }),
    } as CanaryOperationJournal;
  const ready = { syntheticSecret: "private-synthetic-secret" },
    closed = { type: "closed" },
    control = { marker: "private-control" };
  const assets = { scanner: Buffer.from("scan"), worker: Buffer.from("work") },
    logs = { private: "log text" };
  const scan = { ok: true, coverage: "fixture" },
    artifacts = { ok: true, files: 2 };
  let cleanup: (() => Promise<void>) | undefined;
  mock.context.mockImplementation(async () => {
    events.push("context");
    return context;
  });
  mock.recover.mockImplementation(async () => {
    events.push("recover");
  });
  mock.assets.mockImplementation(async () => {
    events.push("assets");
    return assets;
  });
  mock.operation.mockImplementation(async (_ctx, _input, _signal, work) => {
    events.push("lease");
    try {
      return await work(journal, "/private/canary", 19);
    } finally {
      events.push("cleanup");
      await cleanup?.();
      events.push("release");
    }
  });
  mock.process.mockImplementation(async (_input, _signal, work) => {
    events.push("helper-ready");
    let value: unknown;
    try {
      value = await work(ready, active.signal, 123);
    } finally {
      events.push("helper-closed");
    }
    return { value, receipt: closed, stderr: Buffer.from("private-stderr") };
  });
  mock.prepare.mockImplementation(async () => {
    events.push("control");
    return control;
  });
  mock.client.mockReturnValue({ fixture: "client" });
  mock.topology.mockImplementation(async () => {
    events.push("topology");
    return { fixture: "topology" };
  });
  mock.ready.mockImplementation(async () => {
    events.push("ready");
  });
  mock.logs.mockImplementation(async (_socket, _op, _signal, work) => {
    events.push("logs-start");
    const value = await work(running.signal);
    events.push("containers-stopped");
    return { value, logs };
  });
  mock.scan.mockImplementation(async () => {
    events.push("scan");
    return scan;
  });
  mock.artifacts.mockImplementation(async () => {
    events.push("artifacts");
    return artifacts;
  });
  return {
    input,
    controller,
    active,
    running,
    events,
    context,
    journal,
    ready,
    closed,
    control,
    assets,
    logs,
    scan,
    artifacts,
    setCleanup: (fn: () => Promise<void>) => {
      cleanup = fn;
    },
    run: () => runInstalledCanary(input, controller.signal),
  };
}
it("composes recovery, leased helper, live scan, drained final evidence and cleanup in order", async () => {
  const f = fixture();
  const result = await f.run();
  expect(f.events).toEqual([
    "context",
    "recover",
    "assets",
    "lease",
    "helper-ready",
    "control",
    "topology",
    "ready",
    "logs-start",
    "scan",
    "containers-stopped",
    "helper-closed",
    "artifacts",
    "cleanup",
    "release",
  ]);
  expect(result).toEqual({ scan: f.scan, artifacts: f.artifacts });
  expect(JSON.stringify(result)).not.toContain("private");
  expect(mock.recover).toHaveBeenCalledWith(
    f.context,
    { owner: "a".repeat(32), engineId: "engine-fixture" },
    f.controller.signal,
  );
  expect(mock.operation).toHaveBeenCalledWith(
    f.context,
    {
      owner: "a".repeat(32),
      engineId: "engine-fixture",
      cellId: expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{26}$/),
      images: {
        desktop: { ref: imageRef(f.input.manifest.images.desktop), id: f.input.imageIds.desktop },
        gate: { ref: imageRef(f.input.manifest.images.gate), id: f.input.imageIds.gate },
      },
    },
    f.controller.signal,
    expect.any(Function),
  );
  expect(mock.process).toHaveBeenCalledWith(
    {
      verifiedKeydPath: "/verified/keyd",
      directory: "/private/canary",
      directoryDescriptor: 19,
      runId: f.journal.snapshot().runId,
      cellId: f.journal.snapshot().cellId,
    },
    f.controller.signal,
    expect.any(Function),
  );
  expect(mock.scan).toHaveBeenCalledWith(
    "/recorded/docker.sock",
    f.journal.snapshot(),
    f.ready,
    f.assets,
    f.running.signal,
  );
  expect(mock.artifacts).toHaveBeenCalledWith(
    "/private/canary",
    f.journal.snapshot(),
    f.ready,
    f.closed,
    f.control,
    Buffer.from("private-stderr"),
    f.logs,
    f.controller.signal,
  );
});
it.each(["recover", "assets", "prepare", "topology", "ready", "scan", "artifacts"] as const)(
  "propagates %s failure without publishing a partial pass",
  async (stage) => {
    const f = fixture();
    mock[stage].mockRejectedValue(new Error("private detail"));
    await expect(f.run()).rejects.toThrow("installed credential diagnostic failed");
    if (["recover", "assets"].includes(stage)) expect(mock.operation).not.toHaveBeenCalled();
    else expect(f.events.slice(-3)).toEqual(["helper-closed", "cleanup", "release"]);
    if (stage !== "artifacts") expect(mock.artifacts).not.toHaveBeenCalled();
  },
);
it("does not scan final artifacts when the helper fails to confirm actual closure", async () => {
  const f = fixture();
  mock.process.mockRejectedValue(new Error("private"));
  await expect(f.run()).rejects.toThrow();
  expect(mock.artifacts).not.toHaveBeenCalled();
  expect(f.events.slice(-2)).toEqual(["cleanup", "release"]);
});
it("keeps success pending until cleanup settles and lets cleanup failure override all passing scans", async () => {
  const f = fixture();
  let finish: (() => void) | undefined,
    settled = false;
  f.setCleanup(async () => {
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    throw new Error("private cleanup");
  });
  const work = f.run().then(
    () => {
      settled = true;
      return "pass";
    },
    () => {
      settled = true;
      return "failed";
    },
  );
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  expect(mock.artifacts).toHaveBeenCalledTimes(1);
  expect(settled).toBe(false);
  finish?.();
  expect(await work).toBe("failed");
});
it("does not perform any operation after prior cancellation", async () => {
  const f = fixture();
  f.controller.abort();
  await expect(f.run()).rejects.toThrow();
  expect(mock.context).not.toHaveBeenCalled();
});
