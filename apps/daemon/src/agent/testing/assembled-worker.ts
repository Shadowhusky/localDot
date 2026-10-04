// Opt-in local acceptance process: production components, isolated home and Docker
// identities. Only the upstream model is synthetic. No real account is initialized.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { serve } from "@hono/node-server";
import { homeLabel } from "../../agent/brain-cell.ts";
import { createAgent } from "../../agent/wiring.ts";
import { createApp } from "../../app.ts";
import { DockerClient, DockerError } from "../../cells/docker.ts";
import { CellOrchestrator } from "../../cells/orchestrator.ts";
import { probeDesktopd, probeStream } from "../../cells/readiness.ts";
import { TicketRegistry } from "../../cells/secrets.ts";
import { cellStatusRoute } from "../../cells/status-stream.ts";
import { CellStore } from "../../cells/store.ts";
import { desktopStreamRoute } from "../../cells/stream-proxy.ts";
import { monotonicClock } from "../../clock.ts";
import { DesktopdRegistry } from "../../desktopd/registry.ts";
import { findDockerSocket } from "../../doctor-socket.ts";
import { EventLog } from "../../event-log.ts";
import { sessionStreamRoute } from "../../event-stream.ts";
import { FrameStore } from "../../gateway/frames.ts";
import { ActionGateway } from "../../gateway/gateway.ts";
import { KillSwitch } from "../../gateway/kill-switch.ts";
import { LiveSessions } from "../../gateway/live.ts";
import { loadOnsetTable } from "../../gateway/onset-table.ts";
import { policyFromEnv } from "../../gateway/ring-onset.ts";
import { CellKeydWiring, refreshRunningCells } from "../../keyd/cell-wiring.ts";
import { KeydClient } from "../../keyd/client.ts";
import { KeydEventRouter } from "../../keyd/event-router.ts";
import { KeydMonitor } from "../../keyd/monitor.ts";
import { startKeyd } from "../../keyd/testing/keyd-process.ts";
import { attachUpgradeRouter } from "../../upgrade-router.ts";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};
const home = required("LOCALDOT_ACCEPTANCE_HOME"),
  ui = required("LOCALDOT_ACCEPTANCE_UI"),
  artifacts = required("LOCALDOT_ACCEPTANCE_ARTIFACTS"),
  desktopImage = required("LOCALDOT_DESKTOP_IMAGE"),
  gateImage = required("LOCALDOT_GATE_IMAGE"),
  brainImage = required("LOCALDOT_BRAIN_IMAGE");
if (
  process.env.LOCALDOT_ASSEMBLED_TESTS !== "1" ||
  !home ||
  !ui ||
  !desktopImage ||
  !gateImage ||
  !brainImage ||
  !process.env.LOCALDOT_KEYD_BIN ||
  !process.send
)
  throw new Error("Explicit owned acceptance configuration is required.");
const port = Number(process.env.LOCALDOT_ACCEPTANCE_PORT ?? 4765);
const toolPort = Number(process.env.LOCALDOT_ACCEPTANCE_TOOL_PORT ?? 4762);
if (
  ![port, toolPort].every((n) => Number.isInteger(n) && n >= 4750 && n <= 4899) ||
  port === toolPort
)
  throw new Error("Invalid owned acceptance ports.");
const removed: { cellId: string; containers: string[]; networks: string[]; volume: string }[] = [];
const cleanup: { phase: number; run: () => unknown | Promise<unknown> }[] = [];
let closing: Promise<void> | undefined;
let startup: Promise<void> | undefined;
let retiring = false;
const checkStartup = () => {
  if (retiring) throw new Error("Owned startup was cancelled");
};
async function close(): Promise<void> {
  if (closing) return closing;
  closing = (async () => {
    const failures: unknown[] = [];
    for (const action of [...cleanup].sort((a, b) => a.phase - b.phase))
      try {
        await action.run();
      } catch (error) {
        failures.push(error);
      }
    if (failures.length) throw new AggregateError(failures, "Acceptance cleanup incomplete");
  })();
  return closing;
}
function leave(code: number) {
  retiring = true;
  void (async () => {
    await startup?.catch(() => {});
    await close();
    process.exit(code);
  })().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
process.on("disconnect", () => leave(0));
process.on("SIGTERM", () => leave(143));
process.on("SIGINT", () => leave(130));
async function main() {
  const token = "u".repeat(43),
    clock = monotonicClock();
  const log = new EventLog(home, clock),
    docker = new DockerClient(findDockerSocket().path);
  cleanup.push({ phase: 80, run: () => log.close() });
  const keydProcess = await startKeyd({ home, ports: { from: 4791, to: 4794 } });
  cleanup.push({
    phase: 90,
    run: () => keydProcess.stop({ artifactsTo: join(artifacts, "keyd-exit") }),
  });
  checkStartup();
  const keyd = new KeydClient(keydProcess.socketPath),
    keydWiring = new CellKeydWiring({ keyd, docker });
  const range = { from: 4791, to: 4794 };
  let agent: ReturnType<typeof createAgent> | undefined;
  const cells = new CellOrchestrator({
    docker,
    keyd: keydWiring,
    store: new CellStore(home, range),
    images: { desktop: desktopImage, gate: gateImage },
    namePrefix: `localdot-test-ui14-${process.pid}-`,
    externalKeydPorts: () => agent?.reservedPorts() ?? [],
    probeDesktopd,
    probeStream,
    watchEveryMs: 1000,
  });
  cleanup.push(
    {
      phase: 40,
      run: async () => {
        const failures: unknown[] = [];
        for (const cell of cells.list())
          try {
            const record = cells.record(cell.id);
            if (!record) throw new Error("Owned cell record disappeared during cleanup");
            removed.push({
              cellId: cell.id,
              containers: [record.docker.desktop, record.docker.gate],
              networks: [record.docker.internalNetwork, record.docker.egressNetwork],
              volume: record.docker.homeVolume,
            });
            await cells.remove(cell.id, { purgeHome: true });
          } catch (error) {
            failures.push(error);
          }
        if (failures.length) throw new AggregateError(failures, "Owned desktop cleanup incomplete");
      },
    },
    { phase: 50, run: () => cells.dispose() },
  );
  const tickets = new TicketRegistry(),
    registry = new DesktopdRegistry(cells, clock),
    frames = new FrameStore(home),
    onset = loadOnsetTable(home);
  cleanup.push({ phase: 60, run: () => registry.dispose() });
  const gateway = new ActionGateway({
    eventLog: log,
    cells,
    registry,
    onset,
    ringOnset: policyFromEnv(onset),
    frames,
    now: () => clock.nowMicros(),
    sleep: (ms, signal) => sleep(ms, undefined, { signal }),
  });
  const live = new LiveSessions(),
    killSwitch = new KillSwitch({ live, keyd: keydWiring, cells }),
    monitor = new KeydMonitor(keyd);
  cleanup.push({ phase: 20, run: () => monitor.stop() });
  const unsubscribe = monitor.subscribe((now, before) => {
    void agent?.runner.keydChanged(now, before).catch((error) => console.error(error));
  });
  cleanup.push({ phase: 60, run: () => unsubscribe() });
  agent = createAgent({
    home,
    installToken: token,
    eventLog: log,
    live,
    cells,
    registry,
    gateway,
    frames,
    docker,
    keyd,
    monitor,
    killSwitch,
    keydPorts: range,
    toolPort,
  });
  cleanup.push({ phase: 30, run: () => agent?.close() });
  // Metadata only: real UI key intake and real settings routes still establish the
  // selected role, endpoint, sealed key, prices, accounting route and model boot.
  mkdirSync(join(home, "catalog"), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(home, "catalog/models.json"),
    JSON.stringify({
      v: 1,
      source: "owned-local-acceptance",
      fetchedAt: "2026-10-04T00:00:00.000Z",
      skipped: 0,
      providers: {
        "openai-compatible": {
          name: "Synthetic local provider",
          models: {
            "fixture-assembled-v1": {
              id: "fixture-assembled-v1",
              name: "Synthetic assembly model",
              vision: true,
              toolCall: true,
              reasoning: false,
              contextTokens: 200000,
              maxOutputTokens: 500,
              inputUSDPerMTok: 1,
              outputUSDPerMTok: 1,
            },
          },
        },
      },
    }),
    { mode: 0o600 },
  );
  const desktop = { cells, tickets, vendorDir: join(ui, "../vendor/selkies") };
  const events = new KeydEventRouter({ keyd, live, eventLog: log });
  cleanup.push({ phase: 10, run: () => events.stop() });
  monitor.start();
  events.start();
  await cells.reconcile();
  checkStartup();
  await agent.start();
  checkStartup();
  for (let i = 0; !monitor.health.online && i < 50; i++) await sleep(100);
  checkStartup();
  if (!monitor.health.online) throw new Error("Owned keyd did not become ready.");
  const app = createApp({
    token,
    port,
    eventLog: log,
    agent: agent.routes,
    cells: { cells, tickets },
    desktop,
    ui: { dir: ui },
    gateway: { registry, clock, eventLog: log, gateway, frames, live, killSwitch },
    keys: { keyd, monitor, afterChange: (id) => refreshRunningCells(cells, id) },
  });
  const server = await new Promise<ReturnType<typeof serve>>((resolve, reject) => {
    const s = serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, () => resolve(s));
    s.once("error", reject);
  });
  const connections = new Set<import("node:net").Socket>();
  server.on("connection", (socket) => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
  });
  let serverClosed: Promise<void> | undefined;
  cleanup.push(
    {
      phase: 0,
      run: () => {
        serverClosed = new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        void serverClosed.catch(() => {});
      },
    },
    {
      phase: 70,
      run: async () => {
        for (const socket of connections) socket.destroy();
        await serverClosed;
      },
    },
  );
  cleanup.push({
    phase: 75,
    run: async () => {
      for (const entry of removed) {
        const objects = [
          ...entry.containers.map((id) => `/containers/${encodeURIComponent(id)}/json`),
          ...entry.networks.map((id) => `/networks/${encodeURIComponent(id)}`),
          `/volumes/${encodeURIComponent(entry.volume)}`,
        ];
        for (const path of objects) {
          try {
            await docker.request({ method: "GET", path });
            throw new Error(`Owned desktop object remains: ${path}`);
          } catch (error) {
            if (!(error instanceof DockerError) || error.status !== 404) throw error;
          }
        }
      }
      writeFileSync(
        join(artifacts, "cleanup.json"),
        JSON.stringify({ removed, everyOwnedDesktopObjectAbsent: true }, null, 2),
      );
      const filters = JSON.stringify({ label: [`localdot.home=${homeLabel(home)}`] });
      for (const path of ["/containers/json", "/networks"]) {
        const rows = await docker.request<unknown[]>({
          method: "GET",
          path,
          query: { all: "true", filters },
        });
        if (rows.length) throw new Error(`Owned brain objects remain: ${path}`);
      }
    },
  });
  attachUpgradeRouter(server as Server, { port, token }, [
    sessionStreamRoute(log),
    cellStatusRoute(cells),
    desktopStreamRoute(desktop),
  ]);
  const hash = (s: string | undefined) => (s ? createHash("sha256").update(s).digest("hex") : null);
  const records = () => {
    try {
      return readFileSync(join(home, "keyd/provider-requests.jsonl"), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((s) => JSON.parse(s));
    } catch {
      return [];
    }
  };
  process.on("message", async (value: unknown) => {
    if (!value || typeof value !== "object" || !("kind" in value) || !("id" in value)) return;
    const message = value as { kind: unknown; id: unknown; sessionId?: string };
    try {
      if (message.kind === "state") {
        const views = cells.list();
        const sessions = views.map((c) => {
          const id = message.sessionId ?? live.get(c.id),
            s = id ? agent?.runner.get(id) : undefined;
          return {
            cell: c,
            sessionId: id ?? null,
            status: s?.status ?? null,
            generation: s?.generation?.id ?? null,
            proxyHash: hash(s?.boot?.proxy.token),
            desktopTokenHash: hash(cells.record(c.id)?.tokens.desktopd),
            streamTokenHash: hash(cells.record(c.id)?.tokens.stream),
            events: id ? log.read(id) : [],
            provider: records(),
          };
        });
        process.send?.({ id: message.id, ok: true, value: sessions });
      } else if (message.kind === "close") {
        await close();
        process.send?.({ id: message.id, ok: true, value: { clean: true } });
        process.disconnect?.();
      } else throw new Error("Unknown acceptance request");
    } catch (error) {
      process.send?.({ id: message.id, ok: false, error: String(error) });
    }
  });
  process.send?.({
    kind: "ready",
    url: `http://127.0.0.1:${port}/#token=${token}`,
    home,
    images: { desktop: desktopImage, gate: gateImage, brain: brainImage },
    pid: process.pid,
  });
}
startup = main();
void startup.catch(async (error) => {
  console.error(error);
  try {
    await close();
  } catch (cleanupError) {
    console.error(cleanupError);
  }
  process.exit(1);
});
