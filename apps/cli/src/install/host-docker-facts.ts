import { type IncomingMessage, request } from "node:http";
import { dockerSocketPath } from "../../../daemon/src/cells/docker.ts";
import type { DockerFacts } from "./preflight.ts";

const failure = () => new Error("Docker Desktop prerequisites could not be verified.");
const MAX_BYTES = 1024 * 1024;

async function get(socketPath: string, path: "/version" | "/info", signal: AbortSignal) {
  signal.throwIfAborted();
  let req: ReturnType<typeof request> | undefined, response: IncomingMessage | undefined;
  let closed: Promise<void> | undefined;
  let result: Record<string, unknown> | undefined;
  try {
    response = await new Promise<IncomingMessage>((resolve, reject) => {
      req = request(
        {
          socketPath,
          path,
          method: "GET",
          agent: false,
          signal,
          headers: { host: "docker", accept: "application/json", "accept-encoding": "identity" },
        },
        resolve,
      );
      closed = new Promise<void>((done) => req?.once("close", done));
      req.once("error", reject);
      req.end();
    });
    const length = response.headers["content-length"];
    if (
      response.statusCode !== 200 ||
      !/^application\/json(?:;\s*charset=utf-8)?$/i.test(response.headers["content-type"] ?? "") ||
      (response.headers["content-encoding"] !== undefined &&
        response.headers["content-encoding"] !== "identity") ||
      (length !== undefined && (!/^[0-9]+$/.test(length) || Number(length) > MAX_BYTES))
    )
      throw failure();
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response) {
      signal.throwIfAborted();
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > MAX_BYTES) throw failure();
      chunks.push(bytes);
    }
    signal.throwIfAborted();
    if (!response.complete || (length !== undefined && Number(length) !== size)) throw failure();
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    );
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw failure();
    result = value as Record<string, unknown>;
  } finally {
    response?.destroy();
    req?.destroy();
    await closed;
  }
  signal.throwIfAborted();
  if (!result) throw failure();
  return result;
}

/** Fixed read-only Unix-socket probes. Failure/cancellation drains BOTH actual
 * request closures before the caller can release its install scope. No redirects,
 * DNS, ambient proxy, pooled socket or unbounded body. */
export async function readHostDockerFacts(
  socketInput: string,
  callerSignal: AbortSignal,
): Promise<DockerFacts> {
  const socketPath = dockerSocketPath({ DOCKER_HOST: `unix://${socketInput}` });
  const controller = new AbortController(),
    abort = () => controller.abort(failure());
  callerSignal.addEventListener("abort", abort, { once: true });
  if (callerSignal.aborted) abort();
  const timer = setTimeout(abort, 2500),
    active = controller.signal;
  const requests = [get(socketPath, "/version", active), get(socketPath, "/info", active)];
  let facts: DockerFacts | undefined;
  try {
    const [version, info] = await Promise.all(requests);
    active.throwIfAborted();
    if (!version || !info) throw failure();
    facts = {
      version: version.Version,
      apiVersion: version.ApiVersion,
      minimumApiVersion: version.MinAPIVersion,
      operatingSystem: version.Os,
      architecture: version.Arch,
      desktop:
        typeof info.OperatingSystem === "string" &&
        /^Docker Desktop(?:\s|$)/.test(info.OperatingSystem),
      memoryBytes: info.MemTotal,
    };
  } catch {
    throw failure();
  } finally {
    abort();
    await Promise.allSettled(requests);
    clearTimeout(timer);
    callerSignal.removeEventListener("abort", abort);
  }
  if (callerSignal.aborted || !facts) throw failure();
  return facts;
}
