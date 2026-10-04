import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { type TaskModelSelection, ulid } from "@localdot/protocol";
import { normalizeCatalog } from "@localdot/providers";
import { MODELS_DEV_FIXTURE } from "@localdot/providers/testing";
import { expect, type Page } from "@playwright/test";
import { CHATGPT } from "../../../daemon/src/agent/bindings.ts";
import { MemoryStore } from "../../../daemon/src/agent/memory.ts";
import type { AgentRoutesDeps } from "../../../daemon/src/agent/routes.ts";
import { AgentError, AgentRunner } from "../../../daemon/src/agent/runner.ts";
import { AgentSession } from "../../../daemon/src/agent/session.ts";
import { SettingsStore } from "../../../daemon/src/agent/settings.ts";
import { TranscriptStore } from "../../../daemon/src/agent/transcript.ts";
import { createApp } from "../../../daemon/src/app.ts";
import type { CellControls } from "../../../daemon/src/cells/orchestrator.ts";
import { TicketRegistry } from "../../../daemon/src/cells/secrets.ts";
import { cellStatusRoute } from "../../../daemon/src/cells/status-stream.ts";
import { FakeOrchestrator } from "../../../daemon/src/cells/testing/fake-orchestrator.ts";
import type { CellRecord } from "../../../daemon/src/cells/types.ts";
import { monotonicClock } from "../../../daemon/src/clock.ts";
import { DesktopdClient } from "../../../daemon/src/desktopd/client.ts";
import { DesktopdRegistry } from "../../../daemon/src/desktopd/registry.ts";
import { FakeDesktopd } from "../../../daemon/src/desktopd/testing/fake-desktopd.ts";
import { EventLog } from "../../../daemon/src/event-log.ts";
import { sessionStreamRoute } from "../../../daemon/src/event-stream.ts";
import { KillSwitch } from "../../../daemon/src/gateway/kill-switch.ts";
import { LiveSessions } from "../../../daemon/src/gateway/live.ts";
import { attachUpgradeRouter } from "../../../daemon/src/upgrade-router.ts";

// Actual production page/CSP, authenticated daemon routes, journal, manual lease and kill
// switch. Docker/keyd/native desktop are isolated stand-ins; no account or model is used.
const require = createRequire(new URL("../../../daemon/package.json", import.meta.url));
const { getRequestListener } = require("@hono/node-server") as {
  getRequestListener(
    fetch: (request: Request) => Response | Promise<Response>,
  ): Parameters<typeof createServer>[0];
};
const TOKEN = "a".repeat(43);
type StopEdge = "paused" | "fallback" | "unknown";
export async function fixture(
  kind: "api" | "chatgpt" = "api",
  edge: StopEdge = "paused",
  realLifecycle = false,
  nativeSockets = false,
) {
  const home = mkdtempSync(join(tmpdir(), "localdot-controls-browser-")),
    clock = monotonicClock(),
    log = new EventLog(home, clock),
    cellId = ulid(),
    cells = new FakeOrchestrator(),
    tickets = new TicketRegistry(),
    live = new LiveSessions();
  cells.emit({
    id: cellId,
    state: "ready",
    scale: 2,
    createdAt: new Date().toISOString(),
    stream: { connection: "live", viewers: 1, lastUpstreamAt: 1 },
  });
  let realRunner: AgentRunner | undefined;
  let finishDriver: (() => void) | undefined;
  let session: AgentSession;
  if (realLifecycle) {
    const began = Promise.withResolvers<void>();
    const inert = () => {
      throw new Error("Unexpected real-lifecycle fixture boundary");
    };
    realRunner = new AgentRunner({
      home,
      eventLog: log,
      live,
      cell: (key) => cells.get(key),
      brains: {
        open: async () => inert(),
        start: async () => inert(),
        exited: async () => inert(),
        close: async () => inert(),
      },
      keyd: {
        secrets: async () => inert(),
        beginTask: async () => inert(),
        modelAdmission: async () => inert(),
        setModelAdmission: async () => inert(),
      },
      settings: () => ({ main: { provider: CHATGPT, model: "owned-plan-model" } }),
      catalog: () => undefined,
      memory: new MemoryStore(home),
      transcripts: new TranscriptStore(home),
      installSkills: async () => [],
      waitForUploads: async () => {},
      stopSession: async () => undefined,
      idleMs: 0,
      codex: {
        account: {
          status: async () => ({ available: true, codexVersion: "0.154.0", state: "signed_in" }),
        },
        driver: {
          run: async (owned) => {
            owned.beginBrain();
            owned.setStatus("running");
            began.resolve();
            await new Promise<void>((resolve) => {
              const finish = () => {
                owned.abort.signal.removeEventListener("abort", finish);
                resolve();
              };
              finishDriver = finish;
              owned.abort.signal.addEventListener("abort", finish, { once: true });
              if (owned.stopped) finish();
            });
            return 0;
          },
        },
      },
    });
    session = await realRunner.start(cellId, "Sample · questions and manual control");
    await began.promise;
  } else {
    session = new AgentSession(
      log.createSession("Sample · questions and manual control"),
      cellId,
      "Owned sample task",
      log,
    );
    session.beginBrain();
    log.append(session.id, {
      agent: "main",
      type: "session.start",
      data: {
        screen: { w: 2560, h: 1600, scale: 2 },
        os: "linux",
        title: "Sample · questions and manual control",
      },
    });
  }
  const id = session.id;
  session.append("message.user", {
    messageId: ulid(),
    kind: "task",
    text: "Prepare the sample report. Ask me before signing in.",
  });
  session.append("message.assistant", {
    messageId: ulid(),
    text: "I can ask a question, then let you enter text directly on the computer.",
  });
  session.append("plan.set", {
    items: [
      { id: "choose", text: "Choose the report format", status: "doing" },
      { id: "signin", text: "Let you sign in", status: "todo" },
      { id: "finish", text: "Return control and finish the report", status: "todo" },
    ],
  });
  const ledger = { taskId: id, limit: 5, spent: 4 };
  const raises: { id: string; ceiling: number }[] = [];
  const memory = new MemoryStore(home);
  const remembered = memory.apply(
    id,
    "MEMORY.md",
    "append",
    "Sample fact: reports use Chinese and English.",
  );
  session.append("memory.change", {
    file: remembered.file,
    patch: remembered.patch,
    changeId: remembered.changeId,
  });
  const models: TaskModelSelection =
    kind === "chatgpt"
      ? { kind: "chatgpt", model: "owned-plan-model" }
      : { kind: "api", roles: [{ role: "main", provider: "owned", model: "sample-main" }] };
  session.append("model.usage", {
    role: "main",
    route: kind === "chatgpt" ? "chatgpt" : "owned",
    model: kind === "chatgpt" ? "owned-plan-model" : "sample-main",
    inputTokens: 10,
    outputTokens: 3,
    reasoningTokens: 1,
  });
  session.append("model.usage", {
    role: "main",
    route: kind === "chatgpt" ? "chatgpt" : "owned",
    model: kind === "chatgpt" ? "owned-plan-model" : "sample-main",
    inputTokens: 20,
    outputTokens: 4,
  });
  session.append("budget.exceeded", {
    scope: "task",
    taskId: id,
    limitUSD: 5,
    spentUSD: 4,
    needUSD: 2,
  });
  if (kind === "chatgpt")
    session.append("subscription.usage", {
      provider: "chatgpt",
      plan: "Sample plan",
      windows: [{ window: "primary", usedPercent: 98 }],
      limitReached: true,
    });
  session.setStatus("paused");
  session.append("agent.state", {
    state: "paused",
    reason: kind === "chatgpt" ? "chatgpt plan limit reached" : "budget",
  });
  let teardown = false;
  if (!realRunner)
    live.start(
      cellId,
      id,
      (signal) =>
        new Promise<void>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              session.stop();
              void session.toolsSettled().then(resolve, resolve);
            },
            { once: true },
          );
        }),
    );
  const native = new FakeDesktopd({
    type: (body) => ({
      progress: [],
      result: {
        done: true,
        count: [...String((body as { text: string }).text)].length,
        armedMono: 1,
        firstPressMono: 2,
        injector: "xtest",
      },
    }),
  });
  const client = new DesktopdClient(
    { baseUrl: "http://owned-desktop.invalid", token: native.token },
    native.fetchImpl,
  );
  const registry = new DesktopdRegistry(cells, clock, native.fetchImpl);
  const record: CellRecord = {
    v: 1,
    id: cellId,
    scale: 2,
    createdAt: "2026-10-04T00:00:00Z",
    keydPort: 4790,
    tokens: { desktopd: native.token, stream: "s".repeat(43) },
    docker: {
      internalNetwork: "owned-internal",
      egressNetwork: "owned-egress",
      homeVolume: "owned-home",
      gate: "owned-gate",
      desktop: "owned-desktop",
      gateInternalIp: "10.0.0.1",
      gateEgressIp: "10.1.0.1",
      desktopIp: "10.0.0.2",
    },
  };
  const effects: string[] = [];
  const controls: CellControls = {
    waitedForOperation: false,
    pause: async () => {
      effects.push("pause");
      if (edge !== "paused") throw new Error("synthetic private native diagnostic");
      const cell = cells.get(cellId);
      if (cell) cells.emit({ ...cell, paused: true });
    },
    stop: async () => {
      effects.push("stop");
      if (edge === "unknown") throw new Error("synthetic private native diagnostic");
      await cells.stop(cellId);
    },
    start: async () => {
      throw new Error("Unexpected owned start");
    },
    unpause: async () => {
      effects.push("unpause");
      const cell = cells.get(cellId);
      if (cell) {
        const { paused: _, ...ready } = cell;
        cells.emit(ready);
      }
    },
  };
  const killSwitch = new KillSwitch({
    live,
    keyd: {
      revoke: async () => {
        effects.push("revoke");
        return 0;
      },
      close: async () => {
        effects.push("close");
      },
      isWired: async () => true,
      refresh: async () => {
        effects.push("refresh");
        return [];
      },
    },
    cells: {
      get: (key) => cells.get(key),
      record: (key) => (key === cellId ? record : undefined),
      withLifecycle: async (_key, run) => run(controls),
    },
  });
  const catalog = normalizeCatalog(MODELS_DEV_FIXTURE, "2026-10-04T00:00:00Z");
  const unused = () => {
    throw new Error("Unexpected owned dependency");
  };
  const agent: AgentRoutesDeps = {
    home,
    settings: new SettingsStore(home),
    catalog: { get: () => catalog, refresh: async () => catalog },
    keyd: { secrets: async () => [] },
    memory,
    skills: () => [
      {
        name: "sample-tables",
        description: "Read the sample table and check totals.",
        source: "builtin",
        dir: home,
      },
    ],
    canChangeMemory: () => !session.controlHeld && !killSwitch.isBusy(cellId),
    taskMutationReady: (owner) =>
      owner === session &&
      cells.get(cellId)?.state === "ready" &&
      !cells.get(cellId)?.paused &&
      !killSwitch.isBusy(cellId),
    runner: realRunner ?? {
      get: (key) => (key === id ? session : undefined),
      start: unused,
      selectionOf: () => models,
      raiseBudget: async (taskId, ceiling) => {
        if (taskId !== id || kind === "chatgpt" || session.stopped || session.controlHeld)
          throw new AgentError(409, "Owned budget unavailable");
        if (ceiling < ledger.spent) throw new AgentError(400, "Owned ceiling below spent");
        raises.push({ id: taskId, ceiling });
        ledger.limit = ceiling;
        session.post("resume", "");
        session.setStatus("running");
        session.append("agent.state", { state: "thinking" });
      },
    },
    desktop: unused,
    manual: (owner) =>
      owner === session
        ? {
            screen: { w: 2560, h: 1600 },
            client,
            prepare: async () => {},
            release: () => {},
            check: () => {
              const cell = cells.get(cellId);
              if (
                teardown ||
                !cell ||
                cell.state !== "ready" ||
                cell.paused ||
                killSwitch.isBusy(cellId)
              )
                throw new Error("Owned native edge unavailable");
            },
          }
        : undefined,
    redactUserText: (text) => text,
    appendTo: (taskId, type, data) => {
      if (taskId !== id) throw new Error("Unexpected memory owner");
      session.append(type, data);
    },
    harness: () => ({ available: false, reason: "Owned fixture has no account" }),
  };
  let app: ReturnType<typeof createApp>;
  const server: Server = createServer(getRequestListener((request) => app.fetch(request)));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Owned listener missing");
  const origin = `http://127.0.0.1:${address.port}`;
  const upgraded = new Set<Duplex>();
  const historyPeers = new Set<Duplex>();
  let historyConnections = 0;
  if (nativeSockets) {
    attachUpgradeRouter(server, { port: address.port, token: TOKEN }, [
      cellStatusRoute(cells),
      sessionStreamRoute(log),
    ]);
    server.on("upgrade", (request, peer) => {
      upgraded.add(peer);
      if (request.url?.split("?")[0] === `/api/sessions/${id}/stream`) {
        historyPeers.add(peer);
        historyConnections++;
      }
      peer.once("close", () => {
        upgraded.delete(peer);
        historyPeers.delete(peer);
      });
    });
  }
  app = createApp({
    token: TOKEN,
    port: address.port,
    eventLog: log,
    cells: { cells, tickets },
    gateway: { registry, clock, eventLog: log, live, killSwitch },
    agent,
    ui: { dir: fileURLToPath(new URL("../../dist", import.meta.url)) },
  });
  app.get("/api/keyd", (c) =>
    c.json({
      online: true,
      bootId: "owned-controls-fixture",
      audit: { ok: true },
      hairpin: { state: "active" },
    }),
  );
  app.get("/api/keys", (c) => c.json({ keys: [] }));
  app.get("/cells/:cell/desktop/:ticket/", (c) =>
    c.req.param("cell") === cellId && tickets.resolve(c.req.param("ticket")) === cellId
      ? c.html(
          '<!doctype html><video id="videoStream" autoplay muted></video><script src="/owned-preview.js"></script>',
        )
      : c.text("unknown ticket", 404),
  );
  app.get("/owned-preview.js", (c) =>
    c.body(
      `
    const canvas=document.createElement('canvas');canvas.width=2560;canvas.height=1600;
    const ctx=canvas.getContext('2d');let ticks=0;
    function draw(){ctx.fillStyle='#15161a';ctx.fillRect(0,0,2560,1600);
      ctx.fillStyle='#eeeff1';ctx.font='56px system-ui';ctx.fillText('Sample desktop',100,160);
      ctx.font='40px system-ui';ctx.fillText('Manual input stays on the computer',100,250);
      ctx.fillStyle='#25272c';ctx.fillRect(100,330,1000,110);
      ctx.fillStyle='#999ca4';ctx.fillText('Sign in · sample screen',140,400);
      ctx.fillStyle='#3fb5de';ctx.fillRect(100+(ticks++%40),520,350,90);}
    draw();setInterval(draw,100);
    const video=document.getElementById('videoStream');video.srcObject=canvas.captureStream(10);
    video.play().catch(()=>{});
  `,
      200,
      { "content-type": "text/javascript" },
    ),
  );
  return {
    home,
    log,
    id,
    cellId,
    session,
    native,
    effects,
    ledger,
    raises,
    memory,
    remembered,
    origin,
    cells,
    realRunner,
    nativeSockets,
    async reconnectHistory() {
      if (!nativeSockets || !historyPeers.size) throw new Error("No owned native history socket");
      const before = historyConnections;
      for (const peer of historyPeers) peer.destroy();
      const deadline = Date.now() + 5000;
      while (historyConnections === before && Date.now() < deadline)
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      if (historyConnections === before) throw new Error("Owned native reconnect deadline");
      return historyConnections;
    },
    async finish() {
      if (!realRunner || !finishDriver) throw new Error("No real owned lifecycle");
      finishDriver();
      await live.settled(id);
      expect(realRunner.get(id)).toBeUndefined();
      expect(realRunner.terminalOf(id)).toMatchObject({ sessionId: id, cellId, status: "ended" });
    },
    async close() {
      teardown = true;
      live.stop(id);
      session.stop();
      await realRunner?.close();
      await session.toolsSettled();
      await live.settled(id);
      registry.dispose();
      log.close();
      for (const peer of upgraded) peer.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      rmSync(home, { recursive: true, force: true });
      expect(server.listening).toBe(false);
    },
  };
}
export async function load(page: Page, f: Awaited<ReturnType<typeof fixture>>) {
  page.setDefaultTimeout(5_000);
  let replay: (() => void) | undefined;
  const errors: string[] = [],
    external: string[] = [],
    csp: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  if (f.nativeSockets)
    page.on("websocket", (socket) => {
      const url = new URL(socket.url());
      if (
        url.origin.replace(/^ws/, "http") !== f.origin ||
        ![`/api/cells/${f.cellId}/status`, `/api/sessions/${f.id}/stream`].includes(url.pathname)
      )
        external.push("Unexpected native socket");
    });
  await page.route("**/*", (route) => {
    if (new URL(route.request().url()).origin === f.origin) return route.fallback();
    external.push("Unexpected external request");
    return route.abort();
  });
  if (!f.nativeSockets)
    await page.routeWebSocket("**/*", (ws) => {
      const url = new URL(ws.url());
      expect(url.origin.replace(/^ws/, "http")).toBe(f.origin);
      if (url.pathname === `/api/cells/${f.cellId}/status`) {
        ws.send(JSON.stringify(f.cells.get(f.cellId)));
        const unsubscribe = f.cells.subscribe((cell) => ws.send(JSON.stringify(cell)));
        ws.onClose(unsubscribe);
      } else if (url.pathname === `/api/sessions/${f.id}/stream`) {
        replay = () => {
          for (const event of f.log.read(f.id)) ws.send(JSON.stringify(event));
        };
        replay();
        const unsubscribe = f.log.subscribe((id, event) => {
          if (id === f.id) ws.send(JSON.stringify(event));
        });
        ws.onClose(unsubscribe);
      } else throw new Error("Unexpected owned socket");
    });
  await page.addInitScript(() => {
    localStorage.setItem("localdot.token", "a".repeat(43));
    Object.defineProperty(window, "controlProof", { value: { csp: [], rejection: false } });
    document.addEventListener("securitypolicyviolation", (event) => {
      (window as unknown as { controlProof: { csp: string[] } }).controlProof.csp.push(
        event.effectiveDirective,
      );
    });
    window.addEventListener("unhandledrejection", () => {
      (window as unknown as { controlProof: { rejection: boolean } }).controlProof.rejection = true;
    });
  });
  const response = await page.goto(f.origin);
  expect(response?.headers()["content-security-policy"]).toContain("default-src 'self'");
  expect(response?.headers()["content-security-policy"]).not.toContain("unsafe-");
  try {
    await expect(page.locator(".title")).toHaveText("Sample · questions and manual control");
  } catch (error) {
    throw new Error(
      `Owned page did not load: ${JSON.stringify({ errors, external, dom: (await page.locator("body").innerText()).slice(0, 2000) })}`,
      { cause: error },
    );
  }
  return {
    errors,
    external,
    csp,
    replay: async () => {
      if (f.nativeSockets) return f.reconnectHistory();
      if (!replay) throw new Error("No current owned history socket");
      replay();
      return 0;
    },
  };
}
export async function proof(page: Page, errors: string[], external: string[]) {
  expect(errors).toEqual([]);
  expect(external).toEqual([]);
  expect(
    await page.evaluate(() => (window as unknown as { controlProof: unknown }).controlProof),
  ).toEqual({ csp: [], rejection: false });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  expect(overflow).toBe(false);
}
