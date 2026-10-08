import type { BrowserOrchestrator, ReadyBrowser } from "../cells/browser-orchestrator.ts";
import type { CellApi } from "../cells/orchestrator.ts";
import type { TicketRegistry } from "../cells/secrets.ts";
import { type CellSummary, NO_STREAM, type StreamState } from "../cells/types.ts";

interface Entry {
  ready: ReadyBrowser;
  summary: CellSummary;
}

// Browser viewers have their own physical identity and health. A parent change or a
// browser restart revokes the old ticket and closes its viewers before publishing a
// fresh instance, including when a retained profile reuses the same browser cell ID.
export class BrowserStreams {
  readonly #entries = new Map<string, Entry>();
  readonly #listeners = new Set<(cell: CellSummary) => void>();
  readonly #off: (() => void)[];
  #closed = false;

  constructor(
    private readonly deps: {
      parents: Pick<CellApi, "get" | "list" | "subscribe">;
      browser: Pick<BrowserOrchestrator, "endpoints" | "subscribe">;
      tickets: Pick<TicketRegistry, "revoke">;
    },
  ) {
    this.#off = [
      deps.parents.subscribe((cell) => this.#refresh(cell.id)),
      deps.browser.subscribe((parent) => this.#refresh(parent)),
    ];
    for (const cell of deps.parents.list()) this.#refresh(cell.id);
  }

  #available(parentId: string): CellSummary | undefined {
    const parent = this.deps.parents.get(parentId);
    return !this.#closed &&
      parent?.state === "ready" &&
      !parent.paused &&
      !parent.fenced &&
      !parent.replacementPending
      ? parent
      : undefined;
  }

  #current(entry: Entry): boolean {
    const parent = this.#available(entry.ready.parentCellId);
    if (
      !parent ||
      parent.scale !== entry.summary.scale ||
      parent.createdAt !== entry.summary.createdAt
    )
      return false;
    const ready = this.deps.browser.endpoints(entry.ready.parentCellId);
    return (
      ready?.browserCellId === entry.ready.browserCellId &&
      ready.instance === entry.ready.instance &&
      ready.stream.baseUrl === entry.ready.stream.baseUrl &&
      ready.stream.authorization === entry.ready.stream.authorization
    );
  }

  #emit(summary: CellSummary): void {
    for (const listener of this.#listeners) {
      try {
        listener(structuredClone(summary));
      } catch {
        /* One viewer cannot retain another's authority. */
      }
    }
  }

  #refresh(parentId: string): void {
    const parent = this.#available(parentId);
    const ready = parent ? this.deps.browser.endpoints(parentId) : undefined;
    const old = this.#entries.get(parentId);
    if (old && ready && this.#current(old) && parent?.scale === old.summary.scale) return;
    if (old) {
      this.#entries.delete(parentId);
      this.deps.tickets.revoke(old.summary.id);
      this.#emit({ ...old.summary, state: "stopped", stream: { ...NO_STREAM } });
    }
    if (!parent || !ready) return;
    const summary: CellSummary = {
      id: ready.browserCellId,
      state: "ready",
      scale: parent.scale,
      createdAt: parent.createdAt,
      stream: { ...NO_STREAM },
    };
    this.#entries.set(parentId, { ready, summary });
    this.#emit(summary);
  }

  #entry(id: string): Entry | undefined {
    for (const entry of this.#entries.values()) {
      if (entry.summary.id === id && this.#current(entry)) return entry;
    }
    return undefined;
  }

  get(id: string): CellSummary | undefined {
    const entry = this.#entry(id);
    return entry ? structuredClone(entry.summary) : undefined;
  }

  forParent(id: string): CellSummary | undefined {
    const entry = this.#entries.get(id);
    return entry && this.#current(entry) ? structuredClone(entry.summary) : undefined;
  }

  endpoints(id: string) {
    const entry = this.#entry(id);
    return entry ? { stream: structuredClone(entry.ready.stream) } : undefined;
  }

  updateStream(id: string, stream: StreamState): void {
    const entry = this.#entry(id);
    if (!entry) return;
    entry.summary.stream = structuredClone(stream);
    this.#emit(entry.summary);
  }

  subscribe(listener: (cell: CellSummary) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  dispose(): void {
    this.#closed = true;
    for (const off of this.#off) off();
    for (const parentId of [...this.#entries.keys()]) this.#refresh(parentId);
    this.#listeners.clear();
  }
}
