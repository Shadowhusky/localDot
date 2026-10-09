import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";

declare const __LOCALDOT_PACKAGED__: boolean | undefined;

const PACKAGED = typeof __LOCALDOT_PACKAGED__ === "boolean" && __LOCALDOT_PACKAGED__;
// From source the worker loads the protocol's TypeScript, which has more in it than types.
const WORKER = PACKAGED
  ? { entry: new URL("./quiet-page-worker.mjs", import.meta.url), execArgv: [] }
  : {
      entry: new URL("./quiet-page-worker.ts", import.meta.url),
      execArgv: ["--experimental-transform-types", "--no-warnings"],
    };
// The largest page that may be served, a dense 5 MB table, takes about a second and 250 MB.
const HEAP = { maxOldGenerationSizeMb: 384, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 };
const KEPT_CHARS = 16 * 1024 * 1024;
const KEPT_PAGES = 64;

export interface QuieterLimits {
  time: number;
  running: number;
  waiting: number;
}
export type Quieted =
  | { body: string }
  | { refused: "not shown" | "too complex" | "busy" | "stopped" };

const NOT_SHOWN: Quieted = { refused: "not shown" };
const TOO_COMPLEX: Quieted = { refused: "too complex" };
const STOPPED: Quieted = { refused: "stopped" };

const size = (quieted: Quieted) => ("body" in quieted ? quieted.body.length : 0);

// Pages are quieted in a worker each, as parse5 has paths that grow with the square of a page's
// size without nesting deep or building much, and run for minutes on a few megabytes. A worker
// past its time or heap is ended and the page refused; so is one whose request is gone. What a
// page came to is kept by its content, so a HEAD and each later opening never read it again.
export class PageQuieter {
  readonly #limits: QuieterLimits;
  #running = 0;
  readonly #waiting = new Set<() => void>();
  readonly #kept = new Map<string, Quieted>();
  #keptChars = 0;

  constructor(limits: Partial<QuieterLimits> = {}) {
    this.#limits = { time: 2000, running: 2, waiting: 8, ...limits };
  }

  get running(): number {
    return this.#running;
  }

  async page(html: string, signal: AbortSignal): Promise<Quieted> {
    const key = createHash("sha256").update(html).digest("base64");
    const kept = this.#kept.get(key);
    if (kept) {
      this.#kept.delete(key);
      this.#kept.set(key, kept);
      return kept;
    }
    if (!(await this.#turn(signal))) return signal.aborted ? STOPPED : { refused: "busy" };
    try {
      // The request may have gone while this waited for its turn; its abort will not come again.
      const quieted = signal.aborted ? STOPPED : await this.#read(html, signal);
      if (quieted !== STOPPED) this.#keep(key, quieted);
      return quieted;
    } finally {
      this.#running--;
      const [next] = this.#waiting;
      if (next) {
        this.#waiting.delete(next);
        next();
      }
    }
  }

  #turn(signal: AbortSignal): boolean | Promise<boolean> {
    if (signal.aborted) return false;
    if (this.#running < this.#limits.running) {
      this.#running++;
      return true;
    }
    if (this.#waiting.size >= this.#limits.waiting) return false;
    return new Promise((resolve) => {
      const go = () => {
        signal.removeEventListener("abort", leave);
        this.#running++;
        resolve(true);
      };
      const leave = () => {
        this.#waiting.delete(go);
        resolve(false);
      };
      this.#waiting.add(go);
      signal.addEventListener("abort", leave, { once: true });
    });
  }

  // Settles only once the worker has exited.
  #read(html: string, signal: AbortSignal): Promise<Quieted> {
    return new Promise((resolve) => {
      const worker = new Worker(WORKER.entry, {
        workerData: html,
        execArgv: WORKER.execArgv,
        env: {},
        resourceLimits: HEAP,
      });
      let answer: Quieted | undefined;
      let ended: Quieted | undefined;
      const end = (why: Quieted) => {
        ended ??= why;
        void worker.terminate().catch(() => {});
      };
      const late = setTimeout(() => end(TOO_COMPLEX), this.#limits.time);
      const stop = () => end(STOPPED);
      signal.addEventListener("abort", stop, { once: true });
      worker.on("message", (message: unknown) => {
        if (!ended) answer = typeof message === "string" ? { body: message } : NOT_SHOWN;
      });
      worker.on("error", () => end(TOO_COMPLEX));
      worker.once("exit", () => {
        clearTimeout(late);
        signal.removeEventListener("abort", stop);
        resolve(answer ?? ended ?? TOO_COMPLEX);
      });
    });
  }

  #keep(key: string, quieted: Quieted): void {
    const had = this.#kept.get(key);
    if (had) this.#keptChars -= size(had);
    this.#kept.delete(key);
    this.#kept.set(key, quieted);
    this.#keptChars += size(quieted);
    for (const [old, was] of this.#kept) {
      if (this.#kept.size <= KEPT_PAGES && this.#keptChars <= KEPT_CHARS) break;
      this.#kept.delete(old);
      this.#keptChars -= size(was);
    }
  }
}
