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
  UPDATE_UNFINISHED,
} from "./orchestrator.ts";
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
const PHASES = ["creating", "retiring", "renaming", "done"] as const;

// New containers are made beside the stopped old ones ("creating"), the old ones are removed
// ("retiring"), the new ones take the old names and the cell record ("renaming"). Until the old
// ones go, an interrupted update rolls back; after that it only goes forward. The home volume,
// networks, addresses, tokens and keyd port are never touched.
export const ComputerUpdateRecord = z.strictObject({
  v: z.literal(1),
  operationId: Id,
  cellId: Id,
  previous: z.strictObject({ gate: ContainerId, desktop: ContainerId }),
  images: z.strictObject({ gate: ImageId, desktop: ImageId }),
  candidates: z.strictObject({ gate: ContainerId.nullable(), desktop: ContainerId.nullable() }),
  phase: z.enum([...PHASES, "rolled-back"]),
});
export type ComputerUpdateRecord = z.infer<typeof ComputerUpdateRecord>;

const settled = (entry: ComputerUpdateRecord) =>
  entry.phase === "done" || entry.phase === "rolled-back";
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
    if (!before || before.operationId !== next.operationId) {
      if (
        (before && !settled(before)) ||
        next.phase !== "creating" ||
        next.candidates.gate !== null ||
        next.candidates.desktop !== null
      )
        throw new Error("An earlier computer update is unfinished");
    } else {
      const same = (field: "v" | "cellId" | "previous" | "images") =>
        equal(before[field], next[field]);
      const from = PHASES.indexOf(before.phase as (typeof PHASES)[number]);
      const to = PHASES.indexOf(next.phase as (typeof PHASES)[number]);
      const forward =
        next.phase === "rolled-back"
          ? before.phase === "creating"
          : from >= 0 && (to === from || to === from + 1);
      if (
        !same("v") ||
        !same("cellId") ||
        !same("previous") ||
        !same("images") ||
        !forward ||
        (next.phase !== "creating" && next.phase !== "rolled-back" && !full(next)) ||
        ROLES.some(
          (role) =>
            before.candidates[role] !== null && before.candidates[role] !== next.candidates[role],
        )
      )
        throw new Error("Computer update identity or phase changed");
    }
    this.#records.write(next.cellId, next);
  }
}

const failure = () => new CellControlConflict(UPDATE_UNFINISHED);

export interface ComputerUpdatesDeps {
  home: string;
  docker: Docker;
  images: Images;
  stream: StreamOptions;
  everyMs?: number;
}

// Whether a computer runs older images than its configured tags name now, and the swap that
// moves it onto them. Image IDs are compared, never tags: a rebuilt image keeps its tag.
export class ComputerUpdates {
  readonly #docker: Docker;
  readonly #images: Images;
  readonly #stream: StreamOptions;
  readonly #everyMs: number;
  readonly #available = new Map<string, boolean>();
  readonly #unfinished = new Set<string>();
  readonly #ledger: ComputerUpdateStore | undefined;

  constructor(deps: ComputerUpdatesDeps) {
    this.#docker = deps.docker;
    this.#images = deps.images;
    this.#stream = deps.stream;
    this.#everyMs = deps.everyMs ?? 60_000;
    try {
      const ledger = new ComputerUpdateStore(deps.home);
      for (const entry of ledger.list()) if (!settled(entry)) this.#unfinished.add(entry.cellId);
      this.#ledger = ledger;
    } catch {
      // Without its records an interrupted update can't be told apart, so every computer waits.
      console.error("computer update records are unreadable");
    }
  }

  available(id: string): boolean {
    return this.#available.get(id) === true || this.pending(id);
  }

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

  // The computer must be stopped. Resolves the record that now owns the new containers.
  async swap(record: CellRecord, save: Save): Promise<CellRecord> {
    const before = this.#store().read(record.id);
    if (before && !settled(before)) throw failure();
    const previous = ownedContainers(record);
    const images = await this.#targets();
    if (!images) throw new CellControlConflict("The new version isn't on this Mac yet.");
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
            ? gateSpec(record, this.#images.gate)
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
        const made = await this.#candidate(entry, record, role);
        if (!made || made.Image !== images[role]) throw failure();
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
    try {
      return await this.#recover(record, save);
    } catch {
      throw failure();
    }
  }

  async #recover(record: CellRecord, save: Save): Promise<CellRecord> {
    const entry = this.#store().read(record.id);
    if (!entry || settled(entry)) return record;
    const owner = record.ownership;
    const candidates = entry.candidates;
    if (
      !owner ||
      !(
        (owner.gate === entry.previous.gate && owner.desktop === entry.previous.desktop) ||
        (owner.gate === candidates.gate && owner.desktop === candidates.desktop)
      )
    )
      throw failure();
    if (entry.phase === "creating") {
      await this.#rollBack(entry, record);
      return record;
    }
    return this.#finish(entry, record, save);
  }

  async #finish(start: ComputerUpdateRecord, record: CellRecord, save: Save) {
    let entry = start;
    const step = (phase: ComputerUpdateRecord["phase"]) => {
      entry = { ...entry, phase };
      this.#write(entry);
    };
    const { gate, desktop } = entry.candidates;
    if (!gate || !desktop || !record.ownership) throw failure();
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
      const labels = raw?.Config?.Labels;
      if (
        !raw ||
        labels?.["localdot.cell"] !== record.id ||
        labels["localdot.role"] !== role ||
        labels[UPDATE_LABEL] !== entry.operationId
      )
        throw failure();
      if (raw.Name === `/${record.docker[role]}`) continue;
      if (raw.Name !== `/${temporary(record, role)}`) throw failure();
      await this.#docker.request({
        method: "POST",
        path: `/containers/${encodeURIComponent(id)}/rename`,
        query: { name: record.docker[role] },
      });
    }
    const next: CellRecord = { ...record, ownership: { ...record.ownership, gate, desktop } };
    if (!equal(record.ownership, next.ownership)) save(next);
    step("done");
    this.#available.set(record.id, false);
    return next;
  }

  async #rollBack(entry: ComputerUpdateRecord, record: CellRecord): Promise<void> {
    for (const role of ROLES) {
      const id = entry.candidates[role] ?? (await this.#candidate(entry, record, role))?.Id;
      if (id) await retireExactContainers(this.#docker, record.id, [{ role, id }]);
    }
    this.#write({ ...entry, phase: "rolled-back" });
  }

  #write(entry: ComputerUpdateRecord): void {
    this.#store().write(entry);
    if (settled(entry)) this.#unfinished.delete(entry.cellId);
    else this.#unfinished.add(entry.cellId);
  }

  // This update's container under the temporary name. Anything else there is never adopted.
  async #candidate(entry: ComputerUpdateRecord, record: CellRecord, role: Role) {
    const raw = await this.#container(temporary(record, role));
    if (!raw) return undefined;
    const labels = raw.Config?.Labels;
    if (
      typeof raw.Id !== "string" ||
      labels?.["localdot.cell"] !== record.id ||
      labels["localdot.role"] !== role ||
      labels[UPDATE_LABEL] !== entry.operationId ||
      (entry.candidates[role] !== null && raw.Id !== entry.candidates[role]) ||
      raw.State?.Running !== false
    )
      throw failure();
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
    if (!this.#ledger) throw failure();
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
  live: Pick<LiveSessions, "get" | "admitIdleOperation">;
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
  if (cell.updating) throw new ComputerUpdateRefused("Your computer is already updating.");
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
