import { type IncomingMessage, request } from "node:http";
import { DOCKER_API, dockerSocketPath } from "../../../daemon/src/cells/docker.ts";
import { isolatedNetworkSpec } from "../../../daemon/src/cells/spec.ts";
import { type ImageEngine, installImageClient } from "./image-client.ts";

export interface IsolationProbe {
  owner: string;
  nonce: string;
  name: string;
  engineId: string;
}
export interface InstallNetworkClient {
  engine(signal: AbortSignal): Promise<ImageEngine>;
  inspect(reference: string, signal: AbortSignal): Promise<unknown | null>;
  create(probe: IsolationProbe, signal: AbortSignal): Promise<unknown>;
  remove(id: string, signal: AbortSignal): Promise<void>;
}
const failure = () => new Error("The Docker isolation probe could not be completed.");
export const probeName = (owner: string, nonce: string) =>
  `localdot-install-probe-${owner}-${nonce}`;
export function checkedProbe(probe: IsolationProbe): IsolationProbe {
  if (
    !/^[a-f0-9]{32}$/.test(probe.owner) ||
    !/^[a-f0-9]{32}$/.test(probe.nonce) ||
    probe.name !== probeName(probe.owner, probe.nonce) ||
    !/^[A-Za-z0-9_:-]{1,256}$/.test(probe.engineId)
  )
    throw failure();
  return { ...probe };
}
export function probeLabels(probe: IsolationProbe) {
  return { "localdot.install-owner": probe.owner, "localdot.install-probe": probe.nonce };
}

/** Only an empty internal probe network can be created. No container attachment, external
 * address, exec, arbitrary network body or removal by name is exposed. Await actual close.
 */
export function installNetworkClient(socketInput: string): InstallNetworkClient {
  const socketPath = dockerSocketPath({ DOCKER_HOST: `unix://${socketInput}` }),
    images = installImageClient(socketPath);
  async function exchange(
    method: "GET" | "POST" | "DELETE",
    path: string,
    signal: AbortSignal,
    body?: unknown,
  ) {
    signal.throwIfAborted();
    const controller = new AbortController(),
      abort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const timer = setTimeout(() => controller.abort(failure()), 10_000);
    let req: ReturnType<typeof request> | undefined,
      response: IncomingMessage | undefined,
      closed: Promise<void> | undefined;
    try {
      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      response = await new Promise<IncomingMessage>((resolve, reject) => {
        req = request(
          {
            socketPath,
            path: `/${DOCKER_API}${path}`,
            method,
            agent: false,
            signal: controller.signal,
            headers: {
              host: "docker",
              accept: "application/json",
              "accept-encoding": "identity",
              ...(payload
                ? { "content-type": "application/json", "content-length": String(payload.length) }
                : method === "DELETE"
                  ? { "content-length": "0" }
                  : {}),
            },
          },
          resolve,
        );
        closed = new Promise<void>((done) => req?.once("close", done));
        req.once("error", reject);
        req.end(payload);
      });
      const length = response.headers["content-length"];
      if (
        (response.headers["content-encoding"] &&
          response.headers["content-encoding"] !== "identity") ||
        (length !== undefined && (!/^[0-9]+$/.test(length) || Number(length) > 1024 * 1024))
      )
        throw failure();
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of response) {
        controller.signal.throwIfAborted();
        size += chunk.length;
        if (size > 1024 * 1024) throw failure();
        chunks.push(Buffer.from(chunk));
      }
      controller.signal.throwIfAborted();
      if (!response.complete || (length !== undefined && Number(length) !== size)) throw failure();
      if ((method === "GET" || method === "DELETE") && response.statusCode === 404) return null;
      if (method === "DELETE") {
        if (response.statusCode !== 204) throw failure();
        return null;
      }
      if (
        response.statusCode !== (method === "POST" ? 201 : 200) ||
        !/^application\/json(?:;\s*charset=utf-8)?$/i.test(response.headers["content-type"] ?? "")
      )
        throw failure();
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
      ) as unknown;
    } catch {
      signal.throwIfAborted();
      throw failure();
    } finally {
      response?.destroy();
      req?.destroy();
      await closed;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  }
  return {
    engine: (signal) => images.engine(signal),
    inspect(reference, signal) {
      if (
        !/^[a-f0-9]{64}$/.test(reference) &&
        !/^localdot-install-probe-[a-f0-9]{32}-[a-f0-9]{32}$/.test(reference)
      )
        throw failure();
      return exchange("GET", `/networks/${reference}`, signal);
    },
    create(input, signal) {
      const probe = checkedProbe(input);
      return exchange("POST", "/networks/create", signal, {
        ...isolatedNetworkSpec(probe.name),
        CheckDuplicate: true,
        Labels: probeLabels(probe),
      });
    },
    async remove(id, signal) {
      if (!/^[a-f0-9]{64}$/.test(id)) throw failure();
      await exchange("DELETE", `/networks/${id}`, signal);
    },
  };
}
