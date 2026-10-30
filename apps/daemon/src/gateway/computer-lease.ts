// One computer takes one hand at a time: a task's single action, or the user's control. Waiting is
// first come, first served; the user's control goes ahead of every task. A session that already
// holds the computer is granted again at once (a hand-off to the user from inside its own action).
export interface ComputerGrant {
  readonly sessionId: string;
  readonly user: boolean;
  // When the grant began, in the lease's clock.
  readonly since: number;
  release(): void;
}

interface Waiter {
  readonly sessionId: string;
  readonly user: boolean;
  readonly grant: (grant: ComputerGrant) => void;
  readonly refuse: (error: unknown) => void;
}

interface Held {
  readonly sessionId: string;
  // Nested grants of the same session, each released on its own.
  readonly grants: Set<ComputerGrant>;
}

export class ComputerLeaseRevoked extends Error {
  constructor() {
    super("the computer is no longer available to this task");
    this.name = "ComputerLeaseRevoked";
  }
}

export class ComputerLease {
  #held: Held | undefined;
  #last: string | undefined;
  readonly #queue: Waiter[] = [];
  readonly #listeners = new Set<() => void>();

  constructor(private readonly now: () => number = Date.now) {}

  get holder(): string | undefined {
    return this.#held?.sessionId;
  }
  // The session the computer last served, for what outlives an action (a request still on its way).
  get last(): string | undefined {
    return this.#held?.sessionId ?? this.#last;
  }
  get userHolds(): boolean {
    return !!this.#held && [...this.#held.grants].some((grant) => grant.user);
  }
  waiting(): string[] {
    return this.#queue.map((waiter) => waiter.sessionId);
  }

  acquire(sessionId: string, options: { signal?: AbortSignal; user?: boolean } = {}) {
    const { signal, user = false } = options;
    signal?.throwIfAborted();
    if (this.#held?.sessionId === sessionId) return Promise.resolve(this.#grant(sessionId, user));
    const { promise, resolve, reject } = Promise.withResolvers<ComputerGrant>();
    const abort = () => {
      const at = this.#queue.indexOf(waiter);
      if (at < 0) return;
      this.#queue.splice(at, 1);
      reject(signal?.reason ?? new ComputerLeaseRevoked());
      this.#changed();
    };
    const waiter: Waiter = {
      sessionId,
      user,
      grant: (grant) => {
        signal?.removeEventListener("abort", abort);
        resolve(grant);
      },
      refuse: (error) => {
        signal?.removeEventListener("abort", abort);
        reject(error);
      },
    };
    signal?.addEventListener("abort", abort, { once: true });
    const firstTask = this.#queue.findIndex((queued) => !queued.user);
    if (user && firstTask >= 0) this.#queue.splice(firstTask, 0, waiter);
    else this.#queue.push(waiter);
    this.#advance();
    this.#changed();
    return promise;
  }

  // Ends a session's place on the computer: its waits are refused and its grants end.
  revoke(sessionId: string): void {
    for (const waiter of this.#queue.filter((queued) => queued.sessionId === sessionId)) {
      this.#queue.splice(this.#queue.indexOf(waiter), 1);
      waiter.refuse(new ComputerLeaseRevoked());
    }
    if (this.#held?.sessionId === sessionId) for (const grant of this.#held.grants) grant.release();
    if (this.#last === sessionId) this.#last = undefined;
    this.#changed();
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #grant(sessionId: string, user: boolean): ComputerGrant {
    const held = this.#held ?? { sessionId, grants: new Set<ComputerGrant>() };
    this.#held = held;
    let released = false;
    const grant: ComputerGrant = Object.freeze({
      sessionId,
      user,
      since: this.now(),
      release: () => {
        if (released) return;
        released = true;
        held.grants.delete(grant);
        if (this.#held !== held || held.grants.size) return this.#changed();
        this.#held = undefined;
        this.#last = sessionId;
        this.#advance();
        this.#changed();
      },
    });
    held.grants.add(grant);
    return grant;
  }

  #advance(): void {
    if (this.#held) {
      // The holder's own requests join it; everyone else waits.
      const held = this.#held;
      for (const waiter of this.#queue.filter((queued) => queued.sessionId === held.sessionId)) {
        this.#queue.splice(this.#queue.indexOf(waiter), 1);
        waiter.grant(this.#grant(waiter.sessionId, waiter.user));
      }
      return;
    }
    const next = this.#queue.shift();
    if (!next) return;
    next.grant(this.#grant(next.sessionId, next.user));
    this.#advance();
  }

  #changed(): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener();
      } catch {
        console.error("a computer lease listener failed");
      }
    }
  }
}
