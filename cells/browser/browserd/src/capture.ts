import type { Readable, Writable } from "node:stream";
import { captureMaskPacket } from "./capture-mask.ts";

export const BROWSER_CAPTURE_TIMEOUT_MS = 3000;
export const MAX_BROWSER_CAPTURE_BYTES = 2 * 1024 * 1024;
export const MAX_BROWSER_CAPTURE_CHUNK = 262_144;

export class BrowserCaptureError extends Error {
  constructor(
    readonly reason: "closed" | "unready" | "busy" | "aborted" | "timeout" | "protocol" | "mask",
  ) {
    super(`Browser capture refused: ${reason}`);
  }
}

interface CaptureRequest {
  readonly id: number;
  readonly result: PromiseWithResolvers<Buffer>;
  cleanup(): void;
}

export interface BrowserCaptureOptions {
  readonly input: Writable;
  readonly output: Readable;
  onFatal(error: BrowserCaptureError): void;
}

export class BrowserCapture {
  readonly #startup = Promise.withResolvers<void>();
  readonly #readyHeader = Buffer.alloc(4);
  readonly #frameHeader = Buffer.alloc(8);
  readonly #startupTimer: ReturnType<typeof setTimeout>;
  #readyBytes = 0;
  #headerBytes = 0;
  #image?: Buffer;
  #imageBytes = 0;
  #pending?: CaptureRequest;
  #nextId = 1;
  #ready = false;
  #closed = false;

  constructor(private readonly options: BrowserCaptureOptions) {
    void this.#startup.promise.catch(() => {});
    this.#startupTimer = setTimeout(() => this.#fail("timeout"), BROWSER_CAPTURE_TIMEOUT_MS);
    options.input.on("error", () => this.#fail("closed"));
    options.input.once("finish", () => this.#fail("closed"));
    options.input.once("close", () => this.#fail("closed"));
    options.output.on("error", () => this.#fail("closed"));
    options.output.once("end", () => this.#fail("closed"));
    options.output.once("close", () => this.#fail("closed"));
    options.output.on("data", this.#receive);
  }

  get ready(): Promise<void> {
    return this.#startup.promise;
  }

  get alive(): boolean {
    return !this.#closed && this.#ready;
  }

  capture(signal?: AbortSignal): Promise<Buffer> {
    return this.#request(undefined, signal);
  }

  masked(mask: unknown, signal?: AbortSignal): Promise<Buffer> {
    let packet: Buffer;
    try {
      packet = captureMaskPacket(mask);
    } catch {
      return Promise.reject(new BrowserCaptureError("mask"));
    }
    return this.#request(packet, signal);
  }

  #request(mask: Buffer | undefined, signal?: AbortSignal): Promise<Buffer> {
    if (this.#closed) return Promise.reject(new BrowserCaptureError("closed"));
    if (signal?.aborted) return Promise.reject(new BrowserCaptureError("aborted"));
    if (!this.#ready) return Promise.reject(new BrowserCaptureError("unready"));
    if (this.#pending) return Promise.reject(new BrowserCaptureError("busy"));
    if (this.#nextId > 0xffffffff) {
      this.#fail("closed");
      return Promise.reject(new BrowserCaptureError("closed"));
    }
    const id = this.#nextId++;
    const result = Promise.withResolvers<Buffer>();
    const cancel = () => this.#fail("aborted");
    const timeout = setTimeout(() => this.#fail("timeout"), BROWSER_CAPTURE_TIMEOUT_MS);
    this.#pending = {
      id,
      result,
      cleanup: () => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", cancel);
      },
    };
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    if (!this.#closed) {
      const request = mask ?? Buffer.alloc(4);
      request.writeUInt32BE(id, mask ? 4 : 0);
      try {
        this.options.input.write(request);
      } catch {
        this.#fail("closed");
      }
    }
    return result.promise;
  }

  close(): void {
    this.#fail("closed");
  }

  readonly #receive = (chunk: unknown): void => {
    if (this.#closed) return;
    if (!Buffer.isBuffer(chunk) || chunk.length > MAX_BROWSER_CAPTURE_CHUNK) {
      this.#fail("protocol");
      return;
    }
    let offset = 0;
    while (offset < chunk.length && !this.#closed) {
      if (!this.#ready) {
        const copied = chunk.copy(
          this.#readyHeader,
          this.#readyBytes,
          offset,
          offset + 4 - this.#readyBytes,
        );
        offset += copied;
        this.#readyBytes += copied;
        if (this.#readyBytes < 4) return;
        if (!this.#readyHeader.equals(Buffer.from("LDCP")) || offset !== chunk.length) {
          this.#fail("protocol");
          return;
        }
        this.#ready = true;
        clearTimeout(this.#startupTimer);
        this.#startup.resolve();
        continue;
      }
      const pending = this.#pending;
      if (!pending) {
        this.#fail("protocol");
        return;
      }
      if (this.#headerBytes < 8) {
        const copied = chunk.copy(
          this.#frameHeader,
          this.#headerBytes,
          offset,
          offset + 8 - this.#headerBytes,
        );
        offset += copied;
        this.#headerBytes += copied;
        if (this.#headerBytes < 8) return;
        const size = this.#frameHeader.readUInt32BE(4);
        if (
          this.#frameHeader.readUInt32BE(0) !== pending.id ||
          size < 30 ||
          size > MAX_BROWSER_CAPTURE_BYTES
        ) {
          this.#fail("protocol");
          return;
        }
        this.#image = Buffer.alloc(size);
      }
      const image = this.#image;
      if (!image) {
        this.#fail("protocol");
        return;
      }
      const copied = chunk.copy(
        image,
        this.#imageBytes,
        offset,
        offset + image.length - this.#imageBytes,
      );
      offset += copied;
      this.#imageBytes += copied;
      if (this.#imageBytes < image.length) return;
      if (offset !== chunk.length || !validImage(image)) {
        this.#fail("protocol");
        return;
      }
      try {
        pending.cleanup();
      } catch {
        this.#fail("closed");
        return;
      }
      if (this.#closed) return;
      this.#pending = undefined;
      this.#image = undefined;
      this.#imageBytes = 0;
      this.#headerBytes = 0;
      pending.result.resolve(image);
    }
  };

  #fail(reason: BrowserCaptureError["reason"]): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#ready = false;
    clearTimeout(this.#startupTimer);
    const error = new BrowserCaptureError(reason);
    const pending = this.#pending;
    this.#pending = undefined;
    this.#image = undefined;
    try {
      this.options.onFatal(error);
    } catch {}
    this.#startup.reject(error);
    pending?.result.reject(error);
    try {
      this.options.output.removeListener("data", this.#receive);
    } catch {}
    try {
      pending?.cleanup();
    } catch {}
    try {
      this.options.input.destroy();
    } catch {}
    try {
      this.options.output.destroy();
    } catch {}
  }
}

function validImage(image: Buffer): boolean {
  const chunkSize = image.readUInt32LE(16);
  return (
    image.subarray(0, 4).equals(Buffer.from("RIFF")) &&
    image.readUInt32LE(4) === image.length - 8 &&
    image.subarray(8, 16).equals(Buffer.from("WEBPVP8 ")) &&
    chunkSize >= 10 &&
    20 + chunkSize + (chunkSize % 2) === image.length &&
    (image.readUInt8(20) & 1) === 0 &&
    image.subarray(23, 26).equals(Buffer.from([0x9d, 0x01, 0x2a])) &&
    (image.readUInt16LE(26) & 0x3fff) === 1280 &&
    (image.readUInt16LE(28) & 0x3fff) === 800
  );
}
