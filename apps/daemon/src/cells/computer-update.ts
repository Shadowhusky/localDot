import { isDeepStrictEqual as equal } from "node:util";
import { ULID_PATTERN, ulid } from "@localdot/protocol";
import { z } from "zod";
import { PrivateRecords } from "../agent/safety/private-records.ts";
import type { LiveSessions } from "../gateway/live.ts";
import { type DockerClient, DockerError } from "./docker.ts";
import { retireExactContainers } from "./exact-retirement.ts";
import type { Images } from "./images.ts";
import {
  CellControlConflict,
  type CellOrchestrator,
  UnknownCellError,
  UPDATE_NEEDS_FRESH_START,
  UPDATE_RECORDS_UNREADABLE,
  UPDATE_UNFINISHED,
} from "./orchestrator.ts";
import { type GateRelay, HOST_RELAY } from "./relay.ts";
import { desktopSpec, gateSpec, type StreamOptions } from "./spec.ts";
import type { CellRecord } from "./types.ts";

type Docker = Pick<DockerClient, "request">;
type Role = "gate" | "desktop";
type Save = (next: CellRecord) => void;
const ROLES = ["gate", "desktop"] as const;
export const UPDATE_LABEL = "localdot.update";

const ContainerId = z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/);
const ImageId = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const Id = z.string().regex(ULID_PATTERN);
const PHASES = ["creating", "retiring", "renaming"] as const;

// New containers are made beside the stopped old ones ("creating"), the old ones are removed
// ("retiring"), the new ones take the old names and the cell record ("renaming"), and the record
// goes. Until the old ones go, an interrupted update rolls back; after that it only goes forward.
// The home volume, networks, addresses, tokens and keyd port are never touched.
export const ComputerUpdateRecord = z.strictObject({
  v: z.literal(1),
  operationId: Id,
  cellId: Id,
  previous: z.strictObject({ gate: ContainerId, desktop: ContainerId }),
  images: z.strictObject({ gate: ImageId, desktop: ImageId }),
  candidates: z.strictObject({ gate: ContainerId.nullable(), desktop: ContainerId.nullable() }),
  phase: z.enum(PHASES),
});
export type ComputerUpdateRecord = z.infer<typeof ComputerUpdateRecord>;

const full = (entry: ComputerUpdateRecord) =>
  entry.candidates.gate !== null && entry.candidates.desktop !== null;

export class ComputerUpdateStore {
  readonly #records: PrivateRecords<ComputerUpdateRecord>;
  constructor(home: string) {
    this.#records = new PrivateRecords(home, "computer-image-updates", (raw, id) => {
      const record = ComputerUpdateRecord.parse(raw);
      if (record.cellId !== id) throw new Error("Computer update owner mismatch");
      return record;
    });
  }
  read(cellId: string): ComputerUpdateRecord | undefined {
    return this.#records.read(cellId);
  }
  list(): ComputerUpdateRecord[] {
    return this.#records.list();
  }
  write(input: ComputerUpdateRecord): void {
    const next = ComputerUpdateRecord.parse(input),
      before = this.read(next.cellId);
    if (!before) {
      if (
        next.phase !== "creating" ||
        next.candidates.gate !== null ||
        next.candidates.desktop !== null
      )
        throw new Error("A computer update starts with no new containers");
    } else {
      if (before.operationId !== next.operationId)
        throw new Error("An earlier computer update is unfinished");
      const from = PHASES.indexOf(before.phase),
        to = PHASES.indexOf(next.phase);
      if (
        !equal(before.previous, next.previous) ||
        !equal(before.images, next.images) ||
        (to !== from && to !== from + 1) ||
        (next.phase !== "creating" && !full(next)) ||
        ROLES.some(
          (role) =>
            before.candidates[role] !== null && before.candidates[role] !== next.candidates[role],
        )
      )
        throw new Error("Computer update identity or phase changed");
    }
    this.#records.write(next.cellId, next);
  }
  remove(cellId: string): void {
    this.#records.remove(cellId);
  }
}

const failure = () => new CellControlConflict(UPDATE_UNFINISHED);
// A refusal that trying again can't clear: what the update needs to go on was changed or taken.
class Lasting extends CellControlConflict {
  constructor() {
    super(UPDATE_UNFINISHED);
  }
}
const NOT_HERE = "The new version isn't on this Mac yet.";

export interface ComputerUpdatesDeps {
  home: string;
  docker: Docker;
  images: Images;
  stream: StreamOptions;
  // How gates reach keyd and the daemon (cells/relay.ts); Docker Desktop's host name by default.
  relay?: () => Promise<GateRelay>;
  everyMs?: number;
}

// Whether a computer runs older images than its configured tags name now, and the swap that
// moves it onto them. Image IDs are compared, never tags: a rebuilt image keeps its tag.
export class ComputerUpdates {
  readonly #docker: Docker;
  readonly #images: Images;
  readonly #relay: () => Promise<GateRelay>;
  readonly #stream: StreamOptions;
  readonly #everyMs: number;
  readonly #available = new Map<string, boolean>();
  readonly #unfinished = new Set<string>();
  readonly #stuck = new Set<string>();
  readonly #ledger: ComputerUpdateStore | undefined;

  constructor(deps: ComputerUpdatesDeps) {
    this.#docker = deps.docker;
    this.#images = deps.images;
    this.#relay = deps.relay ?? (() => Promise.resolve(HOST_RELAY));
    this.#stream = deps.stream;
    this.#everyMs = deps.everyMs ?? 60_000;
    try {
      const ledger = new ComputerUpdateStore(deps.home);
      for (const entry of ledger.list()) this.#unfinished.add(entry.cellId);
      this.#ledger = ledger;
    } catch {
      console.error("computer update records are unreadable");
    }
  }

  // A new version is ready, or an earlier update is waiting to be finished.
  available(id: string): boolean {
    if (this.#stuck.has(id)) return false;
    return this.#available.get(id) === true || this.#unfinished.has(id);
  }

  // Its update can't be finished or rolled back, so only a fresh start brings it back.
  needsFreshStart(id: string): boolean {
    return this.#stuck.has(id);
  }

  // Without its records an interrupted update can't be told apart, so every computer waits.
  pending(id: string): boolean {
    return !this.#ledger || this.#unfinished.has(id);
  }

  // Resolves whether the answer changed. A Docker that does not answer changes nothing.
  async check(record: CellRecord): Promise<boolean> {
    let outdated: boolean;
    try {
      outdated = await this.#outdated(record);
    } catch {
      return false;
    }
    const before = this.#available.get(record.id) === true;
    this.#available.set(record.id, outdated);
    return before !== outdated;
  }

  // Checks every computer now and then at an interval, telling `changed` which ones changed.
  watch(records: () => CellRecord[], changed: (id: string) => void): () => void {
    let running = false;
    const run = async () => {
      if (running) return;
      running = true;
      try {
        for (const record of records()) if (await this.check(record)) changed(record.id);
      } catch {
        console.error("computer update check failed");
      } finally {
        running = false;
      }
    };
    void run();
    const timer = setInterval(() => void run(), this.#everyMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  // Refuses an update that can't go ahead, before anything is stopped. An unfinished one is
  // finished first, so it is never refused here.
  async prepare(record: CellRecord): Promise<void> {
    this.#store();
    if (this.pending(record.id)) return;
    ownedContainers(record);
    if (!(await this.#targets())) throw new CellControlConflict(NOT_HERE);
  }

  // The computer must be stopped. Resolves the record that now owns the new containers.
  async swap(record: CellRecord, save: Save): Promise<CellRecord> {
    if (this.#store().read(record.id)) throw failure();
    const previous = ownedContainers(record);
    const images = await this.#targets();
    if (!images) throw new CellControlConflict(NOT_HERE);
    const old = await Promise.all(ROLES.map((role) => this.#container(previous[role])));
    if (old.some((raw) => raw?.State?.Running !== false))
      throw new CellControlConflict("Your computer has to be off to update.");
    if (ROLES.every((role, i) => old[i]?.Image === images[role])) {
      this.#available.set(record.id, false);
      return record;
    }
    let entry: ComputerUpdateRecord = {
      v: 1,
      operationId: ulid(),
      cellId: record.id,
      previous,
      images,
      candidates: { gate: null, desktop: null },
      phase: "creating",
    };
    this.#write(entry);
    try {
      for (const role of ROLES) {
        const spec =
          role === "gate"
            ? gateSpec(record, this.#images.gate, await this.#relay())
            : desktopSpec(record, this.#images.desktop, this.#stream);
        await this.#docker
          .request({
            method: "POST",
            path: "/containers/create",
            query: { name: temporary(record, role) },
            body: { ...spec, Labels: { ...spec.Labels, [UPDATE_LABEL]: entry.operationId } },
          })
          .catch(() => {
            // A lost reply may still have created it: the name and this update's label tell.
          });
        const made = await this.#owned(record, role, entry.operationId);
        if (!made || made.Image !== images[role] || made.State?.Running !== false) throw failure();
        entry = { ...entry, candidates: { ...entry.candidates, [role]: made.Id } };
        this.#write(entry);
      }
    } catch (error) {
      await this.#rollBack(entry, record).catch(() =>
        console.error(`cell ${record.id}: an unfinished update could not roll back yet`),
      );
      throw error;
    }
    return this.#finish(entry, record, save);
  }

  // Finishes or rolls back an interrupted update. The computer must be stopped.
  async recover(record: CellRecord, save: Save): Promise<CellRecord> {
    this.#store();
    try {
      return await this.#recover(record, save);
    } catch (error) {
      if (!(error instanceof Lasting)) throw failure();
      this.#stuck.add(record.id);
      throw new CellControlConflict(UPDATE_NEEDS_FRESH_START);
    }
  }

  async #recover(record: CellRecord, save: Save): Promise<CellRecord> {
    const entry = this.#store().read(record.id);
    if (!entry) {
      this.#unfinished.delete(record.id);
      return record;
    }
    // Nothing of the new version is left (pruned, or removed by hand): the update is over.
    if (await this.#candidatesGone(entry, record)) {
      this.#settle(record.id);
      return record;
    }
    const owner = record.ownership;
    const candidates = entry.candidates;
    if (
      !owner ||
      !(
        (owner.gate === entry.previous.gate && owner.desktop === entry.previous.desktop) ||
        (owner.gate === candidates.gate && owner.desktop === candidates.desktop)
      )
    )
      throw new Lasting();
    if (entry.phase === "creating") {
      await this.#rollBack(entry, record);
      return record;
    }
    return this.#finish(entry, record, save);
  }

  // Removes what an unfinished update made beside a computer that is being removed or reset, and
  // forgets the update. The computer's own containers, under its own names, are the caller's.
  async discard(record: CellRecord): Promise<void> {
    let entry: ComputerUpdateRecord | undefined;
    try {
      entry = this.#ledger?.read(record.id);
    } catch {
      // An unreadable record still leaves this update's labels on what it made.
    }
    for (const role of ROLES) {
      const ids = new Set<string>();
      const known = entry?.candidates[role];
      if (known && (await this.#container(known))) ids.add(known);
      const named = await this.#owned(record, role, entry?.operationId);
      if (named) ids.add(named.Id);
      if (ids.size)
        await retireExactContainers(
          this.#docker,
          record.id,
          [...ids].map((id) => ({ role, id })),
        );
    }
    this.#available.delete(record.id);
    this.#stuck.delete(record.id);
    if (entry) this.#settle(record.id);
  }

  async #finish(start: ComputerUpdateRecord, record: CellRecord, save: Save) {
    let entry = start;
    const step = (phase: ComputerUpdateRecord["phase"]) => {
      entry = { ...entry, phase };
      this.#write(entry);
    };
    const { gate, desktop } = entry.candidates;
    if (!gate || !desktop || !record.ownership) throw new Lasting();
    if (entry.phase === "creating") step("retiring");
    if (entry.phase === "retiring") {
      await retireExactContainers(
        this.#docker,
        record.id,
        ROLES.map((role) => ({ role, id: entry.previous[role] })),
      );
      step("renaming");
    }
    for (const role of ROLES) {
      const id = entry.candidates[role] as string;
      const raw = await this.#container(id);
      if (!raw || !ours(raw, record.id, role, entry.operationId)) throw new Lasting();
      if (raw.Name === `/${record.docker[role]}`) continue;
      if (raw.Name !== `/${temporary(record, role)}`) throw new Lasting();
      await this.#docker
        .request({
          method: "POST",
          path: `/containers/${encodeURIComponent(id)}/rename`,
          query: { name: record.docker[role] },
        })
        .catch((error: unknown) => {
          // Docker answered and refused; one that didn't answer may yet.
          throw error instanceof DockerError && error.status !== 0 ? new Lasting() : error;
        });
    }
    const next: CellRecord = { ...record, ownership: { ...record.ownership, gate, desktop } };
    if (!equal(record.ownership, next.ownership)) save(next);
    this.#settle(record.id);
    this.#available.set(record.id, false);
    return next;
  }

  async #rollBack(entry: ComputerUpdateRecord, record: CellRecord): Promise<void> {
    for (const role of ROLES) {
      const id = entry.candidates[role] ?? (await this.#owned(record, role, entry.operationId))?.Id;
      if (id) await retireExactContainers(this.#docker, record.id, [{ role, id }]);
    }
    this.#settle(record.id);
  }

  async #candidatesGone(entry: ComputerUpdateRecord, record: CellRecord): Promise<boolean> {
    for (const role of ROLES) {
      const id = entry.candidates[role];
      if (id && (await this.#container(id))) return false;
      if (await this.#owned(record, role, entry.operationId)) return false;
    }
    return true;
  }

  #write(entry: ComputerUpdateRecord): void {
    this.#store().write(entry);
    this.#unfinished.add(entry.cellId);
  }

  #settle(cellId: string): void {
    this.#store().remove(cellId);
    this.#unfinished.delete(cellId);
    this.#stuck.delete(cellId);
  }

  // The container an update made under the temporary name: this update's when `operationId` is
  // given, any update's otherwise. Anything else there is never adopted or removed.
  async #owned(record: CellRecord, role: Role, operationId?: string) {
    const raw = await this.#container(temporary(record, role));
    if (!raw || typeof raw.Id !== "string" || !ours(raw, record.id, role, operationId))
      return undefined;
    return raw as ContainerInspect & { Id: string };
  }

  async #outdated(record: CellRecord): Promise<boolean> {
    if (!record.ownership || this.pending(record.id)) return false;
    const images = await this.#targets();
    if (!images) return false;
    for (const role of ROLES) {
      const raw = await this.#container(record.ownership[role]);
      if (!raw || !ImageId.safeParse(raw.Image).success) return false;
      if (raw.Image !== images[role]) return true;
    }
    return false;
  }

  async #targets(): Promise<{ gate: string; desktop: string } | undefined> {
    const ids: Partial<Record<Role, string>> = {};
    for (const role of ROLES) {
      const raw = await this.#read<{ Id?: unknown }>(
        `/images/${encodeURIComponent(this.#images[role])}/json`,
      );
      const id = ImageId.safeParse(raw?.Id);
      if (!id.success) return undefined;
      ids[role] = id.data;
    }
    return ids as { gate: string; desktop: string };
  }

  #container(ref: string): Promise<ContainerInspect | undefined> {
    return this.#read<ContainerInspect>(`/containers/${encodeURIComponent(ref)}/json`);
  }

  async #read<T>(path: string): Promise<T | undefined> {
    try {
      return await this.#docker.request<T>({ method: "GET", path });
    } catch (error) {
      if (error instanceof DockerError && error.status === 404) return undefined;
      throw error;
    }
  }

  #store(): ComputerUpdateStore {
    if (!this.#ledger) throw new CellControlConflict(UPDATE_RECORDS_UNREADABLE);
    return this.#ledger;
  }
}

interface ContainerInspect {
  Id?: string;
  Name?: string;
  Image?: string;
  State?: { Running?: boolean };
  Config?: { Labels?: Record<string, string> };
}

function ours(raw: ContainerInspect, cellId: string, role: Role, operationId?: string): boolean {
  const labels = raw.Config?.Labels;
  const update = labels?.[UPDATE_LABEL];
  return (
    labels?.["localdot.cell"] === cellId &&
    labels["localdot.role"] === role &&
    !!update &&
    (operationId === undefined || update === operationId)
  );
}

function temporary(record: CellRecord, role: Role): string {
  return `${record.docker[role]}-update`;
}

function ownedContainers(record: CellRecord): { gate: string; desktop: string } {
  const owner = record.ownership;
  if (!owner?.gate || !owner.desktop)
    throw new CellControlConflict("This computer is too old to update.");
  return { gate: owner.gate, desktop: owner.desktop };
}

export class ComputerUpdateRefused extends CellControlConflict {}

export interface UpdateAdmissionDeps {
  cells: Pick<CellOrchestrator, "get" | "update">;
  live: Pick<LiveSessions, "get" | "admitIdleOperation" | "idleOperationPending">;
  runner: {
    holds(sessionId: string): boolean;
    get(sessionId: string): { status: string; controlHeld: boolean } | undefined;
    release?(signal?: AbortSignal): Promise<void>;
  };
}

// The user's Update: never while dot works or the user holds the computer. A finished task's wait
// for a follow-up ends first; the conversation carries on after the restart.
export async function updateComputer(
  d: UpdateAdmissionDeps,
  id: string,
  signal?: AbortSignal,
): Promise<void> {
  const cell = d.cells.get(id);
  if (!cell) throw new UnknownCellError(id);
  if (cell.fenced || cell.replacementPending)
    throw new ComputerUpdateRefused("This computer can't be updated right now.");
  // An Update already admitted holds the computer's one idle operation until it is done.
  if (cell.updating || d.live.idleOperationPending(id))
    throw new ComputerUpdateRefused("Your computer is already updating.");
  if (!cell.updateAvailable) throw new ComputerUpdateRefused("Your computer is up to date.");
  const busy = () => new ComputerUpdateRefused("Wait for dot to finish, or stop the task first.");
  const sessionId = d.live.get(id);
  if (sessionId) {
    const session = d.runner.get(sessionId);
    if (d.runner.holds(sessionId) || session?.controlHeld)
      throw new ComputerUpdateRefused("Hand back the computer first.");
    if (session?.status !== "idle" || !d.runner.release) throw busy();
    try {
      await d.runner.release(signal);
    } catch {
      throw busy();
    }
  }
  const admission = d.live.admitIdleOperation(id);
  if (!admission) throw busy();
  try {
    await d.cells.update(id);
  } finally {
    admission.release();
  }
}
