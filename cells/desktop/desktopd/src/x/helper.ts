import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";

export interface XEvent {
  ev: "press" | "release";
  kind: "button" | "key";
  detail: number;
  mono: number;
}

export interface XHelper {
  call<T extends object = Record<string, unknown>>(
    cmd: string,
    args?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<T>;
  onEvent(listener: (event: XEvent) => void): () => void;
  readonly alive: boolean;
  close(): Promise<void>;
}

export interface XHelperOptions {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  readyTimeoutMs?: number;
}

export class XHelperError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XHelperError";
  }
}

interface Pending {
  cmd: string;
  resolve(value: object): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
}

const DEFAULT_CALL_TIMEOUT_MS = 5000;

export function startXHelper(opts: XHelperOptions): Promise<XHelper> {
  const child: ChildProcess = spawn(opts.command, opts.args, {
    env: opts.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map<number, Pending>();
  const listeners = new Set<(event: XEvent) => void>();
  let seq = 0;
  let alive = true;
  let readyResolve: (() => void) | undefined;
  let readyReject: ((err: Error) => void) | undefined;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  ready.catch(() => {});

  const failAll = (why: string) => {
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new XHelperError(`xhelper ${p.cmd}: ${why}`));
      pending.delete(id);
    }
  };

  child.stderr?.on("data", (d: Buffer) => console.error(`xhelper: ${String(d).trimEnd()}`));
  createInterface({ input: child.stdout as NodeJS.ReadableStream }).on("line", (line) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      console.error(`xhelper: unreadable line ${line}`);
      return;
    }
    if (typeof msg.ev === "string") {
      if (msg.ev === "ready") readyResolve?.();
      else if (msg.ev === "fatal") {
        alive = false;
        readyReject?.(new XHelperError(String(msg.error)));
        failAll(String(msg.error));
        // A helper whose listener died still holds its X connections: end it, and the next start
        // gets a fresh one.
        child.kill();
      } else for (const l of listeners) l(msg as unknown as XEvent);
      return;
    }
    const p = pending.get(Number(msg.id));
    if (!p) return;
    pending.delete(Number(msg.id));
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg);
    else p.reject(new XHelperError(`xhelper ${p.cmd}: ${String(msg.error)}`));
  });
  child.on("exit", (code, signal) => {
    alive = false;
    const why = `exited with ${code ?? signal}`;
    readyReject?.(new XHelperError(`xhelper ${why} before ready`));
    failAll(why);
  });
  child.on("error", (err) => {
    alive = false;
    readyReject?.(new XHelperError(`xhelper failed to start: ${err.message}`));
    failAll(err.message);
  });

  const helper: XHelper = {
    get alive() {
      return alive;
    },
    call<T extends object>(
      cmd: string,
      args: Record<string, unknown> = {},
      timeoutMs = DEFAULT_CALL_TIMEOUT_MS,
    ): Promise<T> {
      if (!alive) return Promise.reject(new XHelperError(`xhelper ${cmd}: helper is not running`));
      const id = ++seq;
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new XHelperError(`xhelper ${cmd}: timed out after ${timeoutMs} ms`));
        }, timeoutMs);
        pending.set(id, { cmd, resolve: resolve as (v: object) => void, reject, timer });
        child.stdin?.write(`${JSON.stringify({ ...args, id, cmd })}\n`);
      });
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      if (!alive) return;
      try {
        await helper.call("quit", {}, 500);
      } catch {}
      child.kill();
      alive = false;
    },
  };

  const readyTimeout = new Promise<never>((_, reject) =>
    setTimeout(
      () =>
        reject(
          new XHelperError(`xhelper did not say ready within ${opts.readyTimeoutMs ?? 5000} ms`),
        ),
      opts.readyTimeoutMs ?? 5000,
    ).unref(),
  );
  return Promise.race([ready, readyTimeout]).then(
    () => helper,
    (err) => {
      child.kill();
      throw err;
    },
  );
}
