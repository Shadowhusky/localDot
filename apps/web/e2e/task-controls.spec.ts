import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ulid } from "@localdot/protocol";
import { normalizeCatalog } from "@localdot/providers";
import { MODELS_DEV_FIXTURE } from "@localdot/providers/testing";
import { expect, type Page, test } from "@playwright/test";
import { manualStreamRoute } from "../../daemon/src/agent/manual-stream.ts";
import { MemoryStore } from "../../daemon/src/agent/memory.ts";
import type { AgentRoutesDeps } from "../../daemon/src/agent/routes.ts";
import { AgentSession } from "../../daemon/src/agent/session.ts";
import { SettingsStore } from "../../daemon/src/agent/settings.ts";
import { createApp } from "../../daemon/src/app.ts";
import type { CellControls } from "../../daemon/src/cells/orchestrator.ts";
import { TicketRegistry } from "../../daemon/src/cells/secrets.ts";
import { FakeOrchestrator } from "../../daemon/src/cells/testing/fake-orchestrator.ts";
import type { CellRecord } from "../../daemon/src/cells/types.ts";
import { monotonicClock } from "../../daemon/src/clock.ts";
import { DesktopdClient } from "../../daemon/src/desktopd/client.ts";
import { DesktopdRegistry } from "../../daemon/src/desktopd/registry.ts";
import { FakeDesktopd } from "../../daemon/src/desktopd/testing/fake-desktopd.ts";
import { EventLog } from "../../daemon/src/event-log.ts";
import { KillSwitch } from "../../daemon/src/gateway/kill-switch.ts";
import { LiveSessions } from "../../daemon/src/gateway/live.ts";
import { attachUpgradeRouter } from "../../daemon/src/upgrade-router.ts";

// Actual production page/CSP, authenticated daemon routes, journal, manual lease and kill
// switch. Docker/keyd/native desktop are isolated stand-ins; no account or model is used.
const require = createRequire(new URL("../../daemon/package.json", import.meta.url));
const { getRequestListener } = require("@hono/node-server") as {
  getRequestListener(
    fetch: (request: Request) => Response | Promise<Response>,
  ): Parameters<typeof createServer>[0];
};
const TOKEN = "a".repeat(43);
type StopEdge = "paused" | "fallback" | "unknown";
async function fixture(edge: StopEdge = "paused") {
  const home = mkdtempSync(join(tmpdir(), "localdot-controls-browser-")),
    clock = monotonicClock(),
    log = new EventLog(home, clock),
    id = log.createSession("Sample · questions and manual control"),
    cellId = ulid(),
    session = new AgentSession(id, cellId, "Owned sample task", log),
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
  session.beginBrain();
  log.append(id, {
    agent: "main",
    type: "session.start",
    data: {
      screen: { w: 2560, h: 1600, scale: 2 },
      os: "linux",
      title: "Sample · questions and manual control",
    },
  });
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
  let teardown = false;
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
    v: 2,
    kind: "desktop",
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
    memory: new MemoryStore(home),
    skills: () => [],
    runner: {
      get: (key) => (key === id ? session : undefined),
      start: unused,
      raiseBudget: unused,
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
    appendTo: unused,
    harness: () => ({ available: false, reason: "Owned fixture has no account" }),
  };
  let app: ReturnType<typeof createApp>;
  const server: Server = createServer(getRequestListener((request) => app.fetch(request)));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(process.env.QA_PORT ?? 0), "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Owned listener missing");
  const origin = `http://127.0.0.1:${address.port}`;
  attachUpgradeRouter(server, { port: address.port, token: TOKEN }, [
    manualStreamRoute({
      session: (key) => (key === id ? session : undefined),
      manual: agent.manual,
    }),
  ]);
  app = createApp({
    token: TOKEN,
    port: address.port,
    eventLog: log,
    cells: { cells, tickets },
    gateway: { registry, clock, eventLog: log, live, killSwitch },
    agent,
    ui: { dir: fileURLToPath(new URL("../dist", import.meta.url)) },
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
    origin,
    cells,
    async close() {
      teardown = true;
      live.stop(id);
      session.stop();
      await session.toolsSettled();
      await live.settled(id);
      registry.dispose();
      log.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      rmSync(home, { recursive: true, force: true });
      expect(server.listening).toBe(false);
    },
  };
}
async function load(page: Page, f: Awaited<ReturnType<typeof fixture>>) {
  const errors: string[] = [],
    external: string[] = [],
    csp: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => {
    if (new URL(route.request().url()).origin === f.origin) return route.fallback();
    external.push("Unexpected external request");
    return route.abort();
  });
  // The user's input stream goes to the fixture's own upgrade route; the rest are played here.
  await page.routeWebSocket(
    (url) => !url.pathname.includes("/takeover/"),
    (ws) => {
      const url = new URL(ws.url());
      expect(url.origin.replace(/^ws/, "http")).toBe(f.origin);
      if (url.pathname === `/api/cells/${f.cellId}/status`) {
        ws.send(JSON.stringify(f.cells.get(f.cellId)));
        const unsubscribe = f.cells.subscribe((cell) => ws.send(JSON.stringify(cell)));
        ws.onClose(unsubscribe);
      } else if (url.pathname === `/api/sessions/${f.id}/stream`) {
        for (const event of f.log.read(f.id)) ws.send(JSON.stringify(event));
        const unsubscribe = f.log.subscribe((id, event) => {
          if (id === f.id) ws.send(JSON.stringify(event));
        });
        ws.onClose(unsubscribe);
      } else throw new Error("Unexpected owned socket");
    },
  );
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
  await expect(page.locator(".title")).toHaveText("Sample · questions and manual control");
  return { errors, external, csp };
}
async function proof(page: Page, errors: string[], external: string[]) {
  expect(errors).toEqual([]);
  expect(external).toEqual([]);
  expect(
    await page.evaluate(() => (window as unknown as { controlProof: unknown }).controlProof),
  ).toEqual({ csp: [], rejection: false });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  expect(overflow).toBe(false);
}
test.setTimeout(60_000);
test.use({ hasTouch: true });
for (const width of [1280, 390])
  test(`question, masked takeover and hand-back at ${width}px`, async ({ page }, info) => {
    const f = await fixture();
    try {
      const answer = f.session.ask("Which report format?", ["Markdown", "Plain text"], true, 0);
      await page.setViewportSize({ width, height: 900 });
      const p = await load(page, f);
      if (width < 1100) await page.getByRole("tab", { name: /^Conversation/ }).click();
      const askId = f.session.pendingAsk;
      await expect(page.getByRole("form", { name: "Answer dot" })).toBeVisible();
      await page.getByRole("radio", { name: "Markdown", exact: true }).check();
      await expect(page.getByRole("button", { name: "Send answer" })).toBeEnabled();
      await page.getByRole("radio", { name: "Something else…", exact: true }).check();
      await page.getByLabel("Your answer").fill("中文 and English, please");
      await page.screenshot({ path: info.outputPath(`question-${width}.png`), fullPage: true });
      await page.getByRole("button", { name: "Send answer" }).click();
      expect(await answer).toMatchObject({ by: "user", text: "中文 and English, please" });
      await expect(page.getByRole("form", { name: "Answer dot" })).toHaveCount(0);
      expect(f.log.read(f.id).filter((event) => event.type === "ask.answer")).toHaveLength(1);
      expect(f.log.read(f.id).find((event) => event.type === "ask.answer")?.data).toMatchObject({
        askId,
      });
      const returned = f.session
        .takeover("login", "Sign in on the sample computer, then return control.")
        .catch(() => ({ by: "stop" as const }));
      await expect.poll(() => f.session.manualControl).toBe("ready");
      if (width < 1100) await page.getByRole("tab", { name: /^Computer/ }).click();
      // dot hands the computer over from the island; it is the user's once they take it.
      await page.getByRole("button", { name: "Take control", exact: true }).click();
      const handBack = page.getByRole("button", { name: "Hand back", exact: true });
      await expect(handBack).toBeEnabled();
      const keyboard = page.getByLabel("Type on the computer", { exact: true });
      await expect(keyboard).toBeEnabled();
      await page.reload(); // The held takeover is restored from the daemon, never released by reload.
      await expect(handBack).toBeEnabled();
      await expect(keyboard).toBeEnabled();
      await expect
        .poll(async () => Number(await page.locator(".stage-canvas").getAttribute("data-frames")))
        .toBeGreaterThan(0);
      await page.screenshot({ path: info.outputPath(`takeover-${width}.png`), fullPage: true });
      const surface = page.locator(".manual-surface");
      const box = await surface.boundingBox();
      if (!box) throw new Error("Owned manual surface missing");
      await page.evaluate(() => {
        const surface = document.querySelector(".manual-surface");
        surface?.addEventListener(
          "pointerdown",
          (raw) => {
            const event = raw as MouseEvent,
              rect = document.querySelector(".stage-canvas")?.getBoundingClientRect();
            if (!rect) throw new Error("Owned canvas missing");
            const w = Math.round(rect.width * devicePixelRatio),
              h = Math.round(rect.height * devicePixelRatio),
              scale = Math.min(w / 2560, h / 1600);
            Object.defineProperty(window, "sampleClick", {
              value: {
                x: Math.floor(
                  (((event.clientX - rect.left) * w) / rect.width - (w - 2560 * scale) / 2) / scale,
                ),
                y: Math.floor(
                  (((event.clientY - rect.top) * h) / rect.height - (h - 1600 * scale) / 2) / scale,
                ),
              },
            });
          },
          { once: true },
        );
      });
      if (width < 1100) await surface.tap({ position: { x: box.width / 2, y: box.height / 2 } });
      else await surface.click({ position: { x: box.width / 2, y: box.height / 2 } });
      await expect.poll(() => f.native.calls.length).toBe(1);
      const point = await page.evaluate(
        () => (window as unknown as { sampleClick: { x: number; y: number } }).sampleClick,
      );
      expect(Math.abs(point.x - 1280)).toBeLessThanOrEqual(Math.ceil(2560 / box.width));
      expect(Math.abs(point.y - 800)).toBeLessThanOrEqual(Math.ceil(1600 / box.height));
      expect(f.native.calls[0]).toMatchObject({
        path: "/input",
        body: {
          input: { kind: "click", at: point, button: "left", count: 1 },
          holdMs: 0,
        },
      });
      await page
        .getByRole("toolbar", { name: "Computer controls", exact: true })
        .getByRole("button", { name: /^Type text/ })
        .click();
      const paste = page.getByLabel("Text to type on the computer", { exact: true });
      await paste.fill("synthetic-password 中文🙂");
      await paste.press("Enter");
      await expect.poll(() => f.native.calls.length).toBe(2);
      expect(f.native.calls[1]).toMatchObject({
        path: "/type",
        body: { text: "synthetic-password 中文🙂", masked: true },
      });
      await expect(paste).toHaveCount(0);
      expect(JSON.stringify(f.log.read(f.id))).not.toContain("synthetic-password");
      expect(f.session.inboxSequence).toBe(0);
      const handbackRequest = page.waitForRequest(
        (request) => request.url().endsWith("/takeover/done") && request.method() === "POST",
      );
      await handBack.click();
      expect((await handbackRequest).postDataJSON()).not.toHaveProperty("note");
      expect(await returned).toMatchObject({ by: "user" });
      await expect(handBack).toHaveCount(0);
      expect(f.session.controlHeld).toBe(false);
      expect(f.log.read(f.id).find((event) => event.type === "takeover.end")?.data).toMatchObject({
        by: "user",
        typed: true,
      });
      await proof(page, p.errors, p.external);
    } finally {
      await page.close();
      await f.close();
    }
  });
for (const [edge, sheet] of [
  ["paused", "Settings"],
  ["fallback", "Keys"],
  ["unknown", null],
] as const)
  test(`Stop ${edge} from ${sheet ?? "phone task bar"} preserves containment facts`, async ({
    page,
  }, info) => {
    const f = await fixture(edge);
    try {
      const held = f.session
        .takeover("2fa", "Complete sample verification.")
        .catch(() => ({ by: "stop" as const }));
      await expect.poll(() => f.session.manualControl).toBe("ready");
      await page.setViewportSize({ width: 390, height: 850 });
      const p = await load(page, f);
      await page.getByRole("button", { name: "Take control", exact: true }).click();
      await expect(page.getByLabel("Type on the computer", { exact: true })).toBeEnabled();
      await page
        .getByRole("toolbar", { name: "Computer controls", exact: true })
        .getByRole("button", { name: /^Type text/ })
        .click();
      await page
        .getByLabel("Text to type on the computer", { exact: true })
        .fill("unsent-synthetic-password");
      if (sheet === "Keys") await page.getByTestId("keys-button").click();
      else if (sheet) await page.getByRole("button", { name: sheet, exact: true }).click();
      const root = sheet ? page.getByRole("dialog") : page.locator(".task-bar");
      await root.getByRole("button", { name: "Stop", exact: true }).click();
      await held;
      const status = sheet
        ? root.getByRole("region", { name: "Stop status" })
        : page.locator(".theatre-content").getByRole("region", { name: "Stop status" });
      if (edge === "unknown") {
        await expect(status).toContainText("Could not confirm stopped");
        await page.getByRole("button", { name: "Check task and computer" }).click();
        await page.locator(".task-bar").getByRole("button", { name: "Stop", exact: true }).click(); // Actual 404 after live ownership ended.
        await expect(status).toContainText("Could not confirm stopped");
        expect(f.cells.get(f.cellId)?.paused).toBeUndefined();
        expect(f.cells.get(f.cellId)?.state).toBe("ready");
      } else
        await expect(status).toContainText(
          edge === "paused" ? "Your computer is paused" : "Your computer is off",
        );
      await page.screenshot({ path: info.outputPath(`stop-${edge}-390.png`), fullPage: true });
      if (sheet) await root.getByRole("button", { name: /^Close / }).click();
      await expect(page.getByRole("button", { name: "Hand back", exact: true })).toHaveCount(0);
      await expect(page.getByLabel("Message", { exact: true })).toBeDisabled();
      expect(f.native.calls).toEqual([]);
      expect(JSON.stringify(f.log.read(f.id))).not.toContain("unsent-synthetic-password");
      expect(f.effects).toEqual(
        edge === "paused" ? ["revoke", "pause"] : ["revoke", "pause", "close", "stop"],
      );
      if (edge === "paused") {
        await page.getByRole("button", { name: "Resume computer", exact: true }).click();
        await expect.poll(() => f.cells.get(f.cellId)?.paused).toBeUndefined();
        expect(f.effects.slice(-3)).toEqual(["revoke", "refresh", "unpause"]);
        await expect(page.getByLabel("Message", { exact: true })).toBeEnabled();
      }
      await proof(page, p.errors, p.external);
    } finally {
      await page.close();
      await f.close();
    }
  });
