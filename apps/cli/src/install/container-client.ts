import { type IncomingMessage, request } from "node:http";
import { DOCKER_API, dockerSocketPath } from "../../../daemon/src/cells/docker.ts";
import type { ImageEngine } from "./image-client.ts";

export interface InstallContainerClient {
  engine(signal: AbortSignal): Promise<ImageEngine>;
  list(signal: AbortSignal): Promise<unknown>;
  inspect(reference: string, signal: AbortSignal): Promise<unknown | null>;
  kill(id: string, signal: AbortSignal): Promise<void>;
}
const failure = () => new Error("LocalDot container shutdown could not be confirmed.");
const containerId = /^[a-f0-9]{64}$/;

/** Fixed local inspection and termination only. Graceful mode gives applications five seconds to exit. No exec, start, unpause, container/volume deletion,
 * engine fallback, credentials or proxy. A kill response never certifies stopped state.
 */
export function installContainerClient(
  socketInput: string,
  options: { graceful?: boolean } = {},
): InstallContainerClient {
  const socket = dockerSocketPath({ DOCKER_HOST: `unix://${socketInput}` });
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
        if (![204, ...(options.graceful ? [304] : []), 404, 409].includes(res.statusCode ?? 0))
          throw failure();
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
    async engine(signal) {
      // Retirement applies to every supported Linux engine, including x64 WSL and native Linux.
      // Release preparation has stricter platform checks; reusing its arm64 default here would
      // prevent an otherwise valid x64 installation from shutting down.
      const version = (await exchange("GET", "/version", signal)) as Record<string, unknown> | null;
      const info = (await exchange("GET", "/info", signal)) as Record<string, unknown> | null;
      const architecture =
        version?.Arch === "arm64" || version?.Arch === "aarch64"
          ? "arm64"
          : version?.Arch === "amd64" || version?.Arch === "x86_64"
            ? "amd64"
            : undefined;
      if (
        version?.Os !== "linux" ||
        !architecture ||
        typeof info?.ID !== "string" ||
        !/^[A-Za-z0-9_:-]{1,256}$/.test(info.ID)
      )
        throw failure();
      return { id: info.ID, operatingSystem: "linux", architecture };
    },
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
      await exchange(
        "POST",
        options.graceful ? `/containers/${id}/stop?t=5` : `/containers/${id}/kill?signal=SIGKILL`,
        signal,
      );
    },
  };
}
