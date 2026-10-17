import { type StdioOptions, spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  type BrowserProcessName,
  type BrowserProcessSpec,
  type BrowserRuntimeConfig,
  browserProcessSpecs,
} from "./runtime-config.ts";

export const BROWSER_PROCESS_START_MS = 10_000;
export const BROWSER_PROCESS_TERM_MS = 1000;
export const BROWSER_PROCESS_STOP_MS = 5000;

export class BrowserProcessError extends Error {
  constructor(readonly reason: "closed" | "start" | "shutdown" | "busy") {
    super(`Browser runtime unavailable: ${reason}`);
  }
}

export interface BrowserProcessChannels {
  readonly input?: Writable;
  readonly output?: Readable;
}

export interface BrowserProcessHandle {
  readonly started: Promise<void>;
  readonly closed: boolean;
  readonly channels: BrowserProcessChannels;
  signal(signal: "SIGTERM" | "SIGKILL"): void;
  exists(): boolean;
}

export type BrowserProcessDriver = (
  spec: BrowserProcessSpec,
  onFailure: () => void,
) => BrowserProcessHandle;

export const nodeBrowserProcessDriver: BrowserProcessDriver = (spec, onFailure) => {
  const stdio: StdioOptions =
    spec.channel === "cdp"
      ? ["ignore", "ignore", "ignore", "pipe", "pipe"]
      : spec.channel === "stdio"
        ? ["pipe", "pipe", "ignore"]
        : "ignore";
  const child = spawn(spec.executable, [...spec.args], {
    cwd: "/",
    env: { ...spec.env },
    detached: true,
    shell: false,
    stdio,
  });
  const startup = Promise.withResolvers<void>();
  let closed = false;
  let retired = false;
  child.once("spawn", () => {
    if (!Number.isSafeInteger(child.pid) || (child.pid ?? 0) <= 1) {
      startup.reject(new BrowserProcessError("start"));
      onFailure();
      return;
    }
    startup.resolve();
  });
  child.on("error", () => {
    startup.reject(new BrowserProcessError("start"));
    onFailure();
  });
  child.once("exit", () => onFailure());
  child.once("close", () => {
    closed = true;
    onFailure();
  });
  const input = spec.channel === "cdp" ? child.stdio[3] : child.stdin;
  const output = spec.channel === "cdp" ? child.stdio[4] : child.stdout;
  const channels = Object.freeze({
    ...(input instanceof Writable ? { input } : {}),
    ...(output instanceof Readable ? { output } : {}),
  });
  channels.input?.on("error", onFailure);
  channels.input?.once("finish", onFailure);
  channels.input?.once("close", onFailure);
  channels.output?.on("error", onFailure);
  channels.output?.once("end", onFailure);
  channels.output?.once("close", onFailure);
  const signalGroup = (signal: NodeJS.Signals | 0): boolean => {
    if (retired) return false;
    const processId = child.pid;
    if (processId === undefined) return !closed;
    if (!Number.isSafeInteger(processId) || processId <= 1)
      throw new BrowserProcessError("shutdown");
    try {
      process.kill(-processId, signal);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        retired = true;
        return false;
      }
      throw new BrowserProcessError("shutdown");
    }
  };
  return {
    started: startup.promise,
    get closed() {
      return closed;
    },
    channels,
    signal: (signal) => {
      signalGroup(signal);
    },
    exists: () => signalGroup(0),
  };
};

export interface BrowserProcessesOptions {
  fence(): void;
  drain(): Promise<void>;
  gracefulChromiumClose?(): boolean;
  // Runs after successful physical group reaping, independently of the overall owner drain.
  writersExited?(): void;
  driver?: BrowserProcessDriver;
}

export class BrowserProcesses {
  readonly #specs: Readonly<Record<BrowserProcessName, BrowserProcessSpec>>;
  readonly #handles = new Map<BrowserProcessName, BrowserProcessHandle | undefined>();
  readonly #abort = new AbortController();
  readonly #driver: BrowserProcessDriver;
  readonly #owners = new Map<BrowserProcessName, { retiring: boolean }>();
  #closed = false;
  #stopping?: Promise<void>;

  constructor(
    config: BrowserRuntimeConfig,
    private readonly options: BrowserProcessesOptions,
  ) {
    this.#specs = browserProcessSpecs(config);
    this.#driver = options.driver ?? nodeBrowserProcessDriver;
  }

  get closed(): boolean {
    return this.#closed;
  }

  async start(name: BrowserProcessName): Promise<BrowserProcessChannels> {
    return this.#start(name, this.#specs[name]);
  }

  async #start(
    name: BrowserProcessName,
    spec: BrowserProcessSpec,
  ): Promise<BrowserProcessChannels> {
    if (this.#closed) throw new BrowserProcessError("closed");
    if (!Object.hasOwn(this.#specs, name) || this.#handles.has(name))
      throw new BrowserProcessError("start");
    this.#handles.set(name, undefined);
    const owner = { retiring: false };
    this.#owners.set(name, owner);
    try {
      const handle = this.#driver(spec, () => {
        // A late pipe/exit callback from the retired browser cannot kill its successor.
        if (!owner.retiring && this.#owners.get(name) === owner) void this.stop().catch(() => {});
      });
      this.#handles.set(name, handle);
      void handle.started.catch(() => {});
      if (this.#closed) {
        handle.signal("SIGKILL");
        throw new BrowserProcessError("closed");
      }
      await this.#startup(handle.started);
      if (this.#closed || handle.closed || !handle.exists())
        throw new BrowserProcessError("closed");
      return handle.channels;
    } catch {
      if (this.#handles.get(name) === undefined) this.#handles.delete(name);
      void this.stop().catch(() => {});
      throw new BrowserProcessError("start");
    }
  }

  async replaceChromium(
    spec: BrowserProcessSpec,
    retire: () => boolean | Promise<boolean>,
    keepOpen = false,
  ): Promise<BrowserProcessChannels> {
    const owner = this.#owners.get("chromium");
    const handle = this.#handles.get("chromium");
    if (this.#closed || !owner || !handle || owner.retiring)
      throw new BrowserProcessError("closed");
    owner.retiring = true;
    try {
      const graceful = await retire();
      if (!graceful) handle.signal("SIGTERM");
      const start = performance.now();
      while (!handle.closed || handle.exists()) {
        if (this.#closed) throw new BrowserProcessError("closed");
        // Never reuse a locked profile or report success after an unconfirmed exit.
        if (performance.now() - start >= BROWSER_PROCESS_STOP_MS) {
          // A user's beforeunload/download dialog may refuse Quit. Keep their
          // disconnected browser available instead of forcing away that dialog.
          if (keepOpen && !handle.closed && handle.exists()) throw new BrowserProcessError("busy");
          throw new BrowserProcessError("shutdown");
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      }
      if (this.#closed) throw new BrowserProcessError("closed");
      this.#handles.delete("chromium");
      return await this.#start("chromium", spec);
    } catch (error) {
      if (error instanceof BrowserProcessError && error.reason === "busy" && !this.#closed) {
        owner.retiring = false;
        throw error;
      }
      void this.stop().catch(() => {});
      throw new BrowserProcessError("shutdown");
    }
  }

  stop(): Promise<void> {
    if (this.#stopping) return this.#stopping;
    const completion = Promise.withResolvers<void>();
    this.#stopping = completion.promise;
    this.#closed = true;
    let failed = false;
    try {
      this.options.fence();
    } catch {
      failed = true;
    }
    this.#abort.abort(new BrowserProcessError("closed"));
    const termination = this.#terminate();
    let drain: Promise<void>;
    try {
      drain = this.options.drain();
    } catch {
      drain = Promise.reject(new BrowserProcessError("shutdown"));
    }
    const deadline = setTimeout(
      () => completion.reject(new BrowserProcessError("shutdown")),
      BROWSER_PROCESS_STOP_MS,
    );
    void Promise.all([termination, drain]).then(
      () => {
        clearTimeout(deadline);
        if (failed) completion.reject(new BrowserProcessError("shutdown"));
        else completion.resolve();
      },
      () => {
        clearTimeout(deadline);
        completion.reject(new BrowserProcessError("shutdown"));
      },
    );
    return completion.promise;
  }

  async #terminate(): Promise<void> {
    let failed = false;
    try {
      if (this.options.gracefulChromiumClose?.()) {
        const chromium = this.#handles.get("chromium");
        const start = performance.now();
        while (
          chromium &&
          (!chromium.closed || chromium.exists()) &&
          performance.now() - start < BROWSER_PROCESS_TERM_MS
        ) {
          await new Promise<void>((resolve) => setTimeout(resolve, 20));
        }
      }
    } catch {
      failed = true;
    }
    for (const handle of this.#handles.values()) {
      try {
        handle?.signal("SIGTERM");
      } catch {
        failed = true;
      }
    }
    await this.#reap();
    this.options.writersExited?.();
    if (failed) throw new BrowserProcessError("shutdown");
  }

  #startup(started: Promise<void>): Promise<void> {
    const completion = Promise.withResolvers<void>();
    const cancel = () => completion.reject(new BrowserProcessError("closed"));
    const deadline = setTimeout(
      () => completion.reject(new BrowserProcessError("start")),
      BROWSER_PROCESS_START_MS,
    );
    this.#abort.signal.addEventListener("abort", cancel, { once: true });
    if (this.#abort.signal.aborted) cancel();
    void started.then(completion.resolve, () =>
      completion.reject(new BrowserProcessError("start")),
    );
    return completion.promise.finally(() => {
      clearTimeout(deadline);
      this.#abort.signal.removeEventListener("abort", cancel);
    });
  }

  async #reap(): Promise<void> {
    const start = performance.now();
    let forced = false;
    let failed = false;
    while (performance.now() - start < BROWSER_PROCESS_STOP_MS) {
      let remaining = false;
      for (const handle of this.#handles.values()) {
        if (!handle) {
          remaining = true;
          continue;
        }
        try {
          if (handle.exists() || !handle.closed) remaining = true;
        } catch {
          remaining = true;
          failed = true;
        }
      }
      if (!remaining) {
        if (failed) throw new BrowserProcessError("shutdown");
        return;
      }
      if (!forced && performance.now() - start >= BROWSER_PROCESS_TERM_MS) {
        forced = true;
        for (const handle of this.#handles.values()) {
          try {
            handle?.signal("SIGKILL");
          } catch {
            failed = true;
          }
        }
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
    throw new BrowserProcessError("shutdown");
  }
}
