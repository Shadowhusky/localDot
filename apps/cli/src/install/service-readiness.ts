import { type IncomingMessage, request } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import {
  ManagedServiceIdentity,
  ServiceProcessIdentity,
  ServiceReadinessReply,
  sameManagedService,
} from "../../../../packages/protocol/src/install-services.ts";
import { readInstallToken } from "../../../daemon/src/install-token-reader.ts";

export interface ExpectedServices {
  home: string;
  port: number;
  identity: ManagedServiceIdentity;
  daemonPid: number;
  keydPid: number;
}
const failure = () => new Error("The installed services have not confirmed release readiness.");
export class ServiceNotReadyError extends Error {
  constructor() {
    super("The installed services have not confirmed release readiness.");
  }
}

/** A bounded authenticated observation, never a healthz shortcut. The lifecycle supplies PIDs
 * returned by its owned launch operations and must separately verify Docker/isolation before
 * committing an update. This function never logs authority or follows redirects/proxies.
 */
export async function verifyServiceReadiness(
  input: ExpectedServices,
  signal: AbortSignal,
): Promise<ServiceReadinessReply> {
  signal.throwIfAborted();
  const expected = { ...input, identity: ManagedServiceIdentity.parse(input.identity) };
  if (!Number.isInteger(expected.port) || expected.port < 1024 || expected.port > 65535)
    throw failure();
  ServiceProcessIdentity.parse({ ...expected.identity, pid: expected.daemonPid });
  ServiceProcessIdentity.parse({ ...expected.identity, pid: expected.keydPid });
  const controller = new AbortController(),
    abort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const timer = setTimeout(() => controller.abort(failure()), 10_000);
  let req: ReturnType<typeof request> | undefined, response: IncomingMessage | undefined;
  let closed: Promise<void> | undefined;
  try {
    const token = readInstallToken(expected.home);
    controller.signal.throwIfAborted();
    response = await new Promise<IncomingMessage>((resolve, reject) => {
      req = request(
        {
          hostname: "127.0.0.1",
          port: expected.port,
          path: "/api/service/ready",
          method: "GET",
          agent: false,
          signal: controller.signal,
          headers: {
            host: `127.0.0.1:${expected.port}`,
            authorization: `Bearer ${token}`,
            accept: "application/json",
            "accept-encoding": "identity",
            "cache-control": "no-store",
          },
        },
        resolve,
      );
      closed = new Promise<void>((done) => req?.once("close", done));
      req.once("error", reject);
      req.end();
    });
    const length = response.headers["content-length"];
    if (response.statusCode === 503) throw new ServiceNotReadyError();
    if (
      response.statusCode !== 200 ||
      !/^application\/json(?:;\s*charset=utf-8)?$/i.test(response.headers["content-type"] ?? "") ||
      (response.headers["content-encoding"] !== undefined &&
        response.headers["content-encoding"] !== "identity") ||
      (length !== undefined && (!/^[0-9]+$/.test(length) || Number(length) > 8192))
    )
      throw failure();
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of response) {
      controller.signal.throwIfAborted();
      const body = Buffer.from(chunk);
      bytes += body.length;
      if (bytes > 8192) throw failure();
      chunks.push(body);
    }
    controller.signal.throwIfAborted();
    if (!response.complete || (length !== undefined && Number(length) !== bytes)) throw failure();
    const reply = ServiceReadinessReply.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))),
    );
    if (
      !reply.ready ||
      !sameManagedService(expected.identity, reply.service) ||
      reply.service.pid !== expected.daemonPid ||
      reply.keyd?.service.pid !== expected.keydPid ||
      !sameManagedService(expected.identity, reply.keyd.service)
    )
      throw failure();
    return reply;
  } catch (error) {
    signal.throwIfAborted();
    if (
      error instanceof ServiceNotReadyError ||
      controller.signal.aborted ||
      (error instanceof Error &&
        "code" in error &&
        ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT"].includes(String(error.code)))
    )
      throw new ServiceNotReadyError();
    throw failure();
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    response?.destroy();
    req?.destroy();
    await closed;
  }
}

/** A newly kicked service can still be recovering or not listening yet. Only transient startup
 * failures are retried, under one overall deadline; invalid identities/authentication never retry.
 */
export async function waitForServiceReadiness(input: ExpectedServices, signal: AbortSignal) {
  signal.throwIfAborted();
  const expected = { ...input, identity: ManagedServiceIdentity.parse(input.identity) };
  const pending = AbortSignal.any([signal, AbortSignal.timeout(180_000)]);
  try {
    for (;;) {
      pending.throwIfAborted();
      try {
        return await verifyServiceReadiness(expected, pending);
      } catch (error) {
        pending.throwIfAborted();
        if (!(error instanceof ServiceNotReadyError)) throw error;
        await delay(500, undefined, { signal: pending });
      }
    }
  } catch {
    signal.throwIfAborted();
    throw failure();
  }
}
