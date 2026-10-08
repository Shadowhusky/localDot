import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { IMAGE_ROLES } from "../../../../packages/protocol/src/release.ts";
import type { ConsoleIO } from "../runtime.ts";
import { isInstallerBrowserURL, openInstallerBrowser } from "./browser-open.ts";
import { PROGRESS_HTML, PROGRESS_SCRIPT, PROGRESS_STYLE } from "./browser-page.ts";
import type { ImagePreparationProgress } from "./prepare-images.ts";

type Status =
  | { phase: "release" | "starting" | "failed" | "cancelled" }
  | {
      phase: "images";
      role: ImagePreparationProgress["role"];
      imagePhase: ImagePreparationProgress["phase"];
      currentBytes?: number;
      totalBytes?: number;
    }
  | { phase: "ready"; url: string };
const digest = (text: string) => createHash("sha256").update(text).digest("base64");
const CSP = `default-src 'none'; script-src 'sha256-${digest(PROGRESS_SCRIPT)}'; style-src 'sha256-${digest(PROGRESS_STYLE)}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
const IMAGE_PHASES = ["checking", "ready", "pulling", "downloading", "extracting", "verifying"];

/** Pure state/HTTP boundary, kept separate from socket and OS browser effects for auditing. */
export function progressChannel(capability: string, targetPort: number) {
  if (
    capability.length !== 43 ||
    !/^[A-Za-z0-9_-]{43}$/.test(capability) ||
    !Number.isInteger(targetPort) ||
    targetPort < 1024 ||
    targetPort > 65535
  )
    throw new Error("Invalid progress channel");
  const authorization = Buffer.from(`Bearer ${capability}`);
  let status: Status = { phase: "release" },
    terminal = false;
  let seen!: () => void;
  const delivered = new Promise<void>((resolve) => {
    seen = resolve;
  });
  return {
    delivered,
    report(progress: ImagePreparationProgress) {
      if (
        terminal ||
        !IMAGE_ROLES.includes(progress.role) ||
        !IMAGE_PHASES.includes(progress.phase)
      )
        return;
      status = { phase: "images", role: progress.role, imagePhase: progress.phase };
      const { currentBytes, totalBytes } = progress;
      if (
        Number.isSafeInteger(currentBytes) &&
        Number.isSafeInteger(totalBytes) &&
        currentBytes !== undefined &&
        totalBytes !== undefined &&
        currentBytes >= 0 &&
        totalBytes >= currentBytes
      ) {
        status.currentBytes = currentBytes;
        status.totalBytes = totalBytes;
      }
    },
    starting() {
      if (!terminal) status = { phase: "starting" };
    },
    finish(phase: "ready" | "failed" | "cancelled", url?: string) {
      if (terminal) return;
      if (phase === "ready") {
        if (
          !url ||
          !isInstallerBrowserURL(url) ||
          !url.startsWith(`http://127.0.0.1:${targetPort}/#code=`)
        )
          throw new Error("Invalid setup destination");
        status = { phase, url };
      } else status = { phase };
      terminal = true;
    },
    handle(origin: string, request: IncomingMessage, response: ServerResponse) {
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Referrer-Policy", "no-referrer");
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader("X-Frame-Options", "DENY");
      response.setHeader("Content-Security-Policy", CSP);
      response.setHeader("Connection", "close");
      const deny = () => {
        response.writeHead(404);
        response.end();
      };
      if (
        request.method !== "GET" ||
        request.headers.host !== origin.slice(7) ||
        (request.headers.origin !== undefined && request.headers.origin !== origin) ||
        (request.headers["sec-fetch-site"] !== undefined &&
          !["same-origin", "none"].includes(String(request.headers["sec-fetch-site"]))) ||
        request.headers["transfer-encoding"] !== undefined ||
        (request.headers["content-length"] !== undefined &&
          request.headers["content-length"] !== "0")
      ) {
        deny();
        return;
      }
      if (request.url === "/") {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(PROGRESS_HTML);
        return;
      }
      const supplied = Buffer.from(request.headers.authorization ?? "");
      if (
        request.url !== "/status" ||
        supplied.length !== authorization.length ||
        !timingSafeEqual(supplied, authorization)
      ) {
        deny();
        return;
      }
      if (terminal) response.once("finish", seen);
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(status));
    },
  };
}

export interface InstallProgressBrowser {
  report(progress: ImagePreparationProgress): void;
  starting(): void;
  finish(phase: "ready" | "failed" | "cancelled", url?: string): Promise<boolean>;
  close(): Promise<void>;
}

/** Best-effort presentation only. The caller owns install effects and always closes this scope. */
export async function startInstallProgressBrowser(
  targetPort: number,
  signal: AbortSignal,
  io: ConsoleIO,
): Promise<InstallProgressBrowser | undefined> {
  if (signal.aborted) return;
  const capability = randomBytes(32).toString("base64url");
  const channel = progressChannel(capability, targetPort);
  let origin = "",
    closed = false,
    closePromise: Promise<void> | undefined;
  const server = createServer(
    {
      maxHeaderSize: 4096,
      headersTimeout: 5000,
      requestTimeout: 5000,
      connectionsCheckingInterval: 1000,
    },
    (request, response) => channel.handle(origin, request, response),
  );
  server.maxConnections = 16;
  server.setTimeout(5000, (socket) => socket.destroy());
  const close = () => {
    if (closePromise) return closePromise;
    closed = true;
    signal.removeEventListener("abort", abort);
    closePromise = new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    return closePromise;
  };
  const abort = () => {
    void close();
  };
  try {
    await new Promise<void>((resolve, reject) => {
      const error = () => reject(new Error("Progress listener unavailable"));
      server.once("error", error);
      server.listen({ host: "127.0.0.1", port: 0, signal }, () => {
        server.removeListener("error", error);
        resolve();
      });
      // Listen cancellation may emit close without an error or listening event.
      server.once("close", () => reject(new Error("Progress listener closed")));
    });
    server.on("error", abort);
    signal.throwIfAborted();
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing progress address");
    origin = `http://127.0.0.1:${address.port}`;
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) throw new Error("Interrupted");
    const opened = await openInstallerBrowser(`${origin}/#progress=${capability}`, signal);
    if (!opened) io.err("Could not open browser progress. Follow setup in this terminal.");
    if (closed || signal.aborted) {
      await close();
      return;
    }
    return {
      report: channel.report,
      starting: channel.starting,
      close,
      async finish(phase, url) {
        channel.finish(phase, url);
        let received = false;
        if (opened && !closed && !signal.aborted) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          let end!: () => void;
          const cancelled = new Promise<void>((resolve) => {
            end = resolve;
          });
          signal.addEventListener("abort", end, { once: true });
          if (signal.aborted) end();
          try {
            received = await Promise.race([
              channel.delivered.then(() => true),
              cancelled.then(() => false),
              new Promise<boolean>((resolve) => {
                timer = setTimeout(() => resolve(false), 5000);
              }),
            ]);
          } finally {
            clearTimeout(timer);
            signal.removeEventListener("abort", end);
          }
        }
        await close();
        return received;
      },
    };
  } catch {
    await close();
    if (!signal.aborted) io.err("Browser progress is unavailable. Follow setup in this terminal.");
    return;
  }
}
