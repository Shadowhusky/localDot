import { type IncomingMessage, request } from "node:http";
import { isDeepStrictEqual as equal } from "node:util";
import {
  CanaryOperation,
  canaryResourceLabels,
  canaryResourceName,
} from "../../../../packages/protocol/src/canary-operation.ts";
import { CanaryReady } from "../../../../packages/protocol/src/canary-process.ts";
import { ImagePin } from "../../../../packages/protocol/src/release.ts";
import { DOCKER_API, dockerSocketPath } from "../../../daemon/src/cells/docker.ts";
import { tar } from "../../../daemon/src/cells/tar.ts";
import type { CellRecord } from "../../../daemon/src/cells/types.ts";
import { canaryCleanupClient } from "./canary-cleanup-client.ts";
import type { CanaryTopologyClient } from "./canary-topology.ts";
import {
  canaryContainerSpec,
  canaryNetworkSpec,
  inspectCanaryHome,
  privateCanaryAddress,
} from "./canary-topology-spec.ts";
import { installImageClient } from "./image-client.ts";

const failure = () => new Error("Diagnostic preparation transport failed.");
const id = /^[a-f0-9]{64}$/;
/** Fixed topology-only mutations for one journal-owned operation. No arbitrary body, mount,
 * exec, image pull, external URL or force removal interface. All requests drain actual close.
 */
export function canaryTopologyClient(
  socketInput: string,
  input: CanaryOperation,
  inputReady: CanaryReady,
): CanaryTopologyClient {
  const operation = CanaryOperation.parse(input),
    socketPath = dockerSocketPath({ DOCKER_HOST: `unix://${socketInput}` }),
    cleanup = canaryCleanupClient(socketPath),
    images = installImageClient(socketPath);
  const hello = CanaryReady.parse(inputReady);
  if (
    operation.phase !== "active" ||
    operation.runId !== hello.runId ||
    operation.cellId !== hello.cellId
  )
    throw failure();
  const issued = new Set<string>(),
    made = new Map<string, string>();
  const started = new Set<string>();
  let geometry: CellRecord | undefined,
    wired = false,
    connected = false,
    homeCreated = false,
    poisoned = false;
  function once(action: string) {
    if (poisoned || issued.has(action)) throw failure();
    issued.add(action);
  }
  function remember(role: string, value: unknown) {
    if (
      value === null ||
      typeof value !== "object" ||
      !("Id" in value) ||
      typeof value.Id !== "string" ||
      !id.test(value.Id)
    ) {
      poisoned = true;
      throw failure();
    }
    made.set(role, value.Id);
    return value;
  }
  const pins = Object.fromEntries(
    (["desktop", "gate"] as const).map((role) => {
      const [repository, digest] = operation.images[role].ref.split("@");
      return [role, ImagePin.parse({ repository, digest, platforms: ["linux/arm64"] })];
    }),
  );
  async function send(
    method: "POST" | "PUT",
    path: string,
    body: unknown | Buffer,
    status: 200 | 201 | 204,
    signal: AbortSignal,
  ) {
    if (signal.aborted) {
      poisoned = true;
      throw failure();
    }
    const archive = Buffer.isBuffer(body),
      payload = archive
        ? Buffer.from(body)
        : body === undefined
          ? undefined
          : Buffer.from(JSON.stringify(body));
    if (payload && payload.length > 256 * 1024) throw failure();
    const controller = new AbortController(),
      abort = () => controller.abort(failure());
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const timer = setTimeout(abort, 30_000);
    let req: ReturnType<typeof request> | undefined,
      response: IncomingMessage | undefined,
      closed: Promise<void> | undefined;
    let result: unknown;
    try {
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
      const length = response.headers["content-length"];
      if (
        (response.headers["content-encoding"] &&
          response.headers["content-encoding"] !== "identity") ||
        (length !== undefined && (!/^[0-9]+$/.test(length) || Number(length) > 4 * 1024 * 1024))
      )
        throw failure();
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of response) {
        controller.signal.throwIfAborted();
        size += chunk.length;
        if (size > 4 * 1024 * 1024) throw failure();
        chunks.push(Buffer.from(chunk));
      }
      controller.signal.throwIfAborted();
      if (
        !response.complete ||
        response.statusCode !== status ||
        (length !== undefined && Number(length) !== size)
      )
        throw failure();
      if (status === 201) {
        if (
          !/^application\/json(?:;\s*charset=utf-8)?$/i.test(response.headers["content-type"] ?? "")
        )
          throw failure();
        result = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
        ) as unknown;
        if (result === null || typeof result !== "object" || Array.isArray(result)) throw failure();
      } else if (size !== 0) throw failure();
    } catch {
      poisoned = true;
      throw failure();
    } finally {
      response?.destroy();
      req?.destroy();
      await closed;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
    if (controller.signal.aborted) {
      poisoned = true;
      throw failure();
    }
    return result;
  }
  return {
    engine: cleanup.engine,
    inspect: cleanup.inspect,
    image: (role, signal) => images.inspect(ImagePin.parse(pins[role]), signal),
    async createNetwork(role, signal) {
      if (role !== "internal" && role !== "egress") throw failure();
      once(`create:${role}`);
      return remember(
        role,
        await send("POST", "/networks/create", canaryNetworkSpec(operation, role), 201, signal),
      );
    },
    createHome: async (signal) => {
      once("create:home");
      try {
        const value = inspectCanaryHome(
          operation,
          await send(
            "POST",
            "/volumes/create",
            {
              Name: canaryResourceName(operation.runId, "home"),
              Driver: "local",
              Labels: canaryResourceLabels(operation, "home"),
            },
            201,
            signal,
          ),
        );
        homeCreated = true;
        return value;
      } catch {
        poisoned = true;
        throw failure();
      }
    },
    async createContainer(role, inputRecord, signal) {
      const record = structuredClone(inputRecord),
        spec = canaryContainerSpec(operation, record, role);
      if (record.keydPort !== hello.port || (geometry !== undefined && !equal(record, geometry)))
        throw failure();
      if (!made.has("internal") || !made.has("egress") || !homeCreated) throw failure();
      once(`create:${role}`);
      geometry = record;
      const query = new URLSearchParams({ name: canaryResourceName(operation.runId, role) });
      return remember(role, await send("POST", `/containers/create?${query}`, spec, 201, signal));
    },
    async wireDesktop(desktopId, inputReady, signal) {
      const ready = CanaryReady.parse(inputReady);
      if (desktopId !== made.get("desktop") || !equal(ready, hello)) throw failure();
      once("wire");
      const archive = tar(
        [
          { name: "proxy-token", data: `${ready.proxyToken}\n` },
          { name: "ca.pem", data: ready.caCertPem },
          {
            name: "surrogates.sh",
            data: `# Diagnostic surrogate; upstream secret remains in keyd.\nexport LOCALDOT_KEY_DIAGNOSTIC='${ready.surrogate}'\n`,
          },
        ],
        0,
      );
      await send(
        "PUT",
        `/containers/${desktopId}/archive?path=%2Fetc%2Flocaldot%2Fcell&noOverwriteDirNonDir=true`,
        archive,
        200,
        signal,
      );
      wired = true;
    },
    async start(containerId, signal) {
      const role =
        containerId === made.get("gate")
          ? "gate"
          : containerId === made.get("desktop")
            ? "desktop"
            : undefined;
      if (!role || !wired || (role === "desktop" && !connected)) throw failure();
      once(`start:${role}`);
      await send("POST", `/containers/${containerId}/start`, undefined, 204, signal);
      started.add(role);
    },
    async connect(networkId, gateId, address, signal) {
      if (
        networkId !== made.get("internal") ||
        gateId !== made.get("gate") ||
        !privateCanaryAddress(address) ||
        address !== geometry?.docker.gateInternalIp ||
        !started.has("gate")
      )
        throw failure();
      once("connect");
      await send(
        "POST",
        `/networks/${networkId}/connect`,
        { Container: gateId, EndpointConfig: { IPAMConfig: { IPv4Address: address } } },
        200,
        signal,
      );
      connected = true;
    },
  };
}
