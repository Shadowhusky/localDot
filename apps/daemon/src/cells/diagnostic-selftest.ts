import { type IncomingMessage, request } from "node:http";
import { SELFTEST_CHECKS, SelfTestReport, selfTestPassed } from "@localdot/protocol";
import type { DesktopdEndpoint } from "./types.ts";

const failure = () => new Error("The computer self-test could not be confirmed.");
const MAX_BYTES = 64 * 1024;
export interface DiagnosticSelfTest {
  ok: boolean;
  checks: { id: (typeof SELFTEST_CHECKS)[number]["id"]; ok: boolean }[];
}

/** The caller must own the computer's lifecycle scope and freshly verify the exact runtime and
 * published endpoint. This is only a bounded observation, never proof of ownership or readiness.
 * Raw cell descriptions are deliberately excluded from the result and from errors. */
export async function probeDiagnosticSelfTest(
  input: DesktopdEndpoint,
  signal: AbortSignal,
): Promise<DiagnosticSelfTest> {
  const { baseUrl, token } = input;
  signal.throwIfAborted();
  // Canonical numeric loopback only: no DNS, URL credentials, redirects, proxy or ambient config.
  const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(baseUrl);
  const port = Number(match?.[1]);
  if (!match || port < 1024 || port > 65535 || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw failure();
  const controller = new AbortController(),
    abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const timer = setTimeout(abort, 8000);
  let req: ReturnType<typeof request> | undefined,
    response: IncomingMessage | undefined,
    closed: Promise<void> | undefined;
  let result: DiagnosticSelfTest | undefined;
  try {
    controller.signal.throwIfAborted();
    response = await new Promise<IncomingMessage>((resolve, reject) => {
      req = request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/selftest",
          method: "GET",
          agent: false,
          signal: controller.signal,
          headers: {
            host: `127.0.0.1:${port}`,
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
    if (
      response.statusCode !== 200 ||
      !/^application\/json(?:;\s*charset=utf-8)?$/i.test(response.headers["content-type"] ?? "") ||
      (response.headers["content-encoding"] !== undefined &&
        response.headers["content-encoding"] !== "identity") ||
      (length !== undefined && (!/^[0-9]+$/.test(length) || Number(length) > MAX_BYTES))
    )
      throw failure();
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of response) {
      controller.signal.throwIfAborted();
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > MAX_BYTES) throw failure();
      chunks.push(buffer);
    }
    controller.signal.throwIfAborted();
    if (!response.complete || (length !== undefined && Number(length) !== bytes)) throw failure();
    const report = SelfTestReport.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))),
    );
    if (report.checks.some((check) => !SELFTEST_CHECKS.some(({ id }) => id === check.id)))
      throw failure();
    // Recompute from the exact required checks. Duplicate IDs and wrong kinds cannot pass.
    const checks = SELFTEST_CHECKS.map(({ id, kind }) => {
      const matches = report.checks.filter((check) => check.id === id);
      return {
        id,
        ok: matches.length === 1 && matches[0]?.kind === kind && matches[0]?.ok === true,
      };
    });
    result = { ok: selfTestPassed(report), checks };
  } catch {
    throw failure();
  } finally {
    response?.destroy();
    req?.destroy();
    // A promise rejection or aborted signal alone is not transport retirement.
    await closed;
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
  if (controller.signal.aborted || !result) throw failure();
  return result;
}
