import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

declare const __LOCALDOT_PACKAGED__: boolean | undefined;

const PACKAGED = typeof __LOCALDOT_PACKAGED__ === "boolean" && __LOCALDOT_PACKAGED__;
// From source the reader loads the protocol's TypeScript, which has more in it than types.
const READER = PACKAGED
  ? { entry: new URL("./quiet-page-worker.mjs", import.meta.url), flags: [] }
  : {
      entry: new URL("./quiet-page-worker.ts", import.meta.url),
      flags: ["--experimental-transform-types", "--no-warnings"],
    };
const KEPT_CHARS = 16 * 1024 * 1024;
const KEPT_PAGES = 64;
// A page of the largest size served, written out again with every character escaped.
const OUTPUT_BYTES = 48 * 1024 * 1024;

export interface QuieterLimits {
  // Whole seconds of CPU a reading may spend, its collector's threads included. The largest page
  // served, a dense 5 MB table, takes about 3.
  cpu: number;
  // How long a reading may take, however busy the Mac is.
  time: number;
  // The reader's heap, in MB; the dense 5 MB table takes about 250.
  heap: number;
  running: number;
  waiting: number;
}
export type Quieted =
  | { body: string }
  | { refused: "not shown" | "too complex" | "busy" | "stopped" };
interface Read {
  quieted: Quieted;
  // Whether the next opening of the same page would come to the same.
  lasting: boolean;
}
export type LaunchReader = (limits: QuieterLimits) => ChildProcess;

const NOT_SHOWN: Quieted = { refused: "not shown" };
const TOO_COMPLEX: Quieted = { refused: "too complex" };
const BUSY: Quieted = { refused: "busy" };
const STOPPED: Quieted = { refused: "stopped" };

const size = (quieted: Quieted) => ("body" in quieted ? quieted.body.length : 0);

// The CPU limit is the kernel's, so a reading that spends it was too much work however busy the
// Mac was, and one cut short by the clock alone was only slowed down. Only the soft limit is set:
// at a hard one as well, Linux ends the reader with SIGKILL instead of SIGXCPU.
export function cpuLimited(cpu: number, file: string, args: readonly string[]): string[] {
  return ["-c", 'ulimit -S -t "$1" && shift && exec "$0" "$@"', file, String(cpu), ...args];
}

export const launchReader: LaunchReader = (limits) =>
  spawn(
    "/bin/sh",
    cpuLimited(limits.cpu, process.execPath, [
      ...READER.flags,
      `--max-old-space-size=${limits.heap}`,
      "--max-semi-space-size=16",
      fileURLToPath(READER.entry),
    ]),
    { env: {}, stdio: ["pipe", "pipe", "ignore"], windowsHide: true },
  );

// Pages are quieted in a process each, as parse5 has paths that grow with the square of a page's
// size without nesting deep or building much, and run for minutes on a few megabytes; one past its
// heap aborts only itself. A reader past its CPU or time is killed and the page refused; so is one
// whose request is gone. What a page came to is kept by its content, so a HEAD and each later
// opening never read it again, unless it came to nothing for a passing reason.
export class PageQuieter {
  readonly #limits: QuieterLimits;
  readonly #launch: LaunchReader;
  #running = 0;
  readonly #waiting = new Set<() => void>();
  readonly #kept = new Map<string, Quieted>();
  #keptChars = 0;

  constructor(limits: Partial<QuieterLimits> = {}, launch: LaunchReader = launchReader) {
    this.#limits = { cpu: 5, time: 10_000, heap: 384, running: 2, waiting: 8, ...limits };
    this.#launch = launch;
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
    if (!(await this.#turn(signal))) return signal.aborted ? STOPPED : BUSY;
    try {
      // The request may have gone while this waited for its turn; its abort will not come again.
      if (signal.aborted) return STOPPED;
      const read = await this.#read(html, signal);
      if (read.lasting) this.#keep(key, read.quieted);
      return read.quieted;
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

  // Settles only once the reader has exited, or could not start.
  #read(html: string, signal: AbortSignal): Promise<Read> {
    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = this.#launch(this.#limits);
      } catch {
        resolve({ quieted: BUSY, lasting: false });
        return;
      }
      const output: Buffer[] = [];
      let bytes = 0;
      let ended: Read | undefined;
      let settled = false;
      const end = (why: Read) => {
        ended ??= why;
        child.kill("SIGKILL");
      };
      const late = setTimeout(() => end({ quieted: BUSY, lasting: false }), this.#limits.time);
      const stop = () => end({ quieted: STOPPED, lasting: false });
      const settle = (read: Read) => {
        if (settled) return;
        settled = true;
        clearTimeout(late);
        signal.removeEventListener("abort", stop);
        resolve(read);
      };
      signal.addEventListener("abort", stop, { once: true });
      child.stdout?.on("data", (part: Buffer) => {
        bytes += part.byteLength;
        if (bytes > OUTPUT_BYTES) end({ quieted: TOO_COMPLEX, lasting: false });
        else output.push(part);
      });
      // A reader that ends early leaves the rest of the page unwritten.
      child.stdin?.on("error", () => {});
      child.once("error", () => {
        if (child.pid === undefined) settle({ quieted: BUSY, lasting: false });
        else end({ quieted: BUSY, lasting: false });
      });
      child.once("close", (code, cause) => {
        if (ended) return settle(ended);
        if (cause === "SIGXCPU") return settle({ quieted: TOO_COMPLEX, lasting: true });
        settle(code === 0 ? answer(output) : { quieted: TOO_COMPLEX, lasting: false });
      });
      child.stdin?.end(html, "utf8");
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

function answer(output: Buffer[]): Read {
  try {
    const said: unknown = JSON.parse(Buffer.concat(output).toString("utf8"));
    if (typeof said === "string") return { quieted: { body: said }, lasting: true };
    if (said === null) return { quieted: NOT_SHOWN, lasting: true };
  } catch {}
  return { quieted: TOO_COMPLEX, lasting: false };
}
