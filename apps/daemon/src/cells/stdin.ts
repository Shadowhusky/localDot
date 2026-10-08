import { request } from "node:http";
import type { Duplex } from "node:stream";
import { DOCKER_API, type DockerClient } from "./docker.ts";

export const CONTAINER_INPUT_BYTES = 32768;
export const CONTAINER_INPUT_MS = 10000;

export class ContainerInputError extends Error {
  constructor() {
    super("Browser private input handoff failed");
  }
}

export function sendContainerInput(
  docker: Pick<DockerClient, "socketPath">,
  containerId: string,
  input: Buffer,
  signal: AbortSignal,
): Promise<void> {
  if (
    !/^[a-f0-9]{64}$/u.test(containerId) ||
    !docker.socketPath ||
    !Buffer.isBuffer(input) ||
    input.length < 1 ||
    input.length > CONTAINER_INPUT_BYTES ||
    signal.aborted
  )
    return Promise.reject(new ContainerInputError());
  const bytes = Buffer.from(input);
  return new Promise((resolve, reject) => {
    let settled = false;
    let stream: Duplex | undefined;
    let pending: ReturnType<typeof request> | undefined;
    const retired = new WeakSet<object>();
    const retire = (owner: { destroy(): unknown } | undefined): boolean => {
      if (!owner || retired.has(owner)) return true;
      retired.add(owner);
      try {
        owner.destroy();
        return true;
      } catch {
        return false;
      }
    };
    const finish = (success: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      signal.removeEventListener("abort", fail);
      const streamClosed = retire(stream);
      const requestClosed = retire(pending);
      bytes.fill(0);
      if (success && streamClosed && requestClosed) resolve();
      else reject(new ContainerInputError());
    };
    const fail = () => finish(false);
    const deadline = setTimeout(fail, CONTAINER_INPUT_MS);
    signal.addEventListener("abort", fail, { once: true });
    try {
      pending = request({
        socketPath: docker.socketPath,
        path: `/${DOCKER_API}/containers/${containerId}/attach?stream=1&stdin=1&stdout=0&stderr=0`,
        method: "POST",
        agent: false,
        headers: {
          host: "docker",
          connection: "Upgrade",
          upgrade: "tcp",
          "content-type": "text/plain",
          "content-length": "0",
        },
      });
      pending.once("response", (response) => {
        response.on("error", () => {});
        retire(response);
        fail();
      });
      pending.once("error", fail);
      pending.once("upgrade", (response, socket, head) => {
        socket.on("error", fail);
        socket.once("close", () => {
          if (!settled) fail();
        });
        if (settled) {
          retire(socket);
          return;
        }
        stream = socket;
        if (signal.aborted || response.statusCode !== 101 || head.length) {
          fail();
          return;
        }
        socket.on("data", fail);
        try {
          socket.end(bytes, () => finish(true));
        } catch {
          fail();
        }
      });
      if (settled) retire(pending);
      else if (signal.aborted) fail();
      else pending.end();
    } catch {
      fail();
      retire(pending);
    }
  });
}
