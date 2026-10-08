import { type IncomingMessage, request } from "node:http";
import { DOCKER_API, dockerSocketPath } from "../../../daemon/src/cells/docker.ts";
import { type ImageEngine, installImageClient } from "./image-client.ts";

export interface InstallContainerClient {
  engine(signal: AbortSignal): Promise<ImageEngine>;
  list(signal: AbortSignal): Promise<unknown>;
  inspect(reference: string, signal: AbortSignal): Promise<unknown | null>;
  kill(id: string, signal: AbortSignal): Promise<void>;
}
const failure = () => new Error("LocalDot container shutdown could not be confirmed.");
const containerId = /^[a-f0-9]{64}$/;

/** Fixed local inspection and SIGKILL only. No exec, start, unpause, container/volume deletion,
 * engine fallback, credentials or proxy. A kill response never certifies stopped state.
 */
export function installContainerClient(socketInput: string): InstallContainerClient {
  const socket = dockerSocketPath({ DOCKER_HOST: `unix://${socketInput}` });
  const images = installImageClient(socket);
  async function exchange(method: "GET" | "POST", path: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const controller = new AbortController(),
      abort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const timer = setTimeout(() => controller.abort(failure()), 10_000);
    let req: ReturnType<typeof request> | undefined, res: IncomingMessage | undefined;
    let closed: Promise<void> | undefined;
    try {
      res = await new Promise<IncomingMessage>((resolve, reject) => {
        req = request(
          {
            socketPath: socket,
            method,
            path: `/${DOCKER_API}${path}`,
            agent: false,
            signal: controller.signal,
            headers: {
              host: "docker",
              accept: "application/json",
              "accept-encoding": "identity",
              ...(method === "POST" ? { "content-length": "0" } : {}),
            },
          },
          resolve,
        );
        closed = new Promise<void>((done) => req?.once("close", done));
        req.once("error", reject);
        req.end();
      });
      const length = res.headers["content-length"];
      if (
        (res.headers["content-encoding"] && res.headers["content-encoding"] !== "identity") ||
        (length !== undefined && (!/^[0-9]+$/.test(length) || Number(length) > 4 * 1024 * 1024))
      )
        throw failure();
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const part of res) {
        controller.signal.throwIfAborted();
        size += part.length;
        if (size > 4 * 1024 * 1024) throw failure();
        chunks.push(Buffer.from(part));
      }
      controller.signal.throwIfAborted();
      if (!res.complete || (length !== undefined && Number(length) !== size)) throw failure();
      if (method === "POST") {
        // 404/409 can mean a concurrent exit. Only subsequent inspection proves quiescence.
        if (![204, 404, 409].includes(res.statusCode ?? 0)) throw failure();
        return null;
      }
      if (res.statusCode === 404 && path.endsWith("/json")) return null;
      if (
        res.statusCode !== 200 ||
        !/^application\/json(?:;\s*charset=utf-8)?$/i.test(res.headers["content-type"] ?? "")
      )
        throw failure();
      const value: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
      );
      if (value === null || typeof value !== "object") throw failure();
      return value;
    } catch {
      signal.throwIfAborted();
      throw failure();
    } finally {
      res?.destroy();
      req?.destroy();
      await closed;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  }
  return {
    engine: (signal) => images.engine(signal),
    list: (signal) =>
      exchange(
        "GET",
        `/containers/json?${new URLSearchParams({ all: "true", filters: JSON.stringify({ label: ["localdot.role"] }) })}`,
        signal,
      ),
    inspect(reference, signal) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(reference)) throw failure();
      return exchange("GET", `/containers/${encodeURIComponent(reference)}/json`, signal);
    },
    async kill(id, signal) {
      if (!containerId.test(id)) throw failure();
      await exchange("POST", `/containers/${id}/kill?signal=SIGKILL`, signal);
    },
  };
}
