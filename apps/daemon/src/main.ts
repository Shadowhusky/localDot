import type { Server } from "node:http";
import { constants, userInfo } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { serve } from "@hono/node-server";
import { manualStreamRoute } from "./agent/manual-stream.ts";
import { ComputerFences } from "./agent/safety/fences.ts";
import { createReplacementController } from "./agent/safety/replacement-controller.ts";
import { Transfers } from "./agent/transfers.ts";
import { createAgent } from "./agent/wiring.ts";
import { createApp } from "./app.ts";
import { BrowserDownloadCollector } from "./browser/download-collector.ts";
import { QuarantineStore } from "./browser/quarantine.ts";
import { SessionScreens } from "./browser/session-screens.ts";
import { BrowserStreams } from "./browser/streams.ts";
import { BrowserWarmer } from "./browser/warmer.ts";
import { BrowserOrchestrator } from "./cells/browser-orchestrator.ts";
import { BrowserRecovery } from "./cells/browser-recovery.ts";
import { DockerClient } from "./cells/docker.ts";
import { browserImagesFromEnv, imagesFromEnv } from "./cells/images.ts";
import { CellOrchestrator } from "./cells/orchestrator.ts";
import { parsePortRange } from "./cells/ports.ts";
import { probeDesktopd, probeStream } from "./cells/readiness.ts";
import { createComputerResetController } from "./cells/reset-controller.ts";
import { ComputerResetHolds } from "./cells/reset-holds.ts";
import { verifyDesktopRuntimeImages } from "./cells/runtime-image-check.ts";
import { RuntimeUpdateAdmission } from "./cells/runtime-update-admission.ts";
import { RuntimeImages } from "./cells/runtime-update-store.ts";
import { TicketRegistry } from "./cells/secrets.ts";
import { streamOptions } from "./cells/spec.ts";
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
import { setPublicOrigin } from "./guard.ts";
import { InstallCodes } from "./install-codes.ts";
import { CellKeydWiring, refreshRunningCells } from "./keyd/cell-wiring.ts";
import { KeydClient, keydSocketPath } from "./keyd/client.ts";
import { KeydEventRouter } from "./keyd/event-router.ts";
import { cameUp, KeydMonitor } from "./keyd/monitor.ts";
import { acquireDaemonLock, DaemonLockError, DaemonLockedError } from "./lock.ts";
import { localdotHome, secureHome } from "./paths.ts";
import { parsePort } from "./port.ts";
import { SHUTDOWN_FINALIZE_MS } from "./recorder/recorder.ts";
import { ScreenRecordings } from "./recorder/screen-recordings.ts";
import { retainManagedDaemonLease } from "./service-lease.ts";
import { ManagedServiceReadiness, managedServiceFromEnv } from "./service-readiness.ts";
import { SessionIndex } from "./sessions/index-store.ts";
import { retentionFromEnv, sweepRecordings } from "./sessions/retention.ts";
import { summarizeSession, writeSummary } from "./sessions/summary.ts";
import { Thumbnails } from "./sessions/thumbs.ts";
import { webDir } from "./static-ui.ts";
import { loadOrCreateToken } from "./token.ts";
import { attachUpgradeRouter } from "./upgrade-router.ts";

const port = portFromEnv();
publicOriginFromEnv();
const keydPorts = keydPortsFromEnv();
const home = localdotHome();
secureHomeOrFail(home);
const serviceIdentity = managedServiceFromEnv(process.env);
if (serviceIdentity) retainManagedDaemonLease(process.env, serviceIdentity);
let serviceReadiness: ManagedServiceReadiness | undefined;
const releaseLock = lockHome(join(home, "daemon.lock"));
process.on("exit", releaseLock);
const shutdown: (() => void | Promise<void>)[] = [];
let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    serviceReadiness?.stopping();
    const code = 128 + constants.signals[signal];
    const deadline = setTimeout(() => {
      console.error("daemon shutdown deadline exceeded");
      process.exit(code);
    }, 15_000);
    void (async () => {
      for (const stop of shutdown) {
        try {
          await stop();
        } catch {
          console.error("daemon cleanup did not complete");
        }
      }
      clearTimeout(deadline);
      process.exit(code);
    })();
  });
}
const tokenFile = join(home, "daemon-token");
const token = loadOrCreateToken(tokenFile);
const clock = monotonicClock();
const eventLog = new EventLog(home, clock);
const tickets = new TicketRegistry();
const resetHolds = new ComputerResetHolds(home);
const runtimeAdmission = new RuntimeUpdateAdmission(home);
const runtimeImages = serviceIdentity ? RuntimeImages.parse(imagesFromEnv()) : undefined;
const fences = new ComputerFences(home, (id) => resetHolds.oldHeld(id));
const docker = new DockerClient(findDockerSocket().path);
const keyd = new KeydClient(keydSocketPath(home));
serviceReadiness = serviceIdentity
  ? new ManagedServiceReadiness(
      serviceIdentity,
      () => keyd.status(),
      (bootId) => browserRecovery.availableFor(bootId),
    )
  : undefined;
const keydWiring = new CellKeydWiring({ keyd, docker });
let agent: ReturnType<typeof createAgent> | undefined;
let browser: BrowserOrchestrator | undefined;
const store = new CellStore(home, keydPorts);
const stream = streamOptions(process.env);
const orchestrator = new CellOrchestrator({
  diagnosticAdmission: (id) => live.admitIdleOperation(id),
  externalKeydPorts: () => [
    ...(agent?.reservedPorts() ?? []),
    ...(browser?.reservedKeydPorts() ?? []),
  ],
  browser: {
    stop: (id) => browser?.stop(id) ?? Promise.resolve(),
    remove: (id, options) => browser?.remove(id, options) ?? Promise.resolve(),
    reservedKeydPorts: () => browser?.reservedKeydPorts() ?? [],
  },
  permanentFence: (id) =>
    fences.record(id) ? { revision: fences.record(id)?.revision ?? 1 } : fences.isFenced(id),
  candidateHold: (id) => resetHolds.candidateHeld(id),
  runtimeHold: (id) => runtimeAdmission.held(id),
  creationAllowed: () => runtimeAdmission.creationAllowed(),
  ...(runtimeImages
    ? {
        verifyRuntime: (record: import("./cells/types.ts").CellRecord) =>
          verifyDesktopRuntimeImages(docker, record, runtimeImages),
      }
    : {}),
  docker,
  keyd: keydWiring,
  store,
  images: imagesFromEnv(),
  streamFullcolor: stream.fullcolor,
  probeDesktopd,
  probeStream,
});
// Restore reset candidate holds before browser/agent recovery or ordinary cell reconciliation.
// The reset controller will release a candidate only after durable and freshly verified Ready.
const holdResetComputers = (binding: { oldCellId: string; newCellId: string }) => {
  tickets.revoke(binding.oldCellId);
  tickets.revoke(binding.newCellId);
  orchestrator.holdReplacement(binding.newCellId);
  orchestrator.updateStream(binding.oldCellId, {
    connection: "none",
    viewers: 0,
    lastUpstreamAt: null,
  });
};
resetHolds.subscribe(holdResetComputers);
try {
  for (const binding of resetHolds.records()) holdResetComputers(binding);
} catch {
  fences.closeAdmission();
}
const browserAvailable = (id: string) =>
  !shuttingDown && browserRecovery.available && orchestrator.browserAvailable(id);
browser = new BrowserOrchestrator({
  home,
  store,
  docker,
  keyd,
  images: browserImagesFromEnv(),
  streamFullcolor: stream.fullcolor,
  parentAvailable: browserAvailable,
  externalKeydPorts: () => [...orchestrator.reservedKeydPorts(), ...(agent?.reservedPorts() ?? [])],
});
const browserRecovery = new BrowserRecovery(browser);
const browserWarmer =
  process.env.LOCALDOT_BROWSER_WARM === "0"
    ? undefined
    : new BrowserWarmer({ cells: orchestrator, browser, available: browserAvailable });
const browserTickets = new TicketRegistry();
const browserStreams = new BrowserStreams({
  parents: orchestrator,
  browser,
  tickets: browserTickets,
});
// The UI remains available while Docker is unavailable or its startup reconcile is waiting.
// Replacement recovery installs candidate holds before ordinary startup reconciliation.
const desktop = { cells: orchestrator, tickets, vendorDir: webDir("vendor/selkies") };
const browserViewer = {
  cells: browserStreams,
  tickets: browserTickets,
  vendorDir: desktop.vendorDir,
};
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
let sessionIndex: SessionIndex | undefined;
const retentionPolicy = retentionFromEnv();
const recorder = new ScreenRecordings(
  {
    home,
    eventLog,
    cells: orchestrator,
    clock,
    enabled: process.env.LOCALDOT_RECORDING !== "0",
    onFinished: async (sessionId) => {
      writeSummary(home, await summarizeSession(home, sessionId, { live: false }));
      sessionIndex?.invalidate(sessionId);
      sweepRecordings({
        home,
        policy: retentionPolicy,
        now: new Date(),
        isLive: (id) => recorder.isLive(id),
      });
    },
  },
  { cells: browserStreams },
);
await recorder.recoverAll();
sessionIndex = new SessionIndex(home, {
  isLive: (id) => recorder.isLive(id) || live.cellOf(id) !== undefined,
});
sweepRecordings({
  home,
  policy: retentionPolicy,
  now: new Date(),
  isLive: (id) => recorder.isLive(id),
});
live.addHooks({
  beforeRun: (cell, session) => recorder.start(cell, session),
  afterRun: (_cell, session) => recorder.stop(session),
});
const killSwitch = new KillSwitch({ live, keyd: keydWiring, cells: orchestrator });
const keydMonitor = new KeydMonitor(keyd);
keydMonitor.subscribe((now, before) => {
  void browserRecovery
    .recover(now)
    .catch(() => console.error("browser credential recovery could not complete"));
  void agent?.runner.keydChanged(now, before).catch(() => console.error("agent recovery failed"));
  if (!cameUp(now, before)) return;
  for (const cell of orchestrator.list()) {
    void orchestrator
      .rewireIfLost(cell.id)
      .catch(() => console.error("keyd: a computer could not reconnect"));
  }
});
const transfers = new Transfers();
const quarantine = await QuarantineStore.open(home);
const downloads = new BrowserDownloadCollector({ store: quarantine, transfers });
agent = createAgent({
  transfers,
  quarantine,
  sessionScreens: new SessionScreens({
    cells: orchestrator,
    browser,
    streams: browserStreams,
    recordings: recorder,
    registry,
    downloads,
    pendingStop: (sessionId) => killSwitch.pendingStop(sessionId),
    now: () => clock.nowMicros(),
  }),
  home,
  fences,
  installToken: token,
  eventLog,
  live,
  cells: orchestrator,
  registry,
  gateway,
  frames,
  docker,
  keyd,
  monitor: keydMonitor,
  killSwitch,
  keydPorts,
  codex: { realHome: userInfo().homedir, user: userInfo().username },
});
const replacement = createReplacementController({
  home,
  fences,
  runner: agent.runner,
  cells: orchestrator,
  tickets,
});
let resetAvailable = false;
const reset = createComputerResetController({
  home,
  holds: resetHolds,
  fences,
  docker,
  keyd,
  runner: agent.runner,
  cells: orchestrator,
  browser,
  available: () => resetAvailable && !shuttingDown,
  stopping: () => shuttingDown,
});
const startup = async () => {
  await runtimeAdmission.restorePrepared({
    images: runtimeImages,
    readCell: (id) => store.get(id),
    verify: async (record) => {
      if (!runtimeImages) throw new Error("Installed runtime image authority is missing.");
      await verifyDesktopRuntimeImages(docker, record, runtimeImages);
    },
    canPublish: () => !shuttingDown,
    retired: (id) =>
      !!fences.record(id) || resetHolds.records().some((row) => row.oldCellId === id),
  });
  await browserRecovery.recover();
  await orchestrator.containFenced();
  await agent.start();
  try {
    await replacement.owner.start();
  } finally {
    await orchestrator.reconcile({ strict: serviceIdentity !== null });
  }
  await reset.restoreReady();
  resetAvailable = true;
};
void (serviceReadiness ? serviceReadiness.runStartup(startup) : startup()).catch(() =>
  console.error("startup cleanup, replacement recovery or cell reconcile failed"),
);
const keydEvents = new KeydEventRouter({ keyd, live, eventLog });
shutdown.push(
  () => keydEvents.stop(),
  () => keydMonitor.stop(),
  () => browserWarmer?.dispose(),
  () => browserRecovery.close(),
  () => agent?.close(),
  () => orchestrator.dispose(),
  () => registry.dispose(),
  () => recorder.stopAll(SHUTDOWN_FINALIZE_MS),
  () => browserStreams.dispose(),
  () => sessionIndex?.close(),
  () => eventLog.close(),
);
keydMonitor.start();
keydEvents.start();
const installCodes = new InstallCodes(token, port);
const app = createApp({
  token,
  port,
  installCodes,
  serviceReadiness,
  eventLog,
  ...(serviceReadiness
    ? { doctorSelfTests: { cells: orchestrator, readiness: serviceReadiness } }
    : {}),
  agent: agent.routes,
  recorder,
  replay: {
    home,
    eventLog,
    recorder,
    index: sessionIndex,
    thumbs: new Thumbnails(home, frames),
    live,
  },
  cells: { cells: orchestrator, tickets, replacement, reset },
  desktop,
  browser: browserViewer,
  accounts: { cells: orchestrator, browser },
  ui: { dir: webDir("dist") },
  gateway: {
    registry,
    clock,
    eventLog,
    gateway,
    frames,
    live,
    killSwitch,
    prepareDesktopTask: agent.prepareDesktopTask,
  },
  keys: { keyd, monitor: keydMonitor, afterChange: (id) => refreshRunningCells(orchestrator, id) },
});

const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, () => {
  console.log(`localdot daemon on http://127.0.0.1:${port} (token in ${tokenFile})`);
  if (!serviceIdentity) {
    console.log(
      `open http://127.0.0.1:${port}/#code=${installCodes.issue().code} (expires in one minute)`,
    );
  }
  console.log(
    serviceIdentity
      ? "For a fresh sign-in link: localdot open"
      : "For a fresh sign-in link: pnpm --filter @localdot/daemon open",
  );
});
// serve() is typed as HTTP/1-or-HTTP/2; this daemon only ever creates an HTTP/1 server.
attachUpgradeRouter(server as Server, { port, token }, [
  sessionStreamRoute(eventLog),
  manualStreamRoute({
    session: (id) => agent.routes.runner.get(id),
    manual: agent.routes.manual,
  }),
  cellStatusRoute(orchestrator),
  cellStatusRoute(browserStreams, "browsers"),
  desktopStreamRoute(desktop),
  desktopStreamRoute(browserViewer, "browser"),
]);
shutdown.unshift(() => {
  server.close();
});
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

function secureHomeOrFail(dir: string): void {
  try {
    if (secureHome(dir).tightened)
      console.error(`made ${dir} private (removed group and other access)`);
  } catch (err) {
    fail((err as Error).message);
  }
}

function publicOriginFromEnv(): void {
  try {
    setPublicOrigin(process.env.LOCALDOT_PUBLIC_ORIGIN || undefined);
  } catch (err) {
    fail((err as Error).message);
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
