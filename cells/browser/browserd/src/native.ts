import type { Readable, Writable } from "node:stream";
import {
  type NativeArgs,
  type NativeCommand,
  NativeEvent,
  NativeFailure,
  NativeReady,
  type NativeReplies,
  nativeReply,
  nativeRequest,
} from "./native-schema.ts";

export const NATIVE_READY_MS = 5000;
export const NATIVE_COMMAND_MS = 5000;
export const NATIVE_LINE_BYTES = 65_536;
export const NATIVE_WRITE_BYTES = 8192;

export class BrowserNativeError extends Error {
  constructor(
    readonly reason:
      | "closed"
      | "command"
      | "protocol"
      | "timeout"
      | "aborted"
      | "busy"
      | "unavailable",
  ) {
    super(`Browser native operation refused: ${reason}`);
  }
}

interface Pending {
  id: number;
  command: NativeCommand;
  args: NativeArgs[NativeCommand];
  resolve(value: NativeReplies[NativeCommand]): void;
  reject(error: BrowserNativeError): void;
  cleanup(): void;
}

export interface BrowserNativeOptions {
  input: Writable;
  output: Readable;
  scale: 1 | 2;
  onFatal(error: BrowserNativeError): void;
}

export class BrowserNative {
  readonly #options: Readonly<BrowserNativeOptions>;
  readonly #completion = Promise.withResolvers<void>();
  readonly ready = this.#completion.promise;
  readonly #buffer = Buffer.alloc(NATIVE_LINE_BYTES);
  readonly #decoder = new TextDecoder("utf-8", { fatal: true });
  readonly #listeners = new Set<(event: Readonly<NativeEvent>) => void>();
  readonly #readyTimer: NodeJS.Timeout;
  #pending?: Pending;
  #used = 0;
  #sequence = 0;
  #started = false;
  #closed = false;

  constructor(options: BrowserNativeOptions) {
    if (options.scale !== 1 && options.scale !== 2) throw new BrowserNativeError("command");
    this.#options = Object.freeze({ ...options });
    void this.ready.catch(() => {});
    this.#readyTimer = setTimeout(() => this.#fail("timeout"), NATIVE_READY_MS);
    options.input.on("error", () => this.#fail("unavailable"));
    options.output.on("error", () => this.#fail("unavailable"));
    options.input.once("finish", () => this.#fail("closed"));
    options.input.once("close", () => this.#fail("closed"));
    options.output.once("end", () => this.#fail("closed"));
    options.output.once("close", () => this.#fail("closed"));
    options.output.on("data", (chunk: unknown) => this.#receive(chunk));
    if (
      options.input.destroyed ||
      options.input.writableEnded ||
      options.output.destroyed ||
      options.output.readableEnded
    )
      this.#fail("closed");
  }

  get alive(): boolean {
    return this.#started && !this.#closed;
  }

  onEvent(listener: (event: Readonly<NativeEvent>) => void): () => void {
    if (this.#closed) throw new BrowserNativeError("closed");
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  command<Name extends NativeCommand>(
    name: Name,
    raw: NativeArgs[Name],
    signal?: AbortSignal,
  ): Promise<NativeReplies[Name]> {
    if (signal?.aborted) return Promise.reject(new BrowserNativeError("aborted"));
    if (!this.alive) return Promise.reject(new BrowserNativeError("closed"));
    if (this.#pending) return Promise.reject(new BrowserNativeError("busy"));
    let args: ReturnType<typeof nativeRequest>;
    try {
      args = nativeRequest(name, raw, this.#options.scale);
    } catch {
      return Promise.reject(new BrowserNativeError("command"));
    }
    if (!args) return Promise.reject(new BrowserNativeError("command"));
    if (signal?.aborted) return Promise.reject(new BrowserNativeError("aborted"));
    if (!this.alive) return Promise.reject(new BrowserNativeError("closed"));
    if (this.#pending) return Promise.reject(new BrowserNativeError("busy"));
    if (this.#sequence >= Number.MAX_SAFE_INTEGER) {
      this.#fail("protocol");
      return Promise.reject(new BrowserNativeError("closed"));
    }
    const id = ++this.#sequence;
    const message = `${JSON.stringify({ ...args, id, cmd: name })}\n`;
    if (Buffer.byteLength(message) + this.#options.input.writableLength > NATIVE_WRITE_BYTES) {
      this.#fail("protocol");
      return Promise.reject(new BrowserNativeError("closed"));
    }
    const completion = Promise.withResolvers<NativeReplies[Name]>();
    const cancel = () => this.#fail("aborted");
    const timeout = setTimeout(
      () => this.#fail("timeout"),
      name === "settle" && "timeoutMs" in args ? args.timeoutMs + 1000 : NATIVE_COMMAND_MS,
    );
    this.#pending = {
      id,
      command: name,
      args,
      resolve: (reply) => completion.resolve(reply as NativeReplies[Name]),
      reject: completion.reject,
      cleanup: () => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", cancel);
      },
    };
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      if (signal?.aborted) cancel();
      if (!this.#closed)
        this.#options.input.write(message, "utf8", (error) => {
          if (error) this.#fail("unavailable");
        });
    } catch {
      this.#fail("unavailable");
    }
    return completion.promise;
  }

  close(): void {
    this.#fail("closed");
  }

  #fail(reason: BrowserNativeError["reason"]): void {
    if (this.#closed) return;
    this.#closed = true;
    const error = new BrowserNativeError(reason);
    clearTimeout(this.#readyTimer);
    this.#buffer.fill(0);
    this.#used = 0;
    const pending = this.#pending;
    this.#pending = undefined;
    pending?.cleanup();
    this.#listeners.clear();
    try {
      this.#options.onFatal(error);
    } catch {}
    this.#completion.reject(error);
    pending?.reject(error);
    try {
      this.#options.input.destroy();
    } catch {}
    try {
      this.#options.output.destroy();
    } catch {}
  }

  #receive(chunk: unknown): void {
    if (this.#closed) return;
    if (!Buffer.isBuffer(chunk) || chunk.length > NATIVE_LINE_BYTES * 4) {
      this.#fail("protocol");
      return;
    }
    let offset = 0;
    let lines = 0;
    while (offset < chunk.length && !this.#closed) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline;
      const length = end - offset;
      if (this.#used + length > NATIVE_LINE_BYTES || lines >= 512) {
        this.#fail("protocol");
        return;
      }
      chunk.copy(this.#buffer, this.#used, offset, end);
      this.#used += length;
      offset = end + 1;
      if (newline < 0) return;
      lines += 1;
      try {
        const message = JSON.parse(
          this.#decoder.decode(this.#buffer.subarray(0, this.#used)),
        ) as unknown;
        this.#buffer.fill(0, 0, this.#used);
        this.#used = 0;
        this.#message(message);
      } catch {
        this.#fail("protocol");
      }
    }
  }

  #message(message: unknown): void {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      this.#fail("protocol");
      return;
    }
    if ("ev" in message) {
      if (NativeReady.safeParse(message).success) {
        if (this.#started) {
          this.#fail("protocol");
          return;
        }
        this.#started = true;
        clearTimeout(this.#readyTimer);
        this.#completion.resolve();
        return;
      }
      const event = NativeEvent.safeParse(message);
      if (!event.success) {
        this.#fail("protocol");
        return;
      }
      if (!this.#started) return;
      const snapshot = Object.freeze(event.data);
      for (const listener of [...this.#listeners]) {
        if (this.#closed) break;
        if (this.#listeners.has(listener)) listener(snapshot);
      }
      return;
    }
    const pending = this.#pending;
    if (
      !this.#started ||
      !pending ||
      !("id" in message) ||
      message.id !== pending.id ||
      !("ok" in message)
    ) {
      this.#fail("protocol");
      return;
    }
    if (NativeFailure.safeParse(message).success) {
      this.#fail("unavailable");
      return;
    }
    const { id: ignoredId, ok, ...value } = message;
    const parsed = ok === true ? nativeReply(pending.command, value, pending.args) : undefined;
    if (!parsed) {
      this.#fail("protocol");
      return;
    }
    this.#pending = undefined;
    pending.cleanup();
    pending.resolve(parsed);
  }
}
