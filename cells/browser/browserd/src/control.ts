import {
  BROWSER_CONTROL_TIMEOUT_MS,
  BrowserActionPermit,
  type BrowserAgentOwner,
  type BrowserControlReply,
  BrowserControlRequest,
  BrowserManualPermit,
} from "../../../../packages/protocol/src/browser-control.ts";

const KEPT_REQUESTS = 256;

export interface BrowserControlDeps {
  browserCellId: string;
  parentCellId: string;
  instance: string;
  clearSelections(signal: AbortSignal): Promise<void>;
  secretPages(signal: AbortSignal): Promise<readonly string[]>;
  reload(page: string, signal: AbortSignal): Promise<void>;
  // Open file choosers: the user's control may have left them, so a grant out of it drops them.
  clearChoosers?(): void;
  // The tab is in a window of this task's.
  ownsTab?(sessionId: string, tabId: string): boolean;
  // The task's grant ended; `keep` holds its window for its return.
  released?(sessionId: string, keep: boolean): void;
  // The user takes the browser in this task's window.
  front?(sessionId: string, signal: AbortSignal): Promise<void>;
}

export interface BrowserActionLease {
  readonly signal: AbortSignal;
  check(): void;
  finish(): void;
}

interface ActiveAction {
  abort: AbortController;
  settled: Promise<void>;
  sessionId?: string;
}

interface ControlTransition {
  request: BrowserControlRequest;
  fingerprint: string;
  abort: AbortController;
  promise: Promise<BrowserControlReply>;
}

interface AgentGrant {
  owner: BrowserAgentOwner;
  revision: number;
  requestId: string;
}

export class BrowserControlError extends Error {
  constructor(readonly reason: "identity" | "stale" | "locked" | "cleanup" | "timeout") {
    super(`Browser control refused: ${reason}`);
  }
}

function sameOwner(first: BrowserAgentOwner, second: BrowserAgentOwner): boolean {
  return first.sessionId === second.sessionId && first.generation === second.generation;
}

// Several tasks hold the browser at once, each its own grant; the user's control revokes them all.
// Control requests run one at a time, in order of arrival. A task's request reaches only its own
// grant and actions, so one task's release or grant never touches another's work.
export class BrowserControl {
  readonly #deps: Readonly<BrowserControlDeps>;
  readonly #active = new Set<ActiveAction>();
  readonly #agents = new Map<string, AgentGrant>();
  // The requests still running, and those kept to answer a repeat of one.
  readonly #pending = new Set<ControlTransition>();
  readonly #requests = new Map<string, ControlTransition>();
  // Each task's newest revision: a late request of its own must not undo a newer one.
  readonly #revisions = new Map<string, number>();
  #highest = 0;
  // A grant from before the user's latest control is no longer good.
  #userRevision = 0;
  #tail: Promise<void> = Promise.resolve();
  #manualReady?: ControlTransition;
  #holder: "user" | "agent" = "user";
  #closed = false;
  #closing?: Promise<void>;

  constructor(deps: BrowserControlDeps) {
    BrowserControlRequest.parse({
      browserCellId: deps.browserCellId,
      parentCellId: deps.parentCellId,
      instance: deps.instance,
      requestId: deps.browserCellId,
      revision: 1,
      holder: "user",
    });
    if (deps.browserCellId === deps.parentCellId) throw new BrowserControlError("identity");
    this.#deps = Object.freeze({ ...deps });
  }

  get holder(): "user" | "agent" {
    return this.#holder;
  }

  set(raw: unknown, signal?: AbortSignal): Promise<BrowserControlReply> {
    if (this.#closed) throw new BrowserControlError("locked");
    const request = BrowserControlRequest.parse(raw);
    this.#assertIdentity(request);
    const fingerprint = JSON.stringify(request);
    // A task coming to rest beside others only lets go of its own grant.
    const resting =
      request.holder === "user" &&
      request.alone === true &&
      request.front !== undefined &&
      [...this.#agents.keys()].some((sessionId) => sessionId !== request.front);
    const sessionId =
      request.holder === "user" ? (resting ? request.front : undefined) : request.owner.sessionId;
    // Tasks' requests cross on their way here, so a task answers only to its own; the user's control
    // for a task overtakes what other tasks asked, and revokes it.
    const own = sessionId
      ? (this.#revisions.get(sessionId) ?? 0)
      : request.holder === "user" && request.front
        ? Math.max(this.#userRevision, this.#revisions.get(request.front) ?? 0)
        : this.#highest;
    if (
      request.revision <= own ||
      (request.holder === "agent" && request.revision <= this.#userRevision)
    ) {
      const repeat = this.#requests.get(fingerprint);
      if (repeat) return repeat.promise;
      throw new BrowserControlError("stale");
    }
    this.#highest = Math.max(this.#highest, request.revision);
    if (sessionId) this.#revisions.set(sessionId, request.revision);
    const previous = this.#tail;
    const superseded: ControlTransition[] = [];
    let active: ActiveAction[];
    if (request.holder === "user" && !resting) {
      this.#userRevision = request.revision;
      this.#holder = "user";
      this.#agents.clear();
      this.#manualReady = undefined;
      active = [...this.#active];
      superseded.push(...this.#pending);
    } else {
      if (sessionId) this.#agents.delete(sessionId);
      active = [...this.#active].filter((action) => action.sessionId === sessionId);
      // A grant out of the user's control ends it, as a user request ends an older one.
      if (request.holder === "agent" && this.#holder === "user") {
        this.#manualReady = undefined;
        active = [...this.#active];
        superseded.push(...[...this.#pending].filter((t) => t.request.holder === "user"));
      }
    }
    const abort = new AbortController();
    const reply = Promise.withResolvers<BrowserControlReply>();
    const transition: ControlTransition = {
      request,
      fingerprint,
      abort,
      promise: reply.promise,
    };
    this.#pending.add(transition);
    this.#remember(transition);
    const check = () => {
      abort.signal.throwIfAborted();
      if (!this.#pending.has(transition)) throw new BrowserControlError("stale");
    };
    const work = previous.then(async () => {
      check();
      await Promise.all(active.map((action) => action.settled));
      check();
      let reloaded = 0;
      if (request.holder === "agent") {
        // Copied text is the screen's, not a task's: it never reaches the next holder.
        await this.#deps.clearSelections(abort.signal);
        check();
        if (this.#holder !== "agent") {
          this.#deps.clearChoosers?.();
          const pages = [...new Set(await this.#deps.secretPages(abort.signal))];
          check();
          if (pages.length > 256) throw new BrowserControlError("cleanup");
          for (const page of pages) {
            check();
            await this.#deps.reload(page, abort.signal);
            check();
            reloaded += 1;
          }
          const remaining = await this.#deps.secretPages(abort.signal);
          check();
          if (remaining.length !== 0) throw new BrowserControlError("cleanup");
          this.#holder = "agent";
        }
        this.#agents.set(
          request.owner.sessionId,
          Object.freeze({
            owner: Object.freeze({ ...request.owner }),
            revision: request.revision,
            requestId: request.requestId,
          }),
        );
      } else if (resting && sessionId) {
        this.#deps.released?.(sessionId, true);
        if (!this.#agents.size) this.#holder = "user";
      } else if (request.holder === "user") {
        if (request.front) await this.#deps.front?.(request.front, abort.signal).catch(() => {});
        check();
        this.#manualReady = transition;
      } else if (request.holder === "release") {
        this.#deps.released?.(request.owner.sessionId, request.keep === true);
        if (!this.#agents.size) this.#holder = "user";
      }
      return {
        browserCellId: request.browserCellId,
        parentCellId: request.parentCellId,
        instance: request.instance,
        revision: request.revision,
        requestId: request.requestId,
        holder: this.#holder,
        reloaded,
        selectionsCleared: request.holder === "agent",
      };
    });
    this.#tail = work.then(
      () => {},
      () => {},
    );
    const timeout = setTimeout(
      () => abort.abort(new BrowserControlError("timeout")),
      BROWSER_CONTROL_TIMEOUT_MS,
    );
    const cancel = () => abort.abort(new BrowserControlError("locked"));
    const cleanup = () => {
      clearTimeout(timeout);
      abort.signal.removeEventListener("abort", refused);
      signal?.removeEventListener("abort", cancel);
      this.#pending.delete(transition);
    };
    const refused = () => {
      if (request.holder === "agent") {
        const grant = this.#agents.get(request.owner.sessionId);
        if (grant?.requestId === request.requestId) this.#agents.delete(request.owner.sessionId);
        if (!this.#agents.size && this.#holder === "agent") this.#holder = "user";
      } else if (!resting && request.holder === "user" && this.#userRevision === request.revision) {
        this.#manualReady = undefined;
        for (const action of this.#active) action.abort.abort(new BrowserControlError("locked"));
      }
      cleanup();
      reply.reject(abort.signal.reason);
    };
    abort.signal.addEventListener("abort", refused, { once: true });
    signal?.addEventListener("abort", cancel, { once: true });
    void work.then(
      (result) => {
        if (abort.signal.aborted) return;
        cleanup();
        reply.resolve(Object.freeze(result));
      },
      () => abort.abort(new BrowserControlError("cleanup")),
    );
    for (const earlier of superseded) {
      this.#requests.delete(earlier.fingerprint);
      earlier.abort.abort(new BrowserControlError("stale"));
    }
    for (const action of active) action.abort.abort(new BrowserControlError("locked"));
    if (signal?.aborted) cancel();
    return transition.promise;
  }

  #remember(transition: ControlTransition): void {
    this.#requests.set(transition.fingerprint, transition);
    if (this.#requests.size > KEPT_REQUESTS)
      this.#requests.delete(this.#requests.keys().next().value as string);
    if (this.#revisions.size > KEPT_REQUESTS)
      for (const sessionId of this.#revisions.keys()) {
        if (this.#revisions.size <= KEPT_REQUESTS) break;
        if (!this.#agents.has(sessionId)) this.#revisions.delete(sessionId);
      }
  }

  // With a tab, the permit is good only for a tab in the task's own window.
  admit(raw: unknown, tabId?: string): BrowserActionLease {
    const permit = BrowserActionPermit.parse(raw);
    this.#assertIdentity(permit);
    const sessionId = permit.owner.sessionId;
    const grant = this.#agents.get(sessionId);
    if (
      this.#closed ||
      this.#holder !== "agent" ||
      !grant ||
      permit.revision !== grant.revision ||
      permit.requestId !== grant.requestId ||
      !sameOwner(permit.owner, grant.owner) ||
      (tabId !== undefined && this.#deps.ownsTab?.(sessionId, tabId) === false)
    )
      throw new BrowserControlError("locked");
    return this.#lease(
      () => this.#holder === "agent" && this.#agents.get(sessionId) === grant,
      sessionId,
    );
  }

  admitManual(raw: unknown): BrowserActionLease {
    const permit = BrowserManualPermit.parse(raw);
    this.#assertIdentity(permit);
    const transition = this.#manualReady;
    if (
      this.#closed ||
      this.#holder !== "user" ||
      !transition ||
      transition.request.holder !== "user" ||
      transition.abort.signal.aborted ||
      permit.revision !== transition.request.revision ||
      permit.requestId !== transition.request.requestId
    )
      throw new BrowserControlError("locked");
    return this.#lease(() => this.#holder === "user" && this.#manualReady === transition);
  }

  #lease(current: () => boolean, sessionId?: string): BrowserActionLease {
    const abort = new AbortController();
    let settle = () => {};
    const action: ActiveAction = {
      abort,
      ...(sessionId ? { sessionId } : {}),
      settled: new Promise<void>((resolve) => {
        settle = resolve;
      }),
    };
    this.#active.add(action);
    let finished = false;
    return {
      signal: abort.signal,
      check: () => {
        abort.signal.throwIfAborted();
        if (finished || !current()) throw new BrowserControlError("locked");
      },
      finish: () => {
        if (finished) return;
        finished = true;
        this.#active.delete(action);
        settle();
      },
    };
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.#holder = "user";
    this.#agents.clear();
    this.#manualReady = undefined;
    const active = [...this.#active];
    const reply = Promise.withResolvers<void>();
    this.#closing = reply.promise;
    const timeout = setTimeout(
      () => reply.reject(new BrowserControlError("timeout")),
      BROWSER_CONTROL_TIMEOUT_MS,
    );
    const drained = Promise.all([this.#tail, ...active.map((action) => action.settled)]);
    void drained.then(() => {
      clearTimeout(timeout);
      reply.resolve();
    });
    for (const pending of this.#pending) pending.abort.abort(new BrowserControlError("locked"));
    for (const action of active) action.abort.abort(new BrowserControlError("locked"));
    return reply.promise;
  }

  #assertIdentity(identity: {
    browserCellId: string;
    parentCellId: string;
    instance: string;
  }): void {
    if (
      identity.browserCellId !== this.#deps.browserCellId ||
      identity.parentCellId !== this.#deps.parentCellId ||
      identity.instance !== this.#deps.instance
    )
      throw new BrowserControlError("identity");
  }
}
