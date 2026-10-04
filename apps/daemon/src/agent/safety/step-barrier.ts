export class PausedStepError extends Error {
  constructor() {
    super("task execution paused");
    this.name = "PausedStepError";
  }
}
export interface StepPause {
  requestId: string;
  revision: number;
  reason: "user" | "repeated_action";
  phase: "pausing" | "paused" | "uncertain";
}
export class StepBarrier {
  #tail: Promise<unknown> = Promise.resolve();
  #active = 0;
  #revision = 0;
  #pause: StepPause | undefined;
  #stopped = false;
  readonly #wake = new Set<() => void>();
  readonly #queued = new Set<(error: unknown) => void>();
  constructor(readonly current: () => void) {}
  get pause(): StepPause | undefined {
    return this.#pause ? { ...this.#pause } : undefined;
  }
  get active(): number {
    return this.#active;
  }
  #check(signal: AbortSignal): void {
    signal.throwIfAborted();
    this.current();
    if (this.#stopped || this.#pause) throw new PausedStepError();
  }
  run<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
    try {
      this.#check(signal);
    } catch (error) {
      return Promise.reject(error);
    }
    const admittedRevision = this.#revision;
    let retired = false;
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (error: unknown) => void;
    const result = new Promise<T>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const detach = () => {
      this.#queued.delete(cancel);
      signal.removeEventListener("abort", abort);
    };
    const cancel = (error: unknown) => {
      if (retired) return;
      retired = true;
      detach();
      reject(error);
    };
    const abort = () => cancel(signal.reason);
    this.#queued.add(cancel);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const serial = this.#tail.then(async () => {
      if (retired) return;
      try {
        this.#check(signal);
        if (admittedRevision !== this.#revision) throw new PausedStepError();
      } catch (error) {
        cancel(error);
        return;
      }
      // Only physical work owns active/drain. A queued cancellation never releases it.
      detach();
      this.#active++;
      try {
        resolve(await work());
      } catch (error) {
        reject(error);
      } finally {
        retired = true;
        this.#active--;
        for (const wake of [...this.#wake]) wake();
      }
    });
    this.#tail = serial.then(
      () => {},
      () => {},
    );
    return result;
  }
  requestPause(requestId: string, reason: StepPause["reason"]): StepPause {
    this.current();
    if (this.#stopped) throw new PausedStepError();
    if (this.#pause) {
      if (this.#pause.requestId !== requestId) throw new Error("another pause owns the task");
      return { ...this.#pause };
    }
    this.#pause = { requestId, revision: ++this.#revision, reason, phase: "pausing" };
    for (const cancel of [...this.#queued]) cancel(new PausedStepError());
    return { ...this.#pause };
  }
  async waitAtBoundary(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (!this.#pause || this.#stopped) throw new Error("no live pause owner");
    while (this.#active > 0) {
      await new Promise<void>((resolve, reject) => {
        const done = () => {
          this.#wake.delete(done);
          signal.removeEventListener("abort", abort);
          resolve();
        };
        const abort = () => {
          this.#wake.delete(done);
          signal.removeEventListener("abort", abort);
          reject(signal.reason);
        };
        this.#wake.add(done);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
      signal.throwIfAborted();
      if (this.#stopped) throw new PausedStepError();
    }
    this.current();
  }
  confirmPaused(requestId: string, revision: number): void {
    this.current();
    if (
      this.#stopped ||
      this.#active ||
      this.#pause?.requestId !== requestId ||
      this.#pause.revision !== revision ||
      this.#pause.phase !== "pausing"
    )
      throw new Error("pause boundary not confirmed");
    this.#pause.phase = "paused";
  }
  uncertain(requestId: string, revision: number): void {
    if (this.#pause?.requestId === requestId && this.#pause.revision === revision)
      this.#pause.phase = "uncertain";
  }
  resume(requestId: string, revision: number): void {
    this.current();
    if (
      this.#stopped ||
      this.#active ||
      this.#pause?.requestId !== requestId ||
      this.#pause.revision !== revision ||
      this.#pause.phase !== "paused"
    )
      throw new Error("pause owner not resumable");
    this.#pause = undefined;
  }
  stop(): void {
    this.#stopped = true;
    for (const cancel of [...this.#queued]) cancel(new PausedStepError());
    for (const wake of [...this.#wake]) wake();
  }
}
