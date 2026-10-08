import { spawn } from "node:child_process";
import {
  PlacementCommand,
  PlacementNotPlaced,
  PlacementReceipt,
  type PlacementRequest,
  type PlacementResult,
} from "../../../../packages/protocol/src/quarantine.ts";

export class PlacementError extends Error {
  constructor(readonly code: "request" | "aborted" | "unavailable" | "refused") {
    super(`Download placement ${code}`);
  }
}

interface PlacementOptions {
  // Fixed service configuration. Neither value is accepted from a tool request.
  python?: string;
  helper?: string;
  timeoutMs?: number;
  killAfterMs?: number;
}

export function placementHeader(command: PlacementCommand): string {
  return Buffer.from(JSON.stringify(PlacementCommand.parse(command))).toString("base64url");
}

export function parsePlacementHeader(value: string | undefined): PlacementCommand {
  if (!value || value.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(value))
    throw new PlacementError("request");
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) throw new PlacementError("request");
  try {
    return PlacementCommand.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
  } catch {
    throw new PlacementError("request");
  }
}

// The helper receives a bounded stream and a separate commit byte after exact EOF. An abort
// retires both the source reader and child, and this promise waits for their actual settlement.
export async function placeDownload(
  home: string,
  raw: unknown,
  source: ReadableStream<Uint8Array> | null,
  signal: AbortSignal,
  options: PlacementOptions = {},
): Promise<PlacementResult> {
  const parsed = PlacementCommand.safeParse(raw);
  if (!parsed.success) throw new PlacementError("request");
  if (signal.aborted) throw new PlacementError("aborted");
  const { reconcileOnly, ...request } = parsed.data;
  const reader = source?.getReader();
  const child = spawn(
    options.python ?? "/usr/bin/python3",
    ["-I", "-B", options.helper ?? "/opt/localdot/place-download.py", "--home", home],
    { stdio: ["pipe", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin", LC_ALL: "C.UTF-8" } },
  );
  const ready = Promise.withResolvers<void>();
  const outcome = Promise.withResolvers<PlacementResult>();
  const closed = Promise.withResolvers<{ code: number | null; error?: Error }>();
  // A child can fail before its stream or ready promise is awaited.
  void ready.promise.catch(() => undefined);
  void outcome.promise.catch(() => undefined);
  let ended = false;
  let retiring = false;
  let terminal = false;
  let sawReady = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let cancellation: Promise<void> | undefined;
  let pump: Promise<void> | undefined;
  let output = Buffer.alloc(0);
  let stderrBytes = 0;
  let totalOutput = 0;
  let processError: Error | undefined;
  let failure: PlacementError | undefined;

  const cancelReader = () => {
    cancellation ??= reader?.cancel().catch(() => undefined) ?? Promise.resolve();
    return cancellation;
  };
  const retire = () => {
    void cancelReader();
    if (!ended && !retiring) {
      retiring = true;
      child.kill("SIGTERM");
      killTimer ??= setTimeout(() => child.kill("SIGKILL"), options.killAfterMs ?? 1000);
      killTimer.unref();
    }
  };
  const fail = (error: PlacementError) => {
    failure ??= error;
    ready.reject(error);
    outcome.reject(error);
    retire();
  };
  const abort = () => fail(new PlacementError("aborted"));
  signal.addEventListener("abort", abort, { once: true });
  // Covers an abort between the initial check and listener installation.
  if (signal.aborted) abort();
  const deadline = setTimeout(
    () => fail(new PlacementError("unavailable")),
    options.timeoutMs ?? 10 * 60 * 1000,
  );
  deadline.unref();
  child.on("error", (error) => {
    processError = error;
    fail(new PlacementError("unavailable"));
  });
  child.on("close", (code) => {
    ended = true;
    if (killTimer) clearTimeout(killTimer);
    closed.resolve({ code, error: processError });
    if (!terminal || output.length) {
      ready.reject(new PlacementError("unavailable"));
      outcome.reject(new PlacementError("unavailable"));
    }
    void cancelReader();
  });
  child.stdin.on("error", () => {
    if (!terminal) fail(new PlacementError("unavailable"));
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.length;
    if (stderrBytes > 4096) fail(new PlacementError("unavailable"));
  });
  child.stdout.on("data", (chunk: Buffer) => {
    totalOutput += chunk.length;
    if (totalOutput > 16 * 1024 || terminal) {
      fail(new PlacementError("unavailable"));
      return;
    }
    output = Buffer.concat([output, chunk]);
    while (output.includes(10)) {
      const boundary = output.indexOf(10);
      const line = output.subarray(0, boundary);
      output = output.subarray(boundary + 1);
      try {
        const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line));
        if (!value || typeof value !== "object" || Object.keys(value).length !== 1)
          throw new Error("invalid helper response");
        if ("ready" in value && value.ready === true && !sawReady && !terminal && !reconcileOnly) {
          sawReady = true;
          ready.resolve();
        } else if (("receipt" in value || "notPlaced" in value) && !terminal) {
          const receipt =
            "receipt" in value
              ? PlacementReceipt.parse(value.receipt)
              : PlacementNotPlaced.parse(value.notPlaced);
          for (const key of Object.keys(request) as (keyof PlacementRequest)[])
            if (receipt[key] !== request[key]) throw new Error("receipt mismatch");
          terminal = true;
          outcome.resolve(receipt);
          void cancelReader();
          child.stdin.end();
        } else if ("error" in value && typeof value.error === "string" && !terminal) {
          terminal = true;
          fail(new PlacementError("refused"));
        } else throw new Error("invalid helper phase");
      } catch {
        fail(new PlacementError("unavailable"));
        return;
      }
    }
  });
  const write = (bytes: Uint8Array) =>
    new Promise<void>((resolve, reject) => {
      child.stdin.write(bytes, (error) => (error ? reject(error) : resolve()));
    });

  try {
    await write(Buffer.from(`${JSON.stringify({ version: 1, request, reconcileOnly })}\n`));
    if (reconcileOnly) {
      await cancelReader();
      child.stdin.end();
    } else {
      pump = (async () => {
        let count = 0;
        while (reader && !terminal) {
          const item = await reader.read();
          if (signal.aborted) throw new PlacementError("aborted");
          if (item.done || terminal) break;
          if (!(item.value instanceof Uint8Array) || count + item.value.byteLength > request.bytes)
            throw new PlacementError("request");
          count += item.value.byteLength;
          // Keep each write bounded even when the HTTP source returns a larger block.
          for (let offset = 0; offset < item.value.byteLength && !terminal; offset += 64 * 1024)
            await write(item.value.subarray(offset, offset + 64 * 1024));
        }
        if (!terminal && count !== request.bytes) throw new PlacementError("request");
      })();
      void pump.catch(() => undefined);
      const commit = (async () => {
        await pump;
        if (terminal) return;
        await ready.promise;
        if (signal.aborted) throw new PlacementError("aborted");
        if (!terminal) child.stdin.end("C");
      })();
      void commit.catch((error) =>
        fail(error instanceof PlacementError ? error : new PlacementError("unavailable")),
      );
    }
    const receipt = await outcome.promise;
    const status = await closed.promise;
    if (signal.aborted) throw new PlacementError("aborted");
    if (failure) throw failure;
    if (status.code !== 0 || status.error || output.length || stderrBytes)
      throw new PlacementError("unavailable");
    return receipt;
  } catch (error) {
    retire();
    if (signal.aborted) throw new PlacementError("aborted");
    throw error instanceof PlacementError ? error : new PlacementError("unavailable");
  } finally {
    clearTimeout(deadline);
    signal.removeEventListener("abort", abort);
    await cancelReader();
    await pump?.catch(() => undefined);
    await closed.promise;
    reader?.releaseLock();
  }
}
