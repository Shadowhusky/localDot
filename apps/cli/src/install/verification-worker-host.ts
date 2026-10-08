import { Worker } from "node:worker_threads";
import { TufVersions } from "../../../../packages/protocol/src/install-update.ts";

const fail = () => new Error("Release trust verification failed or timed out.");

/** Internal worker host. Production supplies a fixed build-owned entry point. Settles only once
 * the worker exits, including on timeout/abort, so its I/O cannot outlive temporary-cache cleanup.
 * The URL/deadline seams exist for local worker lifecycle tests, never candidate configuration.
 */
export async function runVerificationWorker(
  entry: URL,
  data: unknown,
  signal: AbortSignal,
  timeoutMs = 30_000,
): Promise<TufVersions> {
  signal.throwIfAborted();
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw fail();
  return await new Promise<TufVersions>((resolve, reject) => {
    const worker = new Worker(entry, {
      workerData: data,
      env: {},
      execArgv: [],
      stdout: true,
      stderr: true,
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
      trackUnmanagedFds: true,
    });
    let result: TufVersions | undefined;
    let failed = false,
      messages = 0,
      outputBytes = 0;
    const stop = () => {
      failed = true;
      void worker.terminate().catch(() => {});
    };
    const timer = setTimeout(stop, timeoutMs);
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    const output = (bytes: Buffer) => {
      outputBytes += bytes.length;
      if (outputBytes > 4096) stop();
    };
    worker.stdout.on("data", output);
    worker.stderr.on("data", output);
    worker.on("error", stop);
    worker.on("message", (message: unknown) => {
      try {
        if (
          ++messages !== 1 ||
          !message ||
          typeof message !== "object" ||
          !("ok" in message) ||
          message.ok !== true ||
          !("versions" in message) ||
          Object.keys(message).sort().join(",") !== "ok,versions"
        )
          throw fail();
        result = TufVersions.parse(message.versions);
      } catch {
        stop();
      }
    });
    worker.once("exit", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      if (signal.aborted) reject(signal.reason);
      else if (failed || code !== 0 || !result || messages !== 1) reject(fail());
      else resolve(result);
    });
  });
}
