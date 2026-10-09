import { request } from "node:http";
import type { Duplex } from "node:stream";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { DOCKER_API } from "../cells/docker.ts";

const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const STDERR_KEPT = 2048;
const ATTACH_MS = 15_000;

// A container without a terminal sends its output in frames: one byte for the stream (1 stdout, 2
// stderr), three zero bytes, the length as a 32-bit big-endian number, then the bytes.
export class DockerFrames {
  #pending: Buffer = Buffer.alloc(0);
  push(chunk: Buffer, emit: (stream: 1 | 2, data: Buffer) => void): void {
    this.#pending = this.#pending.length ? Buffer.concat([this.#pending, chunk]) : chunk;
    while (this.#pending.length >= 8) {
      const stream = this.#pending[0];
      const length = this.#pending.readUInt32BE(4);
      if ((stream !== 1 && stream !== 2) || length > MAX_FRAME_BYTES)
        throw new Error("the connector's output is not in Docker's frames");
      if (this.#pending.length < 8 + length) return;
      emit(stream, this.#pending.subarray(8, 8 + length));
      this.#pending = this.#pending.subarray(8 + length);
    }
  }
}

// The container's stdin and output as one stream: Docker's attach, upgraded to a raw connection.
export function attachContainer(
  socketPath: string,
  containerId: string,
  signal: AbortSignal,
): Promise<{ stream: Duplex; head: Buffer }> {
  return new Promise((resolve, reject) => {
    if (!/^[a-f0-9]{64}$/.test(containerId)) {
      reject(new Error("invalid container id"));
      return;
    }
    const pending = request({
      socketPath,
      path: `/${DOCKER_API}/containers/${containerId}/attach?stream=1&stdin=1&stdout=1&stderr=1`,
      method: "POST",
      agent: false,
      headers: {
        host: "docker",
        connection: "Upgrade",
        upgrade: "tcp",
        "content-type": "text/plain",
        "content-length": "0",
      },
    });
    const fail = (error: Error) => {
      clearTimeout(deadline);
      signal.removeEventListener("abort", aborted);
      pending.destroy();
      reject(error);
    };
    const aborted = () => fail(new Error("the connector was stopped"));
    const deadline = setTimeout(() => fail(new Error("Docker did not attach in time")), ATTACH_MS);
    signal.addEventListener("abort", aborted, { once: true });
    pending.once("error", fail);
    pending.once("response", (response) => {
      response.resume();
      fail(new Error(`Docker refused to attach (${response.statusCode})`));
    });
    pending.once("upgrade", (response, socket, head) => {
      clearTimeout(deadline);
      signal.removeEventListener("abort", aborted);
      if (response.statusCode !== 101) {
        socket.destroy();
        reject(new Error("Docker refused to attach"));
        return;
      }
      resolve({ stream: socket, head });
    });
    pending.end();
  });
}

// MCP over a connector cell's stdin and stdout, one JSON message per line. What it writes to stderr
// is kept, briefly, to say why it stopped.
export class AttachTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  readonly #frames = new DockerFrames();
  readonly #buffer = new ReadBuffer({ maxBufferSize: MAX_MESSAGE_BYTES });
  #stderr = "";
  #closed = false;
  constructor(
    private readonly stream: Duplex,
    private readonly head: Buffer = Buffer.alloc(0),
  ) {}
  get stderr(): string {
    return this.#stderr;
  }
  async start(): Promise<void> {
    this.stream.on("data", (chunk: Buffer) => this.#read(chunk));
    this.stream.on("error", (error: Error) => this.onerror?.(error));
    this.stream.on("close", () => this.#close());
    if (this.head.length) this.#read(this.head);
  }
  #read(chunk: Buffer): void {
    try {
      this.#frames.push(chunk, (stream, data) => {
        if (stream === 2) {
          this.#stderr = (this.#stderr + data.toString("utf8")).slice(-STDERR_KEPT);
          return;
        }
        this.#buffer.append(data);
        for (
          let message = this.#buffer.readMessage();
          message;
          message = this.#buffer.readMessage()
        )
          this.onmessage?.(message);
      });
    } catch (error) {
      this.onerror?.(error instanceof Error ? error : new Error(String(error)));
      this.stream.destroy();
    }
  }
  send(message: JSONRPCMessage): Promise<void> {
    if (this.#closed) return Promise.reject(new Error("the connector has stopped"));
    return new Promise((resolve, reject) => {
      this.stream.write(serializeMessage(message), (error) => (error ? reject(error) : resolve()));
    });
  }
  async close(): Promise<void> {
    this.stream.destroy();
    this.#close();
  }
  #close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#buffer.clear();
    this.onclose?.();
  }
}
