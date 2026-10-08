import { randomUUID } from "node:crypto";
import { type IncomingMessage, request } from "node:http";
import {
  DoctorSelfTestsReply,
  DoctorSelfTestsRequest,
} from "../../../../packages/protocol/src/doctor-selftests.ts";
import {
  ServiceProcessIdentity,
  sameManagedService,
} from "../../../../packages/protocol/src/install-services.ts";
import { readInstallToken } from "../../../daemon/src/install-token-reader.ts";
import type { ExpectedServices } from "./service-readiness.ts";

const failure = () => new Error("Fresh computer self-tests could not be confirmed.");
export async function requestDoctorSelfTests(
  input: ExpectedServices & { bootId: string },
  signal: AbortSignal,
) {
  const expected = structuredClone(input);
  signal.throwIfAborted();
  const identity = ServiceProcessIdentity.parse({ ...expected.identity, pid: expected.daemonPid });
  if (
    !Number.isInteger(expected.port) ||
    expected.port < 1024 ||
    expected.port > 65535 ||
    !/^[0-9a-f-]{36}$/i.test(expected.bootId)
  )
    throw failure();
  const body = DoctorSelfTestsRequest.parse({ v: 1, requestId: randomUUID() });
  const bytes = Buffer.from(JSON.stringify(body)),
    token = readInstallToken(expected.home);
  const controller = new AbortController(),
    abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const timer = setTimeout(abort, 100_000);
  let req: ReturnType<typeof request> | undefined,
    response: IncomingMessage | undefined,
    closed: Promise<void> | undefined,
    result: DoctorSelfTestsReply | undefined;
  try {
    controller.signal.throwIfAborted();
    response = await new Promise<IncomingMessage>((resolve, reject) => {
      req = request(
        {
          hostname: "127.0.0.1",
          port: expected.port,
          path: "/api/service/self-tests",
          method: "POST",
          agent: false,
          signal: controller.signal,
          headers: {
            host: `127.0.0.1:${expected.port}`,
            authorization: `Bearer ${token}`,
            accept: "application/json",
            "content-type": "application/json",
            "accept-encoding": "identity",
            "content-length": String(bytes.length),
            "cache-control": "no-store",
          },
        },
        resolve,
      );
      closed = new Promise<void>((done) => req?.once("close", done));
      req.once("error", reject);
      req.end(bytes);
    });
    const length = response.headers["content-length"];
    if (
      response.statusCode !== 200 ||
      !/^application\/json(?:;\s*charset=utf-8)?$/i.test(response.headers["content-type"] ?? "") ||
      (response.headers["content-encoding"] !== undefined &&
        response.headers["content-encoding"] !== "identity") ||
      (length !== undefined && (!/^[0-9]+$/.test(length) || Number(length) > 65536))
    )
      throw failure();
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response) {
      controller.signal.throwIfAborted();
      const b = Buffer.from(chunk);
      size += b.length;
      if (size > 65536) throw failure();
      chunks.push(b);
    }
    controller.signal.throwIfAborted();
    if (!response.complete || (length !== undefined && Number(length) !== size)) throw failure();
    result = DoctorSelfTestsReply.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))),
    );
    if (
      result.requestId !== body.requestId ||
      result.bootId !== expected.bootId ||
      result.service.pid !== identity.pid ||
      !sameManagedService(result.service, identity)
    )
      throw failure();
  } catch {
    throw failure();
  } finally {
    response?.destroy();
    req?.destroy();
    await closed;
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
  if (controller.signal.aborted || !result) throw failure();
  return result;
}
