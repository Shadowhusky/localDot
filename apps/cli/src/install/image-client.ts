import { type IncomingMessage, request } from "node:http";
import { isAbsolute, normalize } from "node:path";
import { ImagePin, imageRef } from "../../../../packages/protocol/src/release.ts";
import { DOCKER_API } from "../../../daemon/src/cells/docker.ts";
import { type ImagePullProgress, readImagePullProgress } from "./image-progress.ts";

export interface ImageEngine {
  id: string;
  operatingSystem: "linux";
  architecture: "arm64" | "amd64";
}
export interface InstallImageClient {
  engine(signal: AbortSignal): Promise<ImageEngine>;
  inspect(pin: ImagePin, signal: AbortSignal): Promise<unknown | null>;
  pull(
    pin: ImagePin,
    signal: AbortSignal,
    report: (progress: ImagePullProgress) => void,
  ): Promise<void>;
}
const fail = () => new Error("Docker image preparation failed. Check Docker Desktop and retry.");

/** Fixed local-socket operations only. No CLI spawn, environment auth, credential helper or
 * registry-login request. Callers obtain this socket through the local installation preflight.
 */
export function installImageClient(
  socketPath: string,
  architecture: ImageEngine["architecture"] = "arm64",
): InstallImageClient {
  if (
    !["arm64", "amd64"].includes(architecture) ||
    !isAbsolute(socketPath) ||
    normalize(socketPath) !== socketPath ||
    socketPath === "/" ||
    socketPath.length > 1024 ||
    /[?#]/.test(socketPath) ||
    [...socketPath].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  )
    throw fail();
  async function exchange<T>(
    method: "GET" | "POST",
    path: string,
    signal: AbortSignal,
    pulling: boolean,
    work: (body: IncomingMessage, active: AbortSignal) => Promise<T>,
  ): Promise<T> {
    signal.throwIfAborted();
    const controller = new AbortController(),
      abort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const timer = setTimeout(() => controller.abort(fail()), pulling ? 15 * 60_000 : 10_000);
    let req: ReturnType<typeof request> | undefined,
      response: IncomingMessage | undefined,
      closed: Promise<void> | undefined;
    try {
      response = await new Promise<IncomingMessage>((resolve, reject) => {
        req = request(
          {
            socketPath,
            path,
            method,
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
      const max = pulling ? 16 * 1024 * 1024 : 2 * 1024 * 1024;
      const length = response.headers["content-length"];
      if (
        (response.headers["content-encoding"] &&
          response.headers["content-encoding"] !== "identity") ||
        (length !== undefined && (!/^[0-9]+$/.test(length) || Number(length) > max))
      )
        throw fail();
      const result = await work(response, controller.signal);
      controller.signal.throwIfAborted();
      if (!response.complete) throw fail();
      return result;
    } catch {
      signal.throwIfAborted();
      throw fail();
    } finally {
      response?.destroy();
      req?.destroy();
      if (closed) await closed;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  }
  async function json(
    path: string,
    signal: AbortSignal,
    allowMissing = false,
  ): Promise<Record<string, unknown> | null> {
    return exchange("GET", path, signal, false, async (response, active) => {
      if (response.statusCode !== 200 && !(allowMissing && response.statusCode === 404))
        throw fail();
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of response) {
        active.throwIfAborted();
        size += chunk.length;
        if (size > 2 * 1024 * 1024) throw fail();
        chunks.push(Buffer.from(chunk));
      }
      const length = response.headers["content-length"];
      if (length !== undefined && Number(length) !== size) throw fail();
      if (response.statusCode === 404) return null;
      const value: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size)),
      );
      if (!value || typeof value !== "object" || Array.isArray(value)) throw fail();
      return value as Record<string, unknown>;
    });
  }
  return {
    async engine(signal) {
      const version = await json("/version", signal),
        info = await json(`/${DOCKER_API}/info`, signal);
      if (
        !version ||
        !info ||
        version.Os !== "linux" ||
        !(architecture === "arm64" ? ["arm64", "aarch64"] : ["amd64", "x86_64"]).includes(
          String(version.Arch),
        ) ||
        typeof info.ID !== "string" ||
        !/^[A-Za-z0-9_:-]{1,256}$/.test(info.ID) ||
        typeof info.OperatingSystem !== "string" ||
        !/^Docker Desktop(?:\s|$)/.test(info.OperatingSystem)
      )
        throw fail();
      return { id: info.ID, operatingSystem: "linux", architecture };
    },
    async inspect(input, signal) {
      const pin = ImagePin.parse(input);
      return json(`/${DOCKER_API}/images/${encodeURIComponent(imageRef(pin))}/json`, signal, true);
    },
    async pull(input, signal, report) {
      const pin = ImagePin.parse(input);
      if (!pin.platforms.includes(`linux/${architecture}`)) throw fail();
      const query = new URLSearchParams({
        fromImage: imageRef(pin),
        platform: `linux/${architecture}`,
      });
      await exchange(
        "POST",
        `/${DOCKER_API}/images/create?${query}`,
        signal,
        true,
        async (response, active) => {
          if (response.statusCode !== 200) throw fail();
          let received = 0;
          async function* body() {
            for await (const chunk of response) {
              received += chunk.length;
              yield Buffer.from(chunk);
            }
          }
          await readImagePullProgress(body(), active, report);
          const length = response.headers["content-length"];
          if (length !== undefined && Number(length) !== received) throw fail();
        },
      );
    },
  };
}
