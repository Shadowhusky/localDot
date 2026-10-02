import type { LeaseHolder, LeaseReply, LeaseRequest } from "../protocol/browserd.ts";

export interface BrowserdLeaseApi {
  setLease(cellId: string, req: LeaseRequest): Promise<LeaseReply>;
}

export type ControlListener = (cellId: string, holder: LeaseHolder) => void;

// Who may drive each browser cell (P8-R11, P8-R13). The daemon's side opens or closes the viewer's
// input (the stream proxy's gate reads holder()); browserd's side opens or closes the agent's
// verbs. The order always shuts first: to the user, browserd locks the agent out before any key of
// theirs can arrive; to the agent, the viewer's input closes before browserd lets the agent back.
export class ScreenControl {
  readonly #holders = new Map<string, LeaseHolder>();
  readonly #listeners = new Set<ControlListener>();

  constructor(
    private readonly deps: {
      browserd: BrowserdLeaseApi;
      isBrowserCell(cellId: string): boolean;
      ulid(): string;
    },
  ) {}

  // Every cell starts with the agent holding it: viewers watch, nobody types.
  holder(cellId: string): LeaseHolder {
    return this.#holders.get(cellId) ?? "agent";
  }

  subscribe(listener: ControlListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async grant(cellId: string, holder: LeaseHolder): Promise<LeaseReply | undefined> {
    const browser = this.deps.isBrowserCell(cellId);
    if (holder === "user") {
      const reply = browser ? await this.deps.browserd.setLease(cellId, { holder, leaseId: this.deps.ulid() }) : undefined;
      this.#set(cellId, "user");
      return reply;
    }
    this.#set(cellId, "agent");
    return browser ? this.deps.browserd.setLease(cellId, { holder, leaseId: this.deps.ulid() }) : undefined;
  }

  // A browser cell that (re)became ready starts locked; it learns the holder again.
  async reassert(cellId: string): Promise<void> {
    if (!this.deps.isBrowserCell(cellId)) return;
    await this.deps.browserd.setLease(cellId, { holder: this.holder(cellId), leaseId: this.deps.ulid() });
  }

  forget(cellId: string): void {
    this.#holders.delete(cellId);
  }

  #set(cellId: string, holder: LeaseHolder): void {
    this.#holders.set(cellId, holder);
    for (const l of this.#listeners) l(cellId, holder);
  }
}
