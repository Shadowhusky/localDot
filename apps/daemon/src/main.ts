import type { Server } from "node:http";
import { constants, userInfo } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { serve } from "@hono/node-server";
import { DEFAULT_AUTONOMY } from "@localdot/protocol";
import { manualStreamRoute } from "./agent/manual-stream.ts";
import { MemoryStore } from "./agent/memory.ts";
import { ComputerFences } from "./agent/safety/fences.ts";
import { createReplacementController } from "./agent/safety/replacement-controller.ts";
import { Transfers } from "./agent/transfers.ts";
import { createAgent } from "./agent/wiring.ts";
import { createApp } from "./app.ts";
import { AppEvents, appEventsRoute } from "./app-events.ts";
import { BrowserDownloadCollector } from "./browser/download-collector.ts";
import { QuarantineStore } from "./browser/quarantine.ts";
import { SessionScreens } from "./browser/session-screens.ts";
import { BrowserStreams } from "./browser/streams.ts";
import { BrowserWarmer } from "./browser/warmer.ts";
import { BrowserOrchestrator } from "./cells/browser-orchestrator.ts";
import { BrowserRecovery } from "./cells/browser-recovery.ts";
import { ComputerUpdates, updateComputer } from "./cells/computer-update.ts";
import { DockerClient } from "./cells/docker.ts";
import { browserImagesFromEnv, imagesFromEnv } from "./cells/images.ts";
import { CellOrchestrator } from "./cells/orchestrator.ts";
import { parsePortRange } from "./cells/ports.ts";
import { probeDesktopd, probeStream } from "./cells/readiness.ts";
import { gateRelaySource, relayDirs, TOOL_SOCKET } from "./cells/relay.ts";
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
import { StreamTuning } from "./cells/stream-tuning.ts";
import { monotonicClock } from "./clock.ts";
import { deliverablesFor } from "./deliverables/wiring.ts";
import { DesktopdRegistry } from "./desktopd/registry.ts";
import { findDockerSocket } from "./doctor-socket.ts";
import { EventLog } from "./event-log.ts";
import { sessionStreamRoute } from "./event-stream.ts";
import { ChromeRenderer } from "./exports/chrome.ts";
import { ExportJobs } from "./exports/jobs.ts";
import { exportsStreamRoute } from "./exports/routes.ts";
import { ExportStore } from "./exports/store.ts";
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
import { describeStartupError, runDaemonStartup } from "./main-startup.ts";
import { createNotify } from "./notify/wiring.ts";
import { localdotHome, secureHome } from "./paths.ts";
import { parsePort } from "./port.ts";
import { SHUTDOWN_FINALIZE_MS } from "./recorder/recorder.ts";
import { ScreenRecordings } from "./recorder/screen-recordings.ts";
import { AbsenceGuard } from "./routines/absence.ts";
import { RoutineLauncher } from "./routines/launch.ts";
import { ExpiredRuns, routinePolicy } from "./routines/policy.ts";
import { agentRunnerPort } from "./routines/runner-port.ts";
import { RoutineScheduler } from "./routines/scheduler.ts";
import { startAtLoginPort } from "./routines/start-at-login.ts";
import { stopAll } from "./routines/stop-all.ts";
import { fileStopAllAudit } from "./routines/stop-all-audit.ts";
import { RoutineStore, type StoredRoutine } from "./routines/store.ts";
import { routineToolPort } from "./routines/tool-port.ts";
import { recallHits } from "./search/recall-hits.ts";
import { SearchFeed } from "./search/search-feed.ts";
import { SearchIndex } from "./search/search-index.ts";
import { retainManagedDaemonLease } from "./service-lease.ts";
import { ManagedServiceReadiness, managedServiceFromEnv } from "./service-readiness.ts";
import { SessionIndex } from "./sessions/index-store.ts";
import { retentionFromEnv, sweepRecordings } from "./sessions/retention.ts";
import { summarizeSession, writeSummary } from "./sessions/summary.ts";
import { Thumbnails } from "./sessions/thumbs.ts";
import { webDir } from "./static-ui.ts";
import { loadOrCreateToken } from "./token.ts";
import { installedAppUpdater } from "./updates/installed-updater.ts";
import { sourceAppUpdater } from "./updates/source-updater.ts";
import { attachUpgradeRouter } from "./upgrade-router.ts";
import { installedSpeech } from "./voice/speech.ts";

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
let appInstalling = false;
const runtimeAdmission = new RuntimeUpdateAdmission(home);
const runtimeImages = serviceIdentity ? RuntimeImages.parse(imagesFromEnv()) : undefined;
const fences = new ComputerFences(home, (id) => resetHolds.oldHeld(id));
const docker = new DockerClient(findDockerSocket().path);
const relay = gateRelaySource(docker, home);
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
const images = imagesFromEnv();
const updates = new ComputerUpdates({ home, docker, images, stream, relay });
const orchestrator = new CellOrchestrator({
  updates,
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
  runtimeHold: (id) => appInstalling || runtimeAdmission.held(id),
  creationAllowed: () => !appInstalling && runtimeAdmission.creationAllowed(),
  ...(runtimeImages
    ? {
        verifyRuntime: (record: import("./cells/types.ts").CellRecord) =>
          verifyDesktopRuntimeImages(docker, record, runtimeImages),
      }
    : {}),
  docker,
  keyd: keydWiring,
  store,
  images,
  relay,
  streamFullcolor: stream.fullcolor,
  probeDesktopd,
  probeStream,
});
// Restore reset candidate holds before browser/agent recovery or ordinary cell reconciliation.
// The reset controller will release a candidate only after durable and freshly verified Ready.
// A candidate published in an earlier run carries a release receipt and is not held again.
const holdResetComputers = (binding: { oldCellId: string; newCellId: string }) => {
  tickets.revoke(binding.oldCellId);
  tickets.revoke(binding.newCellId);
  if (resetHolds.candidateHeld(binding.newCellId)) orchestrator.holdReplacement(binding.newCellId);
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
  relay,
  streamFullcolor: stream.fullcolor,
  parentAvailable: browserAvailable,
  externalKeydPorts: () => [...orchestrator.reservedKeydPorts(), ...(agent?.reservedPorts() ?? [])],
});
const browserRecovery = new BrowserRecovery(browser);
const browserWarmer = new BrowserWarmer({
  cells: orchestrator,
  browser,
  available: browserAvailable,
  report: (message) => console.error(message),
});
const browserTickets = new TicketRegistry();
const browserStreams = new BrowserStreams({
  parents: orchestrator,
  browser,
  tickets: browserTickets,
});
// The UI remains available while Docker is unavailable or its startup reconcile is waiting.
// Replacement recovery installs candidate holds before ordinary startup reconciliation.
const tuning = new StreamTuning();
const desktop = { cells: orchestrator, tickets, vendorDir: webDir("vendor/selkies"), tuning };
const browserViewer = {
  cells: browserStreams,
  tickets: browserTickets,
  vendorDir: desktop.vendorDir,
  tuning,
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
const searchIndex = new SearchIndex(home, { sessions: eventLog });
const searchFeed = new SearchFeed({ index: searchIndex, eventLog, notes: new MemoryStore(home) });
const stopSearchFeed = searchFeed.start();
const transfers = new Transfers();
const quarantine = await QuarantineStore.open(home);
const downloads = new BrowserDownloadCollector({ store: quarantine, transfers });
const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const routineStore = new RoutineStore(home, { now: Date.now, zone });
const appEvents = new AppEvents();
// Pushes wait on the push service (keyd gives up after 10 s), so they get their own deadline.
// Test launchers set LOCALDOT_NOTIFY_MAC=off: no suite may post a real Mac banner.
// Before the routine launcher recovers interrupted runs, so their results are told too.
const notify = createNotify({
  home,
  eventLog,
  keyd: new KeydClient(keydSocketPath(home), 15_000),
  events: appEvents,
  ...(process.env.LOCALDOT_NOTIFY_MAC === "off"
    ? { mac: { available: false, show: async () => "unavailable" as const } }
    : {}),
});
const expiredRuns = new ExpiredRuns();
let scheduler: RoutineScheduler | undefined;
const routineChanged = (routine: StoredRoutine) => {
  scheduler?.replan();
  appEvents.publish({
    type: "routine.changed",
    routineId: routine.id,
    revision: routine.revision,
    state: routine.state,
  });
};
const systemClock = {
  now: Date.now,
  mono: () => performance.now(),
  setTimeout: (fn: () => void, ms: number) => {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return () => clearTimeout(timer);
  },
  setInterval: (fn: () => void, ms: number) => {
    const timer = setInterval(fn, ms);
    timer.unref?.();
    return () => clearInterval(timer);
  },
};
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
    report: (message) => console.error(message),
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
  relay,
  ...(process.platform === "linux"
    ? { toolSocket: join(relayDirs(home).toolDir, TOOL_SOCKET) }
    : {}),
  codex: { realHome: userInfo().homedir, user: userInfo().username },
  claudeCode: { realHome: userInfo().homedir },
  recall: (query, limit, exclude) => recallHits(searchIndex, query, limit, exclude),
  notesChanged: (file) => searchFeed.reindexNotes(file),
  policy: routinePolicy({ runOf: (id) => agent?.runner.get(id)?.run, expired: expiredRuns }),
  routines: routineToolPort({ store: routineStore, now: Date.now, zone, changed: routineChanged }),
});
const running = agent;
const routineLauncher = new RoutineLauncher({
  store: routineStore,
  cells: orchestrator,
  runner: agentRunnerPort(running.runner, live, eventLog),
  events: eventLog,
  dockerAvailable: async () => {
    if (appInstalling) return false;
    try {
      await docker.version();
      return true;
    } catch {
      return false;
    }
  },
  userAutonomy: () => running.routes.settings.get().autonomy ?? DEFAULT_AUTONOMY,
  expired: expiredRuns,
  publish: (event) => appEvents.publish(event),
  clock: systemClock,
});
// Before any route can start a run of its own.
routineLauncher.recoverInterrupted();
scheduler = new RoutineScheduler({
  store: routineStore,
  launcher: routineLauncher,
  publish: (event) => appEvents.publish(event),
  clock: systemClock,
  gate: new AbsenceGuard({
    store: routineStore,
    publish: (event) => appEvents.publish(event),
    now: Date.now,
  }),
});
const routineScheduler = scheduler;
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
const startup = () =>
  runDaemonStartup({
    stopping: () => shuttingDown,
    restorePrepared: () =>
      runtimeAdmission.restorePrepared({
        images: runtimeImages,
        readCell: (id) => store.get(id),
        verify: async (record) => {
          if (!runtimeImages) throw new Error("Installed runtime image authority is missing.");
          await verifyDesktopRuntimeImages(docker, record, runtimeImages);
        },
        canPublish: () => !shuttingDown,
        retired: (id) =>
          !!fences.record(id) || resetHolds.records().some((row) => row.oldCellId === id),
      }),
    recoverBrowsers: () => browserRecovery.recover(),
    containFenced: () => orchestrator.containFenced(),
    startAgent: () => agent.start(),
    recoverReplacements: () => replacement.owner.start(),
    reconcile: () => orchestrator.reconcile({ strict: serviceIdentity !== null }),
    restoreResets: () => reset.restoreReady(),
    openResets: () => {
      resetAvailable = true;
    },
  });
void (serviceReadiness ? serviceReadiness.runStartup(startup) : startup())
  .catch((error) => console.error(describeStartupError(error)))
  // Routines start once computers are reconciled, even when an unrelated startup step failed.
  .finally(() => {
    if (shuttingDown) return;
    routineScheduler.start();
    const records = () => orchestrator.list().flatMap((cell) => orchestrator.record(cell.id) ?? []);
    shutdown.unshift(updates.watch(records, (id) => orchestrator.notify(id)));
  });
const keydEvents = new KeydEventRouter({
  keyd,
  live,
  eventLog,
  ask: (cellId, held) => void agent.connections.ask(cellId, held),
  asksMissed: () => void agent.connections.sweep(),
});
// keyd holds a connection for two minutes; a missed event is picked up well within that.
const sweepAsks = setInterval(() => void agent.connections.sweep(), 15_000);
sweepAsks.unref();
shutdown.push(
  () => clearInterval(sweepAsks),
  () => keydEvents.stop(),
  () => keydMonitor.stop(),
  () => browserWarmer.dispose(),
  () => browserRecovery.close(),
  () => routineScheduler.stop(),
  () => {
    routineLauncher.cancelAll();
  },
  () => agent?.close(),
  () => routineStore.close(),
  () => orchestrator.dispose(),
  () => registry.dispose(),
  () => recorder.stopAll(SHUTDOWN_FINALIZE_MS),
  () => browserStreams.dispose(),
  () => sessionIndex?.close(),
  () => stopSearchFeed(),
  () => searchIndex.close(),
  () => notify.close(),
  () => eventLog.close(),
);
keydMonitor.start();
keydEvents.start();
const exportJobs = new ExportJobs({
  store: new ExportStore(home),
  renderer: new ChromeRenderer({ origin: `http://127.0.0.1:${port}`, token }),
});
shutdown.push(() => exportJobs.close());
const installCodes = new InstallCodes(token, port);
const installWait = () => {
  if (
    orchestrator
      .list()
      .some((cell) => live.get(cell.id) || live.idleOperationPending(cell.id) || cell.operation)
  )
    return "Finish or stop the task before updating localDot.";
  appInstalling = true;
  return null;
};
const installSettled = () => {
  appInstalling = false;
};
const appUpdater = serviceIdentity
  ? installedAppUpdater(home, serviceIdentity, installWait, installSettled)
  : await sourceAppUpdater(home, process.env.LOCALDOT_INSTALL_PREFIX, installWait, installSettled);
appUpdater.start();
shutdown.unshift(() => appUpdater.close());
const app = createApp({
  appUpdater,
  appInstalling: () => appInstalling,
  token,
  port,
  installCodes,
  serviceReadiness,
  eventLog,
  exports: exportJobs,
  ...(serviceReadiness
    ? { doctorSelfTests: { cells: orchestrator, readiness: serviceReadiness } }
    : {}),
  agent: agent.routes,
  search: { index: searchIndex, feed: searchFeed },
  recorder,
  replay: {
    home,
    eventLog,
    recorder,
    index: sessionIndex,
    thumbs: new Thumbnails(home, frames),
    live,
  },
  deliverables: deliverablesFor(home, eventLog, frames, {
    computers: () => orchestrator.list(),
    access: running.computerAccess,
    start: (cellId, task, signal, opts) => running.runner.start(cellId, task, signal, opts),
    upload: running.routes.desktop,
    redactUserText: running.routes.redactUserText,
  }),
  cells: {
    cells: orchestrator,
    tickets,
    replacement,
    reset,
    update: (id, signal) =>
      updateComputer({ cells: orchestrator, live, runner: agent.runner }, id, signal),
  },
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
  keys: {
    keyd,
    monitor: keydMonitor,
    afterChange: async (id) => {
      await agent.connectors.afterKeyChange(id);
      return refreshRunningCells(orchestrator, id);
    },
  },
  connectors: { hub: agent.connectors, keyd, signIn: agent.connectorSignIn },
  notify: notify.routes,
  voice: { speech: installedSpeech() },
  routines: {
    store: routineStore,
    scheduler: routineScheduler,
    launcher: routineLauncher,
    publish: (event) => appEvents.publish(event),
    redact: (text) => running.routes.redactUserText(text),
    zone,
    now: Date.now,
    startAtLogin: startAtLoginPort({
      home,
      identity: serviceIdentity,
      node: process.execPath,
      env: process.env,
    }),
    stopAll: (by) =>
      stopAll(
        {
          cells: orchestrator,
          live,
          killSwitch,
          store: routineStore,
          launcher: routineLauncher,
          scheduler: routineScheduler,
          audit: fileStopAllAudit(home),
          publish: (event) => appEvents.publish(event),
          now: Date.now,
        },
        by,
      ),
  },
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
  exportsStreamRoute(exportJobs),
  desktopStreamRoute(desktop),
  desktopStreamRoute(browserViewer, "browser"),
  appEventsRoute(appEvents, notify.presence),
]);
shutdown.unshift(() => {
  server.close();
  tuning.close();
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
