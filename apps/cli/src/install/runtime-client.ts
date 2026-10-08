import { type IncomingMessage, request } from "node:http";
import {
  DOCKER_API,
  type DockerClient,
  DockerError,
  type DockerRequest,
  dockerSocketPath,
} from "../../../daemon/src/cells/docker.ts";

const failure = () => new Error("Computer runtime transport could not be confirmed.");
const name = /^[A-Za-z0-9][A-Za-z0-9_.-]{1,199}$/;
const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** Only stopped-runtime preparation operations. No start/exec/kill, image pulls, network mutation,
 * volume deletion or force flags. Every exchange retains ownership until the request closes,
 * including cancellation and a lost create/delete reply. The caller retains its service leases. */
export function installRuntimeClient(
  socketInput: string,
  signal: AbortSignal,
): Pick<DockerClient, "request"> {
  const socket = dockerSocketPath({ DOCKER_HOST: `unix://${socketInput}` });
  return {
    request: async <T>(input: DockerRequest): Promise<T> => {
      try {
        return await exchange<T>(input);
      } catch (error) {
        if (error instanceof DockerError && error.status === 404) throw error;
        throw failure();
      }
    },
  };
  async function exchange<T>(input: DockerRequest): Promise<T> {
    signal.throwIfAborted();
    const req = structuredClone(input);
    if (req.raw !== undefined || req.timeoutMs !== undefined) throw failure();
    let body: string | undefined;
    if (req.method === "GET") {
      if (req.body !== undefined) throw failure();
      if (req.path === "/containers/json") {
        if (
          !req.query ||
          Object.keys(req.query).sort().join() !== "all,filters" ||
          req.query.all !== "true"
        )
          throw failure();
        const filters: unknown = JSON.parse(req.query.filters ?? "null");
        if (
          !object(filters) ||
          Object.keys(filters).join() !== "volume" ||
          !Array.isArray(filters.volume) ||
          filters.volume.length !== 1 ||
          typeof filters.volume[0] !== "string" ||
          !name.test(filters.volume[0])
        )
          throw failure();
      } else if (req.path.startsWith("/images/")) {
        const match = /^\/images\/([^/]+)\/json$/.exec(req.path),
          pin = decodeURIComponent(match?.[1] ?? "");
        if (
          !/^[a-z0-9][a-z0-9./:_-]+@sha256:[a-f0-9]{64}$/.test(pin) ||
          encodeURIComponent(pin) !== match?.[1] ||
          req.query !== undefined
        )
          throw failure();
      } else {
        const match = /^\/(containers|networks|volumes)\/([A-Za-z0-9_.-]+)(\/json)?$/.exec(
          req.path,
        );
        if (
          !match ||
          !name.test(match[2] ?? "") ||
          (match[1] === "containers") !== (match[3] === "/json") ||
          req.query !== undefined
        )
          throw failure();
      }
    } else if (req.method === "DELETE") {
      if (
        !/^\/containers\/[a-f0-9]{64}$/.test(req.path) ||
        req.query !== undefined ||
        req.body !== undefined
      )
        throw failure();
    } else if (req.method === "POST") {
      if (
        req.path !== "/containers/create" ||
        !req.query ||
        Object.keys(req.query).join() !== "name" ||
        !name.test(req.query.name ?? "") ||
        !object(req.body)
      )
        throw failure();
      body = JSON.stringify(req.body);
      if (Buffer.byteLength(body) > 256 * 1024) throw failure();
    } else throw failure();
    const path = `/${DOCKER_API}${req.path}${req.query ? `?${new URLSearchParams(req.query)}` : ""}`;
    const controller = new AbortController(),
      abort = () => controller.abort(failure());
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const timer = setTimeout(abort, 30_000);
    let transport: ReturnType<typeof request> | undefined,
      response: IncomingMessage | undefined,
      closed: Promise<void> | undefined;
    try {
      response = await new Promise<IncomingMessage>((resolve, reject) => {
        transport = request(
          {
            socketPath: socket,
            method: req.method,
            path,
            agent: false,
            signal: controller.signal,
            headers: {
              host: "docker",
              accept: "application/json",
              "accept-encoding": "identity",
              ...(body === undefined
                ? {}
                : {
                    "content-type": "application/json",
                    "content-length": Buffer.byteLength(body),
                  }),
            },
          },
          resolve,
        );
        closed = new Promise<void>((done) => transport?.once("close", done));
        transport.once("error", reject);
        transport.end(body);
      });
      const length = response.headers["content-length"];
      if (
        (response.headers["content-encoding"] &&
          response.headers["content-encoding"] !== "identity") ||
        (length !== undefined && (!/^[0-9]+$/.test(length) || Number(length) > 4 * 1024 * 1024))
      )
        throw failure();
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of response) {
        controller.signal.throwIfAborted();
        size += chunk.length;
        if (size > 4 * 1024 * 1024) throw failure();
        chunks.push(Buffer.from(chunk));
      }
      controller.signal.throwIfAborted();
      if (!response.complete || (length !== undefined && Number(length) !== size)) throw failure();
      const status = response.statusCode ?? 0;
      if (status === 404) throw new DockerError(404, "runtime object unavailable", req.path);
      if (req.method === "DELETE") {
        if (status !== 204 || size !== 0) throw failure();
        return undefined as T;
      }
      if (
        status !== (req.method === "POST" ? 201 : 200) ||
        !/^application\/json(?:;\s*charset=utf-8)?$/i.test(response.headers["content-type"] ?? "")
      )
        throw failure();
      const result: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
      );
      if (!object(result) && !Array.isArray(result)) throw failure();
      return result as T;
    } catch (error) {
      if (error instanceof DockerError && error.status === 404 && !controller.signal.aborted)
        throw error;
      throw failure();
    } finally {
      response?.destroy();
      transport?.destroy();
      await closed;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  }
}
