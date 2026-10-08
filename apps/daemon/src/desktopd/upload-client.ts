import { createHash } from "node:crypto";
import { type IncomingMessage, request } from "node:http";
import { addAbortSignal, Readable } from "node:stream";
import {
  DesktopUploadFile,
  DesktopUploadInspect,
} from "../../../../packages/protocol/src/desktop-uploads.ts";
import type { DesktopdEndpoint } from "../cells/types.ts";
import { DesktopdError } from "./client.ts";

export interface UploadSourceScope {
  readonly signal: AbortSignal;
  check(): void;
}
function refusal(): DesktopdError {
  return new DesktopdError(
    409,
    "The approved upload source could not be verified.",
    "/files/upload-read",
  );
}

async function connection(
  endpoint: DesktopdEndpoint,
  path: string,
  input: unknown,
  scope: UploadSourceScope,
) {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), 600000);
  timer.unref();
  const signal = AbortSignal.any([scope.signal, deadline.signal]);
  let outgoing: ReturnType<typeof request> | undefined;
  let response: IncomingMessage | undefined;
  let requestClosed: Promise<void> | undefined, responseClosed: Promise<void> | undefined;
  const check = () => {
    signal.throwIfAborted();
    scope.check();
    signal.throwIfAborted();
  };
  const close = async () => {
    clearTimeout(timer);
    outgoing?.destroy();
    response?.destroy();
    await requestClosed;
    await responseClosed;
  };
  try {
    check();
    if (
      !/^http:\/\/127\.0\.0\.1:[0-9]{4,5}$/u.test(endpoint.baseUrl) ||
      !/^[A-Za-z0-9_-]{43}$/u.test(endpoint.token)
    )
      throw refusal();
    const port = Number(new URL(endpoint.baseUrl).port);
    if (port < 1024 || port > 65535) throw refusal();
    const payload = JSON.stringify(input);
    if (Buffer.byteLength(payload) > 8192) throw refusal();
    response = await new Promise<IncomingMessage>((resolve, reject) => {
      outgoing = request(
        {
          host: "127.0.0.1",
          port,
          path,
          method: "POST",
          agent: false,
          signal,
          headers: {
            authorization: `Bearer ${endpoint.token}`,
            connection: "close",
            "content-type": "application/json",
            "content-length": Buffer.byteLength(payload),
          },
        },
        (incoming) => {
          response = incoming;
          responseClosed = new Promise<void>((done) => incoming.once("close", done));
          resolve(incoming);
        },
      );
      requestClosed = new Promise<void>((resolve) => outgoing?.once("close", resolve));
      outgoing.on("error", reject);
      outgoing.end(payload);
    });
    check();
    if (response.statusCode !== 200 || response.headers["content-encoding"] !== undefined)
      throw refusal();
    return { response, check, close };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function inspectDesktopUpload(
  endpoint: DesktopdEndpoint,
  path: string,
  scope: UploadSourceScope,
): Promise<DesktopUploadFile> {
  const input = DesktopUploadInspect.parse({ path });
  const conn = await connection(endpoint, "/files/upload-info", input, scope);
  try {
    if (conn.response.headers["content-type"] !== "application/json") throw refusal();
    let count = 0;
    const chunks: Buffer[] = [];
    for await (const bytes of conn.response) {
      conn.check();
      count += bytes.length;
      if (count > 8192) throw refusal();
      chunks.push(bytes);
    }
    conn.check();
    if (!conn.response.complete) throw refusal();
    return DesktopUploadFile.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, count))),
    );
  } finally {
    await conn.close();
  }
}

// This stream's EOF is the approval-integrity boundary: both desktopd's final
// identity check and this transport's digest/framing checks must have completed.
export function readDesktopUpload(
  endpoint: DesktopdEndpoint,
  raw: DesktopUploadFile,
  scope: UploadSourceScope,
): Readable {
  const expected = DesktopUploadFile.parse(raw);
  const abort = new AbortController();
  const current: UploadSourceScope = {
    signal: AbortSignal.any([scope.signal, abort.signal]),
    check: () => scope.check(),
  };
  const iterator = (async function* () {
    const conn = await connection(endpoint, "/files/upload-read", { file: expected }, current);
    try {
      if (
        conn.response.headers["content-type"] !== "application/octet-stream" ||
        conn.response.headers["content-length"] !== undefined ||
        conn.response.headers["transfer-encoding"] !== "chunked"
      )
        throw refusal();
      let count = 0;
      const hash = createHash("sha256");
      for await (const chunk of conn.response) {
        conn.check();
        if (!(chunk instanceof Uint8Array) || count + chunk.byteLength > expected.bytes)
          throw refusal();
        count += chunk.byteLength;
        hash.update(chunk);
        for (let offset = 0; offset < chunk.byteLength; offset += 65536) {
          conn.check();
          yield chunk.subarray(offset, offset + 65536);
        }
      }
      conn.check();
      if (
        !conn.response.complete ||
        count !== expected.bytes ||
        hash.digest("hex") !== expected.sha256
      )
        throw refusal();
    } finally {
      await conn.close();
    }
  })();
  const source = new Readable({
    highWaterMark: 65536,
    read() {
      void iterator.next().then(
        (next) => {
          if (!source.destroyed) source.push(next.done ? null : next.value);
        },
        (error: unknown) => source.destroy(error instanceof Error ? error : refusal()),
      );
    },
    destroy(error, done) {
      abort.abort();
      void iterator.return(undefined).then(
        () => done(error),
        (failure: unknown) => done(error ?? (failure instanceof Error ? failure : refusal())),
      );
    },
  });
  return addAbortSignal(current.signal, source);
}
