import { ComputerResetRecord } from "../../../packages/protocol/src/computer-reset.ts";
import { ulid } from "../../../packages/protocol/src/ids.ts";
import { readInstallToken } from "../../daemon/src/install-token-reader.ts";
import type { ConsoleIO } from "./runtime.ts";

interface ResetOptions {
  home: string;
  port: number;
  signal: AbortSignal;
  cellId: string;
  operation: "reset" | "status";
  requestId?: string;
}
const validId = (id: string) => id.length === 26 && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(id);

/** Exactly one authenticated request. The request ID is printed before dispatch and reused in
 * explicit status/retry instructions. Cancellation does not imply that the daemon rolled back. */
export async function runResetComputer(
  options: ResetOptions,
  io: ConsoleIO & { fetch?: typeof fetch },
): Promise<number> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let requestId: string | undefined;
  let sent = false;
  const interrupted = Promise.withResolvers<never>();
  void interrupted.promise.catch(() => {});
  const interrupt = () => {
    controller.abort();
    void reader?.cancel().catch(() => {});
    interrupted.reject(new Error("interrupted"));
  };
  const recovery = () => {
    if (!requestId) return;
    io.out(
      `Check status: localdot reset-computer --cell ${options.cellId} --request ${requestId} --status`,
    );
    io.out(
      `Resume only when intended: localdot reset-computer --cell ${options.cellId} --request ${requestId} --erase-computer`,
    );
  };
  try {
    options.signal.throwIfAborted();
    if (
      !validId(options.cellId) ||
      !Number.isInteger(options.port) ||
      options.port < 1 ||
      options.port > 65535 ||
      (options.operation !== "reset" && options.operation !== "status") ||
      (options.operation === "status" && !options.requestId) ||
      (options.requestId !== undefined && !validId(options.requestId))
    )
      throw new Error("invalid reset options");
    const token = readInstallToken(options.home);
    requestId = options.requestId ?? ulid();
    io.out(`Reset request: ${requestId}; computer: ${options.cellId}`);
    options.signal.addEventListener("abort", interrupt, { once: true });
    if (options.signal.aborted) interrupt();
    timer = setTimeout(interrupt, options.operation === "status" ? 10_000 : 200_000);
    controller.signal.throwIfAborted();
    const status = options.operation === "status";
    const url = `http://127.0.0.1:${options.port}/api/cells/${options.cellId}/reset${status ? `/${requestId}` : ""}`;
    sent = true;
    const pending = (io.fetch ?? fetch)(url, {
      method: status ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${token}`,
        ...(status ? {} : { "content-type": "application/json" }),
      },
      ...(status ? {} : { body: JSON.stringify({ requestId, eraseComputer: true }) }),
      signal: controller.signal,
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
    }).then((response) => {
      if (controller.signal.aborted) {
        void response.body?.cancel().catch(() => {});
        throw new Error("interrupted");
      }
      return response;
    });
    const response = await Promise.race([pending, interrupted.promise]);
    const length = response.headers.get("content-length"),
      limit = 65536;
    if (
      response.status !== 200 ||
      response.redirected ||
      !response.body ||
      response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
        "application/json" ||
      (length !== null && (!/^\d+$/.test(length) || Number(length) > limit))
    ) {
      void response.body?.cancel().catch(() => {});
      throw new Error("reset response unavailable");
    }
    reader = response.body.getReader();
    const bytes = new Uint8Array(limit);
    let offset = 0;
    for (;;) {
      const part = await Promise.race([reader.read(), interrupted.promise]);
      controller.signal.throwIfAborted();
      if (part.done) break;
      if (offset + part.value.byteLength > limit) throw new Error("oversized reset response");
      bytes.set(part.value, offset);
      offset += part.value.byteLength;
    }
    if (length !== null && Number(length) !== offset) throw new Error("incomplete reset response");
    const record = ComputerResetRecord.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, offset))),
    );
    if (record.requestId !== requestId || record.oldCellId !== options.cellId)
      throw new Error("reset receipt mismatch");
    controller.signal.throwIfAborted();
    if (record.phase !== "ready") {
      io.out(`Reset is incomplete (${record.phase}). No retry was sent.`);
      recovery();
      return 1;
    }
    io.out(`Reset confirmed. Replacement computer: ${record.newCellId}`);
    return 0;
  } catch {
    io.err(
      sent
        ? "Reset completion is unconfirmed. The daemon may still be working; do not start a new reset request."
        : "Reset could not start. Check the private installation home, computer ID and confirmation.",
    );
    if (sent) recovery();
    return options.signal.aborted ? 130 : 1;
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener("abort", interrupt);
    controller.abort();
    void reader?.cancel().catch(() => {});
    reader?.releaseLock();
  }
}
