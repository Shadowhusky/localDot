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
  | "list"
  | "get"
  | "endpoints"
  | "create"
  | "start"
  | "stop"
  | "remove"
  | "subscribe"
  | "updateStream"
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

// Names come back from cell.json, which can be edited by hand, so each one is sent as exactly one
// path segment.
const objectPath = (kind: "containers" | "networks" | "volumes", name: string, action?: string) =>
  `/${kind}/${encodeURIComponent(name)}${action ? `/${action}` : ""}`;

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
        const error = isStatus(err, 404)
          ? "containers missing: removed outside localDot"
          : messageOf(err);
        this.#set(record.id, { state: "failed", restarts: 0, error, stream: NO_STREAM });
      }
    }
  }

  async create(opts: { scale: Scale }): Promise<CellSummary> {
    const id = ulid();
    const names = cellNames(id, this.#namePrefix);
    // keyd tells cells apart by their listener port (M3), so the port is reserved before the first
    // await: two concurrent creates never get the same one.
    const keydPort = allocateKeydPort([
      ...this.#store.list().map((r) => r.keydPort),
      ...this.#reservedKeydPorts,
    ]);
    this.#reservedKeydPorts.add(keydPort);
    const undo: (() => Promise<unknown>)[] = [];
    try {
      const internal = await this.#docker.request<{ Id: string }>({
        method: "POST",
        path: "/networks/create",
        body: internalNetworkSpec(names.internalNetwork),
      });
      undo.push(() =>
        this.#docker.request({ method: "DELETE", path: objectPath("networks", internal.Id) }),
      );
      const egress = await this.#docker.request<{ Id: string }>({
        method: "POST",
        path: "/networks/create",
        body: egressNetworkSpec(names.egressNetwork),
      });
      undo.push(() =>
        this.#docker.request({ method: "DELETE", path: objectPath("networks", egress.Id) }),
      );
      const internalSubnet = await this.#subnet(internal.Id);
      const egressSubnet = await this.#subnet(egress.Id);
      await this.#docker.request({
        method: "POST",
        path: "/volumes/create",
        body: homeVolumeSpec(names.homeVolume),
      });
      undo.push(() =>
        this.#docker.request({
          method: "DELETE",
          path: objectPath("volumes", names.homeVolume),
          query: { force: "true" },
        }),
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
        await this.#docker.request({
          method: "POST",
          path: "/containers/create",
          query: { name },
          body: spec,
        });
        undo.push(() => this.#removeContainer(name));
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
        .request({
          method: "POST",
          path: objectPath("containers", name, "stop"),
          query: { t: "10" },
        })
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
      await this.#removeContainer(name).catch(ignoreMissing);
    }
    for (const name of [d.internalNetwork, d.egressNetwork]) {
      await this.#docker
        .request({ method: "DELETE", path: objectPath("networks", name) })
        .catch(ignoreMissing);
    }
    if (opts.purgeHome) {
      await this.#docker
        .request({
          method: "DELETE",
          path: objectPath("volumes", d.homeVolume),
          query: { force: "true" },
        })
        .catch(ignoreMissing);
    }
    this.#set(id, { state: "removed", restarts: 0, stream: NO_STREAM });
    this.#store.remove(id);
    this.#live.delete(id);
  }

  // Resolves false when a stop, a remove or a newer start took the cell over while it ran.
  async #startContainers(record: CellRecord, restarts: number, error?: string): Promise<boolean> {
    const d = record.docker;
    const starting: Live = {
      state: "starting",
      restarts,
      stream: NO_STREAM,
      ...(error ? { error } : {}),
    };
    this.#set(record.id, starting);
    try {
      await this.#docker.request({
        method: "POST",
        path: objectPath("containers", d.gate, "start"),
      });
      // The gate starts on its egress network (where its ports are published) and joins the
      // internal network afterwards, the order S3 proved; a restarted gate is still connected.
      const gate = await this.#inspect(d.gate);
      if (!(d.internalNetwork in gate.NetworkSettings.Networks)) {
        await this.#docker.request({
          method: "POST",
          path: objectPath("networks", d.internalNetwork, "connect"),
          body: {
            Container: d.gate,
            EndpointConfig: { IPAMConfig: { IPv4Address: d.gateInternalIp } },
          },
        });
      }
      if (!this.#current(record.id, starting)) return false;
      await this.#docker.request({
        method: "POST",
        path: objectPath("containers", d.desktop, "start"),
      });
      // Every start publishes new host ports (Review Focus 2).
      const ports = await this.#readPorts(d.gate);
      if (!this.#current(record.id, starting)) return false;
      this.#set(record.id, { ...starting, ports });
      return true;
    } catch (err) {
      if (this.#current(record.id, starting)) {
        this.#set(record.id, {
          state: "failed",
          restarts,
          error: messageOf(err),
          stream: NO_STREAM,
        });
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
          this.#set(record.id, {
            state: "ready",
            restarts: live.restarts,
            ports,
            stream: NO_STREAM,
          });
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
        this.#set(record.id, {
          ...live,
          state: "failed",
          error: `desktop container exited with ${desktop.State.ExitCode}${detail}`,
        });
        return;
      }
      await this.#sleep(1000);
      if (!this.#current(record.id, live)) return;
    }
    this.#set(record.id, {
      ...live,
      state: "failed",
      error: `not ready after ${this.#readyTimeoutMs / 1000} s: ${lastDetail}`,
    });
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
        this.#set(record.id, {
          ...live,
          state: "failed",
          error: `${exited}; gave up after ${live.restarts} restarts`,
        });
        return;
      }
      const note = `${exited}; restarting (attempt ${attempt} of ${this.#restartBackoffMs.length})`;
      const restarting: Live = { ...live, state: "starting", restarts: attempt, error: note };
      this.#set(record.id, restarting);
      await this.#sleep(this.#restartBackoffMs[attempt - 1] ?? 0);
      if (!this.#current(record.id, restarting)) return;
      if (await this.#startContainers(record, attempt, note).catch(() => false)) {
        await this.#waitReady(record);
      }
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
      if (info && !info.State.Running) {
        return `${role} container exited with ${info.State.ExitCode}`;
      }
    }
    return undefined;
  }

  async #readPorts(gate: string): Promise<Ports> {
    const info = await this.#inspect(gate);
    const port = (key: string) => {
      const p = Number(info.NetworkSettings.Ports[key]?.[0]?.HostPort);
      if (!Number.isInteger(p) || p <= 0) {
        throw new Error(`gate ${gate}: no published host port for ${key}`);
      }
      return p;
    };
    return { desktopd: port(GATE_PORTS.desktopd), stream: port(GATE_PORTS.stream) };
  }

  #inspect(name: string): Promise<ContainerInspect> {
    return this.#docker.request<ContainerInspect>({
      method: "GET",
      path: objectPath("containers", name, "json"),
    });
  }

  // v=true also removes the anonymous volumes an image's VOLUME lines create.
  #removeContainer(name: string): Promise<unknown> {
    return this.#docker.request({
      method: "DELETE",
      path: objectPath("containers", name),
      query: { force: "true", v: "true" },
    });
  }

  async #subnet(networkId: string): Promise<string> {
    const info = await this.#docker.request<NetworkInspect>({
      method: "GET",
      path: objectPath("networks", networkId),
    });
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
    const live = this.#live.get(record.id) ?? {
      state: "stopped" as const,
      restarts: 0,
      stream: NO_STREAM,
    };
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
