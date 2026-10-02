import type { Server } from "node:http";
import { constants } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { DockerClient } from "./cells/docker.ts";
import { imagesFromEnv } from "./cells/images.ts";
import { CellOrchestrator } from "./cells/orchestrator.ts";
import { probeDesktopd, probeStream } from "./cells/readiness.ts";
import { TicketRegistry } from "./cells/secrets.ts";
import { cellStatusRoute } from "./cells/status-stream.ts";
import { CellStore } from "./cells/store.ts";
import { desktopStreamRoute } from "./cells/stream-proxy.ts";
import { findDockerSocket } from "./doctor-socket.ts";
import { EventLog } from "./event-log.ts";
import { sessionStreamRoute } from "./event-stream.ts";
import { acquireDaemonLock, DaemonLockError, DaemonLockedError } from "./lock.ts";
import { localdotHome } from "./paths.ts";
import { parsePort } from "./port.ts";
import { webDir } from "./static-ui.ts";
import { loadOrCreateToken } from "./token.ts";
import { attachUpgradeRouter } from "./upgrade-router.ts";

const port = portFromEnv();
const home = localdotHome();
const releaseLock = lockHome(join(home, "daemon.lock"));
process.on("exit", releaseLock);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => process.exit(128 + constants.signals[signal]));
}
const tokenFile = join(home, "daemon-token");
const token = loadOrCreateToken(tokenFile);
const eventLog = new EventLog(home);
const tickets = new TicketRegistry();
const orchestrator = new CellOrchestrator({
  docker: new DockerClient(findDockerSocket().path),
  store: new CellStore(home),
  images: imagesFromEnv(),
  streamFullcolor: process.env.LOCALDOT_STREAM_FULLCOLOR !== "0",
  probeDesktopd,
  probeStream,
});
// The daemon serves the UI without Docker; the UI shows the cell as failed with the reason.
await orchestrator
  .reconcile()
  .catch((err) => console.error(`cell reconcile failed: ${String(err)}`));
const desktop = { cells: orchestrator, tickets, vendorDir: webDir("vendor/selkies") };
const app = createApp({
  token,
  port,
  eventLog,
  cells: { cells: orchestrator, tickets },
  desktop,
  ui: { dir: webDir("dist") },
});

const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, () => {
  console.log(`localdot daemon on http://127.0.0.1:${port} (token in ${tokenFile})`);
  console.log(`open http://127.0.0.1:${port}/#token=${token}`);
});
// serve() is typed as HTTP/1-or-HTTP/2; this daemon only ever creates an HTTP/1 server.
attachUpgradeRouter(server as Server, { port, token }, [
  sessionStreamRoute(eventLog),
  cellStatusRoute(orchestrator),
  desktopStreamRoute(desktop),
]);
server.on("error", (err: NodeJS.ErrnoException) => {
  fail(err.code === "EADDRINUSE" ? `port ${port} is already in use` : err.message);
});

function portFromEnv(): number {
  try {
    return parsePort(process.env.LOCALDOT_PORT);
  } catch (err) {
    return fail(`LOCALDOT_PORT: ${(err as Error).message}`);
  }
}

function lockHome(file: string): () => void {
  try {
    return acquireDaemonLock(file);
  } catch (err) {
    if (err instanceof DaemonLockedError) {
      return fail(`${err.message}; remove ${file} if that process is not localdot`);
    }
    if (err instanceof DaemonLockError) return fail(err.message);
    throw err;
  }
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
