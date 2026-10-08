import { createServer } from "node:net";

export type InstalledPortState = "free" | "occupied" | "unavailable";

/** A bind-and-close observation only, never a reservation or proof of the
 * identity occupying a port. Caller separately verifies stopped service jobs
 * before and after. Does not contact, authenticate or terminate another server. */
export async function probeInstalledPort(
  port: number,
  callerSignal: AbortSignal,
): Promise<InstalledPortState> {
  callerSignal.throwIfAborted();
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error("Invalid recorded port.");
  const controller = new AbortController(),
    abort = () => controller.abort();
  callerSignal.addEventListener("abort", abort, { once: true });
  if (callerSignal.aborted) abort();
  const timer = setTimeout(abort, 2500);
  const server = createServer((socket) => socket.destroy());
  server.maxConnections = 1;
  let outcome: InstalledPortState = "unavailable";
  try {
    await new Promise<void>((resolve) => {
      let closing = false;
      const close = () => {
        if (closing) return;
        closing = true;
        server.close(() => resolve());
      };
      server.once("error", (error: NodeJS.ErrnoException) => {
        outcome = error.code === "EADDRINUSE" ? "occupied" : "unavailable";
        close();
      });
      // Abort while bind is pending can emit close without listening/error.
      server.once("close", () => resolve());
      try {
        server.listen(
          { host: "127.0.0.1", port, exclusive: true, signal: controller.signal },
          () => {
            outcome = "free";
            close();
          },
        );
      } catch {
        close();
      }
    });
  } finally {
    clearTimeout(timer);
    callerSignal.removeEventListener("abort", abort);
  }
  callerSignal.throwIfAborted();
  return controller.signal.aborted ? "unavailable" : outcome;
}
