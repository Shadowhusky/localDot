### Task 8: Container specs and the cell orchestrator

**Files:**
- Create: `apps/daemon/src/cells/images.ts`, `apps/daemon/src/cells/spec.ts`,
  `apps/daemon/src/cells/readiness.ts`, `apps/daemon/src/cells/orchestrator.ts`,
  `apps/daemon/src/cells/testing/fake-docker.ts`
- Test: `apps/daemon/src/cells/spec.test.ts`, `apps/daemon/src/cells/orchestrator.test.ts`,
  `apps/daemon/src/cells/orchestrator.docker.test.ts`

**Interfaces:**
- Consumes: `DockerClient`, `DockerError` (Task 6); `CellStore`, `newCellToken`, `allocateKeydPort`,
  the types (Task 7); `hostAddress` (Task 1).
- Produces: `imagesFromEnv(env?): Images` (`LOCALDOT_DESKTOP_IMAGE`, `LOCALDOT_GATE_IMAGE`, defaults
  `localdot/desktop:dev`, `localdot/gate:dev`); pure spec builders `cellNames(id, prefix = NAME_PREFIX)`
  (`NAME_PREFIX = "localdot-"`), `isolatedNetworkSpec(name)` (internal, isolated gateway mode, no
  labels), `internalNetworkSpec(name)` (the same plus the `localdot.cell` label),
  `egressNetworkSpec(name)`, `homeVolumeSpec(name)`,
  `gateSpec(record, image)`, `desktopSpec(record, image)`, `desktopEnv(record)`, constants
  `GATE_OFFSET = 10`, `DESKTOP_OFFSET = 11`, `GATE_PORTS`, `DESKTOP_LIMITS`, `DESKTOPD_PORT = 7700`,
  `SELKIES_PORT = 3000`; `probeDesktopd(endpoint)`, `probeStream(endpoint)`;
  `class CellOrchestrator { list(); get(id); record(id); endpoints(id): CellEndpoints | undefined; create({scale}); start(id); stop(id); remove(id, {purgeHome?}); reconcile(); subscribe(listener); updateStream(id, patch); dispose() }`
  (deps also take `namePrefix` = `"localdot-"`, which the Docker test sets to `"localdot-test-"`,
  `watchEveryMs` = 5000 and `restartBackoffMs` = [2000, 4000, 8000, 16000, 30000]:
  a ready cell is watched, an exited container is restarted with that backoff and its ports re-read,
  and the cell fails once the list is exhausted; a stop, a remove or a newer start that lands while
  a watch, readiness or start loop awaits wins, and that loop ends without touching the cell's
  state; `create` reserves the keyd port before its first await), `UnknownCellError`,
  `endpointsFor(record, ports)`.

- [ ] **Step 1: Write the failing spec test**

`apps/daemon/src/cells/spec.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import {
  cellNames,
  DESKTOP_LIMITS,
  desktopSpec,
  egressNetworkSpec,
  gateSpec,
  ISOLATED_GATEWAY_OPTION,
  internalNetworkSpec,
  isolatedNetworkSpec,
} from "./spec.ts";
import { sampleRecord } from "./testing/sample-record.ts";

const record = sampleRecord("01JXYZ0000000000000000ABCD");

describe("network specs", () => {
  it("creates every cell network internal with isolated gateway mode", () => {
    expect(internalNetworkSpec("n")).toMatchObject({
      Name: "n",
      Driver: "bridge",
      Internal: true,
      Options: { [ISOLATED_GATEWAY_OPTION]: "isolated" },
      Labels: { "localdot.cell": "1" },
    });
    expect(isolatedNetworkSpec("p")).toEqual({
      Name: "p",
      Driver: "bridge",
      Internal: true,
      Options: { [ISOLATED_GATEWAY_OPTION]: "isolated" },
    });
    expect(egressNetworkSpec("e")).toMatchObject({ Name: "e", Driver: "bridge" });
    expect((egressNetworkSpec("e") as { Internal?: boolean }).Internal).toBeUndefined();
  });

  it("derives every Docker object name from the cell id and the name prefix", () => {
    expect(cellNames("X")).toEqual({
      internalNetwork: "localdot-cell-X",
      egressNetwork: "localdot-egress-X",
      homeVolume: "localdot-home-X",
      gate: "localdot-gate-X",
      desktop: "localdot-desktop-X",
    });
    expect(cellNames("X", "localdot-test-").desktop).toBe("localdot-test-desktop-X");
  });
});

describe("gateSpec", () => {
  const spec = gateSpec(record, "localdot/gate:dev");

  it("is read-only, unprivileged, capability-free and bound to 127.0.0.1", () => {
    expect(spec.HostConfig).toMatchObject({
      NetworkMode: record.docker.egressNetwork,
      CapDrop: ["ALL"],
      ReadonlyRootfs: true,
      SecurityOpt: ["no-new-privileges"],
      PortBindings: {
        "8081/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }],
        "8082/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }],
      },
    });
    expect("Binds" in spec.HostConfig).toBe(false);
    expect("RestartPolicy" in spec.HostConfig).toBe(false);
    expect(spec.NetworkingConfig.EndpointsConfig[record.docker.egressNetwork]).toEqual({
      IPAMConfig: { IPv4Address: "172.25.0.10" },
    });
  });

  it("tells the relays their addresses and the cell's keyd port", () => {
    expect(spec.Env).toEqual([
      "LD_INTERNAL_ADDR=172.24.0.10",
      "LD_EGRESS_ADDR=172.25.0.10",
      "LD_DESKTOP_ADDR=172.24.0.11",
      "LD_KEYD_PORT=4760",
    ]);
  });
});

describe("desktopSpec", () => {
  const spec = desktopSpec(record, "localdot/desktop:dev");

  it("drops NET_RAW, keeps sudo possible, limits resources and mounts only the named home volume", () => {
    expect(spec.HostConfig).toMatchObject({
      NetworkMode: record.docker.internalNetwork,
      CapDrop: ["NET_RAW"],
      Mounts: [{ Type: "volume", Source: record.docker.homeVolume, Target: "/config" }],
      ShmSize: DESKTOP_LIMITS.shmBytes,
      Memory: DESKTOP_LIMITS.memoryBytes,
      MemorySwap: DESKTOP_LIMITS.memoryBytes,
      NanoCpus: DESKTOP_LIMITS.nanoCpus,
      PidsLimit: DESKTOP_LIMITS.pids,
    });
    expect("Binds" in spec.HostConfig).toBe(false);
    expect("SecurityOpt" in spec.HostConfig).toBe(false);
    expect("CapAdd" in spec.HostConfig).toBe(false);
    expect("RestartPolicy" in spec.HostConfig).toBe(false);
    expect(spec.NetworkingConfig.EndpointsConfig[record.docker.internalNetwork]).toEqual({
      IPAMConfig: { IPv4Address: "172.24.0.11" },
    });
  });

  it("passes only the per-cell tokens and the scale into the container", () => {
    const keys = spec.Env.map((e) => e.split("=")[0]);
    expect(keys).toEqual([
      "PUID", "PGID", "TZ", "LOCALDOT_SCALE", "SELKIES_MANUAL_WIDTH", "SELKIES_MANUAL_HEIGHT",
      "LOCALDOT_DESKTOPD_TOKEN", "PASSWORD",
    ]);
    expect(spec.Env).toContain(`LOCALDOT_DESKTOPD_TOKEN=${record.tokens.desktopd}`);
    expect(spec.Env).toContain(`PASSWORD=${record.tokens.stream}`);
    expect(spec.Env).toContain("SELKIES_MANUAL_WIDTH=2560");
    expect(desktopSpec({ ...record, scale: 1 }, "i").Env).toContain("SELKIES_MANUAL_HEIGHT=800");
  });
});
```

- [ ] **Step 2: Run it to see it fail, then implement the specs**

Run: `pnpm exec vitest run apps/daemon/src/cells/spec.test.ts`
Expected: FAIL — `Failed to load url ./spec.ts`.

`apps/daemon/src/cells/images.ts`:
```ts
export interface Images {
  desktop: string;
  gate: string;
}

export function imagesFromEnv(env: NodeJS.ProcessEnv = process.env): Images {
  return {
    desktop: env.LOCALDOT_DESKTOP_IMAGE || "localdot/desktop:dev",
    gate: env.LOCALDOT_GATE_IMAGE || "localdot/gate:dev",
  };
}
```

`apps/daemon/src/cells/spec.ts`:
```ts
import type { CellRecord } from "./types.ts";

export const ISOLATED_GATEWAY_OPTION = "com.docker.network.bridge.gateway_mode_ipv4";
export const GATE_OFFSET = 10;
export const DESKTOP_OFFSET = 11;
export const DESKTOPD_PORT = 7700;
export const SELKIES_PORT = 3000;
export const GATE_PORTS = { desktopd: "8081/tcp", stream: "8082/tcp" } as const;
export const DESKTOP_LIMITS = {
  memoryBytes: 4 * 1024 ** 3,
  nanoCpus: 4_000_000_000,
  pids: 4096,
  shmBytes: 1024 ** 3,
} as const;
export const NAME_PREFIX = "localdot-";
const LABELS = { "localdot.cell": "1" };

export function cellNames(id: string, prefix = NAME_PREFIX) {
  return {
    internalNetwork: `${prefix}cell-${id}`,
    egressNetwork: `${prefix}egress-${id}`,
    homeVolume: `${prefix}home-${id}`,
    gate: `${prefix}gate-${id}`,
    desktop: `${prefix}desktop-${id}`,
  };
}

// Plain --internal still exposes Docker Desktop VM listeners on the bridge gateway (S3, D14).
export function isolatedNetworkSpec(name: string) {
  return {
    Name: name,
    Driver: "bridge",
    Internal: true,
    Options: { [ISOLATED_GATEWAY_OPTION]: "isolated" },
  };
}

export function internalNetworkSpec(name: string) {
  return { ...isolatedNetworkSpec(name), Labels: LABELS };
}

export function egressNetworkSpec(name: string) {
  return { Name: name, Driver: "bridge", Labels: LABELS };
}

export function homeVolumeSpec(name: string) {
  return { Name: name, Labels: LABELS };
}

export function gateSpec(record: CellRecord, image: string) {
  const d = record.docker;
  return {
    Image: image,
    Env: [
      `LD_INTERNAL_ADDR=${d.gateInternalIp}`,
      `LD_EGRESS_ADDR=${d.gateEgressIp}`,
      `LD_DESKTOP_ADDR=${d.desktopIp}`,
      `LD_KEYD_PORT=${record.keydPort}`,
    ],
    Labels: { "localdot.cell": record.id, "localdot.role": "gate" },
    ExposedPorts: { [GATE_PORTS.desktopd]: {}, [GATE_PORTS.stream]: {} },
    HostConfig: {
      NetworkMode: d.egressNetwork,
      PortBindings: {
        [GATE_PORTS.desktopd]: [{ HostIp: "127.0.0.1", HostPort: "" }],
        [GATE_PORTS.stream]: [{ HostIp: "127.0.0.1", HostPort: "" }],
      },
      CapDrop: ["ALL"],
      ReadonlyRootfs: true,
      SecurityOpt: ["no-new-privileges"],
      Memory: 64 * 1024 ** 2,
      PidsLimit: 64,
    },
    NetworkingConfig: {
      EndpointsConfig: { [d.egressNetwork]: { IPAMConfig: { IPv4Address: d.gateEgressIp } } },
    },
  };
}

export function desktopEnv(record: CellRecord): string[] {
  const [w, h] = record.scale === 2 ? [2560, 1600] : [1280, 800];
  return [
    "PUID=1000",
    "PGID=1000",
    "TZ=Etc/UTC",
    `LOCALDOT_SCALE=${record.scale}`,
    `SELKIES_MANUAL_WIDTH=${w}`,
    `SELKIES_MANUAL_HEIGHT=${h}`,
    `LOCALDOT_DESKTOPD_TOKEN=${record.tokens.desktopd}`,
    `PASSWORD=${record.tokens.stream}`,
  ];
}

// The desktop keeps the default capability set minus NET_RAW and no no-new-privileges: the agent
// installs software with passwordless sudo (spec, Hardening). Neither container gets a Docker
// restart policy: the orchestrator restarts them itself and re-reads the ports (P2-R14).
export function desktopSpec(record: CellRecord, image: string) {
  const d = record.docker;
  return {
    Image: image,
    Env: desktopEnv(record),
    Labels: { "localdot.cell": record.id, "localdot.role": "desktop" },
    HostConfig: {
      NetworkMode: d.internalNetwork,
      Mounts: [{ Type: "volume", Source: d.homeVolume, Target: "/config" }],
      CapDrop: ["NET_RAW"],
      ShmSize: DESKTOP_LIMITS.shmBytes,
      Memory: DESKTOP_LIMITS.memoryBytes,
      MemorySwap: DESKTOP_LIMITS.memoryBytes,
      NanoCpus: DESKTOP_LIMITS.nanoCpus,
      PidsLimit: DESKTOP_LIMITS.pids,
    },
    NetworkingConfig: {
      EndpointsConfig: { [d.internalNetwork]: { IPAMConfig: { IPv4Address: d.desktopIp } } },
    },
  };
}
```

Run: `pnpm exec vitest run apps/daemon/src/cells/spec.test.ts`
Expected: 6 tests pass.

- [ ] **Step 3: Write the fake Docker API for the orchestrator tests**

`apps/daemon/src/cells/testing/fake-docker.ts` — an HTTP server on a temporary Unix socket that
implements the subset of the Engine API the orchestrator and `doctor` use, with in-memory state the
tests can read and mutate:
```ts
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface FakeContainer {
  name: string;
  body: { Image: string; HostConfig: Record<string, unknown>; NetworkingConfig?: { EndpointsConfig: Record<string, unknown> } };
  running: boolean;
  exitCode: number;
  starts: number;
  ports: Record<string, { HostIp: string; HostPort: string }[]>;
  networks: Record<string, unknown>;
}

export interface FakeNetwork {
  Id: string;
  Name: string;
  Internal: boolean;
  Options: Record<string, string>;
  subnet: string;
}

export interface FakeDockerState {
  version: { Version: string; ApiVersion: string; MinAPIVersion: string; Os: string; Arch: string };
  images: Set<string>;
  networks: Map<string, FakeNetwork>;
  volumes: Set<string>;
  containers: Map<string, FakeContainer>;
  calls: { method: string; path: string; query: URLSearchParams; body: unknown }[];
  nextPort: number;
  // An engine that ignores isolated gateway mode reports a gateway on internal networks.
  gatewayOnInternal: boolean;
  failCreate: Set<string>;
}

export interface FakeDocker {
  socketPath: string;
  state: FakeDockerState;
  close(): Promise<void>;
}

const json = (status: number, body: unknown) => ({ status, body });
const notFound = (what: string) => json(404, { message: `No such ${what}` });

export async function startFakeDocker(overrides: Partial<FakeDockerState> = {}): Promise<FakeDocker> {
  const state: FakeDockerState = {
    version: { Version: "29.2.0", ApiVersion: "1.53", MinAPIVersion: "1.44", Os: "linux", Arch: "arm64" },
    images: new Set(["localdot/desktop:dev", "localdot/gate:dev"]),
    networks: new Map(),
    volumes: new Set(),
    containers: new Map(),
    calls: [],
    nextPort: 50000,
    gatewayOnInternal: false,
    failCreate: new Set(),
    ...overrides,
  };
  let networkSeq = 20;

  // failCreate holds name prefixes: cell object names carry the (unpredictable) cell id.
  const failsCreate = (name: string) => [...state.failCreate].some((prefix) => name.startsWith(prefix));
  const findNetwork = (ref: string) =>
    state.networks.get(ref) ?? [...state.networks.values()].find((n) => n.Id === ref);
  const containerJson = (c: FakeContainer) => ({
    Id: `id-${c.name}`,
    Name: `/${c.name}`,
    State: { Running: c.running, ExitCode: c.exitCode, Error: "" },
    HostConfig: c.body.HostConfig,
    NetworkSettings: { Ports: c.running ? c.ports : {}, Networks: c.networks },
  });

  function handle(method: string, path: string, query: URLSearchParams, body: unknown): { status: number; body?: unknown } {
    if (method === "GET" && path === "/version") return json(200, state.version);
    const image = /^\/images\/(.+)\/json$/.exec(path);
    if (method === "GET" && image) {
      return state.images.has(decodeURIComponent(image[1] ?? "")) ? json(200, { Id: "sha256:img" }) : notFound("image");
    }
    if (method === "POST" && path === "/networks/create") {
      const spec = body as { Name: string; Internal?: boolean; Options?: Record<string, string> };
      if (failsCreate(spec.Name)) return json(500, { message: `refusing to create ${spec.Name}` });
      networkSeq += 1;
      const net: FakeNetwork = { Id: `net-${networkSeq}`, Name: spec.Name, Internal: spec.Internal ?? false, Options: spec.Options ?? {}, subnet: `172.${networkSeq}.0.0/16` };
      state.networks.set(net.Name, net);
      return json(201, { Id: net.Id, Warning: "" });
    }
    const network = /^\/networks\/([^/]+)$/.exec(path);
    if (network) {
      const net = findNetwork(network[1] ?? "");
      if (!net) return notFound("network");
      if (method === "DELETE") {
        state.networks.delete(net.Name);
        return { status: 204 };
      }
      const isolated = net.Internal && net.Options["com.docker.network.bridge.gateway_mode_ipv4"] === "isolated";
      const gateway = isolated && !state.gatewayOnInternal ? {} : { Gateway: net.subnet.replace(/0\/16$/, "1") };
      return json(200, { Id: net.Id, Name: net.Name, Internal: net.Internal, Options: net.Options, IPAM: { Config: [{ Subnet: net.subnet, ...gateway }] } });
    }
    const connect = /^\/networks\/([^/]+)\/connect$/.exec(path);
    if (method === "POST" && connect) {
      const net = findNetwork(connect[1] ?? "");
      const { Container, EndpointConfig } = body as { Container: string; EndpointConfig?: unknown };
      const c = state.containers.get(Container);
      if (!net || !c) return notFound("network or container");
      if (net.Name in c.networks) return json(403, { message: "endpoint already exists" });
      c.networks[net.Name] = EndpointConfig ?? {};
      return { status: 200 };
    }
    if (method === "POST" && path === "/volumes/create") {
      state.volumes.add((body as { Name: string }).Name);
      return json(201, { Name: (body as { Name: string }).Name });
    }
    const volume = /^\/volumes\/([^/]+)$/.exec(path);
    if (method === "DELETE" && volume) {
      return state.volumes.delete(volume[1] ?? "") ? { status: 204 } : notFound("volume");
    }
    if (method === "POST" && path === "/containers/create") {
      const name = query.get("name") ?? "";
      if (failsCreate(name)) return json(500, { message: `refusing to create ${name}` });
      const spec = body as FakeContainer["body"];
      const networks: Record<string, unknown> = {};
      for (const [net, cfg] of Object.entries(spec.NetworkingConfig?.EndpointsConfig ?? {})) networks[net] = cfg;
      state.containers.set(name, { name, body: spec, running: false, exitCode: 0, starts: 0, ports: {}, networks });
      return json(201, { Id: `id-${name}`, Warnings: [] });
    }
    const action = /^\/containers\/([^/]+)\/(json|start|stop)$/.exec(path);
    if (action) {
      const c = state.containers.get(action[1] ?? "");
      if (!c) return notFound("container");
      if (action[2] === "json") return json(200, containerJson(c));
      if (action[2] === "start") {
        if (c.running) return { status: 304 };
        c.starts += 1;
        c.running = true;
        c.ports = {};
        for (const port of Object.keys((c.body.HostConfig.PortBindings as Record<string, unknown>) ?? {})) {
          c.ports[port] = [{ HostIp: "127.0.0.1", HostPort: String(state.nextPort++) }];
        }
        return { status: 204 };
      }
      if (!c.running) return { status: 304 };
      c.running = false;
      c.exitCode = 0;
      return { status: 204 };
    }
    const container = /^\/containers\/([^/]+)$/.exec(path);
    if (method === "DELETE" && container) {
      return state.containers.delete(container[1] ?? "") ? { status: 204 } : notFound("container");
    }
    return json(404, { message: `fake docker: no route ${method} ${path}` });
  }

  const socketPath = join(mkdtempSync(join(tmpdir(), "ld-fake-docker-")), "d.sock");
  const server: Server = createServer((req, res) => {
    let text = "";
    req.on("data", (c) => {
      text += c;
    });
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://docker");
      const path = url.pathname.replace(/^\/v1\.\d+/, "");
      const body = text ? JSON.parse(text) : undefined;
      state.calls.push({ method: req.method ?? "", path, query: url.searchParams, body });
      const out = handle(req.method ?? "", path, url.searchParams, body);
      if (out.body === undefined) {
        res.writeHead(out.status);
        res.end();
        return;
      }
      res.writeHead(out.status, { "content-type": "application/json" });
      res.end(JSON.stringify(out.body));
    });
  });
  await new Promise<void>((r) => server.listen(socketPath, r));
  return {
    socketPath,
    state,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
```

- [ ] **Step 4: Write the failing orchestrator test**

`apps/daemon/src/cells/orchestrator.test.ts`:
```ts
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DockerClient } from "./docker.ts";
import { CellOrchestrator, UnknownCellError } from "./orchestrator.ts";
import { ISOLATED_GATEWAY_OPTION } from "./spec.ts";
import { CellStore } from "./store.ts";
import { type FakeDocker, startFakeDocker } from "./testing/fake-docker.ts";
import { sampleRecord } from "./testing/sample-record.ts";
import type { CellSummary, DesktopdHealth } from "./types.ts";

const images = { desktop: "localdot/desktop:dev", gate: "localdot/gate:dev" };
const healthy: DesktopdHealth = {
  ok: true,
  scale: 2,
  display: ":1",
  screen: { w: 2560, h: 1600 },
  hidpi: { ok: true, expected: { windowScalingFactor: 2, xftDpi: 96 }, windowScalingFactor: 2, xftDpi: 96 },
};

let fake: FakeDocker;
const made: CellOrchestrator[] = [];
afterEach(async () => {
  for (const o of made.splice(0)) o.dispose();
  await fake?.close();
});

// The default probe answers like a real desktop: healthy only while the fake container runs.
const runningDesktop = (store: CellStore) => () => {
  const names = store.list().map((r) => r.docker.desktop);
  return names.every((n) => fake.state.containers.get(n)?.running) ? healthy : undefined;
};

async function setup(
  opts: {
    desktopd?: (store: CellStore) => () => DesktopdHealth | undefined;
    stream?: () => boolean;
    readyTimeoutMs?: number;
    restartBackoffMs?: number[];
    sleep?: (ms: number) => Promise<void>;
  } = {},
) {
  fake = await startFakeDocker();
  const home = mkdtempSync(join(tmpdir(), "local dot's orch-"));
  const store = new CellStore(home);
  const changes: CellSummary[] = [];
  const probe = (opts.desktopd ?? runningDesktop)(store);
  const orchestrator = new CellOrchestrator({
    docker: new DockerClient(fake.socketPath),
    store,
    images,
    probeDesktopd: async () => probe(),
    probeStream: async () => (opts.stream ?? (() => true))(),
    sleep: opts.sleep ?? (async () => {}),
    readyTimeoutMs: opts.readyTimeoutMs ?? 5000,
    watchEveryMs: 0,
    restartBackoffMs: opts.restartBackoffMs ?? [0, 0],
  });
  made.push(orchestrator);
  orchestrator.subscribe((cell) => changes.push(cell));
  const stateOf = (id: string, state: CellSummary["state"]) =>
    new Promise<CellSummary>((resolve) => {
      const hit = changes.find((c) => c.id === id && c.state === state);
      if (hit) return resolve(hit);
      orchestrator.subscribe((cell) => {
        if (cell.id === id && cell.state === state) resolve(cell);
      });
    });
  return { orchestrator, store, home, changes, stateOf };
}

describe("CellOrchestrator.create", () => {
  it("provisions networks, volume and hardened containers, then reaches ready", async () => {
    const { orchestrator, store, home, stateOf } = await setup();
    const cell = await orchestrator.create({ scale: 2 });
    expect(cell.state).toBe("starting");
    await stateOf(cell.id, "ready");

    const record = store.get(cell.id);
    expect(record).toBeDefined();
    expect(statSync(join(home, "cells", cell.id, "cell.json")).mode & 0o777).toBe(0o600);
    expect(record?.keydPort).toBe(4760);
    expect(record?.docker).toMatchObject({
      gateInternalIp: "172.21.0.10",
      desktopIp: "172.21.0.11",
      gateEgressIp: "172.22.0.10",
    });

    const internal = fake.state.networks.get(record?.docker.internalNetwork ?? "");
    expect(internal).toMatchObject({ Internal: true, Options: { [ISOLATED_GATEWAY_OPTION]: "isolated" } });
    expect(fake.state.volumes.has(record?.docker.homeVolume ?? "")).toBe(true);

    const gate = fake.state.containers.get(record?.docker.gate ?? "");
    const desktop = fake.state.containers.get(record?.docker.desktop ?? "");
    expect(gate?.body.HostConfig).toMatchObject({ CapDrop: ["ALL"], ReadonlyRootfs: true });
    expect(gate?.networks).toEqual({
      [record?.docker.egressNetwork ?? ""]: { IPAMConfig: { IPv4Address: "172.22.0.10" } },
      [record?.docker.internalNetwork ?? ""]: { IPAMConfig: { IPv4Address: "172.21.0.10" } },
    });
    expect(desktop?.body.HostConfig).toMatchObject({ CapDrop: ["NET_RAW"] });
    expect(desktop?.running).toBe(true);

    const order = fake.state.calls.map((c) => `${c.method} ${c.path}`);
    expect(order.indexOf(`POST /containers/${record?.docker.gate}/start`)).toBeLessThan(
      order.indexOf(`POST /networks/${record?.docker.internalNetwork}/connect`),
    );
    expect(order.indexOf(`POST /networks/${record?.docker.internalNetwork}/connect`)).toBeLessThan(
      order.indexOf(`POST /containers/${record?.docker.desktop}/start`),
    );

    const endpoints = orchestrator.endpoints(cell.id);
    expect(endpoints?.desktopd).toEqual({ baseUrl: "http://127.0.0.1:50000", token: record?.tokens.desktopd });
    expect(endpoints?.stream).toEqual({
      baseUrl: "http://127.0.0.1:50001",
      authorization: `Basic ${Buffer.from(`localdot:${record?.tokens.stream}`).toString("base64")}`,
    });
  });

  it("undoes everything when the desktop container cannot be created", async () => {
    const { orchestrator, store } = await setup();
    fake.state.failCreate.add("localdot-desktop-");
    const err = await orchestrator.create({ scale: 2 }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("refusing to create");
    expect(store.list()).toEqual([]);
    expect(fake.state.networks.size).toBe(0);
    expect(fake.state.containers.size).toBe(0);
    expect(fake.state.volumes.size).toBe(0);
  });
});

describe("CellOrchestrator lifecycle", () => {
  it("reads new ports after a stop and start and connects the internal network only once", async () => {
    const { orchestrator, store, stateOf } = await setup();
    const cell = await orchestrator.create({ scale: 2 });
    await stateOf(cell.id, "ready");
    const before = orchestrator.endpoints(cell.id);
    await orchestrator.stop(cell.id);
    expect(orchestrator.get(cell.id)?.state).toBe("stopped");
    await orchestrator.start(cell.id);
    await stateOf(cell.id, "ready");
    const after = orchestrator.endpoints(cell.id);
    expect(after?.desktopd.baseUrl).not.toBe(before?.desktopd.baseUrl);
    const record = store.get(cell.id);
    const connects = fake.state.calls.filter((c) => c.path === `/networks/${record?.docker.internalNetwork}/connect`);
    expect(connects).toHaveLength(1);
  });

  it("fails with the exit code when the desktop container dies while starting", async () => {
    const { orchestrator, store, stateOf } = await setup({ desktopd: () => () => undefined });
    const cell = await orchestrator.create({ scale: 2 });
    const record = store.get(cell.id);
    const desktop = fake.state.containers.get(record?.docker.desktop ?? "");
    if (desktop) {
      desktop.running = false;
      desktop.exitCode = 137;
    }
    const failed = await stateOf(cell.id, "failed");
    expect(failed.error).toContain("exited with 137");
  });

  it("fails with the last detail when readiness times out", async () => {
    const { orchestrator, stateOf } = await setup({ desktopd: () => () => ({ ...healthy, ok: false }), readyTimeoutMs: 30 });
    const cell = await orchestrator.create({ scale: 2 });
    const failed = await stateOf(cell.id, "failed");
    expect(failed.error).toMatch(/not ready after/);
    expect(failed.error).toContain("desktopd not ready");
  });

  it("removes containers and networks, keeps the home volume unless purged, and emits removed", async () => {
    const { orchestrator, store, stateOf, changes } = await setup();
    const cell = await orchestrator.create({ scale: 2 });
    await stateOf(cell.id, "ready");
    const record = store.get(cell.id);
    await orchestrator.remove(cell.id);
    expect(fake.state.containers.size).toBe(0);
    expect(fake.state.networks.size).toBe(0);
    expect(fake.state.volumes.has(record?.docker.homeVolume ?? "")).toBe(true);
    expect(store.get(cell.id)).toBeUndefined();
    expect(changes.at(-1)).toMatchObject({ id: cell.id, state: "removed" });
    await expect(orchestrator.remove(cell.id)).rejects.toBeInstanceOf(UnknownCellError);
  });

  it("purges the home volume on request", async () => {
    const { orchestrator, store, stateOf } = await setup();
    const cell = await orchestrator.create({ scale: 2 });
    await stateOf(cell.id, "ready");
    const record = store.get(cell.id);
    await orchestrator.remove(cell.id, { purgeHome: true });
    expect(fake.state.volumes.has(record?.docker.homeVolume ?? "")).toBe(false);
  });
});

describe("CellOrchestrator restarts", () => {
  it("restarts an exited desktop with backoff and keeps the gate's published ports", async () => {
    const { orchestrator, store, stateOf, changes } = await setup();
    const cell = await orchestrator.create({ scale: 2 });
    await stateOf(cell.id, "ready");
    const before = orchestrator.endpoints(cell.id);
    const record = store.get(cell.id);
    const desktop = fake.state.containers.get(record?.docker.desktop ?? "");
    if (desktop) {
      desktop.running = false;
      desktop.exitCode = 137;
    }
    await new Promise<void>((resolve) => {
      const check = () =>
        changes.some((c) => c.id === cell.id && c.state === "starting" && (c.error ?? "").includes("restarting (attempt 1 of 2)"))
          ? resolve()
          : setTimeout(check, 5);
      check();
    });
    await new Promise<void>((resolve) => {
      const check = () => (desktop?.starts === 2 && orchestrator.get(cell.id)?.state === "ready" ? resolve() : setTimeout(check, 5));
      check();
    });
    expect(orchestrator.endpoints(cell.id)).toEqual(before);
    expect(orchestrator.get(cell.id)?.error).toBeUndefined();
  });

  it("restarts an exited gate with backoff and reads its new published ports", async () => {
    const { orchestrator, store, stateOf } = await setup();
    const cell = await orchestrator.create({ scale: 2 });
    await stateOf(cell.id, "ready");
    const before = orchestrator.endpoints(cell.id);
    const record = store.get(cell.id);
    const gate = fake.state.containers.get(record?.docker.gate ?? "");
    if (gate) {
      gate.running = false;
      gate.exitCode = 137;
    }
    await new Promise<void>((resolve) => {
      const check = () => (gate?.starts === 2 && orchestrator.get(cell.id)?.state === "ready" ? resolve() : setTimeout(check, 5));
      check();
    });
    const after = orchestrator.endpoints(cell.id);
    expect(after?.desktopd.baseUrl).not.toBe(before?.desktopd.baseUrl);
    expect(after?.stream.baseUrl).not.toBe(before?.stream.baseUrl);
    expect(orchestrator.get(cell.id)?.error).toBeUndefined();
  });

  it("gives up once the backoff list is exhausted, even across recoveries", async () => {
    const { orchestrator, store, stateOf } = await setup({ restartBackoffMs: [0] });
    const cell = await orchestrator.create({ scale: 2 });
    await stateOf(cell.id, "ready");
    const record = store.get(cell.id);
    const desktop = fake.state.containers.get(record?.docker.desktop ?? "");
    const kill = () => {
      if (desktop) {
        desktop.running = false;
        desktop.exitCode = 137;
      }
    };
    const until = (pred: () => boolean) =>
      new Promise<void>((resolve) => {
        const check = () => (pred() ? resolve() : setTimeout(check, 5));
        check();
      });
    kill();
    await until(() => desktop?.starts === 2 && orchestrator.get(cell.id)?.state === "ready");
    kill();
    await until(() => orchestrator.get(cell.id)?.state === "failed");
    expect(orchestrator.get(cell.id)?.error).toBe("desktop container exited with 137; gave up after 1 restarts");
    expect(desktop?.starts).toBe(2);
  });

  it("keeps a cell stopped when the stop lands during the restart backoff", async () => {
    const backoff = Promise.withResolvers<void>();
    const { orchestrator, store, stateOf, changes } = await setup({
      restartBackoffMs: [60_000],
      sleep: (ms) => (ms === 60_000 ? backoff.promise : Promise.resolve()),
    });
    const cell = await orchestrator.create({ scale: 2 });
    await stateOf(cell.id, "ready");
    const record = store.get(cell.id);
    const desktop = fake.state.containers.get(record?.docker.desktop ?? "");
    if (desktop) {
      desktop.running = false;
      desktop.exitCode = 137;
    }
    await new Promise<void>((resolve) => {
      const check = () =>
        changes.some((c) => c.id === cell.id && c.state === "starting" && (c.error ?? "").includes("restarting (attempt 1 of 1)"))
          ? resolve()
          : setTimeout(check, 5);
      check();
    });
    await orchestrator.stop(cell.id);
    backoff.resolve();
    await new Promise((r) => setTimeout(r, 50));
    expect(orchestrator.get(cell.id)?.state).toBe("stopped");
    expect(changes.at(-1)).toMatchObject({ id: cell.id, state: "stopped" });
    expect(desktop?.starts).toBe(1);
  });
});

describe("CellOrchestrator.reconcile", () => {
  it("marks a cell whose desktop died while its gate runs as failed with the exit code", async () => {
    const { orchestrator, store, stateOf } = await setup();
    const cell = await orchestrator.create({ scale: 2 });
    await stateOf(cell.id, "ready");
    orchestrator.dispose();
    const record = store.get(cell.id);
    const desktop = fake.state.containers.get(record?.docker.desktop ?? "");
    if (desktop) {
      desktop.running = false;
      desktop.exitCode = 139;
    }
    const fresh = new CellOrchestrator({
      docker: new DockerClient(fake.socketPath),
      store,
      images,
      probeDesktopd: async () => healthy,
      probeStream: async () => true,
      sleep: async () => {},
    });
    made.push(fresh);
    await fresh.reconcile();
    expect(fresh.get(cell.id)).toMatchObject({ state: "failed", error: expect.stringContaining("desktop container exited with 139") });
  });

  it("recovers running, stopped and vanished cells from their records", async () => {
    const { orchestrator, store, stateOf } = await setup();
    const running = await orchestrator.create({ scale: 2 });
    await stateOf(running.id, "ready");
    const stopped = await orchestrator.create({ scale: 2 });
    await stateOf(stopped.id, "ready");
    await orchestrator.stop(stopped.id);
    const vanished = sampleRecord();
    store.save(vanished);

    const fresh = new CellOrchestrator({
      docker: new DockerClient(fake.socketPath),
      store,
      images,
      probeDesktopd: async () => healthy,
      probeStream: async () => true,
      sleep: async () => {},
    });
    made.push(fresh);
    const seen: CellSummary[] = [];
    fresh.subscribe((c) => seen.push(c));
    await fresh.reconcile();
    await new Promise<void>((resolve) => {
      const check = () => (seen.some((c) => c.id === running.id && c.state === "ready") ? resolve() : setTimeout(check, 5));
      check();
    });
    expect(fresh.get(stopped.id)?.state).toBe("stopped");
    expect(fresh.get(vanished.id)).toMatchObject({ state: "failed", error: expect.stringContaining("removed outside localDot") });
    expect(fresh.list()).toHaveLength(3);
  });
});
```

- [ ] **Step 5: Run it to see it fail, then implement readiness and the orchestrator**

Run: `pnpm exec vitest run apps/daemon/src/cells/orchestrator.test.ts`
Expected: FAIL — `Failed to load url ./orchestrator.ts`.

`apps/daemon/src/cells/readiness.ts`:
```ts
import type { DesktopdEndpoint, DesktopdHealth, StreamEndpoint } from "./types.ts";

export async function probeDesktopd(endpoint: DesktopdEndpoint, timeoutMs = 3000): Promise<DesktopdHealth | undefined> {
  try {
    const res = await fetch(`${endpoint.baseUrl}/healthz`, {
      headers: { authorization: `Bearer ${endpoint.token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return undefined;
    return (await res.json()) as DesktopdHealth;
  } catch {
    return undefined;
  }
}

export async function probeStream(endpoint: StreamEndpoint, timeoutMs = 3000): Promise<boolean> {
  try {
    const res = await fetch(`${endpoint.baseUrl}/api/health`, {
      headers: { authorization: endpoint.authorization },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}
```

`apps/daemon/src/cells/orchestrator.ts`:
```ts
import { ulid } from "@localdot/protocol";
import { type DockerClient, DockerError } from "./docker.ts";
import type { Images } from "./images.ts";
import { hostAddress } from "./ipv4.ts";
import { allocateKeydPort } from "./ports.ts";
import { newCellToken } from "./secrets.ts";
import {
  cellNames,
  DESKTOP_OFFSET,
  desktopSpec,
  egressNetworkSpec,
  GATE_OFFSET,
  GATE_PORTS,
  gateSpec,
  homeVolumeSpec,
  internalNetworkSpec,
  NAME_PREFIX,
} from "./spec.ts";
import type { CellStore } from "./store.ts";
import {
  type CellEndpoints,
  type CellRecord,
  type CellState,
  type CellSummary,
  type DesktopdHealth,
  NO_STREAM,
  type Scale,
  type StreamState,
} from "./types.ts";

export interface OrchestratorDeps {
  docker: DockerClient;
  store: CellStore;
  images: Images;
  probeDesktopd(endpoint: CellEndpoints["desktopd"]): Promise<DesktopdHealth | undefined>;
  probeStream(endpoint: CellEndpoints["stream"]): Promise<boolean>;
  // Docker-backed tests pass "localdot-test-", so they never create or touch a real cell's objects.
  namePrefix?: string;
  sleep?: (ms: number) => Promise<void>;
  readyTimeoutMs?: number;
  watchEveryMs?: number;
  restartBackoffMs?: number[];
}

export type CellListener = (cell: CellSummary) => void;

export type CellApi = Pick<
  CellOrchestrator,
  "list" | "get" | "endpoints" | "create" | "start" | "stop" | "remove" | "subscribe" | "updateStream"
>;

interface Ports {
  desktopd: number;
  stream: number;
}

interface Live {
  state: CellState;
  restarts: number;
  error?: string;
  ports?: Ports;
  stream: StreamState;
}

interface NetworkInspect {
  Id: string;
  IPAM: { Config: { Subnet?: string }[] };
}

interface ContainerInspect {
  State: { Running: boolean; ExitCode: number; Error: string };
  NetworkSettings: {
    Ports: Record<string, { HostIp: string; HostPort: string }[] | null>;
    Networks: Record<string, unknown>;
  };
}

export class UnknownCellError extends Error {
  constructor(readonly cellId: string) {
    super(`unknown cell ${cellId}`);
    this.name = "UnknownCellError";
  }
}

export function endpointsFor(record: CellRecord, ports: Ports): CellEndpoints {
  const basic = Buffer.from(`localdot:${record.tokens.stream}`).toString("base64");
  return {
    desktopd: { baseUrl: `http://127.0.0.1:${ports.desktopd}`, token: record.tokens.desktopd },
    stream: { baseUrl: `http://127.0.0.1:${ports.stream}`, authorization: `Basic ${basic}` },
  };
}

const isStatus = (err: unknown, ...statuses: number[]) =>
  err instanceof DockerError && statuses.includes(err.status);

// Spec, error handling: a crashed cell is restarted with backoff. Docker's own restart policy is not
// used (P2-R14): it would restart behind the daemon's back and change the published ports unseen.
const DEFAULT_RESTART_BACKOFF_MS = [2000, 4000, 8000, 16000, 30000];

export class CellOrchestrator {
  readonly #docker: DockerClient;
  readonly #store: CellStore;
  readonly #images: Images;
  readonly #probeDesktopd: OrchestratorDeps["probeDesktopd"];
  readonly #probeStream: OrchestratorDeps["probeStream"];
  readonly #namePrefix: string;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #readyTimeoutMs: number;
  readonly #watchEveryMs: number;
  readonly #restartBackoffMs: number[];
  readonly #live = new Map<string, Live>();
  readonly #listeners = new Set<CellListener>();
  readonly #reservedKeydPorts = new Set<number>();
  #disposed = false;

  constructor(deps: OrchestratorDeps) {
    this.#docker = deps.docker;
    this.#store = deps.store;
    this.#images = deps.images;
    this.#probeDesktopd = deps.probeDesktopd;
    this.#probeStream = deps.probeStream;
    this.#namePrefix = deps.namePrefix ?? NAME_PREFIX;
    this.#sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.#readyTimeoutMs = deps.readyTimeoutMs ?? 180_000;
    this.#watchEveryMs = deps.watchEveryMs ?? 5000;
    this.#restartBackoffMs = deps.restartBackoffMs ?? DEFAULT_RESTART_BACKOFF_MS;
  }

  list(): CellSummary[] {
    return this.#store.list().map((record) => this.#summary(record));
  }

  get(id: string): CellSummary | undefined {
    const record = this.#store.get(id);
    return record && this.#summary(record);
  }

  record(id: string): CellRecord | undefined {
    return this.#store.get(id);
  }

  endpoints(id: string): CellEndpoints | undefined {
    const record = this.#store.get(id);
    const live = this.#live.get(id);
    if (!record || !live?.ports) return undefined;
    return endpointsFor(record, live.ports);
  }

  subscribe(listener: CellListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  updateStream(id: string, patch: Partial<StreamState>): void {
    const live = this.#live.get(id);
    if (!live) return;
    live.stream = { ...live.stream, ...patch };
    this.#emit(id);
  }

  // Stops the background watch and readiness loops; the daemon's process exit does the rest.
  dispose(): void {
    this.#disposed = true;
  }

  // Restart counters live in memory, so a daemon restart starts them again at 0.
  async reconcile(): Promise<void> {
    for (const record of this.#store.list()) {
      try {
        const desktop = await this.#inspect(record.docker.desktop);
        const gate = await this.#inspect(record.docker.gate);
        if (desktop.State.Running && gate.State.Running) {
          const ports = await this.#readPorts(record.docker.gate);
          this.#set(record.id, { state: "starting", restarts: 0, ports, stream: NO_STREAM });
          void this.#waitReady(record);
        } else if (!desktop.State.Running && !gate.State.Running) {
          this.#set(record.id, { state: "stopped", restarts: 0, stream: NO_STREAM });
        } else {
          const [role, info] = desktop.State.Running ? ["gate", gate] : ["desktop", desktop];
          this.#set(record.id, {
            state: "failed",
            restarts: 0,
            error: `${role} container exited with ${info.State.ExitCode}; stop and start the computer`,
            stream: NO_STREAM,
          });
        }
      } catch (err) {
        const error = isStatus(err, 404) ? "containers missing: removed outside localDot" : messageOf(err);
        this.#set(record.id, { state: "failed", restarts: 0, error, stream: NO_STREAM });
      }
    }
  }

  async create(opts: { scale: Scale }): Promise<CellSummary> {
    const id = ulid();
    const names = cellNames(id, this.#namePrefix);
    // keyd tells cells apart by their listener port (M3), so the port is reserved before the first
    // await: two concurrent creates never get the same one.
    const keydPort = allocateKeydPort([...this.#store.list().map((r) => r.keydPort), ...this.#reservedKeydPorts]);
    this.#reservedKeydPorts.add(keydPort);
    const undo: (() => Promise<unknown>)[] = [];
    try {
      const internal = await this.#docker.request<{ Id: string }>({
        method: "POST",
        path: "/networks/create",
        body: internalNetworkSpec(names.internalNetwork),
      });
      undo.push(() => this.#docker.request({ method: "DELETE", path: `/networks/${internal.Id}` }));
      const egress = await this.#docker.request<{ Id: string }>({
        method: "POST",
        path: "/networks/create",
        body: egressNetworkSpec(names.egressNetwork),
      });
      undo.push(() => this.#docker.request({ method: "DELETE", path: `/networks/${egress.Id}` }));
      const internalSubnet = await this.#subnet(internal.Id);
      const egressSubnet = await this.#subnet(egress.Id);
      await this.#docker.request({ method: "POST", path: "/volumes/create", body: homeVolumeSpec(names.homeVolume) });
      undo.push(() =>
        this.#docker.request({ method: "DELETE", path: `/volumes/${names.homeVolume}`, query: { force: "true" } }),
      );
      const record: CellRecord = {
        v: 1,
        id,
        createdAt: new Date().toISOString(),
        scale: opts.scale,
        keydPort,
        tokens: { desktopd: newCellToken(), stream: newCellToken() },
        docker: {
          ...names,
          gateInternalIp: hostAddress(internalSubnet, GATE_OFFSET),
          gateEgressIp: hostAddress(egressSubnet, GATE_OFFSET),
          desktopIp: hostAddress(internalSubnet, DESKTOP_OFFSET),
        },
      };
      for (const [name, spec] of [
        [names.gate, gateSpec(record, this.#images.gate)],
        [names.desktop, desktopSpec(record, this.#images.desktop)],
      ] as const) {
        await this.#docker.request({ method: "POST", path: "/containers/create", query: { name }, body: spec });
        undo.push(() =>
          this.#docker.request({ method: "DELETE", path: `/containers/${name}`, query: { force: "true" } }),
        );
      }
      this.#store.save(record);
      undo.push(async () => this.#store.remove(id));
      if (await this.#startContainers(record, 0)) void this.#waitReady(record);
      return this.#summary(record);
    } catch (err) {
      for (const step of undo.reverse()) await step().catch(() => {});
      this.#live.delete(id);
      throw err;
    } finally {
      this.#reservedKeydPorts.delete(keydPort);
    }
  }

  async start(id: string): Promise<void> {
    const record = this.#require(id);
    if (await this.#startContainers(record, 0)) void this.#waitReady(record);
  }

  async stop(id: string): Promise<void> {
    const record = this.#require(id);
    this.#set(id, { state: "stopping", restarts: 0, stream: NO_STREAM });
    for (const name of [record.docker.desktop, record.docker.gate]) {
      await this.#docker
        .request({ method: "POST", path: `/containers/${name}/stop`, query: { t: "10" } })
        .catch((err) => {
          if (!isStatus(err, 304, 404)) throw err;
        });
    }
    this.#set(id, { state: "stopped", restarts: 0, stream: NO_STREAM });
  }

  async remove(id: string, opts: { purgeHome?: boolean } = {}): Promise<void> {
    const record = this.#require(id);
    const d = record.docker;
    const ignoreMissing = (err: unknown) => {
      if (!isStatus(err, 404)) throw err;
    };
    for (const name of [d.desktop, d.gate]) {
      await this.#docker
        .request({ method: "DELETE", path: `/containers/${name}`, query: { force: "true" } })
        .catch(ignoreMissing);
    }
    for (const name of [d.internalNetwork, d.egressNetwork]) {
      await this.#docker.request({ method: "DELETE", path: `/networks/${name}` }).catch(ignoreMissing);
    }
    if (opts.purgeHome) {
      await this.#docker
        .request({ method: "DELETE", path: `/volumes/${d.homeVolume}`, query: { force: "true" } })
        .catch(ignoreMissing);
    }
    this.#set(id, { state: "removed", restarts: 0, stream: NO_STREAM });
    this.#store.remove(id);
    this.#live.delete(id);
  }

  // Resolves false when a stop, a remove or a newer start took the cell over while it ran.
  async #startContainers(record: CellRecord, restarts: number, error?: string): Promise<boolean> {
    const d = record.docker;
    const starting: Live = { state: "starting", restarts, stream: NO_STREAM, ...(error ? { error } : {}) };
    this.#set(record.id, starting);
    try {
      await this.#docker.request({ method: "POST", path: `/containers/${d.gate}/start` });
      // The gate starts on its egress network (where its ports are published) and joins the
      // internal network afterwards, the order S3 proved; a restarted gate is still connected.
      const gate = await this.#inspect(d.gate);
      if (!(d.internalNetwork in gate.NetworkSettings.Networks)) {
        await this.#docker.request({
          method: "POST",
          path: `/networks/${d.internalNetwork}/connect`,
          body: { Container: d.gate, EndpointConfig: { IPAMConfig: { IPv4Address: d.gateInternalIp } } },
        });
      }
      if (!this.#current(record.id, starting)) return false;
      await this.#docker.request({ method: "POST", path: `/containers/${d.desktop}/start` });
      // Every start publishes new host ports (Review Focus 2).
      const ports = await this.#readPorts(d.gate);
      if (!this.#current(record.id, starting)) return false;
      this.#set(record.id, { ...starting, ports });
      return true;
    } catch (err) {
      if (this.#current(record.id, starting)) {
        this.#set(record.id, { state: "failed", restarts, error: messageOf(err), stream: NO_STREAM });
      }
      throw err;
    }
  }

  async #waitReady(record: CellRecord): Promise<void> {
    const live = this.#live.get(record.id);
    if (this.#disposed || live?.state !== "starting" || !live.ports) return;
    const ports = live.ports;
    const endpoints = endpointsFor(record, ports);
    const deadline = Date.now() + this.#readyTimeoutMs;
    let lastDetail = "no answer from desktopd yet";
    while (Date.now() < deadline) {
      const health = await this.#probeDesktopd(endpoints.desktopd);
      if (!this.#current(record.id, live)) return;
      if (health?.ok) {
        const streaming = await this.#probeStream(endpoints.stream);
        if (!this.#current(record.id, live)) return;
        if (streaming) {
          // The restart count survives a recovery: it resets only on a user start or stop, so a
          // cell that keeps dying runs out of attempts instead of flapping forever.
          this.#set(record.id, { state: "ready", restarts: live.restarts, ports, stream: NO_STREAM });
          void this.#watch(record);
          return;
        }
        lastDetail = "desktopd is ready; the stream is not answering yet";
      } else if (health) {
        lastDetail = `desktopd not ready: hidpi ${JSON.stringify(health.hidpi)}, screen ${JSON.stringify(health.screen)}`;
      }
      const desktop = await this.#inspect(record.docker.desktop).catch(() => undefined);
      if (!this.#current(record.id, live)) return;
      if (desktop && !desktop.State.Running) {
        const detail = desktop.State.Error ? `: ${desktop.State.Error}` : "";
        this.#set(record.id, { ...live, state: "failed", error: `desktop container exited with ${desktop.State.ExitCode}${detail}` });
        return;
      }
      await this.#sleep(1000);
      if (!this.#current(record.id, live)) return;
    }
    this.#set(record.id, { ...live, state: "failed", error: `not ready after ${this.#readyTimeoutMs / 1000} s: ${lastDetail}` });
  }

  // Runs while the cell is ready: an exited container is restarted with backoff, and a cell that
  // keeps dying is marked failed once the backoff list is exhausted.
  async #watch(record: CellRecord): Promise<void> {
    const live = this.#live.get(record.id);
    if (live?.state !== "ready") return;
    for (;;) {
      await this.#sleep(this.#watchEveryMs);
      if (!this.#current(record.id, live)) return;
      const exited = await this.#exitedContainer(record);
      if (!this.#current(record.id, live)) return;
      if (exited === undefined) continue;
      const attempt = live.restarts + 1;
      if (attempt > this.#restartBackoffMs.length) {
        this.#set(record.id, { ...live, state: "failed", error: `${exited}; gave up after ${live.restarts} restarts` });
        return;
      }
      const note = `${exited}; restarting (attempt ${attempt} of ${this.#restartBackoffMs.length})`;
      const restarting: Live = { ...live, state: "starting", restarts: attempt, error: note };
      this.#set(record.id, restarting);
      await this.#sleep(this.#restartBackoffMs[attempt - 1] ?? 0);
      if (!this.#current(record.id, restarting)) return;
      if (await this.#startContainers(record, attempt, note).catch(() => false)) await this.#waitReady(record);
      return;
    }
  }

  // A loop that awaited goes on only while the cell still holds the entry it set or read: a stop, a
  // remove, a newer start or dispose() in the meantime wins (a user's Stop beats a restart).
  #current(id: string, entry: Live): boolean {
    return !this.#disposed && this.#live.get(id) === entry;
  }

  async #exitedContainer(record: CellRecord): Promise<string | undefined> {
    for (const [role, name] of [
      ["desktop", record.docker.desktop],
      ["gate", record.docker.gate],
    ] as const) {
      const info = await this.#inspect(name).catch(() => undefined);
      if (info && !info.State.Running) return `${role} container exited with ${info.State.ExitCode}`;
    }
    return undefined;
  }

  async #readPorts(gate: string): Promise<Ports> {
    const info = await this.#inspect(gate);
    const port = (key: string) => {
      const p = Number(info.NetworkSettings.Ports[key]?.[0]?.HostPort);
      if (!Number.isInteger(p) || p <= 0) throw new Error(`gate ${gate}: no published host port for ${key}`);
      return p;
    };
    return { desktopd: port(GATE_PORTS.desktopd), stream: port(GATE_PORTS.stream) };
  }

  #inspect(name: string): Promise<ContainerInspect> {
    return this.#docker.request<ContainerInspect>({ method: "GET", path: `/containers/${name}/json` });
  }

  async #subnet(networkId: string): Promise<string> {
    const info = await this.#docker.request<NetworkInspect>({ method: "GET", path: `/networks/${networkId}` });
    const subnet = info.IPAM.Config[0]?.Subnet;
    if (!subnet) throw new Error(`network ${networkId} has no IPv4 subnet`);
    return subnet;
  }

  #require(id: string): CellRecord {
    const record = this.#store.get(id);
    if (!record) throw new UnknownCellError(id);
    return record;
  }

  #set(id: string, live: Live): void {
    this.#live.set(id, live);
    this.#emit(id);
  }

  #emit(id: string): void {
    const record = this.#store.get(id);
    if (!record) return;
    const summary = this.#summary(record);
    for (const listener of this.#listeners) {
      try {
        listener(summary);
      } catch (err) {
        console.error(`cell listener failed: ${String(err)}`);
      }
    }
  }

  #summary(record: CellRecord): CellSummary {
    const live = this.#live.get(record.id) ?? { state: "stopped" as const, restarts: 0, stream: NO_STREAM };
    return {
      id: record.id,
      state: live.state,
      scale: record.scale,
      createdAt: record.createdAt,
      stream: live.stream,
      ...(live.error ? { error: live.error } : {}),
    };
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
```

- [ ] **Step 6: Run the orchestrator tests**

Run: `pnpm exec vitest run apps/daemon/src/cells/orchestrator.test.ts apps/daemon/src/cells/spec.test.ts`
Expected: 19 tests pass (6 spec, 13 orchestrator). Note for the reviewer: the fake assigns ports
from 50000 upwards each time a stopped container starts, and answers a start of a running one with
304, as Docker does; the published ports are the gate's, so the stop/start and gate-restart tests
see new endpoints and the desktop-restart test sees the old ones. The restart tests use
`watchEveryMs: 0` with an immediate `sleep`, except the stop-during-backoff test, whose `sleep`
holds the 60 s backoff open until the stop has landed.

- [ ] **Step 7: The Docker-backed isolation test**

`apps/daemon/src/cells/orchestrator.docker.test.ts`:
```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DockerClient } from "./docker.ts";
import { imagesFromEnv } from "./images.ts";
import { CellOrchestrator } from "./orchestrator.ts";
import { probeDesktopd, probeStream } from "./readiness.ts";
import { CellStore } from "./store.ts";
import { DOCKER_TESTS, docker, dockerExec, dockerOk } from "./testing/docker-cli.ts";
import type { CellSummary } from "./types.ts";

const PREFIX = "localdot-test-";

describe.skipIf(!DOCKER_TESTS)("CellOrchestrator against Docker Desktop", () => {
  const store = new CellStore(mkdtempSync(join(tmpdir(), "local dot's orch-docker-")));
  const orchestrator = new CellOrchestrator({
    docker: new DockerClient(),
    store,
    images: imagesFromEnv(),
    probeDesktopd,
    probeStream,
    namePrefix: PREFIX,
  });
  let cell: CellSummary | undefined;

  afterAll(async () => {
    if (cell && store.get(cell.id)) await orchestrator.remove(cell.id, { purgeHome: true }).catch(() => {});
  });

  it("creates a ready cell whose desktop reaches nothing but its gate", async () => {
    cell = await orchestrator.create({ scale: 2 });
    const ready = await new Promise<CellSummary>((resolve, reject) => {
      orchestrator.subscribe((c) => {
        if (c.id !== cell?.id) return;
        if (c.state === "ready") resolve(c);
        if (c.state === "failed") reject(new Error(c.error));
      });
    });
    expect(ready.state).toBe("ready");
    const record = store.get(cell.id);
    if (!record) throw new Error("record missing");
    const desktop = record.docker.desktop;
    expect(desktop).toBe(`${PREFIX}desktop-${cell.id}`);

    expect(dockerExec(desktop, "curl", "-sS", "-m", "5", "https://example.com").status).not.toBe(0);
    expect(dockerExec(desktop, "curl", "-sS", "-m", "5", "http://host.docker.internal:4750/").status).not.toBe(0);
    expect(dockerExec(desktop, "sh", "-c", "getent hosts example.com").status).not.toBe(0);
    expect(dockerExec(desktop, "timeout", "5", "bash", "-c", `exec 3<>/dev/tcp/${record.docker.gateInternalIp}/3128`).status).toBe(0);
    expect(docker("inspect", "-f", "{{.HostConfig.CapDrop}} {{.HostConfig.Binds}}", desktop)).toBe("[NET_RAW] []");
    expect(docker("inspect", "-f", "{{range .Mounts}}{{.Type}}:{{.Destination}} {{end}}", desktop).trim()).toBe("volume:/config");
    expect(docker("inspect", "-f", "{{.HostConfig.ReadonlyRootfs}} {{.HostConfig.CapDrop}}", record.docker.gate)).toBe("true [ALL]");
    expect(docker("inspect", "-f", "{{.HostConfig.RestartPolicy.Name}}", desktop)).toMatch(/^(no)?$/);
    // Engine 29 renders the unset gateway of an isolated network as "invalid IP" (S3 saw the same).
    expect(["", "invalid IP"]).toContain(docker("network", "inspect", "-f", "{{range .IPAM.Config}}{{.Gateway}}{{end}}", record.docker.internalNetwork));
    // NET_RAW is dropped: not even root inside the desktop can open a raw socket (D15, A13).
    expect(dockerExec(desktop, "python3", "-c", "import socket; socket.socket(socket.AF_PACKET, socket.SOCK_RAW)").status).not.toBe(0);

    const endpoints = orchestrator.endpoints(cell.id);
    if (!endpoints) throw new Error("endpoints missing");
    expect(endpoints.desktopd.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const health = await probeDesktopd(endpoints.desktopd);
    expect(health?.ok).toBe(true);
  }, 300_000);

  it("stops, starts with new ports, and removes everything but the home volume", async () => {
    if (!cell) throw new Error("no cell");
    const record = store.get(cell.id);
    if (!record) throw new Error("record missing");
    const before = orchestrator.endpoints(cell.id)?.desktopd.baseUrl;
    await orchestrator.stop(cell.id);
    expect(dockerOk("inspect", "-f", "{{.State.Running}}", record.docker.desktop)).toBe(true);
    expect(docker("inspect", "-f", "{{.State.Running}}", record.docker.desktop)).toBe("false");
    await orchestrator.start(cell.id);
    await new Promise<void>((resolve, reject) => {
      orchestrator.subscribe((c) => {
        if (c.id !== cell?.id) return;
        if (c.state === "ready") resolve();
        if (c.state === "failed") reject(new Error(c.error));
      });
    });
    expect(orchestrator.endpoints(cell.id)?.desktopd.baseUrl).not.toBe(before);

    await orchestrator.remove(cell.id);
    expect(dockerOk("inspect", record.docker.desktop)).toBe(false);
    expect(dockerOk("inspect", record.docker.gate)).toBe(false);
    expect(dockerOk("network", "inspect", record.docker.internalNetwork)).toBe(false);
    expect(dockerOk("volume", "inspect", record.docker.homeVolume)).toBe(true);
    docker("volume", "rm", record.docker.homeVolume);
    cell = undefined;
  }, 300_000);
});
```

Run: `LOCALDOT_DOCKER_TESTS=1 pnpm test:docker apps/daemon/src/cells/orchestrator.docker.test.ts`
Expected: 2 tests pass in about 2–4 minutes. `docker ps -a --filter name=localdot-test-`,
`docker network ls --filter name=localdot-test-` and `docker volume ls --filter name=localdot-test-`
print no rows afterwards. Every check goes by the test prefix: a real cell's objects are named
`localdot-<role>-<id>` and carry the same `localdot.cell` labels, so a label filter would list them too.

- [ ] **Step 8: Commit**

```bash
pnpm format && pnpm lint && pnpm typecheck
git add apps/daemon/src/cells
git commit -m "feat(daemon): cell orchestrator with isolated networks and hardened containers"
```

---
