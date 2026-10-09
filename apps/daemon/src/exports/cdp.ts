import type { Readable, Writable } from "node:stream";

type Handler = (params: Record<string, unknown>, sessionId: string | undefined) => void;

const MAX_RECORD_BYTES = 64 * 1024 * 1024;

interface Waiting {
  resolve(result: Record<string, unknown>): void;
  reject(error: Error): void;
}

// The browser's debugging protocol over the pipe Chrome opens on file descriptors 3 and 4 with
// --remote-debugging-pipe: one JSON message per NUL-terminated record. Nothing listens on a port,
// so only the daemon that started the browser can drive it.
export class CdpPipe {
  readonly #out: Writable;
  #next = 0;
  #pending: Buffer[] = [];
  #pendingBytes = 0;
  #closed: Error | null = null;
  readonly #waiting = new Map<number, Waiting>();
  readonly #handlers = new Map<string, Set<Handler>>();
  readonly #closers = new Set<(error: Error) => void>();

  constructor(out: Writable, input: Readable) {
    this.#out = out;
    out.on("error", (error: Error) => this.#close(error));
    input.on("error", (error: Error) => this.#close(error));
    input.on("close", () => this.#close(new Error("The browser closed its pipe.")));
    input.on("data", (data: Buffer) => this.#read(data));
  }

  send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<Record<string, unknown>> {
    if (this.#closed) return Promise.reject(this.#closed);
    const id = ++this.#next;
    return new Promise((resolve, reject) => {
      this.#waiting.set(id, { resolve, reject });
      this.#out.write(
        `${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`,
      );
    });
  }

  on(method: string, handler: Handler): () => void {
    let handlers = this.#handlers.get(method);
    if (!handlers) {
      handlers = new Set();
      this.#handlers.set(method, handlers);
    }
    handlers.add(handler);
    return () => handlers.delete(handler);
  }

  onClose(listener: (error: Error) => void): void {
    if (this.#closed) listener(this.#closed);
    else this.#closers.add(listener);
  }

  // A record can span many reads (an export's chunk is megabytes), so only new bytes are searched.
  #read(data: Buffer): void {
    let rest = data;
    let end = rest.indexOf(0);
    while (end >= 0) {
      this.#pending.push(rest.subarray(0, end));
      const record = Buffer.concat(this.#pending).toString("utf8");
      this.#pending = [];
      this.#pendingBytes = 0;
      this.#dispatch(record);
      rest = rest.subarray(end + 1);
      end = rest.indexOf(0);
    }
    if (!rest.byteLength) return;
    this.#pending.push(rest);
    this.#pendingBytes += rest.byteLength;
    if (this.#pendingBytes > MAX_RECORD_BYTES) this.#close(new Error("The browser sent too much."));
  }

  #dispatch(record: string): void {
    let message: {
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
      result?: Record<string, unknown>;
      error?: { message?: string };
      sessionId?: string;
    };
    try {
      message = JSON.parse(record);
    } catch {
      this.#close(new Error("The browser sent an unreadable message."));
      return;
    }
    if (typeof message.id === "number") {
      const waiting = this.#waiting.get(message.id);
      if (!waiting) return;
      this.#waiting.delete(message.id);
      if (message.error) waiting.reject(new Error(message.error.message ?? "protocol error"));
      else waiting.resolve(message.result ?? {});
      return;
    }
    if (typeof message.method !== "string") return;
    for (const handler of this.#handlers.get(message.method) ?? [])
      handler(message.params ?? {}, message.sessionId);
  }

  #close(error: Error): void {
    if (this.#closed) return;
    this.#closed = error;
    for (const waiting of this.#waiting.values()) waiting.reject(error);
    this.#waiting.clear();
    for (const listener of this.#closers) listener(error);
    this.#closers.clear();
  }
}
