import { SELFTEST_CHECK_IDS, type SelfTestCheck, selfTestPassed, ulid } from "@localdot/protocol";
import type { CellKeyd } from "../keyd/cell-wiring.ts";
import { KeydUnavailableError } from "../keyd/client.ts";
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
  keyd?: CellKeyd;
  docker: DockerClient;
  store: CellStore;
  images: Images;
  streamFullcolor?: boolean;
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
  paused?: true;
  state: CellState;
  restarts: number;
  error?: string;
  ports?: Ports;
  stream: StreamState;
}

interface NetworkInspect {
  Id: string;
  IPAM: { Config: { Subnet?: string; Gateway?: string }[] };
}

interface UndoStep {
  what: string;
  run(): unknown;
}

interface ContainerInspect {
  State: { Running: boolean; Paused?: boolean; ExitCode: number; Error: string };
  NetworkSettings: {
    Ports: Record<string, { HostIp: string; HostPort: string }[] | null>;
    Networks: Record<string, unknown>;
  };
}

export interface CellControls {
  // A prior operation may replace credentials after Stop's immediate revoke.
  waitedForOperation: boolean;
  pause(): Promise<void>;
  unpause(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export class CellControlConflict extends Error {}

export class UnknownCellError extends Error {
  constructor(readonly cellId: string) {
    super(`unknown cell ${cellId}`);
    this.name = "UnknownCellError";
  }
}

export class SkippedCellsError extends Error {
  constructor(
    readonly cellIds: string[],
    where: { folder(id: string): string; containers(id: string): string } = {
      folder: (id) => id,
      containers: (id) => `localdot-*-${id}`,
    },
  ) {
    super(
      `cell records this daemon can't use (unreadable, or outside its keyd ports) may still hold keyd ports. Fix ${cellIds.map((id) => where.folder(id)).join(", ")} to start those computers again, or remove a folder and then its containers (${cellIds.map((id) => where.containers(id)).join(", ")}), before creating another computer`,
    );
    this.name = "SkippedCellsError";
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

// Detail that comes from a container or from desktopd is cut to this length before it is shown.
const MAX_DETAIL = 200;
const clamp = (text: string) =>
  text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL - 1)}…` : text;

// Spec, error handling: a crashed cell is restarted with backoff. Docker's own restart policy is not
// used (P2-R14): it would restart behind the daemon's back and change the published ports unseen.
const DEFAULT_RESTART_BACKOFF_MS = [2000, 4000, 8000, 16000, 30000];

export class CellOrchestrator {
  readonly #keyd: CellKeyd | undefined;
  readonly #docker: DockerClient;
  readonly #store: CellStore;
  readonly #images: Images;
  readonly #streamFullcolor: boolean;
  readonly #probeDesktopd: OrchestratorDeps["probeDesktopd"];
  readonly #probeStream: OrchestratorDeps["probeStream"];
  readonly #namePrefix: string;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #readyTimeoutMs: number;
  readonly #watchEveryMs: number;
  readonly #restartBackoffMs: number[];
  readonly #live = new Map<string, Live>();
  // Records never change once created, so each is read from disk once, not per request or event.
  readonly #records = new Map<string, CellRecord>();
  readonly #invalidRecords = new Set<string>();
  readonly #unclosedKeyd = new Set<string>();
  readonly #listeners = new Set<CellListener>();
  readonly #reservedKeydPorts = new Set<number>();
  readonly #queues = new Map<string, Promise<void>>();
  #disposed = false;

  constructor(deps: OrchestratorDeps) {
    this.#keyd = deps.keyd;
    this.#docker = deps.docker;
    this.#store = deps.store;
    this.#images = deps.images;
    this.#streamFullcolor = deps.streamFullcolor ?? true;
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
    const record = this.#record(id);
    return record && this.#summary(record);
  }

  record(id: string): CellRecord | undefined {
    return this.#record(id);
  }

  // Only a ready cell's ports are its own: any other state may hold ports Docker has handed on.
  endpoints(id: string): CellEndpoints | undefined {
    const live = this.#live.get(id);
    if (live?.state !== "ready" || live.paused || !live.ports) return undefined;
    const record = this.#record(id);
    return record && endpointsFor(record, live.ports);
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
    const { records, skipped } = this.#store.inventory();
    await this.#stopSkipped(skipped);
    for (const { id } of records) {
      await this.#queued(id, () => this.#reconcile(id)).catch((err: unknown) => {
        console.error(`cell ${id}: not reconciled (${codeOf(err)})`);
      });
    }
  }

  async #reconcile(id: string): Promise<void> {
    const record = this.#record(id);
    if (!record) return;
    try {
      const desktop = await this.#inspect(record.docker.desktop);
      const gate = await this.#inspect(record.docker.gate);
      if (desktop.State.Running && desktop.State.Paused) {
        if (gate.State.Running) {
          const ports = await this.#readPorts(record.docker.gate);
          this.#set(id, { state: "ready", restarts: 0, ports, stream: NO_STREAM, paused: true });
          this.#detach(id, this.#watch(record));
        } else if (await this.#startContainers(record, 0, undefined, true)) {
          this.#detach(id, this.#watch(record));
        }
      } else if (desktop.State.Running && gate.State.Running) {
        const ports = await this.#readPorts(record.docker.gate);
        this.#set(id, { state: "starting", restarts: 0, ports, stream: NO_STREAM });
        if (!(await this.#rewireIfLost(id))) this.#detach(id, this.#waitReady(record));
      } else if (!desktop.State.Running && !gate.State.Running) {
        this.#set(id, { state: "stopped", restarts: 0, stream: NO_STREAM });
      } else {
        const [role, info] = desktop.State.Running ? ["gate", gate] : ["desktop", desktop];
        this.#set(id, {
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
      this.#set(id, { state: "failed", restarts: 0, error, stream: NO_STREAM });
    }
  }

  async create(opts: { scale: Scale }): Promise<CellSummary> {
    const id = ulid();
    const { records, skipped } = this.#store.inventory();
    if (skipped.length > 0) {
      throw new SkippedCellsError(skipped, {
        folder: (cell) => this.#store.folder(cell),
        containers: (cell) => `${this.#namePrefix}*-${cell}`,
      });
    }
    // keyd tells cells apart by their listener port (M3), so the port is reserved before the first
    // await: two concurrent creates never get the same one.
    const keydPort = allocateKeydPort(
      [
        ...records.map((r) => r.keydPort),
        ...[...this.#records.values()].map((r) => r.keydPort),
        ...this.#reservedKeydPorts,
      ],
      this.#store.keydPorts,
    );
    this.#reservedKeydPorts.add(keydPort);
    try {
      return await this.#queued(id, () => this.#provision(id, keydPort, opts.scale));
    } finally {
      this.#reservedKeydPorts.delete(keydPort);
    }
  }

  async #provision(id: string, keydPort: number, scale: Scale): Promise<CellSummary> {
    const names = cellNames(id, this.#namePrefix);
    const undo: UndoStep[] = [];
    try {
      const internal = await this.#docker.request<{ Id: string }>({
        method: "POST",
        path: "/networks/create",
        body: internalNetworkSpec(names.internalNetwork),
      });
      undo.push({
        what: `network ${names.internalNetwork}`,
        run: () =>
          this.#docker.request({ method: "DELETE", path: objectPath("networks", internal.Id) }),
      });
      const egress = await this.#docker.request<{ Id: string }>({
        method: "POST",
        path: "/networks/create",
        body: egressNetworkSpec(names.egressNetwork),
      });
      undo.push({
        what: `network ${names.egressNetwork}`,
        run: () =>
          this.#docker.request({ method: "DELETE", path: objectPath("networks", egress.Id) }),
      });
      const internalSubnet = await this.#subnet(internal.Id, { isolated: true });
      const egressSubnet = await this.#subnet(egress.Id);
      await this.#docker.request({
        method: "POST",
        path: "/volumes/create",
        body: homeVolumeSpec(names.homeVolume),
      });
      undo.push({
        what: `volume ${names.homeVolume}`,
        run: () =>
          this.#docker.request({
            method: "DELETE",
            path: objectPath("volumes", names.homeVolume),
            query: { force: "true" },
          }),
      });
      const record: CellRecord = {
        v: 1,
        id,
        createdAt: new Date().toISOString(),
        scale,
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
        [
          names.desktop,
          desktopSpec(record, this.#images.desktop, { fullcolor: this.#streamFullcolor }),
        ],
      ] as const) {
        await this.#docker.request({
          method: "POST",
          path: "/containers/create",
          query: { name },
          body: spec,
        });
        undo.push({ what: `container ${name}`, run: () => this.#removeContainer(name) });
      }
      // Before the save, so a save that fails part-way leaves no folder behind either.
      undo.push({
        what: "the cell record",
        run: () => {
          // Keep the listener's identity and port reserved if cleanup did not get an answer.
          if (this.#unclosedKeyd.has(id)) return;
          this.#store.remove(id);
          this.#records.delete(id);
        },
      });
      this.#store.save(record);
      this.#records.set(id, record);
      if (await this.#startContainers(record, 0)) this.#detach(id, this.#waitReady(record));
      return this.#summary(record);
    } catch (err) {
      // Subscribers may have seen the cell start; they see it go, so none keeps a ghost.
      const keepRecord = this.#unclosedKeyd.has(id);
      if (!keepRecord && this.#live.has(id))
        this.#set(id, { state: "removed", restarts: 0, stream: NO_STREAM });
      await this.#undo(id, undo);
      if (keepRecord) {
        this.#set(id, {
          state: "failed",
          restarts: 0,
          stream: NO_STREAM,
          error:
            "start failed; keyd cleanup could not be confirmed; remove this computer when the key layer responds",
        });
      } else this.#live.delete(id);
      throw err;
    }
  }

  async #undo(id: string, steps: UndoStep[]): Promise<void> {
    for (const step of steps.reverse()) {
      try {
        await step.run();
      } catch (err) {
        console.error(`cell ${id}: could not undo ${step.what} (${statusOf(err)})`);
      }
    }
  }

  start(id: string): Promise<void> {
    return this.#queued(id, () => this.#start(id));
  }

  async #start(id: string): Promise<void> {
    if (this.#invalidRecords.has(id)) {
      const repaired = this.#store.get(id);
      if (!repaired) throw new Error("fix the cell record before starting the computer");
      this.#records.set(id, repaired);
      this.#invalidRecords.delete(id);
    }
    const record = this.#require(id);
    if (await this.#startContainers(record, 0)) this.#detach(id, this.#waitReady(record));
  }

  // Keep the entire kill switch or Resume in the lifecycle queue, including
  // credential work. A concurrent Start cannot boot between revoke and freeze.
  withLifecycle<T>(id: string, op: (controls: CellControls) => Promise<T>): Promise<T> {
    const waitedForOperation = this.#queues.has(id);
    return this.#queued(id, () =>
      op({
        waitedForOperation,
        pause: () => this.#pause(id),
        unpause: () => this.#unpause(id),
        start: () => this.#start(id),
        stop: () => this.#stop(id),
      }),
    );
  }

  pause(id: string): Promise<void> {
    return this.#queued(id, () => this.#pause(id));
  }

  async #pause(id: string): Promise<void> {
    const record = this.#require(id);
    const live = this.#live.get(id);
    if (live?.paused) {
      const state = (await this.#inspect(record.docker.desktop)).State;
      if (!state.Running || !state.Paused)
        throw new CellControlConflict("the frozen desktop changed outside the daemon");
      return;
    }
    if (live?.state !== "ready") {
      throw new CellControlConflict(`cell is ${live?.state ?? "stopped"}, not ready`);
    }
    const state = (await this.#inspect(record.docker.desktop)).State;
    if (!state.Running)
      throw new CellControlConflict("the desktop stopped before it could be paused");
    if (!state.Paused) {
      await this.#docker.request({
        method: "POST",
        path: objectPath("containers", record.docker.desktop, "pause"),
      });
    }
    this.#set(id, { ...live, paused: true, stream: NO_STREAM });
    this.#detach(id, this.#watch(record));
  }

  unpause(id: string): Promise<void> {
    return this.#queued(id, () => this.#unpause(id));
  }

  async #unpause(id: string): Promise<void> {
    const record = this.#require(id);
    const live = this.#live.get(id);
    if (!live?.paused || live.state !== "ready") {
      throw new CellControlConflict("the computer must be ready and paused before resuming");
    }
    const state = (await this.#inspect(record.docker.desktop)).State;
    if (!state.Running) throw new CellControlConflict("the desktop stopped while it was paused");
    // Docker 29 answers 500 for an already thawed container. Inspect instead of
    // hiding arbitrary server errors, and leave the paused state on failure.
    if (state.Paused) {
      await this.#docker.request({
        method: "POST",
        path: objectPath("containers", record.docker.desktop, "unpause"),
      });
    }
    this.#set(id, thawed(live));
    this.#detach(id, this.#watch(record));
  }

  // Fresh surrogates after a key changed, in the cell's queue: a start, restart or rewire that
  // reopens the cell in keyd finishes first, so a refresh never mints on a cell wire() is about to
  // close and then writes those dead stand-ins over the new ones. Only a running or booting,
  // unfrozen desktop gets them. Resolves the keys it can use only after it starts again.
  refreshKeys(id: string): Promise<string[]> {
    return this.#queued(id, async () => {
      const live = this.#live.get(id);
      const record = this.#record(id);
      const running = (live?.state === "ready" || live?.state === "starting") && !live.paused;
      return running && record && this.#keyd ? this.#keyd.refresh(record) : [];
    });
  }

  // A running desktop whose keyd cell was lost must boot with a new CA and token.
  async rewireIfLost(id: string): Promise<void> {
    await this.#queued(id, () => this.#rewireIfLost(id));
  }

  async #rewireIfLost(id: string): Promise<boolean> {
    const live = this.#live.get(id);
    if (live?.paused) return false;
    const record = this.#record(id);
    if (!record || !this.#keyd || (live?.state !== "ready" && live?.state !== "starting"))
      return false;
    const wired = await this.#keyd.isWired(record).catch(() => true);
    if (wired || !this.#current(id, live)) return false;
    const note = "the key layer restarted; reconnecting the computer";
    if (await this.#startContainers(record, live.restarts, note).catch(() => false)) {
      this.#detach(id, this.#waitReady(record));
    }
    return true;
  }

  stop(id: string): Promise<void> {
    return this.#queued(id, () => this.#stop(id));
  }

  async #stop(id: string): Promise<void> {
    const record = this.#require(id);
    const stopping: Live = { state: "stopping", restarts: 0, stream: NO_STREAM };
    this.#set(id, stopping);
    const closed = await this.#closeInKeyd(id);
    try {
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
      if (!closed)
        throw new Error(
          "keyd closure could not be confirmed; try Stop again when the key layer responds",
        );
    } catch (err) {
      if (this.#current(id, stopping)) {
        this.#set(id, {
          state: "failed",
          restarts: 0,
          error: `stop failed: ${messageOf(err)}`,
          stream: NO_STREAM,
        });
      }
      throw err;
    }
    this.#set(id, { state: "stopped", restarts: 0, stream: NO_STREAM });
  }

  remove(id: string, opts: { purgeHome?: boolean } = {}): Promise<void> {
    return this.#queued(id, () => this.#remove(id, opts));
  }

  async #remove(id: string, opts: { purgeHome?: boolean }): Promise<void> {
    const record = this.#require(id);
    const d = record.docker;
    const ignoreMissing = (err: unknown) => {
      if (!isStatus(err, 404)) throw err;
    };
    const removing: Live = { state: "stopping", restarts: 0, stream: NO_STREAM };
    this.#set(id, removing);
    const closed = await this.#closeInKeyd(id);
    try {
      for (const name of [d.desktop, d.gate]) {
        await this.#removeContainer(name).catch(ignoreMissing);
      }
      if (!closed)
        throw new Error(
          "keyd closure could not be confirmed; retry Remove when the key layer responds",
        );
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
    } catch (err) {
      if (this.#current(id, removing)) {
        this.#set(id, {
          state: "failed",
          restarts: 0,
          error: `remove failed: ${messageOf(err)}`,
          stream: NO_STREAM,
        });
      }
      throw err;
    }
    this.#set(id, { state: "removed", restarts: 0, stream: NO_STREAM });
    this.#store.remove(id);
    this.#records.delete(id);
    this.#invalidRecords.delete(id);
    this.#live.delete(id);
  }

  // Resolves false when a stop, a remove or a newer start took the cell over while it ran.
  async #startContainers(
    record: CellRecord,
    restarts: number,
    error?: string,
    frozen = false,
  ): Promise<boolean> {
    const d = record.docker;
    const starting: Live = {
      state: "starting",
      restarts,
      stream: NO_STREAM,
      ...(error ? { error } : {}),
      ...(frozen ? { paused: true as const } : {}),
    };
    this.#set(record.id, starting);
    try {
      const desktop = (await this.#inspect(d.desktop)).State;
      if (frozen && (!desktop.Running || !desktop.Paused)) {
        throw new Error("the frozen desktop changed; start the computer again");
      }
      if (!frozen) {
        let running = desktop.Running;
        if (running && (desktop.Paused || (this.#keyd && !(await this.#keyd.isWired(record))))) {
          await this.#stopContainer(d.desktop);
          running = false;
        }
        if (!this.#current(record.id, starting)) return false;
        if (!running) await this.#keyd?.wire(record);
        if (!this.#current(record.id, starting)) return false;
      }
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
      if (!frozen) {
        await this.#docker.request({
          method: "POST",
          path: objectPath("containers", d.desktop, "start"),
        });
      }
      // Every start publishes new host ports (Review Focus 2).
      const ports = await this.#readPorts(d.gate);
      if (!this.#current(record.id, starting)) return false;
      this.#set(
        record.id,
        frozen
          ? { state: "ready", restarts, ports, stream: NO_STREAM, paused: true }
          : { ...starting, ports },
      );
      return true;
    } catch (err) {
      if (this.#current(record.id, starting)) {
        // A partial start must not strand its listener or either running container.
        await this.#closeInKeyd(record.id);
        await Promise.allSettled([this.#stopContainer(d.desktop), this.#stopContainer(d.gate)]);
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
      const ready =
        health?.ok && (!this.#keyd || (health.selftest && selfTestPassed(health.selftest)));
      if (ready) {
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
          this.#detach(record.id, this.#watch(record));
          return;
        }
        lastDetail = "desktopd is ready; the stream is not answering yet";
      } else if (health?.selftest) {
        const breach = health.selftest.checks.find((c) => c.kind === "isolation" && !c.ok);
        if (breach) {
          await this.#queued(record.id, () => this.#isolationFailure(record, live, breach));
          return;
        }
        const { checks } = health.selftest;
        const problems = [
          ...checks.filter((c) => !c.ok).map((c) => `${c.id}: ${c.detail}`),
          ...SELFTEST_CHECK_IDS.filter((id) => !checks.some((c) => c.id === id)).map(
            (id) => `${id}: missing`,
          ),
        ];
        lastDetail = `self-test failed: ${clamp(problems.join("; "))}`;
      } else if (health) {
        lastDetail = clamp(
          `desktopd not ready: hidpi ${JSON.stringify(health.hidpi)}, screen ${JSON.stringify(health.screen)}`,
        );
      }
      const exited = await this.#exitedContainer(record);
      if (!this.#current(record.id, live)) return;
      if (exited) {
        this.#set(record.id, { ...live, state: "failed", error: exited.detail });
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

  async #isolationFailure(record: CellRecord, live: Live, breach: SelfTestCheck): Promise<void> {
    if (!this.#current(record.id, live)) return;
    // Hold the lifecycle queue so this cleanup cannot close a newer start's listener or desktop.
    await this.#closeInKeyd(record.id);
    let stopped = true;
    await this.#stopContainer(record.docker.desktop, 0).catch(() => {
      stopped = false;
    });
    if (!this.#current(record.id, live)) return;
    this.#set(record.id, {
      ...live,
      state: "failed",
      error: `network isolation check failed (${breach.id}: ${clamp(breach.detail)}); ${stopped ? "the computer was stopped" : "could not confirm the computer stopped; stop it in Docker"}`,
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
      // Claim the transition in the same queue as Stop/Resume. A watch that
      // inspected before a freeze must not restart a now-frozen desktop.
      const restarting = await this.#queued(record.id, async () => {
        if (!this.#current(record.id, live)) return undefined;
        if (exited.gone || (live.paused && exited.role === "desktop")) {
          this.#set(record.id, {
            ...thawed(live),
            state: "failed",
            error: exited.gone
              ? exited.detail
              : `${exited.detail} while it was frozen; start the computer again`,
          });
          return undefined;
        }
        const attempt = live.restarts + 1;
        if (attempt > this.#restartBackoffMs.length) {
          this.#set(record.id, {
            ...live,
            state: "failed",
            error: `${exited.detail}; gave up after ${live.restarts} restarts`,
          });
          return undefined;
        }
        const next: Live = {
          ...live,
          state: "starting",
          restarts: attempt,
          error: `${exited.detail}; restarting (attempt ${attempt} of ${this.#restartBackoffMs.length})`,
        };
        this.#set(record.id, next);
        return next;
      });
      if (!restarting) return;
      const attempt = restarting.restarts;
      const note = restarting.error;
      const frozen = live.paused === true;
      await this.#sleep(this.#restartBackoffMs[attempt - 1] ?? 0);
      if (!this.#current(record.id, restarting)) return;
      // Queued like a user's start: a Stop that lands during the restart runs after it.
      const restarted = await this.#queued(record.id, async () =>
        this.#current(record.id, restarting)
          ? this.#startContainers(record, attempt, note, frozen)
          : false,
      ).catch(() => false);
      if (restarted)
        this.#detach(record.id, frozen ? this.#watch(record) : this.#waitReady(record));
      return;
    }
  }

  // One cell's create, start, stop, remove, restart and reconcile run one at a time, in the order
  // they arrive, while other cells go on: a Start that lands during a Stop runs after it instead of
  // interleaving with it and being lost. Readiness and the restart backoff wait outside the queue.
  #queued<T>(id: string, op: () => Promise<T>): Promise<T> {
    const run = (this.#queues.get(id) ?? Promise.resolve()).then(op);
    const settled = run.then(
      () => {},
      () => {},
    );
    this.#queues.set(id, settled);
    void settled.then(() => {
      if (this.#queues.get(id) === settled) this.#queues.delete(id);
    });
    return run;
  }

  // Readiness and watch run with no caller to hand an error to: one that escapes fails the cell, if
  // nothing has taken it over since, with one line, and never ends the daemon.
  #detach(id: string, loop: Promise<void>): void {
    const entry = this.#live.get(id);
    void loop.catch((err: unknown) => {
      const error = `background check stopped (${codeOf(err)})`;
      console.error(`cell ${id}: ${error}`);
      if (entry && this.#current(id, entry)) this.#set(id, { ...entry, state: "failed", error });
    });
  }

  // A loop that awaited goes on only while the cell still holds the entry it set or read: a stop, a
  // remove, a newer start or dispose() in the meantime wins (a user's Stop beats a restart).
  #current(id: string, entry: Live): boolean {
    return !this.#disposed && this.#live.get(id) === entry;
  }

  // A container that is gone (404) can't be restarted; any other inspect error says nothing about
  // it, so the container counts as running until an answer says otherwise.
  async #exitedContainer(
    record: CellRecord,
  ): Promise<{ role: "desktop" | "gate"; detail: string; gone: boolean } | undefined> {
    for (const [role, name] of [
      ["desktop", record.docker.desktop],
      ["gate", record.docker.gate],
    ] as const) {
      const info = await this.#inspect(name).catch((err: unknown) =>
        isStatus(err, 404) ? null : undefined,
      );
      if (info === null) {
        return {
          role,
          detail: `${role} container is missing: removed outside localDot`,
          gone: true,
        };
      }
      if (info && !info.State.Running) {
        const reason = info.State.Error ? `: ${clamp(info.State.Error)}` : "";
        return {
          role,
          detail: `${role} container exited with ${info.State.ExitCode}${reason}`,
          gone: false,
        };
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

  // Only unreadable folders in this home are ours to stop. Never scan by a shared prefix.
  async #stopSkipped(skipped: string[]): Promise<void> {
    for (const id of skipped) {
      await this.#queued(id, async () => {
        const names = cellNames(id, this.#namePrefix);
        this.#invalidRecords.add(id);
        // Reconcile may run while a watch still holds a cached record that became unreadable.
        this.#set(id, {
          state: "failed",
          restarts: 0,
          stream: NO_STREAM,
          error: "cell.json can't be used; fix the record before starting the computer",
        });
        const closed = await this.#closeInKeyd(id);
        let stopped = true;
        for (const name of [names.desktop, names.gate]) {
          await this.#stopContainer(name).catch((err: unknown) => {
            stopped = false;
            console.error(`cell ${id}: could not stop ${name} (${statusOf(err)})`);
          });
        }
        console.error(
          `cell ${id}: cell.json can't be used; ${closed && stopped ? "keyd closed the cell and its containers were stopped" : "cleanup could not be confirmed"}; fix or remove ${this.#store.folder(id)}`,
        );
      });
    }
  }

  async #stopContainer(name: string, seconds = 10): Promise<void> {
    await this.#docker
      .request({
        method: "POST",
        path: objectPath("containers", name, "stop"),
        query: { t: String(seconds) },
      })
      .catch((err) => {
        if (!isStatus(err, 304, 404)) throw err;
      });
  }

  async #closeInKeyd(id: string): Promise<boolean> {
    try {
      await this.#keyd?.close(id);
      this.#unclosedKeyd.delete(id);
      return true;
    } catch (err) {
      // A missing/refused local socket has no service behind it. A response timeout or a server
      // error does not prove the listener is gone, so it must retain the cell record and port.
      if (err instanceof KeydUnavailableError && ["ENOENT", "ECONNREFUSED"].includes(err.detail)) {
        this.#unclosedKeyd.delete(id);
        return true;
      }
      this.#unclosedKeyd.add(id);
      console.error(`cell ${id}: keyd did not close it (${codeOf(err)})`);
      return false;
    }
  }

  // v=true also removes the anonymous volumes an image's VOLUME lines create.
  #removeContainer(name: string): Promise<unknown> {
    return this.#docker.request({
      method: "DELETE",
      path: objectPath("containers", name),
      query: { force: "true", v: "true" },
    });
  }

  async #subnet(networkId: string, opts: { isolated?: boolean } = {}): Promise<string> {
    const info = await this.#docker.request<NetworkInspect>({
      method: "GET",
      path: objectPath("networks", networkId),
    });
    const config = info.IPAM.Config[0];
    const subnet = config?.Subnet;
    if (!subnet) throw new Error(`network ${networkId} has no IPv4 subnet`);
    const gateway = info.IPAM.Config.find(
      (entry) => entry.Gateway && entry.Gateway !== "invalid IP",
    )?.Gateway;
    if (opts.isolated && gateway && gateway !== "invalid IP") {
      throw new Error(
        `network ${networkId} has a gateway address (${clamp(gateway)}): this Docker Engine does not isolate internal networks; run the doctor`,
      );
    }
    return subnet;
  }

  #require(id: string): CellRecord {
    const record = this.#record(id);
    if (!record) throw new UnknownCellError(id);
    return record;
  }

  #record(id: string): CellRecord | undefined {
    const cached = this.#records.get(id);
    if (cached) return cached;
    const record = this.#store.get(id);
    if (record) this.#records.set(id, record);
    return record;
  }

  #set(id: string, live: Live): void {
    this.#live.set(id, live);
    this.#emit(id);
  }

  // Every cell with a state has its record in memory, so an event never reads the disk.
  #emit(id: string): void {
    const record = this.#records.get(id);
    if (!record) return;
    const summary = this.#summary(record);
    for (const listener of this.#listeners) {
      try {
        const result: unknown = listener(summary);
        if (result instanceof Promise) result.catch((err: unknown) => listenerFailed(id, err));
      } catch (err) {
        listenerFailed(id, err);
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
      ...(live.paused ? { paused: true as const } : {}),
    };
  }
}

function thawed(live: Live): Live {
  const { paused: _paused, ...rest } = live;
  return rest;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function codeOf(err: unknown): string {
  return (err as NodeJS.ErrnoException | undefined)?.code ?? "no error code";
}

function statusOf(err: unknown): string {
  if (!(err instanceof DockerError)) return codeOf(err);
  return err.status ? `status ${err.status}` : "Docker unreachable";
}

// Only the code: a listener's error message may quote anything it was handling.
function listenerFailed(id: string, err: unknown): void {
  console.error(`cell ${id}: a state listener failed (${codeOf(err)})`);
}
