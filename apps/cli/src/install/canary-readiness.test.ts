import { afterEach, expect, it, vi } from "vitest";
import type { CanaryOperation } from "../../../../packages/protocol/src/canary-operation.ts";
import type { CellRecord } from "../../../daemon/src/cells/types.ts";
import { waitCanaryReadiness } from "./canary-readiness.ts";
import type { CanaryTopologyClient } from "./canary-topology.ts";

const mock = vi.hoisted(() => ({ topology: vi.fn(), probe: vi.fn() }));
vi.mock("./canary-topology.ts", () => ({ inspectRunningCanaryTopology: mock.topology }));
vi.mock("../../../daemon/src/cells/diagnostic-selftest.ts", () => ({
  probeDiagnosticSelfTest: mock.probe,
}));
afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});
function fixture() {
  const controller = new AbortController(),
    events: string[] = [];
  // Boundary modules validate complete records; these tests isolate orchestration.
  const operation = { runId: "fixture-run" } as CanaryOperation;
  const topology = {
    record: { tokens: { desktopd: "t".repeat(43) } } as CellRecord,
    ports: { desktopd: 51001, stream: 51002 },
  };
  const client = {} as CanaryTopologyClient;
  mock.topology.mockImplementation(async () => {
    events.push("identity");
    return { ...topology.ports };
  });
  mock.probe.mockImplementation(async () => {
    events.push("probe");
    return { ok: true, checks: [] };
  });
  return {
    controller,
    operation,
    topology,
    client,
    events,
    run: () => waitCanaryReadiness(operation, topology, client, controller.signal),
  };
}
it("bounds the probe with fresh topology checks and uses only its recorded loopback port/token", async () => {
  const f = fixture();
  await f.run();
  expect(f.events).toEqual(["identity", "probe", "identity"]);
  expect(mock.probe).toHaveBeenCalledWith(
    { baseUrl: "http://127.0.0.1:51001", token: "t".repeat(43) },
    expect.any(AbortSignal),
  );
});
it.each(["unavailable", "not-ready"])(
  "retries %s service startup after rechecking ownership",
  async (fault) => {
    vi.useFakeTimers();
    const f = fixture();
    if (fault === "unavailable") mock.probe.mockRejectedValueOnce(new Error("private"));
    else mock.probe.mockResolvedValueOnce({ ok: false });
    const work = f.run();
    await vi.advanceTimersByTimeAsync(250);
    await work;
    expect(mock.probe).toHaveBeenCalledTimes(2);
    expect(mock.topology).toHaveBeenCalledTimes(4);
  },
);
it.each(["before", "after", "port-change"])(
  "refuses %s topology failure instead of retrying it",
  async (fault) => {
    const f = fixture();
    if (fault === "before") mock.topology.mockRejectedValue(new Error("private"));
    if (fault === "after")
      mock.topology.mockResolvedValueOnce(f.topology.ports).mockRejectedValue(new Error("private"));
    if (fault === "port-change")
      mock.topology.mockResolvedValue({ ...f.topology.ports, desktopd: 59999 });
    await expect(f.run()).rejects.toThrow("did not become ready");
    expect(mock.probe).toHaveBeenCalledTimes(fault === "after" ? 1 : 0);
  },
);
it.each(["cancel", "deadline"])(
  "awaits the in-flight probe's drain after %s and rejects its late success",
  async (fault) => {
    vi.useFakeTimers();
    const f = fixture();
    let drain: (() => void) | undefined,
      active: AbortSignal | undefined,
      settled = false;
    mock.probe.mockImplementation(async (_input, signal) => {
      active = signal;
      await new Promise<void>((resolve) => {
        drain = resolve;
      });
      return { ok: true };
    });
    const work = f.run().then(
      () => {
        settled = true;
        return "success";
      },
      () => {
        settled = true;
        return "failure";
      },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(drain).toBeTypeOf("function");
    if (fault === "cancel") f.controller.abort();
    else await vi.advanceTimersByTimeAsync(90_000);
    expect(active?.aborted).toBe(true);
    expect(settled).toBe(false);
    drain?.();
    expect(await work).toBe("failure");
    expect(mock.probe).toHaveBeenCalledTimes(1);
  },
);
it("does not inspect or probe after prior cancellation", async () => {
  const f = fixture();
  f.controller.abort();
  await expect(f.run()).rejects.toThrow();
  expect(mock.topology).not.toHaveBeenCalled();
  expect(mock.probe).not.toHaveBeenCalled();
});
