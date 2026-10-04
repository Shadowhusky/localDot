import { createHash, randomBytes } from "node:crypto";
import {
  KeydOpened,
  SecretId,
  SURROGATE_PATTERN,
  TaskPricing,
  ULID_PATTERN,
  ulid,
} from "@localdot/protocol";
import { type DockerClient, DockerError } from "../cells/docker.ts";
import { hostAddress } from "../cells/ipv4.ts";
import type { PortRange } from "../cells/ports.ts";
import type { KeydClient } from "../keyd/client.ts";
import {
  BRAIN_GATE_OFFSET,
  BRAIN_OFFSET,
  BRAIN_PROXY_PORT,
  type BrainLayout,
  brainGateSpec,
  brainNames,
  brainNetworkSpecs,
  brainSpec,
} from "./brain-spec.ts";

export interface BrainImages {
  brain: string;
  gate: string;
}
export interface BrainCellsDeps {
  docker: Pick<DockerClient, "request">;
  keyd: Pick<KeydClient, "openCell" | "closeCell"> & {
    beginPricedTask(
      cellId: string,
      taskId: string,
      pricing: TaskPricing,
      budgetUSD?: number,
    ): Promise<void>;
  };
  images: BrainImages;
  home: string;
  range: PortRange;
  // Must include desktop records AND creations in progress. Task 13 wires reservations both ways.
  desktopPorts(): Iterable<number>;
  namePrefix?: string;
  // Host backend port only. The gate's internal listener is always TOOL_API_PORT (4751).
  toolPort?: number;
  pollMs?: number;
}
export interface BrainCell extends BrainLayout {
  readonly proxyUrl: string;
  readonly proxyToken: string;
  readonly surrogates: Readonly<Record<string, string>>;
  readonly toolToken: string;
}
export interface OpenBrain {
  initialModelAdmission: "paused";
  sessionId: string;
  secrets: string[];
  pricing: TaskPricing;
  // Resend the originally captured initial value (including omission), never a current raise.
  budgetUSD?: number;
  signal?: AbortSignal;
}
export function imagesWithBrain(env: NodeJS.ProcessEnv = process.env): BrainImages {
  return {
    brain: env.LOCALDOT_BRAIN_IMAGE || "localdot/brain:dev",
    gate: env.LOCALDOT_GATE_IMAGE || "localdot/gate:dev",
  };
}
export function homeLabel(home: string): string {
  return createHash("sha256").update(home).digest("hex").slice(0, 16);
}
export class BrainCleanupError extends Error {
  constructor(
    readonly cellId: string,
    readonly failed: readonly string[],
  ) {
    super("brain cleanup could not be confirmed");
    this.name = "BrainCleanupError";
  }
}
export class BrainStateError extends Error {}

interface Resource {
  kind: "containers" | "networks";
  name: string;
  role: string;
  id?: string;
}
interface Owned {
  layout: BrainLayout;
  cell?: BrainCell;
  resources: Resource[];
  keydAttempted: boolean;
  signal?: AbortSignal;
  phase: "opening" | "ready" | "starting" | "started" | "closing" | "cleanup-failed" | "closed";
  starting?: Promise<unknown>;
  closing?: Promise<void>;
}
interface NetworkInspect {
  Id: string;
  Labels: Record<string, string>;
  IPAM: { Config: { Subnet?: string }[] };
}
interface Listed {
  Id: string;
  Labels?: Record<string, string>;
}
const objectPath = (kind: Resource["kind"], name: string, action?: string) =>
  `/${kind}/${encodeURIComponent(name)}${action ? `/${action}` : ""}`;
const is404 = (error: unknown) => error instanceof DockerError && error.status === 404;
const abortError = () => new DOMException("brain operation cancelled", "AbortError");
const checkAbort = (...signals: (AbortSignal | undefined)[]) => {
  if (signals.some((signal) => signal?.aborted)) throw abortError();
};
const usableId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 256;

export class BrainCells {
  readonly #owned = new Map<string, Owned>();
  readonly #reserved = new Set<number>();
  readonly #closed = new WeakSet<BrainCell>();
  readonly #sweepPorts = new Set<number>();
  readonly #prefix: string;
  readonly #home: string;
  #sweeping = false;
  #sweepFailed = false;
  constructor(private readonly deps: BrainCellsDeps) {
    this.#prefix = deps.namePrefix ?? "localdot-";
    this.#home = homeLabel(deps.home);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(this.#prefix))
      throw new RangeError("invalid brain name prefix");
    if (
      !Number.isInteger(deps.range.from) ||
      !Number.isInteger(deps.range.to) ||
      deps.range.from < 1024 ||
      deps.range.to > 65535 ||
      deps.range.from > deps.range.to
    )
      throw new RangeError("invalid brain keyd port range");
    if (
      deps.toolPort !== undefined &&
      (!Number.isInteger(deps.toolPort) || deps.toolPort < 1024 || deps.toolPort > 65535)
    )
      throw new RangeError("invalid tool API port");
    if (deps.pollMs !== undefined && (!Number.isFinite(deps.pollMs) || deps.pollMs < 1))
      throw new RangeError("invalid brain poll interval");
  }
  reservedPorts(): number[] {
    return [...this.#reserved];
  }
  #allocate(): number {
    if (this.#sweeping || this.#sweepFailed)
      throw new BrainStateError("brain startup cleanup is incomplete");
    const used = new Set([...this.deps.desktopPorts(), ...this.#reserved]);
    for (let port = this.deps.range.to; port >= this.deps.range.from; port--) {
      if (!used.has(port)) {
        this.#reserved.add(port);
        return port;
      }
    }
    throw new Error(`no free keyd listener port in ${this.deps.range.from}-${this.deps.range.to}`);
  }
  async open(opts: OpenBrain): Promise<BrainCell> {
    if (opts.initialModelAdmission !== "paused")
      throw new BrainStateError("brain model admission must start paused");
    const signal = opts.signal;
    checkAbort(signal);
    if (!ULID_PATTERN.test(opts.sessionId)) throw new TypeError("invalid brain session id");
    const secrets = opts.secrets.map((id) => SecretId.parse(id));
    if (secrets.length > 32 || new Set(secrets).size !== secrets.length)
      throw new TypeError("invalid brain secrets");
    const pricing = TaskPricing.parse(opts.pricing);
    const budget = opts.budgetUSD;
    if (
      budget !== undefined &&
      (!Number.isFinite(budget) ||
        budget < 0 ||
        budget > 10000 ||
        (budget > 0 && Math.floor(budget * 1e6 + 0.5) < 1))
    )
      throw new TypeError("invalid initial brain budget");
    if ([...this.#owned.values()].some((owned) => owned.layout.sessionId === opts.sessionId))
      throw new BrainStateError("this session still owns a brain");
    const id = ulid();
    const keydPort = this.#allocate();
    const layout: BrainLayout = {
      id,
      sessionId: opts.sessionId,
      keydPort,
      names: Object.freeze(brainNames(id, this.#prefix)),
      home: this.#home,
      gateInternalIp: "",
      gateEgressIp: "",
      brainIp: "",
    };
    const owned: Owned = {
      layout,
      phase: "opening",
      resources: [],
      keydAttempted: false,
      signal: signal,
    };
    this.#owned.set(id, owned);
    const step = async <T>(action: () => Promise<T>): Promise<T> => {
      checkAbort(signal);
      const result = await action();
      checkAbort(signal);
      return result;
    };
    const create = async (resource: Resource, body: unknown) => {
      checkAbort(signal);
      // Record intent before dispatch: a lost create reply may still leave the object behind.
      owned.resources.push(resource);
      const reply = await this.deps.docker.request<{ Id: string }>({
        method: "POST",
        path: resource.kind === "networks" ? "/networks/create" : "/containers/create",
        ...(resource.kind === "containers" ? { query: { name: resource.name } } : {}),
        body,
      });
      if (!usableId(reply?.Id)) throw new BrainStateError("invalid Docker create reply");
      resource.id = reply.Id;
      checkAbort(signal);
    };
    try {
      const networks = brainNetworkSpecs(layout);
      for (const spec of [networks.internal, networks.egress])
        await create({ kind: "networks", name: spec.Name, role: "brain-network" }, spec);
      const internalId = this.#resourceId(owned, layout.names.internalNetwork);
      const egressId = this.#resourceId(owned, layout.names.egressNetwork);
      const internal = await step(() =>
        this.deps.docker.request<NetworkInspect>({
          method: "GET",
          path: objectPath("networks", internalId),
        }),
      );
      const egress = await step(() =>
        this.deps.docker.request<NetworkInspect>({
          method: "GET",
          path: objectPath("networks", egressId),
        }),
      );
      if (
        internal.Id !== internalId ||
        egress.Id !== egressId ||
        !this.#owns(internal.Labels, id, layout.sessionId, "brain-network") ||
        !this.#owns(egress.Labels, id, layout.sessionId, "brain-network")
      )
        throw new BrainStateError("refusing a different Docker network");
      const internalSubnet = internal.IPAM?.Config?.[0]?.Subnet;
      const egressSubnet = egress.IPAM?.Config?.[0]?.Subnet;
      if (!internalSubnet || !egressSubnet)
        throw new BrainStateError("a brain network has no IPv4 subnet");
      layout.gateInternalIp = hostAddress(internalSubnet, BRAIN_GATE_OFFSET);
      layout.gateEgressIp = hostAddress(egressSubnet, BRAIN_GATE_OFFSET);
      layout.brainIp = hostAddress(internalSubnet, BRAIN_OFFSET);
      checkAbort(signal);
      owned.keydAttempted = true;
      const opened = KeydOpened.parse(
        await step(() =>
          this.deps.keyd.openCell({ cellId: id, role: "brain", port: keydPort, secrets }),
        ),
      );
      const surrogates = opened.surrogates ?? {};
      if (
        opened.cellId !== id ||
        opened.port !== keydPort ||
        Object.keys(surrogates).length !== secrets.length ||
        secrets.some((secret) => !SURROGATE_PATTERN.test(surrogates[secret] ?? ""))
      )
        throw new BrainStateError("keyd returned different brain credentials");
      await step(() => this.deps.keyd.beginPricedTask(id, layout.sessionId, pricing, budget));
      const toolToken = randomBytes(32).toString("base64url");
      await create(
        { kind: "containers", name: layout.names.gate, role: "brain-gate" },
        brainGateSpec(layout, this.deps.images.gate, this.deps.toolPort, egressId),
      );
      await create(
        { kind: "containers", name: layout.names.brain, role: "brain" },
        brainSpec(layout, this.deps.images.brain, toolToken, internalId),
      );
      await step(() =>
        this.deps.docker.request({
          method: "POST",
          path: objectPath("containers", this.#resourceId(owned, layout.names.gate), "start"),
        }),
      );
      await step(() =>
        this.deps.docker.request({
          method: "POST",
          path: objectPath("networks", internalId, "connect"),
          body: {
            Container: this.#resourceId(owned, layout.names.gate),
            EndpointConfig: { IPAMConfig: { IPv4Address: layout.gateInternalIp } },
          },
        }),
      );
      checkAbort(signal); // The final step promise introduced another continuation boundary.
      const cell: BrainCell = Object.freeze({
        ...layout,
        proxyUrl: `http://${layout.gateInternalIp}:${BRAIN_PROXY_PORT}`,
        proxyToken: opened.proxyToken,
        surrogates: Object.freeze({ ...surrogates }),
        toolToken,
      });
      owned.cell = cell;
      owned.phase = "ready";
      return cell;
    } catch (error) {
      try {
        await this.#cleanup(owned);
      } catch (cleanup) {
        throw new AggregateError(
          [error, cleanup],
          "brain creation failed and cleanup is unconfirmed",
        );
      }
      throw error;
    }
  }
  #resourceId(owned: Owned, name: string): string {
    const id = owned.resources.find((resource) => resource.name === name)?.id;
    if (!id) throw new BrainStateError("missing owned Docker object id");
    return id;
  }
  #record(cell: BrainCell): Owned {
    const owned = this.#owned.get(cell.id);
    if (!owned || owned.cell !== cell)
      throw new BrainStateError("brain is not owned by this manager");
    return owned;
  }
  async start(cell: BrainCell, signal?: AbortSignal): Promise<void> {
    const owned = this.#record(cell);
    if (owned.phase !== "ready")
      throw new BrainStateError("brain cannot start in its current state");
    try {
      checkAbort(owned.signal, signal);
      owned.phase = "starting";
      owned.starting = this.deps.docker.request({
        method: "POST",
        path: objectPath("containers", this.#resourceId(owned, cell.names.brain), "start"),
      });
      await owned.starting;
      checkAbort(owned.signal, signal);
      if (owned.phase !== "starting") throw abortError();
      owned.phase = "started";
    } catch (error) {
      await this.close(cell);
      throw error;
    }
  }
  async exited(cell: BrainCell, signal: AbortSignal): Promise<number | undefined> {
    if (signal.aborted || this.#closed.has(cell)) return undefined;
    const owned = this.#record(cell);
    const ended = () => owned.phase === "closing" || owned.phase === "closed";
    while (!signal.aborted && !ended()) {
      const info = await this.deps.docker
        .request<{ State: { Running: boolean; ExitCode: number } }>({
          method: "GET",
          path: objectPath("containers", this.#resourceId(owned, cell.names.brain), "json"),
          timeoutMs: 5000,
        })
        .catch((error) => {
          if (is404(error)) return { State: { Running: false, ExitCode: -1 } };
          throw error;
        });
      if (signal.aborted || ended()) return undefined;
      if (typeof info?.State?.Running !== "boolean" || !Number.isInteger(info.State.ExitCode))
        throw new BrainStateError("invalid brain exit status");
      if (!info.State.Running) return info.State.ExitCode;
      await sleep(this.deps.pollMs ?? 2000, signal);
    }
    return undefined;
  }
  async retireSession(sessionId: string): Promise<void> {
    if (!ULID_PATTERN.test(sessionId)) throw new BrainStateError("invalid historical session");
    for (const owned of this.#owned.values())
      if (owned.layout.sessionId === sessionId) await this.#cleanup(owned);
    const filters = JSON.stringify({
      label: [`localdot.home=${this.#home}`, `localdot.session=${sessionId}`, "localdot.brain"],
    });
    for (const path of ["/containers/json", "/networks"]) {
      const objects = await this.deps.docker.request<unknown>({
        method: "GET",
        path,
        query: { all: "true", filters },
      });
      if (!Array.isArray(objects) || objects.length)
        throw new BrainStateError("historical brain retirement cannot be confirmed");
    }
  }
  async close(cell: BrainCell): Promise<void> {
    if (this.#closed.has(cell)) return Promise.resolve();
    return this.#cleanup(this.#record(cell));
  }
  #cleanup(owned: Owned): Promise<void> {
    if (owned.closing) return owned.closing;
    if (owned.phase === "closed") return Promise.resolve();
    owned.phase = "closing";
    owned.closing = this.#remove(owned).finally(() => {
      owned.closing = undefined;
    });
    return owned.closing;
  }
  async #remove(owned: Owned): Promise<void> {
    const failed: string[] = [];
    let keydClosed = !owned.keydAttempted;
    if (owned.keydAttempted) {
      try {
        await this.deps.keyd.closeCell(owned.layout.id);
        keydClosed = true;
        owned.keydAttempted = false;
      } catch {
        failed.push("keyd");
      }
    }
    // Stop key access before waiting for an in-flight start, then delete after it settles.
    await owned.starting?.catch(() => undefined);
    for (const resource of [...owned.resources].reverse()) {
      // Keep an ownership marker until keyd closure is confirmed, including across daemon restart.
      if (resource.kind === "networks" && !keydClosed) continue;
      try {
        await this.#removeResource(owned.layout, resource);
        owned.resources.splice(owned.resources.indexOf(resource), 1);
      } catch {
        failed.push(resource.role);
      }
    }
    if (failed.length > 0) {
      owned.phase = "cleanup-failed";
      throw new BrainCleanupError(owned.layout.id, failed);
    }
    owned.phase = "closed";
    this.#reserved.delete(owned.layout.keydPort);
    if (owned.cell) this.#closed.add(owned.cell);
    this.#owned.delete(owned.layout.id);
  }
  async #removeResource(layout: BrainLayout, resource: Resource): Promise<void> {
    try {
      const inspect = await this.deps.docker.request<{
        Id: string;
        Labels?: Record<string, string>;
        Config?: { Labels?: Record<string, string> };
      }>({
        method: "GET",
        path: objectPath(
          resource.kind,
          resource.id ?? resource.name,
          resource.kind === "containers" ? "json" : undefined,
        ),
      });
      const labels = resource.kind === "containers" ? inspect.Config?.Labels : inspect.Labels;
      if (
        !usableId(inspect.Id) ||
        (resource.id !== undefined && resource.id !== inspect.Id) ||
        !this.#owns(labels, layout.id, layout.sessionId, resource.role)
      )
        throw new BrainStateError("refusing cleanup of a different Docker object");
      await this.deps.docker.request({
        method: "DELETE",
        path: objectPath(resource.kind, inspect.Id),
        ...(resource.kind === "containers" ? { query: { force: "true", v: "true" } } : {}),
      });
    } catch (error) {
      if (!is404(error)) throw error;
    }
  }
  #owns(
    labels: Record<string, string> | undefined,
    id: string,
    session: string,
    role: string,
  ): boolean {
    return (
      labels?.["localdot.home"] === this.#home &&
      labels["localdot.brain"] === id &&
      labels["localdot.session"] === session &&
      labels["localdot.role"] === role
    );
  }
  async sweep(): Promise<number> {
    if (
      this.#sweeping ||
      [...this.#owned.values()].some((o) => o.phase !== "closed" && o.phase !== "cleanup-failed")
    )
      throw new BrainStateError("cannot sweep active brains");
    this.#sweeping = true;
    try {
      for (const owned of this.#owned.values())
        if (owned.phase === "cleanup-failed") await this.#cleanup(owned);
      const filters = JSON.stringify({ label: [`localdot.home=${this.#home}`, "localdot.brain"] });
      const containers = await this.deps.docker.request<Listed[]>({
        method: "GET",
        path: "/containers/json",
        query: { all: "true", filters },
      });
      const networks = await this.deps.docker.request<Listed[]>({
        method: "GET",
        path: "/networks",
        query: { filters },
      });
      if (!Array.isArray(containers) || !Array.isArray(networks))
        throw new BrainStateError("invalid brain cleanup inventory");
      const groups = new Map<string, { session: string; resources: Resource[]; port?: number }>();
      for (const [kind, objects] of [
        ["containers", containers],
        ["networks", networks],
      ] as const)
        for (const object of objects) {
          const labels = object.Labels;
          if (labels?.["localdot.home"] !== this.#home || !labels["localdot.brain"]) continue;
          const id = labels["localdot.brain"];
          const session = labels["localdot.session"] ?? "";
          const role = labels["localdot.role"] ?? "";
          if (
            !usableId(object.Id) ||
            !ULID_PATTERN.test(id) ||
            !ULID_PATTERN.test(session) ||
            !(kind === "networks"
              ? role === "brain-network"
              : role === "brain" || role === "brain-gate")
          )
            throw new BrainStateError("invalid owned brain cleanup labels");
          const group: { session: string; resources: Resource[]; port?: number } = groups.get(
            id,
          ) ?? { session, resources: [] };
          if (group.session !== session)
            throw new BrainStateError("conflicting owned brain cleanup labels");
          group.resources.push({ kind, name: object.Id, id: object.Id, role });
          const port = Number(labels["localdot.keyd-port"]);
          if (Number.isInteger(port) && port >= this.deps.range.from && port <= this.deps.range.to)
            group.port = port;
          groups.set(id, group);
        }
      const failures: string[] = [];
      for (const [id, group] of groups) {
        let closed = false;
        try {
          await this.deps.keyd.closeCell(id);
          closed = true;
        } catch {
          failures.push("keyd");
        }
        if (group.port !== undefined) {
          this.#reserved.add(group.port);
          this.#sweepPorts.add(group.port);
        }
        const layout: BrainLayout = {
          id,
          sessionId: group.session,
          keydPort: group.port ?? 0,
          home: this.#home,
          names: brainNames(id, this.#prefix),
          gateInternalIp: "",
          gateEgressIp: "",
          brainIp: "",
        };
        for (const resource of group.resources) {
          if (resource.kind === "networks" && !closed) continue;
          try {
            await this.#removeResource(layout, resource);
          } catch {
            failures.push(resource.role);
          }
        }
        if (closed && failures.length === 0 && group.port !== undefined)
          this.#reserved.delete(group.port);
      }
      if (failures.length > 0) throw new BrainCleanupError("startup", failures);
      for (const port of this.#sweepPorts) this.#reserved.delete(port);
      this.#sweepPorts.clear();
      this.#sweepFailed = false;
      return groups.size;
    } catch (error) {
      this.#sweepFailed = true;
      throw error;
    } finally {
      this.#sweeping = false;
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    if (signal.aborted) done();
  });
}
