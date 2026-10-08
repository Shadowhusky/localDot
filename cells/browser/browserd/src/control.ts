import {
  BROWSER_CONTROL_TIMEOUT_MS,
  BrowserActionPermit,
  type BrowserAgentOwner,
  type BrowserControlReply,
  BrowserControlRequest,
  BrowserManualPermit,
} from "../../../../packages/protocol/src/browser-control.ts";

export interface BrowserControlDeps {
  browserCellId: string;
  parentCellId: string;
  instance: string;
  clearSelections(signal: AbortSignal): Promise<void>;
  secretPages(signal: AbortSignal): Promise<readonly string[]>;
  reload(page: string, signal: AbortSignal): Promise<void>;
}

export interface BrowserActionLease {
  readonly signal: AbortSignal;
  check(): void;
  finish(): void;
}

interface ActiveAction {
  abort: AbortController;
  settled: Promise<void>;
}

interface ControlTransition {
  request: BrowserControlRequest;
  fingerprint: string;
  abort: AbortController;
  promise: Promise<BrowserControlReply>;
}

export class BrowserControlError extends Error {
  constructor(readonly reason: "identity" | "stale" | "locked" | "cleanup" | "timeout") {
    super(`Browser control refused: ${reason}`);
  }
}

function sameOwner(first: BrowserAgentOwner, second: BrowserAgentOwner): boolean {
  return first.sessionId === second.sessionId && first.generation === second.generation;
}

export class BrowserControl {
  readonly #deps: Readonly<BrowserControlDeps>;
  readonly #active = new Set<ActiveAction>();
  #tail: Promise<void> = Promise.resolve();
  #transition?: ControlTransition;
  #manualReady?: ControlTransition;
  #holder: "user" | "agent" = "user";
  #owner?: BrowserAgentOwner;
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
    if (request.revision <= (this.#transition?.request.revision ?? 0)) {
      if (this.#transition?.fingerprint === fingerprint) return this.#transition.promise;
      throw new BrowserControlError("stale");
    }
    const previous = this.#tail;
    const previousTransition = this.#transition;
    const active = [...this.#active];
    this.#holder = "user";
    this.#owner = undefined;
    this.#manualReady = undefined;
    const abort = new AbortController();
    const reply = Promise.withResolvers<BrowserControlReply>();
    const transition: ControlTransition = {
      request,
      fingerprint,
      abort,
      promise: reply.promise,
    };
    this.#transition = transition;
    const check = () => {
      abort.signal.throwIfAborted();
      if (this.#transition !== transition) throw new BrowserControlError("stale");
    };
    const work = previous.then(async () => {
      check();
      await Promise.all(active.map((action) => action.settled));
      check();
      let reloaded = 0;
      if (request.holder === "agent") {
        await this.#deps.clearSelections(abort.signal);
        check();
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
        this.#owner = Object.freeze({ ...request.owner });
        this.#holder = "agent";
      } else this.#manualReady = transition;
      return {
        browserCellId: request.browserCellId,
        parentCellId: request.parentCellId,
        instance: request.instance,
        revision: request.revision,
        requestId: request.requestId,
        holder: request.holder,
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
    };
    const refused = () => {
      if (this.#transition === transition) {
        this.#holder = "user";
        this.#owner = undefined;
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
        cleanup();
        if (!abort.signal.aborted) reply.resolve(Object.freeze(result));
      },
      () => abort.abort(new BrowserControlError("cleanup")),
    );
    previousTransition?.abort.abort(new BrowserControlError("stale"));
    for (const action of active) action.abort.abort(new BrowserControlError("locked"));
    if (signal?.aborted) cancel();
    return transition.promise;
  }

  admit(raw: unknown): BrowserActionLease {
    const permit = BrowserActionPermit.parse(raw);
    this.#assertIdentity(permit);
    const transition = this.#transition;
    if (
      this.#closed ||
      this.#holder !== "agent" ||
      !this.#owner ||
      !transition ||
      transition.abort.signal.aborted ||
      permit.revision !== transition.request.revision ||
      permit.requestId !== transition.request.requestId ||
      !sameOwner(permit.owner, this.#owner)
    )
      throw new BrowserControlError("locked");
    return this.#lease(transition, "agent");
  }

  admitManual(raw: unknown): BrowserActionLease {
    const permit = BrowserManualPermit.parse(raw);
    this.#assertIdentity(permit);
    const transition = this.#transition;
    if (
      this.#closed ||
      this.#holder !== "user" ||
      !transition ||
      this.#manualReady !== transition ||
      transition.request.holder !== "user" ||
      transition.abort.signal.aborted ||
      permit.revision !== transition.request.revision ||
      permit.requestId !== transition.request.requestId
    )
      throw new BrowserControlError("locked");
    return this.#lease(transition, "user");
  }

  #lease(transition: ControlTransition, holder: "agent" | "user"): BrowserActionLease {
    const abort = new AbortController();
    let settle = () => {};
    const action: ActiveAction = {
      abort,
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
        if (finished || this.#holder !== holder || this.#transition !== transition)
          throw new BrowserControlError("locked");
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
    this.#owner = undefined;
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
    this.#transition?.abort.abort(new BrowserControlError("locked"));
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
