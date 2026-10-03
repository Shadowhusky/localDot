import type { Readable, Writable } from "node:stream";
import { CLIENT_METHODS, type ClientMethod } from "./protocol.ts";

export const RPC_MAX_LINE_BYTES = 8 * 1024 * 1024;
const MAX_PENDING = 64;
const methods = new Set<string>(CLIENT_METHODS);
const decoder = new TextDecoder("utf-8", { fatal: true });
const object = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const validId = (v: unknown): v is number | string =>
  (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) ||
  (typeof v === "string" && v.length > 0 && v.length <= 1024);
const safeCode = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);
const passivePipes = new WeakSet<Readable | Writable>();
const consumeLateError = () => {};
// Retired RPCs leave a single stateless error sink on each owned pipe. The process owner drains
// and closes those pipes; a delayed EPIPE must not become an uncaught EventEmitter error.
function ownPipeErrors(pipe: Readable | Writable): void {
  if (!passivePipes.has(pipe)) {
    passivePipes.add(pipe);
    pipe.on("error", consumeLateError);
  }
}
export class RpcError extends Error {
  readonly method: ClientMethod | "rpc";
  constructor(
    method: string,
    readonly code: number,
  ) {
    const safeMethod = methods.has(method) ? (method as ClientMethod) : "rpc";
    super(`${safeMethod}: Codex protocol request could not be completed.`);
    this.method = safeMethod;
    this.name = "RpcError";
  }
}
export type ServerRequestReply = (
  | { result: unknown; error?: never }
  | { error: { code: number; message?: string }; result?: never }
) & { current(): boolean };
export interface RpcCallbackContext {
  readonly signal: AbortSignal;
}
export interface RpcRequestOptions<T> {
  signal: AbortSignal;
  timeoutMs?: number;
  validateResult(value: unknown): T;
}
export interface AppServerRpcOptions {
  input: Readable;
  output: Writable;
  signal: AbortSignal;
  onServerRequest(
    method: string,
    params: unknown,
    context: RpcCallbackContext,
  ): ServerRequestReply | Promise<ServerRequestReply>;
  onNotification(
    method: string,
    params: unknown,
    context: RpcCallbackContext,
  ): void | Promise<void>;
  onFailure(error: RpcError): void | Promise<void>;
  requestTimeoutMs?: number;
}
interface Pending {
  method: ClientMethod;
  signal: AbortSignal;
  abort(): void;
  timer: NodeJS.Timeout;
  validate(value: unknown): unknown;
  resolve(value: unknown): void;
  reject(error: RpcError): void;
}

// Each instance belongs to one registered process/auth generation. The owner passes its signal
// before any listener or await. onFailure must synchronously fence that owner and request Stop.
export class AppServerRpc {
  #next = 1;
  #closed = false;
  #failure: RpcError | undefined;
  #buffer: Buffer = Buffer.alloc(0);
  #bytes = 0;
  #callbacks = 0;
  readonly #serverIds = new Set<number | string>();
  readonly #pending = new Map<number, Pending>();
  readonly #controller = new AbortController();
  readonly #context: RpcCallbackContext;
  readonly #ownerAbort = () => this.close();
  readonly #streamError = () => this.#fail();
  readonly #streamClose = () => this.#fail();
  readonly #end = () => this.#fail();
  readonly #data = (chunk: unknown) => this.#consume(chunk);
  constructor(private readonly opts: AppServerRpcOptions) {
    this.#context = Object.freeze({ signal: this.#controller.signal });
    if (!(opts.signal instanceof AbortSignal) || opts.signal.aborted) {
      this.#closed = true;
      this.#controller.abort();
      return;
    }
    opts.signal.addEventListener("abort", this.#ownerAbort, { once: true });
    ownPipeErrors(opts.input);
    ownPipeErrors(opts.output);
    opts.input.on("error", this.#streamError);
    opts.output.on("error", this.#streamError);
    opts.input.on("close", this.#streamClose);
    opts.output.on("close", this.#streamClose);
    opts.input.on("end", this.#end);
    opts.input.on("data", this.#data);
    if (
      opts.input.destroyed ||
      opts.input.readableEnded ||
      opts.output.destroyed ||
      opts.output.writableEnded
    )
      this.#fail();
  }
  request<T>(method: ClientMethod, params: unknown, options: RpcRequestOptions<T>): Promise<T> {
    if (!methods.has(method)) return Promise.reject(new RpcError("rpc", -32601));
    if (!this.#live()) return Promise.reject(new RpcError(method, -32000));
    const timeout = options?.timeoutMs ?? this.opts.requestTimeoutMs ?? 120_000;
    if (!(options?.signal instanceof AbortSignal) || options.signal.aborted)
      return Promise.reject(new RpcError(method, -32002));
    if (
      typeof options.validateResult !== "function" ||
      !Number.isSafeInteger(timeout) ||
      timeout <= 0 ||
      timeout > 120_000 ||
      this.#pending.size >= MAX_PENDING ||
      this.#next >= Number.MAX_SAFE_INTEGER
    )
      return Promise.reject(new RpcError(method, -32600));
    const id = this.#next;
    let line: string;
    try {
      line = this.#serialize({ id, method, params });
    } catch {
      return Promise.reject(new RpcError(method, -32600));
    }
    if (!this.#live() || options.signal.aborted)
      return Promise.reject(new RpcError(method, -32002));
    this.#next++;
    return new Promise<T>((resolve, reject) => {
      const abort = () => this.#reject(id, new RpcError(method, -32002));
      const timer = setTimeout(() => this.#reject(id, new RpcError(method, -32001)), timeout);
      this.#pending.set(id, {
        method,
        signal: options.signal,
        abort,
        timer,
        validate: options.validateResult,
        resolve: (v) => resolve(v as T),
        reject,
      });
      options.signal.addEventListener("abort", abort, { once: true });
      // Ownership is installed before a pipe write can synchronously deliver a response/error.
      this.#write(line);
    });
  }
  notify(method: "initialized", params: Record<string, never>): void {
    if (method !== "initialized" || !object(params) || Object.keys(params).length !== 0)
      throw new RpcError("rpc", -32601);
    if (!this.#live()) throw new RpcError("rpc", -32000);
    let line: string;
    try {
      line = this.#serialize({ method, params });
    } catch {
      throw new RpcError("rpc", -32600);
    }
    if (!this.#live()) throw new RpcError("rpc", -32000);
    this.#write(line);
  }
  close(): void {
    this.#retire();
  }
  #live(): boolean {
    return !this.#closed && !this.opts.signal.aborted;
  }
  #take(id: number): Pending | undefined {
    const p = this.#pending.get(id);
    if (p) {
      this.#pending.delete(id);
      clearTimeout(p.timer);
      p.signal.removeEventListener("abort", p.abort);
    }
    return p;
  }
  #reject(id: number, error: RpcError): void {
    this.#take(id)?.reject(error);
  }
  #retire(): void {
    if (this.#closed) return;
    this.#closed = true;
    // Invalidate callbacks and admission before rejecting waiters or tearing down listeners.
    this.#controller.abort();
    this.opts.signal.removeEventListener("abort", this.#ownerAbort);
    this.opts.input
      .off("data", this.#data)
      .off("end", this.#end)
      .off("close", this.#streamClose)
      .off("error", this.#streamError);
    this.opts.output.off("close", this.#streamClose).off("error", this.#streamError);
    this.#buffer = Buffer.alloc(0);
    this.#bytes = 0;
    this.#serverIds.clear();
    for (const [id, p] of this.#pending) this.#reject(id, new RpcError(p.method, -32000));
  }
  #fail(): void {
    if (this.#closed || this.#failure) return;
    this.#failure = new RpcError("rpc", -32000);
    this.#retire();
    try {
      Promise.resolve(this.opts.onFailure(this.#failure)).catch(() => {});
    } catch {
      /* fixed error already fenced the transport */
    }
  }
  #serialize(message: unknown): string {
    const line = JSON.stringify(message);
    if (typeof line !== "string" || Buffer.byteLength(line) > RPC_MAX_LINE_BYTES)
      throw new RpcError("rpc", -32600);
    return `${line}\n`;
  }
  #write(line: string, current?: () => boolean): void {
    if (!this.#live()) return;
    try {
      // Serialization already finished: no result getter can retire authority after this check.
      if (current) {
        const allowed: unknown = current();
        if (typeof allowed !== "boolean") {
          Promise.resolve(allowed).catch(() => {});
          throw new RpcError("rpc", -32600);
        }
        if (allowed !== true) return;
      }
      if (!this.#live()) return;
      if (this.opts.output.writableLength + Buffer.byteLength(line) > RPC_MAX_LINE_BYTES + 1) {
        this.#fail();
        return;
      }
      this.opts.output.write(line, (error) => {
        if (error) this.#fail();
      });
    } catch {
      this.#fail();
    }
  }
  #consume(chunk: unknown): void {
    if (!this.#live()) return;
    if (!Buffer.isBuffer(chunk) && typeof chunk !== "string") {
      this.#fail();
      return;
    }
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let offset = 0;
    while (offset < bytes.length && this.#live()) {
      const end = bytes.indexOf(10, offset),
        last = end < 0 ? bytes.length : end;
      const size = last - offset;
      if (this.#bytes + size > RPC_MAX_LINE_BYTES) {
        this.#fail();
        return;
      }
      if (size > 0) {
        this.#ensureCapacity(this.#bytes + size);
        bytes.copy(this.#buffer, this.#bytes, offset, last);
        this.#bytes += size;
      }
      if (end < 0) return;
      const line = this.#buffer.subarray(0, this.#bytes);
      this.#bytes = 0;
      this.#line(line);
      offset = end + 1;
    }
  }
  #ensureCapacity(size: number): void {
    if (this.#buffer.length >= size) return;
    const grown = Buffer.allocUnsafe(
      Math.min(RPC_MAX_LINE_BYTES, Math.max(size, 4096, this.#buffer.length * 2)),
    );
    this.#buffer.copy(grown, 0, 0, this.#bytes);
    this.#buffer = grown;
  }
  #line(line: Buffer): void {
    let value: unknown;
    try {
      value = JSON.parse(decoder.decode(line));
    } catch {
      this.#fail();
      return;
    }
    if (!object(value) || Object.hasOwn(value, "jsonrpc")) {
      this.#fail();
      return;
    }
    const hasMethod = Object.hasOwn(value, "method"),
      hasId = Object.hasOwn(value, "id"),
      hasResult = Object.hasOwn(value, "result"),
      hasError = Object.hasOwn(value, "error");
    if (hasMethod) {
      if (
        typeof value.method !== "string" ||
        value.method.length === 0 ||
        value.method.length > 1024 ||
        hasResult ||
        hasError ||
        (hasId && !validId(value.id))
      ) {
        this.#fail();
        return;
      }
      if (
        this.#callbacks >= MAX_PENDING ||
        (hasId && this.#serverIds.has(value.id as number | string))
      ) {
        this.#fail();
        return;
      }
      this.#callbacks++;
      if (hasId) {
        const id = value.id as number | string;
        this.#serverIds.add(id);
        this.#callback(
          () => this.opts.onServerRequest(value.method as string, value.params, this.#context),
          (reply) => this.#reply(id, reply),
          () => {
            this.#serverIds.delete(id);
            this.#callbacks--;
          },
        );
      } else
        this.#callback(
          () => this.opts.onNotification(value.method as string, value.params, this.#context),
          () => {},
          () => {
            this.#callbacks--;
          },
        );
      return;
    }
    if (
      !hasId ||
      !validId(value.id) ||
      hasResult === hasError ||
      (hasError &&
        (!object(value.error) ||
          !safeCode(value.error.code) ||
          typeof value.error.message !== "string"))
    ) {
      this.#fail();
      return;
    }
    if (typeof value.id !== "number") return;
    const p = this.#pending.get(value.id);
    if (!p) return;
    if (hasError) {
      this.#reject(value.id, new RpcError(p.method, (value.error as { code: number }).code));
      return;
    }
    // Validate while still registered. Abort/close inside a trusted validator rejects this waiter;
    // it cannot resolve after the callback returns.
    let parsed: unknown;
    try {
      parsed = p.validate(value.result);
      if (
        (object(parsed) || typeof parsed === "function") &&
        typeof (parsed as { then?: unknown }).then === "function"
      ) {
        Promise.resolve(parsed).catch(() => {});
        throw new RpcError("rpc", -32600);
      }
    } catch {
      this.#fail();
      return;
    }
    if (!this.#live() || p.signal.aborted || this.#pending.get(value.id) !== p) return;
    this.#take(value.id)?.resolve(parsed);
  }
  #callback<T>(run: () => T | Promise<T>, complete: (value: T) => void, release: () => void): void {
    let pending = false;
    let value: T | Promise<T>;
    try {
      value = run();
      if (
        (object(value) || typeof value === "function") &&
        typeof (value as { then?: unknown }).then === "function"
      ) {
        pending = true;
        void Promise.resolve(value)
          .then(
            (result) => {
              try {
                if (this.#live()) complete(result);
              } catch {
                this.#fail();
              } finally {
                release();
              }
            },
            () => {
              this.#fail();
              release();
            },
          )
          .catch(() => this.#fail());
        return;
      }
      if (this.#live()) complete(value as T);
    } catch {
      this.#fail();
    } finally {
      // Pending asynchronous handlers release in their continuation instead.
      if (!pending) release();
    }
  }
  #reply(id: number | string, reply: unknown): void {
    if (
      !object(reply) ||
      typeof reply.current !== "function" ||
      Object.hasOwn(reply, "result") === Object.hasOwn(reply, "error")
    )
      throw new Error();
    const line = Object.hasOwn(reply, "result")
      ? this.#serialize({ id, result: reply.result })
      : this.#serialize({ id, error: this.#serverError(reply.error) });
    const current = reply.current as () => boolean;
    this.#write(line, () => current());
  }
  #serverError(error: unknown): { code: number; message: string } {
    if (!object(error) || !safeCode(error.code)) throw new Error();
    return { code: error.code, message: "localDot does not handle this Codex request." };
  }
}
