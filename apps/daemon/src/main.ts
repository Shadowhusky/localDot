import type { Server } from "node:http";
import { constants } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { DockerClient } from "./cells/docker.ts";
import { imagesFromEnv } from "./cells/images.ts";
import { CellOrchestrator } from "./cells/orchestrator.ts";
import { parsePortRange } from "./cells/ports.ts";
import { probeDesktopd, probeStream } from "./cells/readiness.ts";
import { TicketRegistry } from "./cells/secrets.ts";
import { cellStatusRoute } from "./cells/status-stream.ts";
import { CellStore } from "./cells/store.ts";
import { desktopStreamRoute } from "./cells/stream-proxy.ts";
import { monotonicClock } from "./clock.ts";
import { DesktopdRegistry } from "./desktopd/registry.ts";
import { findDockerSocket } from "./doctor-socket.ts";
import { EventLog } from "./event-log.ts";
import { sessionStreamRoute } from "./event-stream.ts";
import { FrameStore } from "./gateway/frames.ts";
import { ActionGateway } from "./gateway/gateway.ts";
import { KillSwitch } from "./gateway/kill-switch.ts";
import { LiveSessions } from "./gateway/live.ts";
import { loadOnsetTable } from "./gateway/onset-table.ts";
import { policyFromEnv } from "./gateway/ring-onset.ts";
import { CellKeydWiring, refreshRunningCells } from "./keyd/cell-wiring.ts";
import { KeydClient, keydSocketPath } from "./keyd/client.ts";
import { KeydEventRouter } from "./keyd/event-router.ts";
import { cameUp, KeydMonitor } from "./keyd/monitor.ts";
import { acquireDaemonLock, DaemonLockError, DaemonLockedError } from "./lock.ts";
import { localdotHome } from "./paths.ts";
import { parsePort } from "./port.ts";
import { webDir } from "./static-ui.ts";
import { loadOrCreateToken } from "./token.ts";
import { attachUpgradeRouter } from "./upgrade-router.ts";

const port = portFromEnv();
const keydPorts = keydPortsFromEnv();
const home = localdotHome();
const releaseLock = lockHome(join(home, "daemon.lock"));
process.on("exit", releaseLock);
const shutdown: (() => void)[] = [];
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    for (const stop of shutdown) {
      try {
        stop();
      } catch {
        console.error("daemon cleanup did not complete");
      }
    }
    process.exit(128 + constants.signals[signal]);
  });
}
const tokenFile = join(home, "daemon-token");
const token = loadOrCreateToken(tokenFile);
const clock = monotonicClock();
const eventLog = new EventLog(home, clock);
const tickets = new TicketRegistry();
const docker = new DockerClient(findDockerSocket().path);
const keyd = new KeydClient(keydSocketPath(home));
const keydWiring = new CellKeydWiring({ keyd, docker });
const orchestrator = new CellOrchestrator({
  docker,
  keyd: keydWiring,
  store: new CellStore(home, keydPorts),
  images: imagesFromEnv(),
  streamFullcolor: process.env.LOCALDOT_STREAM_FULLCOLOR !== "0",
  probeDesktopd,
  probeStream,
});
// The UI remains available while Docker is unavailable or its startup reconcile is waiting.
void orchestrator.reconcile().catch(() => console.error("cell reconcile failed"));
const desktop = { cells: orchestrator, tickets, vendorDir: webDir("vendor/selkies") };
const registry = new DesktopdRegistry(orchestrator, clock);
const onset = loadOnsetTable(home);
const frames = new FrameStore(home);
const gateway = new ActionGateway({
  eventLog,
  cells: orchestrator,
  registry,
  onset,
  ringOnset: policyFromEnv(onset),
  frames,
  now: () => clock.nowMicros(),
  sleep: (ms, signal) => sleep(ms, undefined, { signal }),
});
const live = new LiveSessions();
const killSwitch = new KillSwitch({ live, keyd: keydWiring, cells: orchestrator });
const keydMonitor = new KeydMonitor(keyd);
keydMonitor.subscribe((now, before) => {
  if (!cameUp(now, before)) return;
  for (const cell of orchestrator.list()) {
    void orchestrator
      .rewireIfLost(cell.id)
      .catch(() => console.error("keyd: a computer could not reconnect"));
  }
});
const keydEvents = new KeydEventRouter({ keyd, live, eventLog });
shutdown.push(
  () => keydEvents.stop(),
  () => keydMonitor.stop(),
  () => orchestrator.dispose(),
  () => registry.dispose(),
  () => eventLog.close(),
);
keydMonitor.start();
keydEvents.start();
const app = createApp({
  token,
  port,
  eventLog,
  cells: { cells: orchestrator, tickets },
  desktop,
  ui: { dir: webDir("dist") },
  gateway: { registry, clock, eventLog, gateway, frames, live, killSwitch },
  keys: { keyd, monitor: keydMonitor, afterChange: (id) => refreshRunningCells(orchestrator, id) },
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

function keydPortsFromEnv() {
  try {
    return parsePortRange(process.env.LOCALDOT_KEYD_PORTS);
  } catch (err) {
    return fail(`LOCALDOT_KEYD_PORTS: ${(err as Error).message}`);
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
