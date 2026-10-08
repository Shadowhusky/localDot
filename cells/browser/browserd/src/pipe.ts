import type { Readable, Writable } from "node:stream";

export const MAX_CDP_MESSAGE_BYTES = 8 * 1024 * 1024;
export const MAX_CDP_COMMAND_BYTES = 64 * 1024;
export const MAX_CDP_QUEUED_BYTES = 512 * 1024;
export const CDP_RETIRE_MS = 1000;

export interface CdpTransport {
  write(message: string): void;
  onMessage(listener: (message: string) => void): () => void;
  onClose(listener: () => void): () => void;
  close(): void;
  /** Terminal owner-only shutdown; never accepts a caller-supplied CDP command. */
  retire?(): boolean;
}

export class CdpPipeError extends Error {
  constructor() {
    super("The private browser pipe is unavailable");
  }
}

export function pipeTransport(toChrome: Writable, fromChrome: Readable): CdpTransport {
  const messages = new Set<(message: string) => void>();
  const closers = new Set<() => void>();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffered = Buffer.allocUnsafe(64 * 1024);
  let used = 0;
  let closed = false;
  let retirement: ReturnType<typeof setTimeout> | undefined;
  const seal = () => {
    if (closed) return;
    closed = true;
    buffered.fill(0);
    used = 0;
    messages.clear();
    for (const listener of [...closers]) {
      try {
        listener();
      } catch {}
    }
    closers.clear();
  };
  const close = () => {
    seal();
    clearTimeout(retirement);
    toChrome.destroy();
    fromChrome.destroy();
  };
  const append = (part: Buffer): boolean => {
    const required = used + part.length;
    if (required > MAX_CDP_MESSAGE_BYTES) {
      close();
      return false;
    }
    if (required > buffered.length) {
      const grown = Buffer.allocUnsafe(
        Math.min(MAX_CDP_MESSAGE_BYTES, Math.max(required, buffered.length * 2)),
      );
      buffered.copy(grown, 0, 0, used);
      buffered.fill(0);
      buffered = grown;
    }
    part.copy(buffered, used);
    used = required;
    return true;
  };
  fromChrome.on("data", (chunk: unknown) => {
    if (closed) return;
    if (!Buffer.isBuffer(chunk)) {
      close();
      return;
    }
    let offset = 0;
    while (!closed && offset < chunk.length) {
      const delimiter = chunk.indexOf(0, offset);
      const end = delimiter < 0 ? chunk.length : delimiter;
      if (!append(chunk.subarray(offset, end))) return;
      offset = end + 1;
      if (delimiter < 0) return;
      if (used === 0) {
        close();
        return;
      }
      try {
        const message = decoder.decode(buffered.subarray(0, used));
        used = 0;
        for (const listener of [...messages]) {
          if (closed) break;
          if (!messages.has(listener)) continue;
          listener(message);
        }
      } catch {
        close();
      }
    }
  });
  fromChrome.on("end", close);
  fromChrome.on("close", close);
  fromChrome.on("error", close);
  toChrome.on("close", close);
  toChrome.on("error", close);
  return {
    write(message) {
      const length = Buffer.byteLength(message, "utf8") + 1;
      if (closed) throw new CdpPipeError();
      if (
        length > MAX_CDP_COMMAND_BYTES ||
        message.includes("\0") ||
        toChrome.writableLength + length > MAX_CDP_QUEUED_BYTES
      ) {
        close();
        throw new CdpPipeError();
      }
      try {
        toChrome.write(`${message}\0`, "utf8");
      } catch {
        close();
        throw new CdpPipeError();
      }
    },
    onMessage(listener) {
      if (closed) throw new CdpPipeError();
      messages.add(listener);
      return () => {
        messages.delete(listener);
      };
    },
    onClose(listener) {
      if (closed) {
        listener();
        return () => {};
      }
      closers.add(listener);
      return () => {
        closers.delete(listener);
      };
    },
    close,
    retire() {
      if (closed) return false;
      seal();
      // Ordinary admission and reply delivery are already revoked. Keep the pipe alive
      // briefly so Chromium can flush its profile before its process group is retired.
      const terminal = '{"id":0,"method":"Browser.close","params":{}}\0';
      if (
        toChrome.destroyed ||
        fromChrome.destroyed ||
        toChrome.writableLength + Buffer.byteLength(terminal) > MAX_CDP_QUEUED_BYTES
      ) {
        close();
        return false;
      }
      retirement = setTimeout(close, CDP_RETIRE_MS);
      try {
        toChrome.write(terminal, "utf8", (error) => {
          if (error) close();
        });
      } catch {
        close();
        return false;
      }
      return !toChrome.destroyed && !fromChrome.destroyed;
    },
  };
}
