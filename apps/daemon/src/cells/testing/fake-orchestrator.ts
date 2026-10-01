import { ulid } from "@localdot/protocol";
import { type CellApi, type CellListener, UnknownCellError } from "../orchestrator.ts";
import {
  type CellEndpoints,
  type CellSummary,
  NO_STREAM,
  type Scale,
  type StreamState,
} from "../types.ts";

export class FakeOrchestrator implements CellApi {
  readonly cells = new Map<string, CellSummary>();
  readonly endpointsById = new Map<string, CellEndpoints>();
  readonly listeners = new Set<CellListener>();
  readonly streamUpdates: { id: string; patch: Partial<StreamState> }[] = [];
  readonly removals: { id: string; purgeHome: boolean }[] = [];
  failWith: Error | undefined;

  list(): CellSummary[] {
    return [...this.cells.values()];
  }

  get(id: string): CellSummary | undefined {
    return this.cells.get(id);
  }

  endpoints(id: string): CellEndpoints | undefined {
    return this.endpointsById.get(id);
  }

  subscribe(listener: CellListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(cell: CellSummary): void {
    this.cells.set(cell.id, cell);
    for (const listener of this.listeners) listener(cell);
  }

  updateStream(id: string, patch: Partial<StreamState>): void {
    this.streamUpdates.push({ id, patch });
    const cell = this.cells.get(id);
    if (cell) this.emit({ ...cell, stream: { ...cell.stream, ...patch } });
  }

  async create({ scale }: { scale: Scale }): Promise<CellSummary> {
    if (this.failWith) throw this.failWith;
    const cell: CellSummary = {
      id: ulid(),
      state: "starting",
      scale,
      createdAt: new Date().toISOString(),
      stream: NO_STREAM,
    };
    this.cells.set(cell.id, cell);
    return cell;
  }

  async start(id: string): Promise<void> {
    this.emit({ ...this.#require(id), state: "starting" });
  }

  async stop(id: string): Promise<void> {
    this.emit({ ...this.#require(id), state: "stopped" });
  }

  async remove(id: string, opts: { purgeHome?: boolean } = {}): Promise<void> {
    const cell = this.#require(id);
    this.removals.push({ id, purgeHome: opts.purgeHome ?? false });
    this.emit({ ...cell, state: "removed" });
    this.cells.delete(id);
  }

  #require(id: string): CellSummary {
    const cell = this.cells.get(id);
    if (!cell) throw new UnknownCellError(id);
    return cell;
  }
}
