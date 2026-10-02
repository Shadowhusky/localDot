import type { LeaseHolder, LeaseReply, LeaseRequest } from "../protocol/browserd.ts";

// Who drives the signed-in browser (P8-R11, P8-R12). browserd starts with the user holding it, so
// no agent call is served until the daemon grants the agent; the daemon re-asserts the holder
// whenever the cell becomes ready. Taking the screen is immediate; handing it back clears the X
// selections and reloads every page whose secret field still holds what the user typed, and only
// then lets the agent act. A step that fails leaves the user holding it.
export interface LeaseDeps {
  clearSelections(): Promise<void>;
  // The pages (CDP session ids) with a non-empty secret field.
  secretPages(): Promise<string[]>;
  // Page.reload, then wait for its load event (at most 10 s).
  reload(sessionId: string): Promise<void>;
  // Ends every agent call in flight (an /input or /type mid-way), as the user's control begins.
  abortAgentCalls(): void;
}

export class Lease {
  #holder: LeaseHolder = "user";
  #leaseId: string | undefined;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: LeaseDeps) {}

  get holder(): LeaseHolder {
    return this.#holder;
  }

  get agentMayAct(): boolean {
    return this.#holder === "agent";
  }

  // Changes run one at a time, in the order they arrive.
  set(req: LeaseRequest): Promise<LeaseReply> {
    const next = this.#queue.then(() => this.#apply(req));
    this.#queue = next.catch(() => {});
    return next;
  }

  async #apply(req: LeaseRequest): Promise<LeaseReply> {
    if (req.holder === "user") {
      this.#holder = "user";
      this.#leaseId = req.leaseId;
      this.deps.abortAgentCalls();
      return { holder: "user", leaseId: req.leaseId, reloaded: 0, selectionsCleared: false };
    }
    if (this.#holder === "agent" && this.#leaseId === req.leaseId) {
      return { holder: "agent", leaseId: req.leaseId, reloaded: 0, selectionsCleared: false };
    }
    // Still the user's until every step below has worked.
    this.#holder = "user";
    await this.deps.clearSelections();
    const pages = await this.deps.secretPages();
    for (const page of pages) await this.deps.reload(page);
    const left = await this.deps.secretPages();
    if (left.length > 0) throw new Error("a secret field still holds a value after reloading");
    this.#holder = "agent";
    this.#leaseId = req.leaseId;
    return { holder: "agent", leaseId: req.leaseId, reloaded: pages.length, selectionsCleared: true };
  }
}
