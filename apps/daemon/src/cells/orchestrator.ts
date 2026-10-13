import { isDeepStrictEqual as equal } from "node:util";
import {
  type ComputerOperationKind,
  type ComputerOperationStep,
  SELFTEST_CHECK_IDS,
  type SelfTestCheck,
  selfTestPassed,
  ulid,
} from "@localdot/protocol";
import { ComputerResetRecord } from "../../../../packages/protocol/src/computer-reset.ts";
import type { CellKeyd } from "../keyd/cell-wiring.ts";
import { KeydUnavailableError } from "../keyd/client.ts";
import type { ComputerUpdates } from "./computer-update.ts";
import { type DiagnosticSelfTest, probeDiagnosticSelfTest } from "./diagnostic-selftest.ts";
import { type DockerClient, DockerError } from "./docker.ts";
import { inspectOwnedCell, requireFreshNames, retireExactCell } from "./exact-retirement.ts";
import { gateCaptures, type ImageInspect, type Images } from "./images.ts";
import { hostAddress } from "./ipv4.ts";
import { type BeginOptions, CellOperations } from "./operations.ts";
import { allocateKeydPort } from "./ports.ts";
import { type GateRelay, HOST_RELAY } from "./relay.ts";
import { captureComputerResetSource } from "./reset-source.ts";
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
  linkName,
  linkSpec,
  NAME_PREFIX,
} from "./spec.ts";
import type { CellStore } from "./store.ts";
import { SystemBaseMissing, SystemMigrationConflict } from "./system-migration-plan.ts";
import { ComputerSystemState } from "./system-state.ts";
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
  browser?: {
    stop(parentCellId: string): Promise<void>;
    remove(parentCellId: string, options?: { purgeProfile?: boolean }): Promise<void>;
    reservedKeydPorts?(): Iterable<number>;
  };
  externalKeydPorts?(): Iterable<number>;
  permanentFence?(id: string): { revision: number } | boolean | undefined;
  // Independent reset ownership cannot be cleared by ordinary replacement publication.
  candidateHold?(id: string): boolean;
  runtimeHold?(id: string): boolean;
  creationAllowed?(): boolean;
  verifyRuntime?(record: CellRecord): Promise<void>;
  diagnosticAdmission?(id: string): { release(): void } | undefined;
  updates?: Pick<
    ComputerUpdates,
    "available" | "needsFreshStart" | "pending" | "prepare" | "swap" | "recover" | "discard"
  >;
  diagnosticProbe?(
    endpoint: CellEndpoints["desktopd"],
    signal: AbortSignal,
  ): Promise<DiagnosticSelfTest>;
  docker: DockerClient;
  store: CellStore;
  images: Images;
  // How gates reach keyd and the daemon (cells/relay.ts); Docker Desktop's host name by default.
  relay?: () => Promise<GateRelay>;
  streamFullcolor?: boolean;
  probeDesktopd(
    endpoint: CellEndpoints["desktopd"],
    timeoutMs?: number,
    options?: { selftest?: boolean },
  ): Promise<DesktopdHealth | undefined>;
  probeStream(endpoint: CellEndpoints["stream"]): Promise<boolean>;
  // Docker-backed tests pass "localdot-test-", so they never create or touch a real cell's objects.
  namePrefix?: string;
  // Added to every Docker object a cell gets, so a test's cleanup can filter by its label alone.
  labels?: Readonly<Record<string, string>>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
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

type OperationStart = BeginOptions & { kind: ComputerOperationKind };

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

// The result of one required retirement, independent of later recovery attempts.
class BrowserShutdownConflict extends CellControlConflict {
  constructor() {
    super("browser shutdown could not be confirmed; retry Stop");
  }
}

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
const objectPath = (
  kind: "containers" | "networks" | "volumes" | "images",
  name: string,
  action?: string,
) => `/${kind}/${encodeURIComponent(name)}${action ? `/${action}` : ""}`;

export const UPDATE_UNFINISHED = "The update didn't finish. Turn on your computer to finish it.";
export const UPDATE_RECORDS_UNREADABLE =
  "localDot can't read its update records. Restart localDot, then turn on your computer.";
export const UPDATE_NEEDS_FRESH_START =
  "Your computer's update can't be finished. Start fresh to use it again.";
const UPDATE_UNDONE = "Your computer couldn't be updated. It's back as it was.";
const UPDATE_STOPPED = "Your computer couldn't be updated. Turn it on to keep using it.";

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
  readonly #relay: () => Promise<GateRelay>;
  readonly #streamFullcolor: boolean;
  readonly #probeDesktopd: OrchestratorDeps["probeDesktopd"];
  readonly #probeStream: OrchestratorDeps["probeStream"];
  readonly #namePrefix: string;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;
  readonly #ops: CellOperations;
  readonly #candidateHolds = new Set<string>();
  readonly #reservedIds = new Set<string>();
  readonly #retiredPortOwners = new Set<string>();
  readonly #readyTimeoutMs: number;
  readonly #watchEveryMs: number;
  readonly #restartBackoffMs: number[];
  readonly #live = new Map<string, Live>();
  readonly #watchOwners = new Map<string, Live>();
  // A record changes only when an update moves it onto new containers, which also caches it, so
  // each is read from disk once, not per request or event.
  readonly #records = new Map<string, CellRecord>();
  readonly #invalidRecords = new Set<string>();
  readonly #unclosedKeyd = new Set<string>();
  readonly #listeners = new Set<CellListener>();
  readonly #reservedKeydPorts = new Set<number>();
  readonly #externalKeydPorts: (() => Iterable<number>) | undefined;
  readonly #queues = new Map<string, Promise<void>>();
  readonly #diagnostics = new Map<string, AbortController>();
  readonly #browserHolds = new Map<string, number>();
  readonly #browserStops = new Map<string, Promise<void>>();
  readonly #browserFailures = new Set<string>();
  // From an update's stop until its computer is ready again or fails.
  readonly #updating = new Set<string>();
  #browserRecoveries = 0;
  #browserRecoveryEpoch = 0;
  #browserRecoveryFailed = false;
  #disposed = false;

  constructor(private readonly deps: OrchestratorDeps) {
    this.#keyd = deps.keyd;
    this.#docker = deps.docker;
    this.#store = deps.store;
    this.#images = deps.images;
    this.#relay = deps.relay ?? (() => Promise.resolve(HOST_RELAY));
    this.#streamFullcolor = deps.streamFullcolor ?? false;
    this.#probeDesktopd = deps.probeDesktopd;
    this.#probeStream = deps.probeStream;
    this.#externalKeydPorts = deps.externalKeydPorts;
    this.#namePrefix = deps.namePrefix ?? NAME_PREFIX;
    this.#sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.#now = deps.now ?? Date.now;
    this.#ops = new CellOperations(deps.store, this.#now);
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

  reservedKeydPorts(): number[] {
    const { records, skipped } = this.#store.inventoryAll();
    if (skipped.length)
      throw new CellControlConflict("unreadable cell records may retain keyd ports");
    return [
      ...new Set([
        ...records.filter((r) => !this.#retiredPortOwners.has(r.id)).map((r) => r.keydPort),
        ...[...this.#records.values()]
          .filter((r) => !this.#retiredPortOwners.has(r.id))
          .map((r) => r.keydPort),
        ...this.#reservedKeydPorts,
        ...(this.deps.browser?.reservedKeydPorts?.() ?? []),
      ]),
    ];
  }

  record(id: string): CellRecord | undefined {
    return this.#record(id);
  }
  hasStoredIdentity(id: string): boolean {
    return !!this.#store.getStored(id) || this.#store.inventoryAll().skipped.includes(id);
  }

  browserAvailable(id: string): boolean {
    return (
      !this.#disposed &&
      this.#browserRecoveries === 0 &&
      !this.#browserRecoveryFailed &&
      !this.#browserHolds.has(id) &&
      !this.#browserStops.has(id) &&
      !this.#browserFailures.has(id) &&
      this.endpoints(id) !== undefined
    );
  }

  // Only a ready cell's ports are its own: any other state may hold ports Docker has handed on.
  endpoints(id: string): CellEndpoints | undefined {
    const live = this.#live.get(id);
    if (this.#held(id) || live?.state !== "ready" || live.paused || !live.ports) return undefined;
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
    if (live.stream.connection === "live") this.#ops.connected(id);
    this.#emit(id);
  }

  // Stops the background watch and readiness loops; the daemon's process exit does the rest.
  dispose(): void {
    this.#disposed = true;
    for (const controller of this.#diagnostics.values()) controller.abort();
    for (const id of this.#live.keys()) void this.#stopBrowser(id).catch(() => {});
  }

  // Restart counters live in memory, so a daemon restart starts them again at 0.
  async reconcile(options: { strict?: boolean } = {}): Promise<void> {
    const epoch = ++this.#browserRecoveryEpoch;
    this.#browserRecoveries++;
    this.#browserRecoveryFailed = true;
    const drains = new Map<string, Promise<void>>();
    const fence = (id: string) => {
      if (drains.has(id)) return;
      const stopped = this.#stopBrowser(id);
      drains.set(id, stopped);
      void stopped.catch(() => {});
    };
    // Inventory and cleanup may fail or stall. Revoke every known owner first, including
    // those queued behind a different operation; a global hold also covers newly found IDs.
    for (const id of new Set([
      ...this.#live.keys(),
      ...this.#records.keys(),
      ...this.#queues.keys(),
      ...this.#reservedIds,
      ...this.#candidateHolds,
      ...this.#browserHolds.keys(),
      ...this.#browserStops.keys(),
      ...this.#browserFailures,
    ]))
      fence(id);
    try {
      const { records, skipped } = this.#store.inventory();
      for (const id of [...records.map((record) => record.id), ...skipped]) fence(id);
      let failed = false;
      let incomplete = options.strict === true && skipped.length > 0;
      await this.#stopSkipped(skipped).catch(() => {
        failed = true;
      });
      for (const { id } of records) {
        await this.#withBrowser(id, () => this.#reconcile(id, options.strict)).catch(
          (err: unknown) => {
            incomplete = true;
            // Keep the existing per-record diagnostic behavior for parent read errors,
            // but a failed child retirement cannot become a successful recovery receipt.
            if (err instanceof BrowserShutdownConflict) failed = true;
            console.error(`cell ${id}: not reconciled (${codeOf(err)})`);
          },
        );
      }
      const results = await Promise.allSettled(drains.values());
      if (failed || results.some((result) => result.status === "rejected"))
        throw new CellControlConflict("browser shutdown could not be confirmed; retry Stop");
      if (options.strict && incomplete)
        throw new CellControlConflict("installed service recovery could not be confirmed");
      if (epoch === this.#browserRecoveryEpoch) this.#browserRecoveryFailed = false;
    } finally {
      // A discovery error must still wait for already-started browser containment.
      await Promise.allSettled(drains.values());
      this.#browserRecoveries--;
    }
  }

  async #reconcile(id: string, strict = false): Promise<void> {
    let record = this.#record(id);
    if (!record) return;
    if (this.deps.runtimeHold?.(id) && !this.deps.permanentFence?.(id)) {
      this.#set(id, {
        state: "failed",
        restarts: 0,
        stream: NO_STREAM,
        error: "Computer runtime update recovery is incomplete.",
      });
      if (strict) throw new CellControlConflict("Computer runtime update recovery is incomplete.");
      return;
    }
    if (this.#held(id)) {
      if (this.deps.permanentFence?.(id)) await this.#containFenced(record);
      else
        this.#set(id, {
          state: "failed",
          restarts: 0,
          stream: NO_STREAM,
          error: "Replacement recovery has not confirmed this computer.",
        });
      return;
    }
    try {
      record = await this.#finishUpdate(record);
      await this.deps.verifyRuntime?.(record);
      if (this.#held(id))
        throw new CellControlConflict("computer admission changed during recovery");
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
        this.#ops.begin(id, "start", "ready", { timed: false });
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
      // A missing container is an observed state; other failed observations cannot certify
      // managed startup. Preserve per-cell diagnostics and continue recovering other records.
      if (strict && !isStatus(err, 404)) throw err;
    }
  }

  async create(opts: { scale: Scale; id?: string; restoreFrom?: string }): Promise<CellSummary> {
    if (this.deps.creationAllowed?.() === false)
      throw new CellControlConflict("Computer runtime update recovery is incomplete.");
    const id = opts.id ?? ulid();
    if (
      !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id) ||
      this.#store.getStored(id) ||
      this.#record(id) ||
      this.#queues.has(id) ||
      this.#reservedIds.has(id) ||
      this.deps.permanentFence?.(id)
    )
      throw new CellControlConflict("computer identity is unavailable");
    this.#reservedIds.add(id);
    let keydPort: number | undefined;
    try {
      const { records, skipped } = this.#store.inventoryAll();
      if (skipped.length)
        throw new SkippedCellsError(skipped, {
          folder: (cell) => this.#store.folder(cell),
          containers: (cell) => `${this.#namePrefix}*-${cell}`,
        });
      if (opts.id) await requireFreshNames(this.#docker, cellNames(id, this.#namePrefix));
      keydPort = allocateKeydPort(
        [
          ...records
            .filter((record) => !this.#retiredPortOwners.has(record.id))
            .map((record) => record.keydPort),
          ...[...this.#records.values()]
            .filter((record) => !this.#retiredPortOwners.has(record.id))
            .map((record) => record.keydPort),
          ...this.#reservedKeydPorts,
          ...(this.#externalKeydPorts?.() ?? []),
        ],
        this.#store.keydPorts,
      );
      this.#reservedKeydPorts.add(keydPort);
      const port = keydPort;
      return await this.#queued(id, () => this.#provision(id, port, opts.scale, opts.restoreFrom));
    } finally {
      this.#reservedIds.delete(id);
      if (keydPort !== undefined) this.#reservedKeydPorts.delete(keydPort);
    }
  }

  async #provision(
    id: string,
    keydPort: number,
    scale: Scale,
    restoreFrom?: string,
  ): Promise<CellSummary> {
    const startedAt = this.#now();
    const names = cellNames(id, this.#namePrefix);
    const undo: UndoStep[] = [];
    try {
      const capture = await this.#gateCaptures();
      const internal = await this.#docker.request<{ Id: string }>({
        method: "POST",
        path: "/networks/create",
        body: this.#labeled(internalNetworkSpec(names.internalNetwork, id)),
      });
      undo.push({
        what: `network ${names.internalNetwork}`,
        run: () =>
          this.#docker.request({ method: "DELETE", path: objectPath("networks", internal.Id) }),
      });
      const egress = await this.#docker.request<{ Id: string }>({
        method: "POST",
        path: "/networks/create",
        body: this.#labeled(egressNetworkSpec(names.egressNetwork, id)),
      });
      undo.push({
        what: `network ${names.egressNetwork}`,
        run: () =>
          this.#docker.request({ method: "DELETE", path: objectPath("networks", egress.Id) }),
      });
      const internalSubnet = await this.#subnet(internal.Id, { isolated: true });
      const egressSubnet = await this.#subnet(egress.Id);
      const volume = await this.#docker.request<{ Name: string; Labels?: Record<string, string> }>({
        method: "POST",
        path: "/volumes/create",
        body: this.#labeled(homeVolumeSpec(names.homeVolume, id)),
      });
      if (
        volume.Name !== names.homeVolume ||
        volume.Labels?.["localdot.cell"] !== id ||
        volume.Labels?.["localdot.role"] !== "home"
      )
        throw new Error("fresh home ownership unavailable");
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
        v: 2,
        kind: "desktop",
        ownership: {
          internalNetwork: internal.Id,
          egressNetwork: egress.Id,
          gate: "",
          desktop: "",
        },
        id,
        createdAt: new Date().toISOString(),
        scale,
        keydPort,
        tokens: {
          desktopd: newCellToken(),
          stream: newCellToken(),
          ...(capture ? { capture: newCellToken() } : {}),
        },
        docker: {
          ...names,
          gateInternalIp: hostAddress(internalSubnet, GATE_OFFSET),
          gateEgressIp: hostAddress(egressSubnet, GATE_OFFSET),
          desktopIp: hostAddress(internalSubnet, DESKTOP_OFFSET),
        },
      };
      let desktopImage = this.#images.desktop;
      if (restoreFrom) {
        const state = new ComputerSystemState(this.#store.home, this.#docker, this.#images.desktop);
        // Even a lost helper-create response is cleaned up before volume rollback.
        undo.push({ what: "home copy helper", run: () => state.cleanupCopy(id) });
        desktopImage = await state.copyHome(restoreFrom, id, names.homeVolume);
      }
      for (const [name, spec] of [
        [names.gate, gateSpec(record, this.#images.gate, await this.#relay())],
        [names.desktop, desktopSpec(record, desktopImage, { fullcolor: this.#streamFullcolor })],
      ] as const) {
        const made = await this.#docker.request<{ Id: string }>({
          method: "POST",
          path: "/containers/create",
          query: { name },
          body: this.#labeled(spec),
        });
        if (!made.Id || typeof made.Id !== "string")
          throw new Error("container identity unavailable");
        if (record.ownership) record.ownership[name === names.gate ? "gate" : "desktop"] = made.Id;
        undo.push({ what: `container ${name}`, run: () => this.#removeContainer(made.Id) });
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
      const begun = await this.#startContainers(record, 0, undefined, false, {
        kind: "first-start",
        startedAt,
      });
      if (begun) this.#detach(id, this.#waitReady(record));
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
      } else {
        this.#live.delete(id);
        this.#ops.end(id);
      }
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
    return this.#withBrowser(id, () => this.#start(id));
  }

  async #start(id: string): Promise<void> {
    const startedAt = this.#now();
    if (this.#held(id))
      throw new CellControlConflict(
        "the computer is permanently fenced or awaiting replacement confirmation",
      );
    if (this.#invalidRecords.has(id)) {
      const repaired = this.#store.get(id);
      if (!repaired) throw new Error("fix the cell record before starting the computer");
      this.#records.set(id, repaired);
      this.#invalidRecords.delete(id);
    }
    const record = await this.#finishUpdate(this.#require(id)).catch((error: unknown) => {
      if (this.deps.updates?.needsFreshStart(id))
        this.#set(id, {
          state: "failed",
          restarts: 0,
          stream: NO_STREAM,
          error: UPDATE_NEEDS_FRESH_START,
        });
      throw error;
    });
    const begun = await this.#startContainers(
      record,
      0,
      undefined,
      false,
      { kind: "start", startedAt },
      this.#live.get(id)?.state === "failed",
    );
    if (begun) this.#detach(id, this.#waitReady(record));
  }

  // Stops the computer, moves it onto the images its tags name now and starts it again. Its home,
  // networks, addresses, tokens and keyd port stay; an update that fails before the old containers
  // go brings the computer back as it was.
  async update(id: string): Promise<void> {
    // Refuse missing prerequisites before #withBrowser fences and stops the user's browser.
    // #update repeats this check after acquiring the lifecycle queue.
    if (!this.deps.updates) throw new CellControlConflict("Updates are unavailable.");
    await this.deps.updates.prepare(this.#require(id));
    return this.#withBrowser(id, () => this.#update(id));
  }

  async #update(id: string): Promise<void> {
    const startedAt = this.#now();
    const updates = this.deps.updates;
    if (!updates) throw new CellControlConflict("Updates are unavailable.");
    const record = this.#require(id);
    await updates.prepare(record);
    // Checked after the last wait: a reset or replacement holds the computer from its first step.
    if (this.#held(id))
      throw new CellControlConflict(
        "the computer is permanently fenced or awaiting replacement confirmation",
      );
    this.#updating.add(id);
    const stopping: Live = { state: "stopping", restarts: 0, stream: NO_STREAM };
    this.#ops.begin(id, "update", "shutdown", { startedAt });
    this.#set(id, stopping);
    let refusal = UPDATE_UNDONE;
    let next: CellRecord;
    try {
      if (!(await this.#closeInKeyd(id))) {
        refusal = "The key layer didn't answer. Try again in a moment.";
        throw new CellControlConflict(refusal);
      }
      for (const name of [record.docker.desktop, record.docker.gate])
        await this.#stopContainer(name);
      this.#step(id, "install");
      next = await updates.swap(await this.#finishUpdate(record), (n) => this.#adopt(n));
    } catch (error) {
      console.error(`computer update ${id} failed:`, error);
      this.#updating.delete(id);
      if (!this.#current(id, stopping)) throw error;
      if (updates.pending(id)) {
        const unfinished =
          error instanceof CellControlConflict &&
          (error.message === UPDATE_RECORDS_UNREADABLE ||
            error.message === UPDATE_NEEDS_FRESH_START)
            ? error.message
            : UPDATE_UNFINISHED;
        this.#set(id, { state: "failed", restarts: 0, stream: NO_STREAM, error: unfinished });
        throw new CellControlConflict(unfinished);
      }
      const old = this.#require(id);
      const back = await this.#startContainers(old, 0, undefined, false, {
        kind: "start",
        timed: false,
      }).catch(() => false);
      if (back) this.#detach(id, this.#waitReady(old));
      else if (this.#current(id, stopping))
        this.#set(id, { state: "stopped", restarts: 0, stream: NO_STREAM });
      throw new CellControlConflict(
        back
          ? error instanceof SystemMigrationConflict || error instanceof SystemBaseMissing
            ? error.message
            : refusal
          : UPDATE_STOPPED,
      );
    }
    if (!this.#current(id, stopping)) return;
    try {
      if (await this.#startContainers(next, 0)) this.#detach(id, this.#waitReady(next));
    } catch (error) {
      if (this.#current(id, stopping))
        this.#set(id, { state: "stopped", restarts: 0, stream: NO_STREAM });
      throw error;
    }
  }

  // An update the daemon stopped in the middle is finished, or rolled back, before anything else
  // uses the computer's containers.
  async #finishUpdate(record: CellRecord): Promise<CellRecord> {
    const updates = this.deps.updates;
    if (!updates?.pending(record.id)) return record;
    return updates.recover(record, (next) => this.#adopt(next));
  }

  // Clears what an unfinished update left beside a computer about to be reset.
  discardUpdate(id: string): Promise<void> {
    return this.#queued(id, async () => {
      const record = this.#record(id);
      if (record) await this.deps.updates?.discard(record);
    });
  }

  #adopt(next: CellRecord): void {
    this.#store.save(next);
    this.#records.set(next.id, next);
  }

  // Sends a computer's summary again, after something outside the lifecycle changed it.
  notify(id: string): void {
    this.#emit(id);
  }

  /** An idle-only fresh observation. Lifecycle commands preempt its transport before waiting
   * for the same queue. This deliberately avoids #withBrowser's destructive browser Stop. */
  diagnoseSelfTest(id: string, caller: AbortSignal): Promise<DiagnosticSelfTest> {
    const refused = () =>
      new CellControlConflict("Computer diagnostics are unavailable or the computer changed.");
    if (
      caller.aborted ||
      this.#disposed ||
      this.#queues.has(id) ||
      this.#held(id) ||
      !this.deps.verifyRuntime ||
      !this.#keyd
    )
      return Promise.reject(refused());
    const admission = this.deps.diagnosticAdmission?.(id);
    if (!admission) return Promise.reject(refused());
    const controller = new AbortController(),
      signal = AbortSignal.any([caller, controller.signal]);
    const work = this.#queued(id, async () => {
      const live = this.#live.get(id),
        record = structuredClone(this.#require(id));
      if (live?.state !== "ready" || live.paused || !live.ports || !record.ownership)
        throw refused();
      const ownership = { ...record.ownership };
      if (![ownership.gate, ownership.desktop].every((value) => /^[a-f0-9]{64}$/.test(value)))
        throw refused();
      const active = () => {
        signal.throwIfAborted();
        if (
          !this.#current(id, live) ||
          this.#held(id) ||
          this.#browserHolds.has(id) ||
          !equal(this.#store.get(id), record)
        )
          throw refused();
      };
      const inspect = async (role: "gate" | "desktop", running: boolean) => {
        const raw = await this.#docker.request<{
          Id?: string;
          Config?: { Labels?: Record<string, string> };
          State?: { Running?: boolean; Paused?: boolean };
          NetworkSettings?: {
            Ports?: Record<string, { HostIp?: string; HostPort?: string }[] | null>;
          };
        }>({ method: "GET", path: objectPath("containers", ownership[role], "json") });
        if (
          raw?.Id !== ownership[role] ||
          raw.Config?.Labels?.["localdot.cell"] !== id ||
          raw.Config?.Labels?.["localdot.role"] !== role ||
          raw.State?.Running !== running ||
          (running && raw.State.Paused !== false)
        )
          throw refused();
        return raw;
      };
      const fresh = async () => {
        active();
        await this.deps.verifyRuntime?.(record);
        active();
        await inspect("desktop", true);
        const gate = await inspect("gate", true);
        const port = (key: string) => {
          const bindings = gate.NetworkSettings?.Ports?.[key],
            binding = bindings?.[0];
          if (
            bindings?.length !== 1 ||
            binding?.HostIp !== "127.0.0.1" ||
            !/^[1-9][0-9]{3,4}$/.test(binding.HostPort ?? "")
          )
            throw refused();
          const value = Number(binding.HostPort);
          if (value < 1024 || value > 65535) throw refused();
          return value;
        };
        const ports = { desktopd: port(GATE_PORTS.desktopd), stream: port(GATE_PORTS.stream) };
        if (
          JSON.stringify(ports) !== JSON.stringify(live.ports) ||
          !(await this.#keyd?.isWired(record))
        )
          throw refused();
        active();
        return endpointsFor(record, ports).desktopd;
      };
      const endpoint = await fresh();
      const result = await (this.deps.diagnosticProbe ?? probeDiagnosticSelfTest)(endpoint, signal);
      await fresh();
      if (!result.ok) {
        // A failed fresh check closes admission immediately. Cleanup retains the queue and idle
        // lease even if the diagnostic caller cancels now; only captured full IDs are stopped.
        this.#set(id, {
          state: "failed",
          restarts: 0,
          stream: NO_STREAM,
          error:
            "A fresh computer self-test failed. Stop and restart the computer before using it.",
        });
        const stops = await Promise.allSettled([
          this.#stopBrowser(id),
          (async () => {
            if (!(await this.#closeInKeyd(id))) throw refused();
          })(),
          (async () => {
            let failed = false;
            for (const role of ["gate", "desktop"] as const) {
              try {
                try {
                  await this.#docker.request({
                    method: "POST",
                    path: objectPath("containers", ownership[role], "stop"),
                    query: { t: "0" },
                  });
                } catch (error) {
                  if (!isStatus(error, 304, 404)) throw error;
                }
                try {
                  await inspect(role, false);
                } catch (error) {
                  if (!isStatus(error, 404)) throw error;
                }
              } catch {
                failed = true;
              }
            }
            if (failed) throw refused();
          })(),
        ]);
        if (stops.some((outcome) => outcome.status === "rejected")) throw refused();
      }
      signal.throwIfAborted();
      return result;
    });
    // Register synchronously before the queued callback can begin. A Stop queued immediately
    // after this method returns must cancel even a diagnostic that has not started probing yet.
    this.#diagnostics.set(id, controller);
    return work
      .catch(() => {
        throw refused();
      })
      .finally(async () => {
        if (this.#diagnostics.get(id) === controller) this.#diagnostics.delete(id);
        // A preempting Stop already owns the next queue position. Keep new task admission closed
        // until that queued operation settles rather than exposing a gap between the two owners.
        try {
          await this.#queues.get(id);
        } finally {
          admission.release();
        }
      });
  }

  // Keep the entire kill switch or Resume in the lifecycle queue, including
  // credential work. A concurrent Start cannot boot between revoke and freeze.
  withLifecycle<T>(id: string, op: (controls: CellControls) => Promise<T>): Promise<T> {
    const waitedForOperation = this.#queues.has(id);
    return this.#withBrowser(id, () =>
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
    return this.#withBrowser(id, () => this.#pause(id));
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
    return this.#withBrowser(id, () => this.#unpause(id));
  }

  async #unpause(id: string): Promise<void> {
    if (this.#held(id))
      throw new CellControlConflict(
        "the computer is permanently fenced or awaiting replacement confirmation",
      );
    const record = this.#require(id);
    const live = this.#live.get(id);
    if (!live?.paused || live.state !== "ready") {
      throw new CellControlConflict("the computer must be ready and paused before resuming");
    }
    await this.deps.verifyRuntime?.(record);
    if (this.#held(id) || !this.#current(id, live))
      throw new CellControlConflict("the computer changed before resuming");
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
    if (this.#held(id)) return false;
    const live = this.#live.get(id);
    if (live?.paused) return false;
    const record = this.#record(id);
    if (!record || !this.#keyd || (live?.state !== "ready" && live?.state !== "starting"))
      return false;
    const wired = await this.#keyd.isWired(record).catch(() => true);
    if (wired || !this.#current(id, live)) return false;
    const note = "the key layer restarted; reconnecting the computer";
    const restart = { kind: "restart" } as const;
    if (
      await this.#startContainers(record, live.restarts, note, false, restart).catch(() => false)
    ) {
      this.#detach(id, this.#waitReady(record));
    }
    return true;
  }

  stop(id: string): Promise<void> {
    return this.#withBrowser(id, () => this.#stop(id));
  }

  async #stop(id: string): Promise<void> {
    const record = this.#require(id);
    const stopping: Live = { state: "stopping", restarts: 0, stream: NO_STREAM };
    this.#ops.begin(id, "stop", "shutdown");
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
    this.#ops.finish(id);
    this.#set(id, { state: "stopped", restarts: 0, stream: NO_STREAM });
  }

  remove(
    id: string,
    opts: { purgeHome?: boolean; purgeBrowserProfile?: boolean } = {},
  ): Promise<void> {
    return this.#withBrowser(id, () => this.#remove(id, opts), {
      purgeProfile: opts.purgeBrowserProfile === true,
    });
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
      await this.deps.updates?.discard(record);
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
    operation?: OperationStart,
    recycle = false,
  ): Promise<boolean> {
    if (this.#fenced(record.id))
      throw new CellControlConflict("the computer is permanently fenced");
    // Refuse mismatched ownership/images before key wiring, starting, or failure cleanup by name.
    try {
      await this.deps.verifyRuntime?.(record);
    } catch (error) {
      this.#set(record.id, {
        state: "failed",
        restarts,
        stream: NO_STREAM,
        error: "Computer runtime does not match the installed release.",
      });
      throw error;
    }
    if (this.#fenced(record.id))
      throw new CellControlConflict("computer admission changed during runtime verification");
    const d = record.docker;
    const starting: Live = {
      state: "starting",
      restarts,
      stream: NO_STREAM,
      ...(error ? { error } : {}),
      ...(frozen ? { paused: true as const } : {}),
    };
    if (operation) this.#ops.begin(record.id, operation.kind, "network", operation);
    this.#ops.step(record.id, "network");
    this.#set(record.id, starting);
    try {
      await this.#stopBrowser(record.id);
      const desktop = (await this.#inspect(d.desktop)).State;
      if (frozen && (!desktop.Running || !desktop.Paused)) {
        throw new Error("the frozen desktop changed; start the computer again");
      }
      if (!frozen) {
        let running = desktop.Running;
        if (
          running &&
          (recycle || desktop.Paused || (this.#keyd && !(await this.#keyd.isWired(record))))
        ) {
          await this.#stopContainer(d.desktop);
          running = false;
        }
        if (!this.#current(record.id, starting)) return false;
        if (recycle) await this.#stopContainer(d.gate);
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
        this.#step(record.id, "desktop");
        await this.#docker.request({
          method: "POST",
          path: objectPath("containers", d.desktop, "start"),
        });
        if (record.tokens.capture && (await this.#gateCaptures())) await this.#link(record);
      }
      // Every start publishes new host ports (Review Focus 2).
      const ports = await this.#readPorts(d.gate);
      if (!this.#current(record.id, starting)) return false;
      if (!frozen) this.#ops.step(record.id, "ready");
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
          await this.deps.verifyRuntime?.(record);
          // A held replacement candidate still reaches Ready here: its owner waits for it, and
          // input, Start and stream tickets keep refusing it until the owner publishes it.
          if (!this.#current(record.id, live) || this.#fenced(record.id)) return;
          this.#ops.finish(record.id);
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

  // Watch both the containers and the services inside them. A guest shutdown can leave PID 1
  // alive. Require three consecutive failed probes before recycling, and retain the bounded
  // restart budget so a broken desktop cannot flap forever.
  async #watch(record: CellRecord): Promise<void> {
    const live = this.#live.get(record.id);
    if (live?.state !== "ready" || this.#held(record.id) || !this.#current(record.id, live)) return;
    if (this.#watchOwners.get(record.id) === live) return;
    this.#watchOwners.set(record.id, live);
    try {
      await this.#watchLoop(record, live);
    } finally {
      if (this.#watchOwners.get(record.id) === live) this.#watchOwners.delete(record.id);
    }
  }

  async #watchLoop(record: CellRecord, live: Live): Promise<void> {
    let unhealthy = 0;
    for (;;) {
      await this.#sleep(this.#watchEveryMs);
      if (this.#held(record.id) || !this.#current(record.id, live)) return;
      await this.deps.verifyRuntime?.(record);
      if (this.#held(record.id) || !this.#current(record.id, live)) return;
      let exited = await this.#exitedContainer(record);
      if (!this.#current(record.id, live)) return;
      let recycle = false;
      if (exited === undefined) {
        if (live.paused || !live.ports) continue;
        const endpoints = endpointsFor(record, live.ports);
        const health = await this.#probeDesktopd(endpoints.desktopd, undefined, {
          selftest: false,
        });
        if (this.#held(record.id) || !this.#current(record.id, live) || live.paused) return;
        const breach = health?.selftest?.checks.find((c) => c.kind === "isolation" && !c.ok);
        if (breach) {
          await this.#queued(record.id, () => this.#isolationFailure(record, live, breach));
          return;
        }
        const desktopReady = health?.ok;
        const streaming = desktopReady && (await this.#probeStream(endpoints.stream));
        if (this.#held(record.id) || !this.#current(record.id, live) || live.paused) return;
        if (streaming) {
          unhealthy = 0;
          continue;
        }
        if (++unhealthy < 3) continue;
        recycle = true;
        exited = {
          role: "desktop",
          gone: false,
          detail: `${desktopReady ? "desktop stream" : "desktop services"} stopped responding for 3 consecutive checks`,
        };
      }
      // Claim the transition in the same queue as Stop/Resume. A watch that
      // inspected before a freeze must not restart a now-frozen desktop.
      const restarting = await this.#queued(record.id, async () => {
        if (this.#held(record.id) || !this.#current(record.id, live)) return undefined;
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
        this.#ops.begin(record.id, "restart", "network", {
          extraMs: this.#restartBackoffMs[attempt - 1] ?? 0,
        });
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
          ? this.#startContainers(record, attempt, note, frozen, undefined, recycle)
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
    this.#diagnostics.get(id)?.abort();
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

  #stopBrowser(id: string): Promise<void> {
    if (!this.deps.browser) return Promise.resolve();
    const pending = this.#browserStops.get(id);
    if (pending) return pending;
    let stop: Promise<void>;
    try {
      // Browser Stop fences synchronously, before any parent lifecycle queue can wait.
      stop = this.deps.browser.stop(id);
    } catch {
      stop = Promise.reject(new CellControlConflict("browser shutdown could not be confirmed"));
    }
    this.#browserStops.set(id, stop);
    const finish = () => {
      if (this.#browserStops.get(id) === stop) this.#browserStops.delete(id);
    };
    void stop.then(
      () => {
        this.#browserFailures.delete(id);
        finish();
      },
      () => {
        this.#browserFailures.add(id);
        finish();
      },
    );
    return stop;
  }

  #withBrowser<T>(
    id: string,
    op: () => Promise<T>,
    remove?: { purgeProfile: boolean },
  ): Promise<T> {
    if (!this.deps.browser) return this.#queued(id, op);
    this.#browserHolds.set(id, (this.#browserHolds.get(id) ?? 0) + 1);
    const stopped = this.#stopBrowser(id);
    const child = remove ? stopped.then(() => this.deps.browser?.remove(id, remove)) : stopped;
    void child.catch(() => {});
    const operation = this.#queued(id, async () => {
      // A failed child must not prevent physical containment of the desktop, or vice versa.
      const [parentResult, browserResult] = await Promise.allSettled([
        Promise.resolve().then(op),
        child,
      ]);
      if (browserResult.status === "rejected") throw new BrowserShutdownConflict();
      if (parentResult.status === "rejected") throw parentResult.reason;
      return parentResult.value;
    });
    return operation.finally(() => {
      const count = (this.#browserHolds.get(id) ?? 1) - 1;
      if (count > 0) this.#browserHolds.set(id, count);
      else this.#browserHolds.delete(id);
    });
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
    let failed = false;
    for (const id of skipped) {
      await this.#withBrowser(id, async () => {
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
      }).catch(() => {
        failed = true;
      });
    }
    if (failed)
      throw new CellControlConflict("browser shutdown could not be confirmed; retry Stop");
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

  // A gate image that isn't there can't capture; creating a gate from it fails by itself.
  async #gateCaptures(): Promise<boolean> {
    const image = await this.#docker
      .request<ImageInspect>({
        method: "GET",
        path: objectPath("images", this.#images.gate, "json"),
      })
      .catch((err) => {
        if (isStatus(err, 404)) return undefined;
        throw err;
      });
    return gateCaptures(image);
  }

  // A fresh desktop's network namespace has no link to its gate yet: a one-shot helper adds it.
  async #link(record: CellRecord): Promise<void> {
    const name = linkName(record.id, this.#namePrefix);
    const create = () =>
      this.#docker.request<{ Id: string }>({
        method: "POST",
        path: "/containers/create",
        query: { name },
        body: this.#labeled(linkSpec(record, this.#images.gate)),
      });
    const made = await create().catch(async (err) => {
      if (!isStatus(err, 409)) throw err;
      // A helper an interrupted start left behind goes only if it is this cell's own.
      const stale = await this.#docker.request<{
        Id: string;
        Config: { Labels?: Record<string, string> };
      }>({
        method: "GET",
        path: objectPath("containers", name, "json"),
      });
      const labels = stale.Config.Labels ?? {};
      if (labels["localdot.cell"] !== record.id || labels["localdot.role"] !== "link") throw err;
      await this.#removeContainer(stale.Id);
      return create();
    });
    try {
      await this.#docker.request({
        method: "POST",
        path: objectPath("containers", made.Id, "start"),
      });
      const { StatusCode } = await this.#docker.request<{ StatusCode: number }>({
        method: "POST",
        path: objectPath("containers", made.Id, "wait"),
      });
      if (StatusCode !== 0) throw new Error("the computer's network link could not be set up");
    } finally {
      await this.#removeContainer(made.Id).catch(() => {});
    }
  }

  #labeled<T extends { Labels?: Record<string, string> }>(spec: T): T {
    return this.deps.labels ? { ...spec, Labels: { ...spec.Labels, ...this.deps.labels } } : spec;
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
    if (live.state !== "stopping" && live.state !== "starting") this.#updating.delete(id);
    // Every way into starting or stopping has a start time, even one that began no operation.
    if (live.state === "starting" || live.state === "stopping") {
      if (!this.#ops.running(id))
        this.#ops.begin(
          id,
          live.state === "starting" ? "start" : "stop",
          live.state === "starting" ? "network" : "shutdown",
          { timed: false },
        );
    } else if (live.state === "ready" && !live.paused) this.#ops.settle(id);
    else this.#ops.end(id);
    this.#live.set(id, live);
    if (!this.#browserHolds.has(id) && (live.state !== "ready" || live.paused))
      void this.#stopBrowser(id).catch(() => {});
    this.#emit(id);
  }

  #step(id: string, step: ComputerOperationStep): void {
    if (this.#ops.step(id, step)) this.#emit(id);
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

  async containFenced(): Promise<void> {
    for (const record of this.#store.inventory().records) {
      if (this.deps.permanentFence?.(record.id))
        await this.#withBrowser(record.id, () => this.#containFenced(record));
    }
  }
  async #containFenced(record: CellRecord): Promise<void> {
    this.#set(record.id, { state: "stopping", restarts: 0, stream: NO_STREAM });
    let confirmed = !!this.#keyd && (await this.#closeInKeyd(record.id));
    try {
      // Inspect every label and captured identity before touching any executable object.
      const objects = await inspectOwnedCell(
        this.#docker,
        record.id,
        record.docker,
        record.ownership,
      );
      if (confirmed && objects.every((object) => object.kind === "volumes"))
        this.#retiredPortOwners.add(record.id);
      for (const object of objects.filter((o) => o.kind === "containers" && o.running)) {
        try {
          await this.#docker.request({
            method: "POST",
            path: objectPath("containers", object.id, "stop"),
            query: { t: "2" },
          });
          const after = await this.#docker.request<ContainerInspect>({
            method: "GET",
            path: objectPath("containers", object.id, "json"),
          });
          if (after.State.Running) confirmed = false;
        } catch (error) {
          if (!isStatus(error, 404)) confirmed = false;
        }
      }
    } catch {
      confirmed = false;
    }
    this.#set(record.id, {
      state: "failed",
      restarts: 0,
      stream: NO_STREAM,
      error: confirmed
        ? "This computer is fenced; use explicit replacement after retirement."
        : "This fenced computer needs cleanup attention before replacement.",
    });
  }
  #fenced(id: string): boolean {
    return !!this.deps.permanentFence?.(id) || !!this.deps.runtimeHold?.(id);
  }
  #held(id: string): boolean {
    return this.#fenced(id) || this.#candidateHeld(id);
  }
  #candidateHeld(id: string): boolean {
    return this.#candidateHolds.has(id) || !!this.deps.candidateHold?.(id);
  }
  holdReplacement(id: string): void {
    this.#candidateHolds.add(id);
    void this.#stopBrowser(id).catch(() => {});
    this.#emit(id);
  }
  publishReplacement(id: string): void {
    this.#candidateHolds.delete(id);
    const record = this.#record(id);
    if (record) this.#detach(id, this.#watch(record));
    this.#emit(id);
  }
  async inspectReplacement(id: string): Promise<"ready" | "owned" | "absent" | "foreign"> {
    const record = this.#record(id);
    try {
      if (record) await this.deps.verifyRuntime?.(record);
      const objects = await inspectOwnedCell(
        this.#docker,
        id,
        record?.docker ?? cellNames(id, this.#namePrefix),
        record?.ownership,
      );
      if (!objects.length) return "absent";
      if (
        record &&
        objects.length === 5 &&
        objects.filter((o) => o.kind === "containers").every((o) => o.running && !o.paused)
      ) {
        const ports = await this.#readPorts(record.docker.gate),
          endpoints = endpointsFor(record, ports);
        const health = await this.#probeDesktopd(endpoints.desktopd);
        if (
          health?.ok &&
          this.#keyd &&
          health.selftest &&
          selfTestPassed(health.selftest) &&
          (await this.#keyd.isWired(record)) &&
          (await this.#probeStream(endpoints.stream))
        ) {
          // Public input remains held until the durable owner republishes Ready.
          this.#set(id, { state: "ready", restarts: 0, ports, stream: NO_STREAM });
          return "ready";
        }
      }
      return "owned";
    } catch {
      return "foreign";
    }
  }
  /** Thaws a held reset candidate only when every object is exactly owned and only the desktop is
   * frozen, with Resume's key order: revoke while frozen, refresh, then thaw. It never publishes;
   * the caller must still confirm Ready. */
  thawReplacement(id: string): Promise<void> {
    return this.#withBrowser(id, async () => {
      const refused = () =>
        new CellControlConflict("the reset computer cannot be resumed for confirmation");
      const record = this.#record(id),
        keyd = this.#keyd;
      if (
        !record?.ownership ||
        !keyd ||
        this.#disposed ||
        this.#fenced(id) ||
        !this.#candidateHeld(id)
      )
        throw refused();
      const objects = await inspectOwnedCell(this.#docker, id, record.docker, record.ownership);
      const container = (role: string) =>
        objects.find((o) => o.kind === "containers" && o.role === role);
      const desktop = container("desktop"),
        gate = container("gate");
      if (
        objects.length !== 5 ||
        !gate?.running ||
        gate.paused !== false ||
        !desktop?.running ||
        desktop.paused !== true
      )
        throw refused();
      await this.deps.verifyRuntime?.(record);
      await keyd.revoke(id);
      if (!(await keyd.isWired(record))) throw refused();
      await keyd.refresh(record);
      if (this.#disposed || this.#fenced(id) || !this.#candidateHeld(id)) throw refused();
      await this.#docker.request({
        method: "POST",
        path: objectPath("containers", record.ownership.desktop, "unpause"),
      });
    });
  }
  retireReset(input: ComputerResetRecord, retire: () => Promise<void>): Promise<void> {
    const reset = ComputerResetRecord.parse(input),
      id = reset.oldCellId;
    return this.#queued(id, async () => {
      if (!this.deps.permanentFence?.(id) || this.#disposed)
        throw new CellControlConflict("reset admission is not held");
      if (this.#store.inventoryAll().skipped.includes(id))
        throw new CellControlConflict("reset record is unreadable");
      const record = this.#record(id);
      if (
        record &&
        JSON.stringify(captureComputerResetSource(record).desktop) !==
          JSON.stringify(reset.source.desktop)
      )
        throw new CellControlConflict("reset desktop ownership changed");
      if (!record && this.#store.getStored(id))
        throw new CellControlConflict("reset identity changed");
      this.#set(id, { state: "stopping", restarts: 0, stream: NO_STREAM });
      if (!this.#keyd || !(await this.#closeInKeyd(id)))
        throw new CellControlConflict("reset key closure is unconfirmed");
      // The controller owns the browser queue, exact physical cleanup and post-close key proof.
      // Do not use #withBrowser here: that would race a second browser resource deleter.
      await retire();
      this.#retiredPortOwners.add(id);
      this.#set(id, { state: "removed", restarts: 0, stream: NO_STREAM });
      this.#store.remove(id);
      this.#records.delete(id);
      this.#live.delete(id);
    });
  }
  retireReplacement(id: string, purgeHome = false): Promise<{ absent: boolean; revoked: boolean }> {
    return this.#withBrowser(id, async () => {
      const record = this.#record(id),
        names = record?.docker ?? cellNames(id, this.#namePrefix);
      this.#set(id, { state: "stopping", restarts: 0, stream: NO_STREAM });
      const revoked = !!this.#keyd && (await this.#closeInKeyd(id));
      if (!revoked) return { absent: false, revoked: false };
      if (record) await this.deps.updates?.discard(record);
      if (purgeHome)
        await new ComputerSystemState(
          this.#store.home,
          this.#docker,
          this.#images.desktop,
        ).cleanupCopy(id);
      if (!purgeHome) {
        if (!record)
          throw new Error("The system data source is unavailable; refusing a clean recovery.");
        // Verify exact ownership before stopping or snapshotting any resource.
        await inspectOwnedCell(this.#docker, id, names, record.ownership);
        const state = new ComputerSystemState(this.#store.home, this.#docker, this.#images.desktop);
        if (!state.records.read(id)) {
          await this.#stopContainer(record.ownership?.desktop ?? names.desktop);
        }
        await state.capture(record);
      }
      await retireExactCell(this.#docker, id, names, record?.ownership, purgeHome);
      this.#retiredPortOwners.add(id);
      this.#set(id, { state: "removed", restarts: 0, stream: NO_STREAM });
      if (purgeHome && record) {
        this.#store.remove(id);
        this.#records.delete(id);
        this.#live.delete(id);
      }
      return { absent: true, revoked };
    });
  }
  #summary(record: CellRecord): CellSummary {
    const live = this.#live.get(record.id) ?? {
      state: "stopped" as const,
      restarts: 0,
      stream: NO_STREAM,
    };
    const operation = this.deps.runtimeHold?.(record.id)
      ? undefined
      : this.#ops.summary(record.id, live);
    return {
      id: record.id,
      ...(this.deps.permanentFence?.(record.id)
        ? {
            fenced:
              typeof this.deps.permanentFence(record.id) === "object"
                ? (this.deps.permanentFence(record.id) as { revision: number })
                : { revision: 1 },
          }
        : {}),
      ...(this.#candidateHeld(record.id) ? { replacementPending: true as const } : {}),
      state: live.state,
      scale: record.scale,
      createdAt: record.createdAt,
      stream: live.stream,
      ...(live.error ? { error: live.error } : {}),
      ...(live.paused ? { paused: true as const } : {}),
      ...(operation ? { operation } : {}),
      ...(this.#updating.has(record.id) ? { updating: true as const } : {}),
      ...(this.deps.updates?.needsFreshStart(record.id) ? { needsFreshStart: true as const } : {}),
      ...(!this.#updating.has(record.id) &&
      !this.#held(record.id) &&
      this.deps.updates?.available(record.id)
        ? { updateAvailable: true as const }
        : {}),
      ...(this.deps.runtimeHold?.(record.id)
        ? {
            state: "failed" as const,
            stream: NO_STREAM,
            error: "Computer runtime update recovery is incomplete.",
          }
        : {}),
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
