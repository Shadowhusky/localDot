import { afterEach, expect, it, vi } from "vitest";
import type { InstallNetworkClient, IsolationProbe } from "./network-client.ts";
import { probeLabels, probeName } from "./network-client.ts";
import { type ProbeStore, verifyGatewayIsolation } from "./network-isolation.ts";

afterEach(() => vi.useRealTimers());
const owner = "a".repeat(32),
  id = "b".repeat(64);
function fixture() {
  let record: IsolationProbe | null = null,
    network: Record<string, unknown> | null = null;
  const events: string[] = [],
    controller = new AbortController();
  const store: ProbeStore = {
    read: vi.fn(async () => structuredClone(record)),
    save: vi.fn(async (value) => {
      record = structuredClone(value);
      events.push(value ? "intent" : "clear");
    }),
  };
  const client: InstallNetworkClient = {
    engine: vi.fn(async () => ({
      id: "engine",
      operatingSystem: "linux" as const,
      architecture: "arm64" as const,
    })),
    inspect: vi.fn(async (reference) => {
      events.push(`inspect:${reference === id ? "id" : "name"}`);
      return network === null ? null : structuredClone(network);
    }),
    create: vi.fn(async (probe) => {
      expect(record).toEqual(probe);
      events.push("create");
      network = {
        Id: id,
        Name: probe.name,
        Labels: probeLabels(probe),
        Containers: {},
        Driver: "bridge",
        Internal: true,
        EnableIPv6: false,
        Options: { "com.docker.network.bridge.gateway_mode_ipv4": "isolated" },
        IPAM: { Config: [{ Subnet: "172.31.0.0/24" }] },
      };
      return { Id: id, Warning: "" };
    }),
    remove: vi.fn(async (reference) => {
      expect(reference).toBe(id);
      events.push("remove");
      network = null;
    }),
  };
  return {
    store,
    client,
    controller,
    events,
    run: () => verifyGatewayIsolation(owner, store, client, controller.signal),
    record: () => record,
    network: () => network,
    change: (patch: Record<string, unknown>) => {
      if (!network) throw new Error("No fixture network");
      Object.assign(network, patch);
    },
    seed: () => {
      const nonce = "c".repeat(32);
      record = { owner, nonce, name: probeName(owner, nonce), engineId: "engine" };
    },
  };
}
it("persists intent before create and confirms deletion before clearing recovery state", async () => {
  const f = fixture();
  expect(await f.run()).toEqual({ engineId: "engine", isolatedGateway: true });
  expect(f.events.indexOf("intent")).toBeLessThan(f.events.indexOf("create"));
  expect(f.events.slice(-4)).toEqual(["remove", "inspect:id", "inspect:name", "clear"]);
  expect(f.record()).toBeNull();
  expect(f.network()).toBeNull();
});
it.each(["gateway", "internal", "ipv6", "driver", "option", "subnet", "ipam"])(
  "fails %s isolation and still removes its empty probe",
  async (kind) => {
    const f = fixture(),
      create = f.client.create;
    vi.mocked(f.client.create).mockImplementation(async (...args) => {
      const reply = await createOriginal(...args);
      return reply;
    });
    // Save the implementation before replacing the mock to avoid recursive calls.
    async function createOriginal(...args: Parameters<typeof create>) {
      const probe = args[0];
      const good = {
        Id: id,
        Name: probe.name,
        Labels: probeLabels(probe),
        Containers: {},
        Driver: "bridge",
        Internal: true,
        EnableIPv6: false,
        Options: { "com.docker.network.bridge.gateway_mode_ipv4": "isolated" },
        IPAM: { Config: [{ Subnet: "172.31.0.0/24" }] },
      };
      const bad: Record<string, unknown> = { ...good };
      if (kind === "gateway")
        bad.IPAM = { Config: [{ Subnet: "172.31.0.0/24", Gateway: "172.31.0.1" }] };
      if (kind === "internal") bad.Internal = false;
      if (kind === "ipv6") bad.EnableIPv6 = true;
      if (kind === "driver") bad.Driver = "host";
      if (kind === "option") bad.Options = {};
      if (kind === "subnet") bad.IPAM = { Config: [{ Subnet: "invalid/24" }] };
      if (kind === "ipam") bad.IPAM = { Config: [] };
      let present = true;
      vi.mocked(f.client.inspect).mockImplementation(async () =>
        present ? structuredClone(bad) : null,
      );
      vi.mocked(f.client.remove).mockImplementation(async () => {
        present = false;
      });
      return { Id: id };
    }
    await expect(f.run()).rejects.toThrow();
    expect(f.client.remove).toHaveBeenCalledWith(id, expect.any(AbortSignal));
    expect(f.record()).toBeNull();
  },
);
it.each(["lost-create", "malformed-create", "cancelled", "inspection-failed"])(
  "cleans up after %s without claiming success",
  async (kind) => {
    const f = fixture(),
      original = vi.mocked(f.client.create).getMockImplementation();
    vi.mocked(f.client.create).mockImplementation(async (...args) => {
      const reply = await original?.(...args);
      if (kind === "lost-create") throw new Error("lost reply");
      if (kind === "cancelled") f.controller.abort();
      if (kind === "inspection-failed")
        vi.mocked(f.client.inspect).mockRejectedValueOnce(new Error("inspect failed"));
      return kind === "malformed-create" ? {} : reply;
    });
    await expect(f.run()).rejects.toThrow();
    expect(f.client.remove).toHaveBeenCalledOnce();
    expect(f.record()).toBeNull();
  },
);
it.each(["labels", "name", "id", "attached"])("never deletes a %s mismatch", async (kind) => {
  const f = fixture(),
    original = vi.mocked(f.client.create).getMockImplementation();
  vi.mocked(f.client.create).mockImplementation(async (...args) => {
    const reply = await original?.(...args);
    f.change(
      kind === "labels"
        ? { Labels: {} }
        : kind === "name"
          ? { Name: "foreign" }
          : kind === "id"
            ? { Id: "invalid" }
            : { Containers: { foreign: {} } },
    );
    return reply;
  });
  await expect(f.run()).rejects.toThrow();
  expect(f.client.remove).not.toHaveBeenCalled();
  expect(f.record()).not.toBeNull();
});
it("keeps pending state when removal cannot be confirmed", async () => {
  const f = fixture();
  vi.mocked(f.client.remove).mockResolvedValue(undefined);
  await expect(f.run()).rejects.toThrow();
  expect(f.record()).not.toBeNull();
});
it("resolves a lost delete reply by independently observing absence", async () => {
  const f = fixture(),
    original = vi.mocked(f.client.remove).getMockImplementation();
  vi.mocked(f.client.remove).mockImplementation(async (...args) => {
    await original?.(...args);
    throw new Error("lost");
  });
  await expect(f.run()).resolves.toEqual({ engineId: "engine", isolatedGateway: true });
  expect(f.record()).toBeNull();
});
it("recovers an old intent before creating another probe", async () => {
  const f = fixture();
  f.seed();
  await f.run();
  expect(f.events.indexOf("clear")).toBeLessThan(f.events.indexOf("intent"));
});
it("refuses a changed engine without deleting anything or clearing its old intent", async () => {
  const f = fixture();
  f.seed();
  vi.mocked(f.client.engine).mockResolvedValue({
    id: "different",
    operatingSystem: "linux",
    architecture: "arm64",
  });
  await expect(f.run()).rejects.toThrow();
  expect(f.client.remove).not.toHaveBeenCalled();
  expect(f.client.create).not.toHaveBeenCalled();
  expect(f.record()).not.toBeNull();
});
it("does not create after a failed intent write or cancellation", async () => {
  const f = fixture();
  vi.mocked(f.store.save).mockRejectedValue(new Error("disk"));
  await expect(f.run()).rejects.toThrow();
  expect(f.client.create).not.toHaveBeenCalled();
  const g = fixture();
  g.controller.abort();
  await expect(g.run()).rejects.toThrow();
  expect(g.client.engine).not.toHaveBeenCalled();
});
