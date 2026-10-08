import { expect, it } from "vitest";
import {
  CanaryOperation,
  type CanaryRole,
  canaryResourceLabels,
  canaryResourceName,
} from "../../../../packages/protocol/src/canary-operation.ts";
import { CanaryReady } from "../../../../packages/protocol/src/canary-process.ts";
import type { CellRecord } from "../../../daemon/src/cells/types.ts";
import type { CanaryOperationJournal } from "./canary-operation.ts";
import {
  type CanaryTopologyClient,
  createCanaryTopology,
  inspectRunningCanaryTopology,
} from "./canary-topology.ts";
import {
  canaryContainerSpec,
  canaryNames,
  canaryNetworkSpec,
  canarySubnet,
} from "./canary-topology-spec.ts";

function fixture() {
  const operation = CanaryOperation.parse({
    v: 1,
    owner: "a".repeat(32),
    engineId: "engine-fixture",
    runId: "01234567-89ab-4cde-8fab-0123456789ab",
    cellId: "01JXYZ00000000000000000001",
    phase: "active",
    directory: { device: "1", inode: "2" },
    images: {
      desktop: {
        ref: `ghcr.io/fixture/localdot-desktop@sha256:${"b".repeat(64)}`,
        id: `sha256:${"c".repeat(64)}`,
      },
      gate: {
        ref: `ghcr.io/fixture/localdot-gate@sha256:${"d".repeat(64)}`,
        id: `sha256:${"e".repeat(64)}`,
      },
    },
    resources: { desktop: null, gate: null, internal: null, egress: null, home: false },
  });
  const ready = CanaryReady.parse({
    v: 1,
    type: "ready",
    runId: operation.runId,
    cellId: operation.cellId,
    port: 49123,
    proxyToken: "t".repeat(43),
    caCertPem: `-----BEGIN CERTIFICATE-----\n${"A".repeat(128)}\n-----END CERTIFICATE-----\n`,
    surrogate: `ld_key_${"a".repeat(22)}_${"b".repeat(6)}`,
    syntheticSecret: `canary-${"f".repeat(64)}`,
    challenge: "a".repeat(32),
    url: `https://canary.localdot.invalid/v1/canary/${"a".repeat(32)}`,
  });
  const names = canaryNames(operation),
    resources = new Map<CanaryRole, Record<string, unknown>>(),
    events: string[] = [];
  let captured: CellRecord | undefined;
  const journal: CanaryOperationJournal = {
    snapshot: () => structuredClone(operation),
    capture: async (role: CanaryRole, value: string | true) => {
      events.push(`capture:${role}`);
      Object.assign(operation.resources, { [role]: value });
    },
  };
  const ids = {
    internal: "1".repeat(64),
    egress: "2".repeat(64),
    gate: "3".repeat(64),
    desktop: "4".repeat(64),
  };
  const image = (role: "desktop" | "gate") => ({
    Id: operation.images[role].id,
    RepoDigests: [operation.images[role].ref],
    Os: "linux",
    Architecture: "arm64",
    Config: { User: "", Cmd: ["/init"], Entrypoint: null, WorkingDir: "/" },
  });
  function attach(role: "desktop" | "gate", network: "internal" | "egress", address: string) {
    const raw = resources.get(role),
      net = resources.get(network);
    if (!raw || !net) throw new Error("missing resource");
    (net.Containers as Record<string, unknown>)[ids[role]] = {
      Name: canaryResourceName(operation.runId, role),
      IPv4Address: `${address}/24`,
    };
    const settings = raw.NetworkSettings as { Networks: Record<string, unknown> };
    settings.Networks[canaryResourceName(operation.runId, network)] = {
      NetworkID: ids[network],
      IPAddress: address,
      GlobalIPv6Address: "",
    };
  }
  const client: CanaryTopologyClient = {
    engine: async () => ({
      id: operation.engineId,
      operatingSystem: "linux",
      architecture: "arm64",
    }),
    image: async (role) => image(role),
    inspect: async (role, reference) => {
      const raw = resources.get(role);
      return raw &&
        (raw.Id === reference || canaryResourceName(operation.runId, role) === reference)
        ? structuredClone(raw)
        : null;
    },
    createNetwork: async (role) => {
      events.push(`create:${role}`);
      const subnet = role === "internal" ? "172.20.0.0/24" : "172.21.0.0/24";
      resources.set(role, {
        ...canaryNetworkSpec(operation, role),
        Id: ids[role],
        Internal: role === "internal",
        Containers: {},
        IPAM: {
          Config: [{ Subnet: subnet, ...(role === "egress" ? { Gateway: "172.21.0.1" } : {}) }],
        },
      });
      return { Id: ids[role] };
    },
    createHome: async () => {
      events.push("create:home");
      const raw = {
        Name: names.homeVolume,
        Driver: "local",
        Options: null,
        Labels: canaryResourceLabels(operation, "home"),
      };
      resources.set("home", raw);
      return structuredClone(raw);
    },
    createContainer: async (role, record) => {
      events.push(`create:${role}`);
      captured = structuredClone(record);
      const spec = canaryContainerSpec(operation, record, role);
      resources.set(role, {
        Id: ids[role],
        Name: `/${names[role]}`,
        Image: operation.images[role].id,
        Config: {
          ...image(role).Config,
          Image: spec.Image,
          Labels: spec.Labels,
          Env: [...spec.Env, "PATH=/usr/bin"],
          User: role === "gate" ? "nobody" : "",
        },
        HostConfig: {
          Privileged: false,
          PublishAllPorts: false,
          AutoRemove: false,
          PidMode: "",
          IpcMode: "private",
          RestartPolicy: { Name: "no" },
          ReadonlyRootfs: false,
          ...spec.HostConfig,
        },
        State: { Running: false, Paused: false, Restarting: false, Dead: false },
        NetworkSettings: { Networks: {}, Ports: {} },
      });
      return { Id: ids[role] };
    },
    wireDesktop: async (id, hello) => {
      expect(id).toBe(ids.desktop);
      expect(hello).toEqual(ready);
      expect(operation.resources.desktop).toBe(id);
      events.push("wire");
    },
    start: async (id) => {
      const role = id === ids.gate ? "gate" : "desktop",
        raw = resources.get(role);
      if (!raw || !captured) throw new Error("missing resource");
      expect(operation.resources[role]).toBe(id);
      events.push(`start:${role}`);
      raw.State = { Running: true, Paused: false, Restarting: false, Dead: false };
      if (role === "gate") {
        attach("gate", "egress", captured.docker.gateEgressIp);
        (raw.NetworkSettings as Record<string, unknown>).Ports = {
          "8081/tcp": [{ HostIp: "127.0.0.1", HostPort: "51001" }],
          "8082/tcp": [{ HostIp: "127.0.0.1", HostPort: "51002" }],
        };
      } else attach("desktop", "internal", captured.docker.desktopIp);
    },
    connect: async (net, gate, address) => {
      expect(net).toBe(ids.internal);
      expect(gate).toBe(ids.gate);
      events.push("connect");
      attach("gate", "internal", address);
    },
  };
  return { operation, ready, journal, resources, events, client, ids, names };
}
const signal = () => new AbortController().signal;

it("provisions the normal hardened topology with durable IDs before every dependent mutation", async () => {
  const f = fixture(),
    result = await createCanaryTopology(f.journal, f.ready, f.client, signal());
  expect(f.events).toEqual([
    "create:internal",
    "capture:internal",
    "create:egress",
    "capture:egress",
    "create:home",
    "capture:home",
    "create:gate",
    "capture:gate",
    "create:desktop",
    "capture:desktop",
    "wire",
    "start:gate",
    "connect",
    "start:desktop",
  ]);
  expect(result.ports).toEqual({ desktopd: 51001, stream: 51002 });
  expect(result.record.ownership).toEqual({
    internalNetwork: f.ids.internal,
    egressNetwork: f.ids.egress,
    gate: f.ids.gate,
    desktop: f.ids.desktop,
  });
  expect(JSON.stringify([...f.resources.values()])).not.toContain(f.ready.syntheticSecret);
  expect(result.record.keydPort).toBe(49123);
});

it("streams the diagnostic desktop in 4:2:0 like every installed computer", async () => {
  const f = fixture();
  await createCanaryTopology(f.journal, f.ready, f.client, signal());
  expect(f.resources.get("desktop")?.Config).toMatchObject({
    Env: expect.arrayContaining(["SELKIES_VIDEO_FULLCOLOR=false|locked"]),
  });
});

it.each(["run", "cell", "phase", "used", "cancelled", "engine", "image", "name-collision"])(
  "refuses %s before any create",
  async (fault) => {
    const f = fixture(),
      controller = new AbortController();
    if (fault === "run") f.ready.runId = "11111111-1111-4111-8111-111111111111";
    if (fault === "cell") f.ready.cellId = "01JXYZ00000000000000000002";
    if (fault === "phase") f.operation.phase = "retired";
    if (fault === "used") f.operation.resources.home = true;
    if (fault === "cancelled") controller.abort();
    if (fault === "engine")
      f.client.engine = async () => ({
        id: "other",
        operatingSystem: "linux",
        architecture: "arm64",
      });
    if (fault === "image") f.client.image = async () => null;
    if (fault === "name-collision") f.resources.set("home", { Name: f.names.homeVolume });
    await expect(
      createCanaryTopology(f.journal, f.ready, f.client, controller.signal),
    ).rejects.toThrow();
    expect(f.events).toEqual([]);
  },
);

it.each(["isolation", "ipv6", "gateway", "public-subnet", "overlap", "foreign-endpoint", "labels"])(
  "refuses a network with %s before container creation",
  async (fault) => {
    const f = fixture(),
      original = f.client.createNetwork;
    f.client.createNetwork = async (...args) => {
      const result = await original(...args),
        role = args[0],
        raw = f.resources.get(role);
      if (!raw) throw new Error("fixture");
      if (role === "internal") {
        if (fault === "isolation") raw.Options = {};
        if (fault === "ipv6") raw.EnableIPv6 = true;
        if (fault === "gateway")
          raw.IPAM = { Config: [{ Subnet: "172.20.0.0/24", Gateway: "172.20.0.1" }] };
        if (fault === "public-subnet") raw.IPAM = { Config: [{ Subnet: "8.8.8.0/24" }] };
        if (fault === "foreign-endpoint") raw.Containers = { foreign: {} };
        if (fault === "labels") raw.Labels = {};
      }
      if (role === "egress" && fault === "overlap")
        raw.IPAM = { Config: [{ Subnet: "172.20.0.0/24", Gateway: "172.20.0.1" }] };
      return result;
    };
    await expect(createCanaryTopology(f.journal, f.ready, f.client, signal())).rejects.toThrow();
    expect(f.events.some((e) => e === "create:gate" || e === "create:desktop")).toBe(false);
  },
);

it.each([
  "privileged",
  "host-pid",
  "host-ipc",
  "bind",
  "cap-add",
  "all-ports",
  "auto-remove",
  "command",
  "entrypoint",
  "environment",
  "image",
  "gate-mount",
  "restart",
  "public-bind",
])("refuses %s container before starting", async (fault) => {
  const f = fixture(),
    original = f.client.createContainer;
  f.client.createContainer = async (...args) => {
    const result = await original(...args),
      raw = f.resources.get(args[0]);
    if (!raw) throw new Error("fixture");
    const host = raw.HostConfig as Record<string, unknown>,
      config = raw.Config as Record<string, unknown>;
    if (fault === "privileged") host.Privileged = true;
    if (fault === "host-pid") host.PidMode = "host";
    if (fault === "host-ipc") host.IpcMode = "host";
    if (fault === "bind") host.Binds = ["/:/host"];
    if (fault === "cap-add") host.CapAdd = ["SYS_ADMIN"];
    if (fault === "all-ports") host.PublishAllPorts = true;
    if (fault === "auto-remove") host.AutoRemove = true;
    if (fault === "command") config.Cmd = ["unapproved"];
    if (fault === "entrypoint") config.Entrypoint = ["unapproved"];
    if (fault === "environment") (config.Env as string[]).push("LD_KEYD_PORT=1");
    if (fault === "image") raw.Image = `sha256:${"f".repeat(64)}`;
    if (fault === "gate-mount") host.Mounts = [{ Type: "bind", Source: "/", Target: "/host" }];
    if (fault === "restart") host.RestartPolicy = { Name: "always" };
    if (fault === "public-bind")
      host.PortBindings = { "8081/tcp": [{ HostIp: "0.0.0.0", HostPort: "" }] };
    return result;
  };
  await expect(createCanaryTopology(f.journal, f.ready, f.client, signal())).rejects.toThrow();
  expect(f.events.some((e) => e.startsWith("start:"))).toBe(false);
});

it.each([
  "attachment",
  "network-id",
  "address",
  "public-port",
  "extra-port",
  "endpoint",
  "image-change",
  "engine-change",
])("refuses %s in final running state", async (fault) => {
  const f = fixture(),
    original = f.client.start;
  f.client.start = async (...args) => {
    await original(...args);
    if (args[0] !== f.ids.desktop) return;
    const raw = f.resources.get("gate");
    if (!raw) throw new Error("fixture");
    const settings = raw.NetworkSettings as {
      Networks: Record<string, Record<string, unknown>>;
      Ports: Record<string, unknown>;
    };
    if (fault === "attachment") settings.Networks.foreign = {};
    if (fault === "network-id") {
      const n = settings.Networks[f.names.internalNetwork];
      if (n) n.NetworkID = "f".repeat(64);
    }
    if (fault === "address") {
      const n = settings.Networks[f.names.internalNetwork];
      if (n) n.IPAddress = "172.20.0.99";
    }
    if (fault === "public-port")
      settings.Ports["8081/tcp"] = [{ HostIp: "0.0.0.0", HostPort: "51001" }];
    if (fault === "extra-port")
      settings.Ports["9999/tcp"] = [{ HostIp: "127.0.0.1", HostPort: "51003" }];
    if (fault === "endpoint") {
      const net = f.resources.get("internal");
      if (net) (net.Containers as Record<string, unknown>).foreign = {};
    }
    if (fault === "image-change") f.client.image = async () => null;
    if (fault === "engine-change")
      f.client.engine = async () => ({
        id: "foreign",
        operatingSystem: "linux",
        architecture: "arm64",
      });
  };
  await expect(createCanaryTopology(f.journal, f.ready, f.client, signal())).rejects.toThrow();
});

it.each(["create", "capture", "wire", "connect", "start"])(
  "preserves recorded intent on uncertain %s without retrying it",
  async (fault) => {
    const f = fixture();
    if (fault === "create") {
      const original = f.client.createNetwork;
      f.client.createNetwork = async (...args) => {
        await original(...args);
        throw new Error("lost create");
      };
    }
    if (fault === "capture")
      f.journal.capture = async () => {
        throw new Error("lost journal write");
      };
    if (fault === "wire")
      f.client.wireDesktop = async () => {
        throw new Error("lost archive reply");
      };
    if (fault === "connect")
      f.client.connect = async () => {
        throw new Error("lost connect reply");
      };
    if (fault === "start")
      f.client.start = async () => {
        throw new Error("lost start reply");
      };
    await expect(createCanaryTopology(f.journal, f.ready, f.client, signal())).rejects.toThrow();
    expect(f.events.filter((e) => e === "create:internal")).toHaveLength(1);
    expect(f.resources.has("internal")).toBe(true);
  },
);

it.each([
  "127.0.0.0/24",
  "10.0.0.0/7",
  "172.15.0.0/16",
  "192.168.0.0/15",
  "10.0.0.0/29",
  "10.0.0.1/24",
  "010.0.0.0/24",
  "10.0.0.0/32",
  "::/64",
])("refuses unsafe subnet %s", (cidr) => {
  expect(() => canarySubnet(cidr)).toThrow();
});

it("rechecks a running topology without creating, starting or wiring anything", async () => {
  const f = fixture(),
    made = await createCanaryTopology(f.journal, f.ready, f.client, signal());
  const prior = [...f.events];
  expect(await inspectRunningCanaryTopology(f.operation, made.record, f.client, signal())).toEqual(
    made.ports,
  );
  expect(f.events).toEqual(prior);
});
it.each([
  "engine",
  "image",
  "stopped",
  "label",
  "extra-network",
  "network-member",
  "subnet",
  "port",
  "home",
  "record",
  "journal",
])("rejects a changed %s during the read-only readiness inspection", async (fault) => {
  const f = fixture(),
    made = await createCanaryTopology(f.journal, f.ready, f.client, signal());
  if (fault === "engine")
    f.client.engine = async () => ({
      id: "other",
      operatingSystem: "linux",
      architecture: "arm64",
    });
  if (fault === "image") f.client.image = async () => ({ Id: `sha256:${"0".repeat(64)}` });
  if (fault === "record") made.record.ownership = undefined;
  if (fault === "journal") f.operation.resources.desktop = "9".repeat(64);
  const role = ["stopped", "label", "extra-network", "port"].includes(fault)
    ? "gate"
    : fault === "home"
      ? "home"
      : "internal";
  const value = f.resources.get(role);
  if (!value) throw new Error("fixture");
  if (fault === "stopped")
    value.State = { Running: false, Paused: false, Restarting: false, Dead: false };
  if (fault === "label") (value.Config as Record<string, unknown>).Labels = {};
  if (fault === "extra-network")
    (
      (value.NetworkSettings as Record<string, unknown>).Networks as Record<string, unknown>
    ).foreign = {};
  if (fault === "network-member")
    (value.Containers as Record<string, unknown>)["9".repeat(64)] = {};
  if (fault === "subnet") value.IPAM = { Config: [{ Subnet: "172.22.0.0/24" }] };
  if (fault === "port")
    (value.NetworkSettings as Record<string, unknown>).Ports = {
      "8081/tcp": [{ HostIp: "0.0.0.0", HostPort: "51001" }],
    };
  if (fault === "home") value.Options = { device: "/foreign" };
  const prior = [...f.events];
  await expect(
    inspectRunningCanaryTopology(f.operation, made.record, f.client, signal()),
  ).rejects.toThrow();
  expect(f.events).toEqual(prior);
});
