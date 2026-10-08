import { type IncomingMessage, request } from "node:http";
import type { CanaryRole } from "../../../../packages/protocol/src/canary-operation.ts";
import { DOCKER_API, dockerSocketPath } from "../../../daemon/src/cells/docker.ts";
import type { CanaryCleanupClient } from "./canary-cleanup.ts";
import { installImageClient } from "./image-client.ts";

const failure = () => new Error("Diagnostic cleanup transport failed.");
const id = /^[a-f0-9]{64}$/;
function resourceName(role: CanaryRole, name: string) {
  return new RegExp(`^localdot-canary-[a-f0-9]{32}-${role}$`).test(name);
}
function prefix(role: CanaryRole) {
  if (role === "desktop" || role === "gate") return "containers";
  if (role === "internal" || role === "egress") return "networks";
  if (role === "home") return "volumes";
  throw failure();
}
/** Cleanup-only local Docker transport. No create, exec, start, image pulls, force flag or
 * filesystem path is exposed. Reads and mutations retain ownership until actual request close.
 */
export function canaryCleanupClient(socketInput: string): CanaryCleanupClient {
  const socketPath = dockerSocketPath({ DOCKER_HOST: `unix://${socketInput}` }),
    images = installImageClient(socketPath);
  async function exchange(method: "GET" | "POST" | "DELETE", suffix: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const controller = new AbortController(),
      abort = () => controller.abort(failure());
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const timer = setTimeout(abort, 10_000);
    let req: ReturnType<typeof request> | undefined,
      response: IncomingMessage | undefined,
      closed: Promise<void> | undefined;
    let result: unknown = null;
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
              accept: "application/json",
              "accept-encoding": "identity",
              ...(method === "GET" ? {} : { "content-length": "0" }),
            },
          },
          resolve,
        );
        closed = new Promise<void>((done) => req?.once("close", done));
        req.once("error", reject);
        req.end();
      });
      const length = response.headers["content-length"];
      if (
        (response.headers["content-encoding"] &&
          response.headers["content-encoding"] !== "identity") ||
        (length !== undefined && (!/^[0-9]+$/.test(length) || Number(length) > 4 * 1024 * 1024))
      )
        throw failure();
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const data of response) {
        controller.signal.throwIfAborted();
        size += data.length;
        if (size > 4 * 1024 * 1024) throw failure();
        chunks.push(Buffer.from(data));
      }
      controller.signal.throwIfAborted();
      if (!response.complete || (length !== undefined && Number(length) !== size)) throw failure();
      const status = response.statusCode;
      // Mutation callers still prove absence by fresh inspection after a 404.
      if (status !== 404 && method !== "GET") {
        if (size !== 0 || (status !== 204 && !(method === "POST" && status === 304)))
          throw failure();
      } else if (status !== 404) {
        if (
          status !== 200 ||
          !/^application\/json(?:;\s*charset=utf-8)?$/i.test(response.headers["content-type"] ?? "")
        )
          throw failure();
        result = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
        ) as unknown;
        if (result === null || typeof result !== "object") throw failure();
      }
    } catch {
      throw failure();
    } finally {
      response?.destroy();
      req?.destroy();
      await closed;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
    if (controller.signal.aborted) throw failure();
    return result;
  }
  return {
    engine: (s) => images.engine(s),
    inspect(role, reference, signal) {
      const kind = prefix(role);
      if (
        role === "home"
          ? !resourceName(role, reference)
          : !id.test(reference) && !resourceName(role, reference)
      )
        throw failure();
      return exchange(
        "GET",
        `/${kind}/${reference}${kind === "containers" ? "/json" : ""}`,
        signal,
      );
    },
    async stop(reference, signal) {
      if (!id.test(reference)) throw failure();
      await exchange("POST", `/containers/${reference}/stop?t=3`, signal);
    },
    async remove(role, reference, signal) {
      const kind = prefix(role);
      if (role === "home" ? !resourceName(role, reference) : !id.test(reference)) throw failure();
      await exchange("DELETE", `/${kind}/${reference}`, signal);
    },
    volumeReferences(name, signal) {
      if (!resourceName("home", name)) throw failure();
      const query = new URLSearchParams({
        all: "true",
        filters: JSON.stringify({ volume: [name] }),
      });
      return exchange("GET", `/containers/json?${query}`, signal);
    },
  };
}
