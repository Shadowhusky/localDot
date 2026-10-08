import { expect, it, vi } from "vitest";
import {
  CANARY_ROLES,
  CanaryOperation,
  type CanaryRole,
  canaryResourceLabels,
  canaryResourceName,
} from "../../../../packages/protocol/src/canary-operation.ts";
import { type CanaryCleanupClient, cleanupCanaryResources } from "./canary-cleanup.ts";

function fixture(recorded = true) {
  const operation = CanaryOperation.parse({
    v: 1,
    owner: "a".repeat(32),
    runId: "01234567-89ab-4cde-8fab-0123456789ab",
    cellId: "01JXYZ00000000000000000001",
    engineId: "engine-fixture",
    phase: "active",
    directory: { device: "1", inode: "2" },
    images: {
      desktop: {
        ref: `registry.invalid/desktop@sha256:${"a".repeat(64)}`,
        id: `sha256:${"b".repeat(64)}`,
      },
      gate: {
        ref: `registry.invalid/gate@sha256:${"c".repeat(64)}`,
        id: `sha256:${"d".repeat(64)}`,
      },
    },
    resources: {
      desktop: recorded ? "1".repeat(64) : null,
      gate: recorded ? "2".repeat(64) : null,
      internal: recorded ? "3".repeat(64) : null,
      egress: recorded ? "4".repeat(64) : null,
      home: recorded,
    },
  });
  const resources = new Map<CanaryRole, Record<string, unknown>>();
  for (const [index, role] of CANARY_ROLES.entries()) {
    const name = canaryResourceName(operation.runId, role),
      labels = canaryResourceLabels(operation, role);
    resources.set(
      role,
      role === "desktop" || role === "gate"
        ? {
            Id: String(index + 1).repeat(64),
            Name: `/${name}`,
            Config: { Labels: labels, Image: operation.images[role].ref },
            Image: operation.images[role].id,
            State: { Running: true, Paused: false, Restarting: false, Dead: false },
          }
        : {
            Id: String(index + 1).repeat(64),
            Name: name,
            Labels: labels,
            Driver: role === "home" ? "local" : "bridge",
            Options: null,
            Containers: {},
          },
    );
  }
  const events: string[] = [];
  const client: CanaryCleanupClient = {
    engine: vi.fn(async () => ({
      id: operation.engineId,
      operatingSystem: "linux" as const,
      architecture: "arm64" as const,
    })),
    inspect: vi.fn(async (role, reference) => {
      const value = resources.get(role);
      return value &&
        (reference === value.Id || reference === canaryResourceName(operation.runId, role))
        ? structuredClone(value)
        : null;
    }),
    stop: vi.fn(async (id) => {
      events.push(`stop:${id}`);
      const value = [...resources.values()].find((v) => v.Id === id);
      if (!value) throw new Error("missing");
      value.State = { Running: false, Paused: false, Restarting: false, Dead: false };
    }),
    remove: vi.fn(async (role, reference) => {
      expect(reference).toBe(
        role === "home" ? canaryResourceName(operation.runId, role) : resources.get(role)?.Id,
      );
      events.push(`remove:${role}`);
      resources.delete(role);
    }),
    volumeReferences: vi.fn(async () => []),
  };
  return { operation, resources, client, events };
}
const signal = () => new AbortController().signal;

it.each([true, false])(
  "retires only exact owned resources, including lost-create recovery (recorded=%s)",
  async (recorded) => {
    const f = fixture(recorded);
    await cleanupCanaryResources(f.operation, f.client, signal());
    expect(f.events).toEqual([
      `stop:${"1".repeat(64)}`,
      `stop:${"2".repeat(64)}`,
      "remove:desktop",
      "remove:gate",
      "remove:internal",
      "remove:egress",
      "remove:home",
    ]);
    expect(f.resources.size).toBe(0);
    expect(f.client.volumeReferences).toHaveBeenCalledWith(
      canaryResourceName(f.operation.runId, "home"),
      expect.any(AbortSignal),
    );
  },
);

it("accepts confirmed absence without stop or deletion", async () => {
  const f = fixture();
  f.resources.clear();
  await cleanupCanaryResources(f.operation, f.client, signal());
  expect(f.events).toEqual([]);
});

it.each(["owner", "run", "cell", "role", "name", "id", "image", "image-ref", "state"])(
  "refuses a mismatched %s container before stopping it",
  async (fault) => {
    const f = fixture(),
      raw = f.resources.get("desktop");
    if (!raw) throw new Error("fixture");
    const config = raw.Config as Record<string, unknown>,
      labels = config.Labels as Record<string, unknown>;
    if (["owner", "run", "cell", "role"].includes(fault))
      labels[
        {
          owner: "localdot.install-owner",
          run: "localdot.canary-run",
          cell: "localdot.cell",
          role: "localdot.role",
        }[fault] ?? ""
      ] = "foreign";
    if (fault === "name") raw.Name = "/foreign";
    if (fault === "id") raw.Id = "f".repeat(64);
    if (fault === "image") raw.Image = `sha256:${"f".repeat(64)}`;
    if (fault === "image-ref") config.Image = "unrelated:latest";
    if (fault === "state") raw.State = { Running: false };
    await expect(cleanupCanaryResources(f.operation, f.client, signal())).rejects.toThrow();
    expect(f.events).toEqual([]);
  },
);

it.each(["foreign-label", "attached", "driver"])(
  "never removes a network with %s",
  async (fault) => {
    const f = fixture(),
      raw = f.resources.get("internal");
    if (!raw) throw new Error("fixture");
    if (fault === "foreign-label") raw.Labels = {};
    if (fault === "attached") raw.Containers = { foreign: { Name: "keep" } };
    if (fault === "driver") raw.Driver = "overlay";
    await expect(cleanupCanaryResources(f.operation, f.client, signal())).rejects.toThrow();
    expect(f.events).not.toContain("remove:internal");
    expect(f.resources.has("internal")).toBe(true);
  },
);

it.each(["foreign-label", "mounted", "invalid-references", "driver", "options", "changed-labels"])(
  "retains a volume with %s",
  async (fault) => {
    const f = fixture(),
      raw = f.resources.get("home");
    if (!raw) throw new Error("fixture");
    if (fault === "foreign-label") raw.Labels = {};
    if (fault === "driver") raw.Driver = "nfs";
    if (fault === "options") raw.Options = { device: "/foreign" };
    if (fault === "mounted")
      f.client.volumeReferences = vi.fn(async () => [{ Id: "f".repeat(64) }]);
    if (fault === "invalid-references") f.client.volumeReferences = vi.fn(async () => ({}));
    if (fault === "changed-labels")
      f.client.volumeReferences = vi.fn(async () => {
        raw.Labels = {};
        return [];
      });
    await expect(cleanupCanaryResources(f.operation, f.client, signal())).rejects.toThrow();
    expect(f.events).not.toContain("remove:home");
    expect(f.resources.has("home")).toBe(true);
  },
);

it.each(["initial", "before-stop", "final"])("refuses engine changes at %s", async (when) => {
  const f = fixture();
  let checks = 0;
  f.client.engine = vi.fn(async () => {
    checks++;
    return {
      id:
        when === "initial" ||
        (when === "before-stop" && checks > 1) ||
        (when === "final" && f.resources.size === 0)
          ? "foreign"
          : f.operation.engineId,
      operatingSystem: "linux" as const,
      architecture: "arm64" as const,
    };
  });
  await expect(cleanupCanaryResources(f.operation, f.client, signal())).rejects.toThrow();
  if (when !== "final") expect(f.events).toEqual([]);
});

it.each(["stop", "remove"])("recovers a lost %s response only from fresh state", async (method) => {
  const f = fixture();
  if (method === "stop") {
    const original = f.client.stop;
    f.client.stop = async (...args) => {
      await original(...args);
      throw new Error("lost reply");
    };
  } else {
    const original = f.client.remove;
    f.client.remove = async (...args) => {
      await original(...args);
      throw new Error("lost reply");
    };
  }
  await cleanupCanaryResources(f.operation, f.client, signal());
  expect(f.resources.size).toBe(0);
});

it.each(["stop", "remove"] as const)(
  "cannot accept an ineffective %s acknowledgement",
  async (method) => {
    const f = fixture();
    f.client[method] = vi.fn(async () => {});
    await expect(cleanupCanaryResources(f.operation, f.client, signal())).rejects.toThrow();
    expect(f.resources.has("desktop")).toBe(true);
  },
);

it("refuses a replaced name after full-ID deletion", async () => {
  const f = fixture(),
    original = f.client.remove;
  f.client.remove = async (...args) => {
    const raw = f.resources.get(args[0]);
    await original(...args);
    if (args[0] === "desktop" && raw) f.resources.set("desktop", { ...raw, Id: "f".repeat(64) });
  };
  await expect(cleanupCanaryResources(f.operation, f.client, signal())).rejects.toThrow();
  expect(f.events.filter((e) => e === "remove:desktop")).toHaveLength(1);
  expect(f.resources.get("desktop")?.Id).toBe("f".repeat(64));
});

it("does not mutate on pre-cancellation", async () => {
  const f = fixture(),
    controller = new AbortController();
  controller.abort();
  await expect(cleanupCanaryResources(f.operation, f.client, controller.signal)).rejects.toThrow();
  expect(f.client.engine).not.toHaveBeenCalled();
  expect(f.events).toEqual([]);
});
