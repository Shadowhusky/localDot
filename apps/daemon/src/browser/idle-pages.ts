// A page nobody has used for this long is frozen. The stage lets the browser's stream go a second
// after the desktop covers it, and a user who looks away or answers dot within a minute shouldn't
// see pages freeze and wake in turn; a page still loading after a task's last action has mostly
// settled by then; and a minute of the worst page seen (four cores) is little beside the hours it
// was left running.
export const IDLE_PAGES_GRACE_MS = 60_000;
// How often the browsers are looked at again, and a freeze asserted again for pages woken since.
export const IDLE_PAGES_SWEEP_MS = 10_000;
const RETRY_MS = 1000;

export interface IdleTask {
  readonly id: string;
  // At work, or waiting for its turn on the computer.
  readonly busy: boolean;
  // The user has taken the computer from it.
  readonly controlled: boolean;
}

export type IdleRequest = { frozen: false } | { frozen: true; keep: readonly string[] };

export interface BrowserIdlePagesDeps {
  // The computers whose web browser is running.
  browsers(): readonly { readonly parentCellId: string; readonly instance: string }[];
  viewers(parentCellId: string): number;
  tasks(parentCellId: string): readonly IdleTask[];
  send(parentCellId: string, instance: string, request: IdleRequest): Promise<void>;
  now?(): number;
}

interface Computer {
  readonly instance: string;
  watched: boolean;
  // Until when someone watched or held the computer; while they do, the latest look.
  watchedAt: number;
  busy: Set<string>;
  // Until when each task was at work.
  busyAt: Map<string, number>;
  // What browserd last confirmed, and how many requests in a row it didn't.
  sent?: string;
  failures: number;
  sending: boolean;
  again: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

// Freezes the pages of a computer's web browser that nobody uses: no task is at work in their
// window or waiting for its turn, the user doesn't hold the computer, and no one watches the
// browser's stream, each for a minute. A viewer or the user's control thaws every page at once.
// browserd wakes a page itself before anything reads or drives it, so a late thaw costs only time.
export class BrowserIdlePages {
  readonly #computers = new Map<string, Computer>();
  readonly #pending = new Set<string | undefined>();
  readonly #sweep: ReturnType<typeof setInterval>;
  #disposed = false;

  constructor(private readonly deps: BrowserIdlePagesDeps) {
    this.#sweep = setInterval(
      () => this.#safely(() => this.#considerAll(true)),
      IDLE_PAGES_SWEEP_MS,
    );
    this.#sweep.unref?.();
    this.changed();
  }

  // Something one computer's freeze depends on changed; without one, any computer's. Considered
  // after the caller's own work, so a status read that reports a change can't reenter.
  changed(parentCellId?: string): void {
    if (this.#disposed) return;
    const first = this.#pending.size === 0;
    this.#pending.add(parentCellId);
    if (!first) return;
    queueMicrotask(() => {
      const pending = [...this.#pending];
      this.#pending.clear();
      this.#safely(() => {
        if (pending.includes(undefined)) this.#considerAll(false);
        else for (const parent of pending) if (parent) this.#considerOne(parent);
      });
    });
  }

  dispose(): void {
    this.#disposed = true;
    clearInterval(this.#sweep);
    for (const computer of this.#computers.values()) clearTimeout(computer.timer);
    this.#computers.clear();
  }

  #considerAll(sweep: boolean): void {
    if (this.#disposed) return;
    const browsers = this.deps.browsers();
    for (const [parent, computer] of this.#computers)
      if (!browsers.some((browser) => browser.parentCellId === parent)) {
        clearTimeout(computer.timer);
        this.#computers.delete(parent);
      }
    for (const { parentCellId, instance } of browsers)
      this.#consider(parentCellId, instance, sweep);
  }

  #considerOne(parent: string): void {
    if (this.#disposed) return;
    const browser = this.deps.browsers().find((candidate) => candidate.parentCellId === parent);
    if (browser) this.#consider(parent, browser.instance, false);
    else {
      clearTimeout(this.#computers.get(parent)?.timer);
      this.#computers.delete(parent);
    }
  }

  #consider(parent: string, instance: string, sweep: boolean): void {
    const now = this.#now();
    let computer = this.#computers.get(parent);
    if (computer?.instance !== instance) {
      clearTimeout(computer?.timer);
      computer = {
        instance,
        watched: false,
        watchedAt: now,
        busy: new Set(),
        busyAt: new Map(),
        failures: 0,
        sending: false,
        again: false,
      };
      this.#computers.set(parent, computer);
    }
    const tasks = this.deps.tasks(parent);
    const watched = this.deps.viewers(parent) > 0 || tasks.some((task) => task.controlled);
    // A watch or a task's work that ended since the last look ended now, as far as is known.
    if (watched || computer.watched) computer.watchedAt = now;
    computer.watched = watched;
    const busy = new Set(tasks.filter((task) => task.busy).map((task) => task.id));
    for (const id of new Set([...busy, ...computer.busy])) computer.busyAt.set(id, now);
    computer.busy = busy;
    for (const [id, at] of computer.busyAt)
      if (now - at >= IDLE_PAGES_GRACE_MS) computer.busyAt.delete(id);
    const request: IdleRequest =
      now - computer.watchedAt < IDLE_PAGES_GRACE_MS
        ? { frozen: false }
        : { frozen: true, keep: [...computer.busyAt.keys()].sort() };
    const key = JSON.stringify(request);
    if (key !== computer.sent || (sweep && request.frozen)) this.#send(parent, computer, request);
    this.#schedule(parent, computer, now);
  }

  #send(parent: string, computer: Computer, request: IdleRequest): void {
    if (computer.sending) {
      computer.again = true;
      return;
    }
    computer.sending = true;
    const key = JSON.stringify(request);
    void this.deps
      .send(parent, computer.instance, request)
      .then(
        () => {
          computer.sent = key;
          computer.failures = 0;
        },
        () => {
          computer.sent = undefined;
          computer.failures += 1;
          if (this.#computers.get(parent) === computer)
            this.#schedule(parent, computer, this.#now());
        },
      )
      .finally(() => {
        computer.sending = false;
        if (computer.again && this.#computers.get(parent) === computer) {
          computer.again = false;
          this.changed(parent);
        }
      });
  }

  // The next moment a page may freeze, when the last watch or a task's last work is a grace old,
  // and a request browserd didn't confirm is sent again.
  #schedule(parent: string, computer: Computer, now: number): void {
    clearTimeout(computer.timer);
    computer.timer = undefined;
    const waits = computer.watched
      ? []
      : [computer.watchedAt, ...computer.busyAt.values()]
          .map((at) => at + IDLE_PAGES_GRACE_MS - now)
          .filter((ms) => ms > 0);
    if (computer.failures)
      waits.push(Math.min(RETRY_MS * 2 ** (computer.failures - 1), IDLE_PAGES_SWEEP_MS));
    if (!waits.length) return;
    computer.timer = setTimeout(() => this.changed(parent), Math.min(...waits) + 1);
    computer.timer.unref?.();
  }

  // A computer or task read mid-change is read again on the next sweep; pages stay as they are.
  #safely(work: () => void): void {
    try {
      work();
    } catch {}
  }

  #now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}
