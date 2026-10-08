import { type IncomingMessage, request } from "node:http";
import { DOCKER_API } from "../../../daemon/src/cells/docker.ts";

const failure = () => new Error("Diagnostic Docker transport failed.");

/** Preserve stdout/stderr separately; arbitrary HTTP chunk boundaries are irrelevant. */
export function canaryDockerStreams(bytes: Buffer, stdoutLimit: number, stderrLimit: number) {
  const stdout: Buffer[] = [],
    stderr: Buffer[] = [];
  let outBytes = 0,
    errBytes = 0,
    offset = 0,
    frames = 0;
  while (offset < bytes.length) {
    if (++frames > 65536 || bytes.length - offset < 8) throw failure();
    const stream = bytes[offset],
      length = bytes.readUInt32BE(offset + 4);
    if (
      (stream !== 1 && stream !== 2) ||
      bytes[offset + 1] !== 0 ||
      bytes[offset + 2] !== 0 ||
      bytes[offset + 3] !== 0 ||
      length > bytes.length - offset - 8
    )
      throw failure();
    offset += 8;
    const part = bytes.subarray(offset, offset + length);
    if (stream === 1) {
      outBytes += length;
      if (outBytes > stdoutLimit) throw failure();
      stdout.push(part);
    } else {
      errBytes += length;
      if (errBytes > stderrLimit) throw failure();
      stderr.push(part);
    }
    offset += length;
  }
  return { stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
}

/** Internal transport only. Callers bind all paths/bodies to a verified owned
 * operation and retain that scope through actual request close, even on abort. */
export function canaryDockerExchange(socketPath: string, s: AbortSignal) {
  return async function exchange(
    method: "GET" | "POST" | "PUT",
    suffix: string,
    body: Buffer | object | undefined,
    status: number,
    kind: "json" | "stream" | "empty",
    limit = 4 * 1024 * 1024,
  ): Promise<Buffer> {
    s.throwIfAborted();
    const archive = Buffer.isBuffer(body),
      payload = archive ? body : body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    if (payload && payload.length > 512 * 1024) throw failure();
    const controller = new AbortController(),
      abort = () => controller.abort(failure());
    s.addEventListener("abort", abort, { once: true });
    if (s.aborted) abort();
    const timer = setTimeout(abort, kind === "stream" ? 180_000 : 15_000);
    let req: ReturnType<typeof request> | undefined,
      response: IncomingMessage | undefined,
      closed: Promise<void> | undefined;
    let bytes: Buffer;
    try {
      response = await new Promise<IncomingMessage>((resolve, reject) => {
        req = request(
          {
            socketPath,
            path: `/${DOCKER_API}${suffix}`,
            method,
            agent: false,
            signal: controller.signal,
            headers: {
              host: "docker",
              accept: kind === "stream" ? "application/vnd.docker.raw-stream" : "application/json",
              "accept-encoding": "identity",
              "content-length": String(payload?.length ?? 0),
              ...(payload
                ? { "content-type": archive ? "application/x-tar" : "application/json" }
                : {}),
            },
          },
          resolve,
        );
        closed = new Promise<void>((done) => req?.once("close", done));
        req.once("error", reject);
        req.end(payload);
      });
      const length = response.headers["content-length"],
        content = response.headers["content-type"] ?? "";
      if (
        response.statusCode !== status ||
        (response.headers["content-encoding"] &&
          response.headers["content-encoding"] !== "identity") ||
        (length !== undefined && (!/^[0-9]+$/.test(length) || Number(length) > limit)) ||
        (kind === "json" && !/^application\/json(?:;\s*charset=utf-8)?$/i.test(content)) ||
        (kind === "stream" &&
          !/^application\/vnd\.docker\.(raw|multiplexed)-stream$/i.test(content))
      )
        throw failure();
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of response) {
        controller.signal.throwIfAborted();
        size += chunk.length;
        if (size > limit || (kind === "empty" && size)) throw failure();
        chunks.push(Buffer.from(chunk));
      }
      controller.signal.throwIfAborted();
      if (!response.complete || (length !== undefined && Number(length) !== size)) throw failure();
      bytes = Buffer.concat(chunks);
    } finally {
      response?.destroy();
      req?.destroy();
      await closed;
      clearTimeout(timer);
      s.removeEventListener("abort", abort);
    }
    controller.signal.throwIfAborted();
    return bytes;
  };
}
