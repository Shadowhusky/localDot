import type { KeydOpened, TaskPricing } from "@localdot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DockerError, type DockerRequest } from "../cells/docker.ts";
import {
  BrainCells,
  BrainCleanupError,
  homeLabel,
  imagesWithBrain,
  type OpenBrain,
} from "./brain-cell.ts";
import { brainGateSpec, brainNetworkSpecs, brainSpec } from "./brain-spec.ts";

const SESSION = "01JXYZ0000000000000000SESS";
const OTHER = "01JXYZ0000000000000000SES2";
const SURROGATE = "ld_ant_0123456789abcdefghijkl_abcdef";
function options(): OpenBrain {
  return {
    initialModelAdmission: "paused",
    sessionId: SESSION,
    secrets: ["provider"],
    budgetUSD: 5,
    pricing: {
      v: 1,
      routes: [
        {
          route: "provider",
          models: [{ id: "model", inputUSDPerMTok: 1, outputUSDPerMTok: 2, maxOutputTokens: 100 }],
        },
      ],
    },
  };
}
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
interface ObjectInfo {
  Id: string;
  name: string;
  kind: "containers" | "networks";
  Labels: Record<string, string>;
  spec: Record<string, unknown>;
  running: boolean;
}
function fixture() {
  const calls: DockerRequest[] = [];
  const order: string[] = [];
  const objects = new Map<string, ObjectInfo>();
  const initialized: { id: string; task: string; pricing: TaskPricing; budget?: number }[] = [];
  const keydCells = new Set<string>();
  let serial = 0;
  const hooks: {
    before?(request: DockerRequest): Promise<void> | void;
    after?(request: DockerRequest): Promise<void> | void;
    open?(reply: KeydOpened): Promise<KeydOpened> | KeydOpened;
    close?(id: string): Promise<void> | void;
    begin?(): Promise<void> | void;
  } = {};
  const docker = {
    async request<T>(req: DockerRequest): Promise<T> {
      calls.push(req);
      order.push(`${req.method} ${req.path}`);
      await hooks.before?.(req);
      let out: unknown;
      if (
        req.method === "POST" &&
        (req.path === "/networks/create" || req.path === "/containers/create")
      ) {
        const spec = req.body as Record<string, unknown>;
        const name = String(req.query?.name ?? spec.Name);
        const kind = req.path === "/networks/create" ? "networks" : "containers";
        const object: ObjectInfo = {
          Id: `object-${++serial}`,
          name,
          kind,
          Labels: spec.Labels as Record<string, string>,
          spec,
          running: false,
        };
        objects.set(object.Id, object);
        out = { Id: object.Id };
      } else if (req.path === "/containers/json" || req.path === "/networks") {
        const kind = req.path === "/networks" ? "networks" : "containers";
        out = [...objects.values()]
          .filter((o) => o.kind === kind)
          .map((o) => ({ Id: o.Id, Labels: o.Labels }));
      } else {
        const [, kind, encoded, action] = req.path.split("/");
        const name = decodeURIComponent(encoded ?? "");
        const object = [...objects.values()].find(
          (o) => o.kind === kind && (o.name === name || o.Id === name),
        );
        if (!object) throw new DockerError(404, "gone", req.path);
        if (req.method === "DELETE") objects.delete(object.Id);
        else if (req.method === "POST" && action === "start") object.running = true;
        else if (req.method === "GET")
          out = {
            Id: object.Id,
            Labels: object.Labels,
            Config: { Labels: object.Labels },
            IPAM: {
              Config: [
                { Subnet: object.name.includes("braincell") ? "172.30.4.0/24" : "172.30.5.0/24" },
              ],
            },
            State: { Running: object.running, ExitCode: 0 },
          };
      }
      await hooks.after?.(req);
      return out as T;
    },
  };
  const keyd = {
    async openCell(req: { cellId: string; port: number; secrets: string[] }): Promise<KeydOpened> {
      order.push(`keyd open ${req.cellId}`);
      keydCells.add(req.cellId);
      const reply = {
        cellId: req.cellId,
        port: req.port,
        proxyToken: "p".repeat(43),
        caCertPem: "-----BEGIN CERTIFICATE-----fixture",
        caPath: "/fixture",
        surrogates: Object.fromEntries(req.secrets.map((id) => [id, SURROGATE])),
      };
      return (await hooks.open?.(reply)) ?? reply;
    },
    async closeCell(id: string) {
      order.push(`keyd close ${id}`);
      await hooks.close?.(id);
      return keydCells.delete(id);
    },
    async beginPricedTask(id: string, task: string, pricing: TaskPricing, budget?: number) {
      order.push(`keyd task ${task}`);
      initialized.push({ id, task, pricing: structuredClone(pricing), budget });
      await hooks.begin?.();
    },
  };
  const make = (
    home = "/tmp/owned-brain-home",
    extra: Partial<ConstructorParameters<typeof BrainCells>[0]> = {},
  ) =>
    new BrainCells({
      docker,
      keyd,
      home,
      images: { brain: "brain:fixture", gate: "gate:fixture" },
      range: { from: 4760, to: 4763 },
      desktopPorts: () => [4760],
      ...extra,
    });
  const cells = make();
  return { calls, order, objects, initialized, keydCells, hooks, cells, make };
}
afterEach(() => vi.useRealTimers());

describe("BrainCells", () => {
  it("freezes pricing under the session id, reserves concurrent ports, and starts only on request", async () => {
    const f = fixture();
    const hold = deferred();
    let blocked = false;
    f.hooks.before = (req) => {
      if (!blocked && req.path === "/networks/create") {
        blocked = true;
        return hold.promise;
      }
    };
    const firstOptions = options();
    const first = f.cells.open(firstOptions);
    const model = firstOptions.pricing.routes[0]?.models[0];
    if (!model) throw new Error("missing fixture model");
    model.inputUSDPerMTok = 99;
    firstOptions.secrets.length = 0;
    firstOptions.budgetUSD = 99;
    const second = f.cells.open({ ...options(), sessionId: OTHER });
    expect(f.cells.reservedPorts().sort()).toEqual([4762, 4763]);
    hold.resolve();
    const [a, b] = await Promise.all([first, second]);
    expect(f.initialized.map((x) => x.task).sort()).toEqual([SESSION, OTHER].sort());
    expect(
      f.initialized.every(
        (x) => x.budget === 5 && x.pricing.routes[0]?.models[0]?.inputUSDPerMTok === 1,
      ),
    ).toBe(true);
    expect(a.proxyUrl).toBe("http://172.30.4.10:3128");
    expect(a.toolToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const brainId = [...f.objects.values()].find((o) => o.name === a.names.brain)?.Id;
    expect(f.calls.some((c) => c.path === `/containers/${brainId}/start`)).toBe(false);
    await f.cells.start(a);
    await f.cells.close(a);
    await f.cells.close(b);
    expect(f.cells.reservedPorts()).toEqual([]);
    expect(f.objects.size).toBe(0);
    expect(f.keydCells.size).toBe(0);
  });
  it("rejects a second brain for a session while setup or uncertain cleanup still owns it", async () => {
    const f = fixture();
    const entered = deferred();
    const release = deferred();
    f.hooks.begin = () => {
      entered.resolve();
      return release.promise;
    };
    const pending = f.cells.open(options());
    await entered.promise;
    await expect(f.cells.open(options())).rejects.toThrow("still owns a brain");
    release.resolve();
    const cell = await pending;
    f.hooks.close = () => {
      throw new Error("offline");
    };
    await expect(f.cells.close(cell)).rejects.toThrow();
    await expect(f.cells.open(options())).rejects.toThrow("still owns a brain");
    f.hooks.close = undefined;
    await f.cells.close(cell);
  });

  it("carries the same original ceiling and immutable policy on replacement opens", async () => {
    const f = fixture();
    const opts = options();
    const a = await f.cells.open(opts);
    await f.cells.close(a);
    const b = await f.cells.open(opts);
    expect(a.id).not.toBe(b.id);
    expect(
      f.initialized.map((x) => ({ task: x.task, pricing: x.pricing, budget: x.budget })),
    ).toEqual([
      { task: SESSION, pricing: opts.pricing, budget: 5 },
      { task: SESSION, pricing: opts.pricing, budget: 5 },
    ]);
    await f.cells.close(b);
  });
  it("does no work for invalid or pre-aborted admission", async () => {
    const f = fixture();
    const control = new AbortController();
    control.abort();
    await expect(f.cells.open({ ...options(), signal: control.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    await expect(f.cells.open({ ...options(), pricing: { v: 1, routes: [] } })).rejects.toThrow();
    for (const secrets of [["Bad Key"], ["provider", "provider"]])
      await expect(f.cells.open({ ...options(), secrets })).rejects.toThrow(
        "invalid brain secrets",
      );
    expect(f.calls).toEqual([]);
    expect(f.cells.reservedPorts()).toEqual([]);
  });
  it("leaves a key stored under a since-reserved name to keyd", async () => {
    const f = fixture();
    const cell = await f.cells.open({ ...options(), secrets: ["webpush-vapid"] });
    expect(f.keydCells.size).toBe(1);
    await f.cells.close(cell);
  });
  it("closes a committed keyd open when its reply is lost", async () => {
    const f = fixture();
    f.hooks.open = () => {
      throw new Error("lost reply");
    };
    await expect(f.cells.open(options())).rejects.toThrow("lost reply");
    expect(f.keydCells.size).toBe(0);
    expect(f.objects.size).toBe(0);
    expect(f.cells.reservedPorts()).toEqual([]);
    const firstDelete = f.order.findIndex((x) => x.startsWith("DELETE"));
    expect(f.order.findIndex((x) => x.startsWith("keyd close"))).toBeLessThan(firstDelete);
  });
  it("closes a committed Docker create when its reply is lost", async () => {
    const f = fixture();
    let once = true;
    f.hooks.after = (req) => {
      if (once && req.path === "/containers/create") {
        once = false;
        throw new Error("lost Docker reply");
      }
    };
    await expect(f.cells.open(options())).rejects.toThrow("lost Docker reply");
    expect(f.keydCells.size).toBe(0);
    expect(f.objects.size).toBe(0);
    expect(f.cells.reservedPorts()).toEqual([]);
  });
  it("cleans abort during an ignored keyd dependency and never publishes/starts a brain", async () => {
    const f = fixture();
    const entered = deferred();
    const release = deferred();
    const control = new AbortController();
    f.hooks.begin = () => {
      entered.resolve();
      return release.promise;
    };
    const pending = f.cells.open({ ...options(), signal: control.signal });
    await entered.promise;
    control.abort();
    release.resolve();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(f.calls.some((c) => c.path === "/containers/create")).toBe(false);
    expect(f.keydCells.size).toBe(0);
    expect(f.objects.size).toBe(0);
  });
  it("rejects an open reply for a different listener", async () => {
    const f = fixture();
    f.hooks.open = (reply) => ({ ...reply, port: reply.port - 1 });
    await expect(f.cells.open(options())).rejects.toThrow("different brain credentials");
    expect(f.keydCells.size).toBe(0);
    expect(f.initialized).toEqual([]);
  });
  it("keeps a cleanup marker and reservation when keyd closure is uncertain, then retries", async () => {
    const f = fixture();
    const cell = await f.cells.open(options());
    f.hooks.close = () => {
      throw new Error("offline");
    };
    await expect(f.cells.close(cell)).rejects.toBeInstanceOf(BrainCleanupError);
    expect([...f.objects.values()].map((o) => o.kind)).toEqual(["networks", "networks"]);
    expect(f.cells.reservedPorts()).toEqual([4763]);
    f.hooks.close = undefined;
    await f.cells.close(cell);
    await f.cells.close(cell);
    expect(f.objects.size).toBe(0);
    expect(f.cells.reservedPorts()).toEqual([]);
    await expect(f.cells.start(cell)).rejects.toThrow();
  });
  it("never removes a replaced foreign object while rolling back", async () => {
    const f = fixture();
    let once = true;
    f.hooks.after = (req) => {
      if (once && req.path === "/networks/create") {
        once = false;
        const object = [...f.objects.values()][0];
        if (!object) throw new Error("missing fixture object");
        object.Labels = { ...object.Labels, "localdot.home": "foreign" };
        throw new Error("uncertain creation");
      }
    };
    await expect(f.cells.open(options())).rejects.toBeInstanceOf(AggregateError);
    expect(f.calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(f.cells.reservedPorts()).toEqual([4763]);
  });
  it("revokes before waiting for an in-flight start, and cannot publish late start success", async () => {
    const f = fixture();
    const cell = await f.cells.open(options());
    const hold = deferred();
    const entered = deferred();
    f.hooks.before = (req) => {
      if (
        req.path ===
        `/containers/${[...f.objects.values()].find((o) => o.name === cell.names.brain)?.Id}/start`
      ) {
        entered.resolve();
        return hold.promise;
      }
    };
    const starting = f.cells.start(cell);
    const rejected = expect(starting).rejects.toMatchObject({ name: "AbortError" });
    await entered.promise;
    const closing = f.cells.close(cell);
    await Promise.resolve();
    expect(f.order).toContain(`keyd close ${cell.id}`);
    expect(f.calls.some((c) => c.method === "DELETE")).toBe(false);
    hold.resolve();
    await closing;
    await rejected;
    expect(f.objects.size).toBe(0);
  });
  it("refuses abort before start and copied foreign cell handles", async () => {
    const f = fixture();
    const control = new AbortController();
    const cell = await f.cells.open({ ...options(), signal: control.signal });
    await expect(f.cells.close({ ...cell })).rejects.toThrow();
    control.abort();
    await expect(f.cells.start(cell)).rejects.toMatchObject({ name: "AbortError" });
    expect(f.calls.filter((c) => c.path.endsWith("/start"))).toHaveLength(1);
    expect(f.objects.size).toBe(0);
  });
  it("sweeps network-only leftovers keyd first, but never another home or a desktop", async () => {
    const f = fixture();
    const cell = await f.cells.open(options());
    f.hooks.close = () => {
      throw new Error("offline");
    };
    await expect(f.cells.close(cell)).rejects.toThrow();
    f.hooks.close = undefined;
    const network = [...f.objects.values()][0];
    if (!network) throw new Error("missing fixture network");
    f.objects.set("foreign", {
      ...network,
      Id: "foreign",
      Labels: { ...network.Labels, "localdot.home": "foreign" },
    });
    f.objects.set("desktop", {
      ...network,
      Id: "desktop",
      Labels: { "localdot.home": homeLabel("/tmp/owned-brain-home"), "localdot.role": "desktop" },
    });
    f.order.length = 0;
    const fresh = f.make();
    expect(await fresh.sweep()).toBe(1);
    expect([...f.objects.keys()].sort()).toEqual(["desktop", "foreign"]);
    expect(f.order.findIndex((x) => x.startsWith("keyd close"))).toBeLessThan(
      f.order.findIndex((x) => x.startsWith("DELETE")),
    );
  });
  it("blocks opens after incomplete startup cleanup until a successful sweep", async () => {
    const f = fixture();
    await f.cells.open(options());
    const fresh = f.make();
    f.hooks.close = () => {
      throw new Error("offline");
    };
    await expect(fresh.sweep()).rejects.toBeInstanceOf(BrainCleanupError);
    await expect(fresh.open(options())).rejects.toThrow("cleanup is incomplete");
    expect(fresh.reservedPorts()).toEqual([4763]);
    f.hooks.close = undefined;
    await fresh.sweep();
    expect(fresh.reservedPorts()).toEqual([]);
    const resumed = await fresh.open(options());
    await fresh.close(resumed);
  });
  it("does not report a late inspect result after cancellation and removes poll timers", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const cell = await f.cells.open(options());
    await f.cells.start(cell);
    const control = new AbortController();
    const waiting = f.cells.exited(cell, control.signal);
    await vi.advanceTimersByTimeAsync(4000);
    control.abort();
    expect(await waiting).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    const entered = deferred();
    const release = deferred();
    f.hooks.before = (req) => {
      if (req.path.endsWith("/json")) {
        entered.resolve();
        return release.promise;
      }
    };
    const lateControl = new AbortController();
    const late = f.cells.exited(cell, lateControl.signal);
    await entered.promise;
    lateControl.abort();
    release.resolve();
    expect(await late).toBeUndefined();
    f.hooks.before = undefined;
    await f.cells.close(cell);
  });
});

describe("brain network and container specifications", () => {
  it("keeps the gate's internal tool listener fixed while selecting a host backend", async () => {
    const f = fixture();
    const cells = f.make(undefined, { toolPort: 4999 });
    const cell = await cells.open(options());
    const brain = brainSpec(cell, "brain:fixture", cell.toolToken);
    const gate = brainGateSpec(cell, "gate:fixture", 4999);
    const networks = brainNetworkSpecs(cell);
    expect(brain.Env).toEqual([
      `LOCALDOT_TOOL_URL=http://172.30.4.10:4751`,
      `LOCALDOT_TOOL_TOKEN=${cell.toolToken}`,
      "NODE_ENV=production",
    ]);
    expect(gate.Env).toContain("LD_TOOL_PORT=4999");
    expect(brain.User).toBe("node");
    expect(brain.HostConfig).toMatchObject({
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
      NetworkMode: cell.names.internalNetwork,
      Memory: 1024 ** 3,
      MemorySwap: 1024 ** 3,
      NanoCpus: 2_000_000_000,
      PidsLimit: 256,
      Tmpfs: { "/tmp": "rw,noexec,nosuid,nodev,size=64m" },
    });
    expect(Object.keys(brain.NetworkingConfig.EndpointsConfig)).toEqual([
      cell.names.internalNetwork,
    ]);
    expect(networks.internal).toMatchObject({
      Internal: true,
      EnableIPv6: false,
      Options: { "com.docker.network.bridge.gateway_mode_ipv4": "isolated" },
    });
    expect(networks.egress.EnableIPv6).toBe(false);
    expect(gate.HostConfig).not.toHaveProperty("PortBindings");
    expect(JSON.stringify(brain)).not.toContain("docker.sock");
    expect(JSON.stringify(brain)).not.toContain("HTTP_PROXY");
    await cells.close(cell);
  });
  it("gives the gate keyd's and the tool API's sockets on Docker Engine", async () => {
    const f = fixture();
    const relay = { kind: "socket", keydDir: "/h/keyd/relay", toolDir: "/h/relay" } as const;
    const cells = f.make(undefined, { relay: async () => relay });
    const cell = await cells.open(options());
    const gate = f.calls.find(
      (c) => c.path === "/containers/create" && c.query?.name === cell.names.gate,
    )?.body as { Env: string[]; HostConfig: { Mounts?: unknown } };
    expect(gate.Env).toContain(`LD_KEYD_SOCKET=/run/localdot/keyd/${cell.keydPort}.sock`);
    expect(gate.Env).toContain("LD_TOOL_SOCKET=/run/localdot/tool/tool.sock");
    expect(gate.HostConfig.Mounts).toEqual([
      { Type: "bind", Source: "/h/keyd/relay", Target: "/run/localdot/keyd", ReadOnly: true },
      { Type: "bind", Source: "/h/relay", Target: "/run/localdot/tool", ReadOnly: true },
    ]);
    await cells.close(cell);
  });
  it("uses independent brain/gate image overrides", () => {
    expect(imagesWithBrain({ LOCALDOT_BRAIN_IMAGE: "b", LOCALDOT_GATE_IMAGE: "g" })).toEqual({
      brain: "b",
      gate: "g",
    });
  });
});

describe("independent lifecycle boundaries", () => {
  it("does not publish an open after cancellation in the final step continuation gap", async () => {
    const f = fixture();
    const stop = new AbortController();
    f.hooks.after = (req) => {
      if (req.method === "POST" && req.path.endsWith("/connect")) {
        queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => stop.abort())));
      }
    };
    let published: Awaited<ReturnType<BrainCells["open"]>> | undefined;
    const opening = f.cells.open({ ...options(), signal: stop.signal }).then((cell) => {
      published = cell;
      return cell;
    });
    try {
      await expect(opening).rejects.toMatchObject({ name: "AbortError" });
      expect(f.keydCells.size).toBe(0);
      expect(f.objects.size).toBe(0);
      expect(f.cells.reservedPorts()).toEqual([]);
    } finally {
      if (published) await f.cells.close(published);
    }
  });
  it("never starts a foreign container substituted under an owned brain name", async () => {
    const f = fixture();
    const cell = await f.cells.open(options());
    const original = [...f.objects.values()].find((o) => o.name === cell.names.brain);
    if (!original) throw new Error("missing owned brain");
    f.objects.delete(original.Id);
    const foreign = {
      ...original,
      Id: "foreign-replacement",
      Labels: { ...original.Labels, "localdot.home": "foreign" },
      running: false,
    };
    f.objects.set(foreign.Id, foreign);
    try {
      await expect(f.cells.start(cell)).rejects.toThrow();
    } finally {
      expect.soft(foreign.running).toBe(false);
      await f.cells.close(cell).catch(() => {});
    }
  });
});

it("pins all active setup targets to created IDs and exit polling to the original brain", async () => {
  const f = fixture();
  const cell = await f.cells.open(options());
  const byName = (name: string) => {
    const o = [...f.objects.values()].find((v) => v.name === name);
    if (!o) throw new Error("fixture object missing");
    return o;
  };
  const internal = byName(cell.names.internalNetwork);
  const egress = byName(cell.names.egressNetwork);
  const gate = byName(cell.names.gate);
  const brain = byName(cell.names.brain);
  expect((gate.spec.HostConfig as { NetworkMode: string }).NetworkMode).toBe(egress.Id);
  expect(
    Object.keys((gate.spec.NetworkingConfig as { EndpointsConfig: object }).EndpointsConfig),
  ).toEqual([egress.Id]);
  expect((brain.spec.HostConfig as { NetworkMode: string }).NetworkMode).toBe(internal.Id);
  expect(
    Object.keys((brain.spec.NetworkingConfig as { EndpointsConfig: object }).EndpointsConfig),
  ).toEqual([internal.Id]);
  expect(f.calls.find((c) => c.path.endsWith("/connect"))).toMatchObject({
    path: `/networks/${internal.Id}/connect`,
    body: { Container: gate.Id },
  });
  expect(f.calls.filter((c) => c.path.endsWith("/start")).map((c) => c.path)).toEqual([
    `/containers/${gate.Id}/start`,
  ]);
  const inspected = f.calls.filter((c) => c.method === "GET" && c.path.startsWith("/networks/"));
  expect(inspected.map((c) => c.path)).toEqual([
    `/networks/${internal.Id}`,
    `/networks/${egress.Id}`,
  ]);
  await f.cells.start(cell);
  f.objects.delete(brain.Id);
  const foreign = {
    ...brain,
    Id: "foreign-exit",
    Labels: { ...brain.Labels, "localdot.home": "foreign" },
    running: false,
  };
  f.objects.set(foreign.Id, foreign);
  expect(await f.cells.exited(cell, new AbortController().signal)).toBe(-1);
  await f.cells.close(cell);
  expect(f.objects.get(foreign.Id)).toBe(foreign);
});
