import { webcrypto } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { type KeydRecord, toBase64url, ulid } from "@localdot/protocol";
import { normalizeCatalog } from "@localdot/providers";
import { MODELS_DEV_FIXTURE } from "@localdot/providers/testing";
import type { CodexInstaller, InstalledCodex } from "../../../../harness/codex/src/index.ts";
import type { ChatgptStatus, CodexAccount } from "../../../daemon/src/agent/codex/account.ts";
import { MemoryStore } from "../../../daemon/src/agent/memory.ts";
import type { AgentRoutesDeps } from "../../../daemon/src/agent/routes.ts";
import { AgentSession } from "../../../daemon/src/agent/session.ts";
import { type AgentSettings, SettingsStore } from "../../../daemon/src/agent/settings.ts";
import { createApp } from "../../../daemon/src/app.ts";
import type { CellControls } from "../../../daemon/src/cells/orchestrator.ts";
import { TicketRegistry } from "../../../daemon/src/cells/secrets.ts";
import { cellStatusRoute } from "../../../daemon/src/cells/status-stream.ts";
import { FakeOrchestrator } from "../../../daemon/src/cells/testing/fake-orchestrator.ts";
import type { CellRecord, CellSummary } from "../../../daemon/src/cells/types.ts";
import { monotonicClock } from "../../../daemon/src/clock.ts";
import { DesktopdClient } from "../../../daemon/src/desktopd/client.ts";
import { DesktopdRegistry } from "../../../daemon/src/desktopd/registry.ts";
import { FakeDesktopd } from "../../../daemon/src/desktopd/testing/fake-desktopd.ts";
import { EventLog } from "../../../daemon/src/event-log.ts";
import { sessionStreamRoute } from "../../../daemon/src/event-stream.ts";
import { FrameStore } from "../../../daemon/src/gateway/frames.ts";
import { KillSwitch } from "../../../daemon/src/gateway/kill-switch.ts";
import { LiveSessions } from "../../../daemon/src/gateway/live.ts";
import { keyLabel } from "../../../daemon/src/gateway/text.ts";
import { Recorder } from "../../../daemon/src/recorder/recorder.ts";
import { seedSession } from "../../../daemon/src/recorder/testing/seed-session.ts";
import { SessionIndex } from "../../../daemon/src/sessions/index-store.ts";
import { Thumbnails } from "../../../daemon/src/sessions/thumbs.ts";
import { attachUpgradeRouter } from "../../../daemon/src/upgrade-router.ts";

const require = createRequire(new URL("../../../daemon/package.json", import.meta.url));
const { getRequestListener } = require("@hono/node-server") as {
  getRequestListener(
    fetch: (request: Request) => Response | Promise<Response>,
  ): Parameters<typeof createServer>[0];
};
const env = process.env;
const TOKEN = "a".repeat(43);
const PORT = Number(env.QA_PORT ?? 4786);
const HOME = env.QA_HOME ?? join(tmpdir(), `localdot-ui-fixture-${PORT}`);
const ASSETS = fileURLToPath(new URL("./ui-assets", import.meta.url));
type CellKind =
  | "none"
  | "starting"
  | "connecting"
  | "live"
  | "reconnecting"
  | "paused"
  | "stopped"
  | "failed"
  | "fenced";
const cellKind = (env.QA_CELL ?? "live") as CellKind;
const withSession = env.QA_SESSION !== "0";
const phase = env.QA_PHASE ?? "running";
const settingsMode = env.QA_SETTINGS ?? "configured";
let chatgptState = (env.QA_CHATGPT || undefined) as
  | "signed_in"
  | "signed_out"
  | "not_installed"
  | "unavailable"
  | undefined;
let keydMode = (env.QA_KEYD ?? "online") as "online" | "offline" | "audit" | "guard";
const replays = Number(env.QA_REPLAYS ?? 2);

rmSync(HOME, { recursive: true, force: true });
mkdirSync(HOME, { recursive: true, mode: 0o700 });

const seeded: string[] = [];
for (let n = 0; n < replays; n++) {
  const r = await seedSession({
    home: HOME,
    minutes: n === 0 ? 3 : 1,
    stepsPerMinute: 8,
    title: n === 0 ? "Organize the sample workspace" : `Earlier sample task ${n}`,
    ...(n === 0 ? { takeover: { fromMs: 30000, toMs: 45000 } } : {}),
  });
  seeded.push(r.sessionId);
}

let SAMPLE_KEYS: KeydRecord[] = [
  {
    id: "anthropic-main",
    kind: "llm",
    provider: "anthropic",
    createdAt: "2026-10-01T09:00:00Z",
    updatedAt: "2026-10-01T09:00:00Z",
  },
  {
    id: "openai-fast",
    kind: "llm",
    provider: "openai",
    createdAt: "2026-10-02T09:00:00Z",
    updatedAt: "2026-10-02T09:00:00Z",
  },
  {
    id: "weather",
    kind: "http",
    hosts: ["api.weather.example"],
    header: "Authorization",
    format: "Bearer {key}",
    methods: ["GET"],
    paths: ["/v1/*"],
    createdAt: "2026-10-03T09:00:00Z",
    updatedAt: "2026-10-03T09:00:00Z",
  },
] as KeydRecord[];
if (env.QA_KEYS === "0") SAMPLE_KEYS = [];
const SETTINGS: Record<string, AgentSettings> = {
  configured: {
    main: { provider: "anthropic", model: "claude-sonnet-5-5", key: "anthropic-main" },
    fast: { provider: "openai", model: "gpt-6-luna", key: "openai-fast" },
    taskBudgetUSD: 3,
  } as AgentSettings,
  empty: {},
  chatgpt: { main: { provider: "chatgpt", model: "sample-plan-model" } } as AgentSettings,
};

const DESKTOP_JS = `
const W=2560,H=1600;const canvas=document.createElement('canvas');canvas.width=W;canvas.height=H;
const ctx=canvas.getContext('2d');let t=0;
function draw(){t++;
 const g=ctx.createLinearGradient(0,0,W,H);g.addColorStop(0,'#2b3442');g.addColorStop(1,'#151a22');
 ctx.fillStyle=g;ctx.fillRect(0,0,W,H);
 ctx.fillStyle='#f4f5f7';ctx.fillRect(240,150,2080,1300);
 ctx.fillStyle='#30343c';ctx.font='600 60px system-ui';ctx.fillText('Sample desktop '+t,300,300);
 ctx.strokeStyle='#2f7cf6';ctx.lineWidth=8;ctx.strokeRect(300+(t%60)*10,500,400,200);
}
draw();setInterval(draw,100);
const video=document.getElementById('videoStream');video.srcObject=canvas.captureStream(10);
video.play().catch(()=>{});
`;

let skew = 0;
const base = monotonicClock();
const clock = { nowMicros: () => base.nowMicros() + skew };
const log = new EventLog(HOME, clock);
const cells = new FakeOrchestrator();
const tickets = new TicketRegistry();
const live = new LiveSessions();
const frames = new FrameStore(HOME);
let cellId = ulid();

function cellFor(kind: CellKind, id: string): CellSummary | undefined {
  const b = {
    id,
    scale: 2 as const,
    createdAt: "2026-10-08T09:00:00Z",
    stream: { connection: "live" as const, viewers: 1, lastUpstreamAt: 1 },
  };
  const none = { connection: "none" as const, viewers: 0, lastUpstreamAt: null };
  switch (kind) {
    case "none":
      return undefined;
    case "starting":
      return { ...b, state: "starting", stream: none };
    case "connecting":
      return { ...b, state: "ready", stream: none };
    case "live":
      return { ...b, state: "ready" };
    case "reconnecting":
      return { ...b, state: "ready", stream: { ...b.stream, connection: "stalled" } };
    case "paused":
      return { ...b, state: "ready", paused: true };
    case "stopped":
      return { ...b, state: "stopped", stream: none };
    case "failed":
      return { ...b, state: "failed", stream: none, error: "not ready after 120s" };
    case "fenced":
      return { ...b, state: "ready", fenced: { revision: 1 } } as CellSummary;
  }
}
const initial = cellFor(cellKind, cellId);
if (initial) cells.emit(initial);
const origCreate = cells.create.bind(cells);
cells.create = async (opts) => {
  const created = await origCreate(opts);
  cellId = created.id;
  cells.emit(created);
  setTimeout(() => {
    const c = cells.get(created.id);
    if (c && c.state === "starting")
      cells.emit({
        ...c,
        state: "ready",
        stream: { connection: "live", viewers: 1, lastUpstreamAt: 1 },
      });
  }, 1500);
  return created;
};
cells.stop = async (id) => {
  const c = cells.get(id);
  if (!c) throw new Error("unknown");
  const { paused: _p, ...rest } = c as CellSummary & { paused?: boolean };
  cells.emit({
    ...(rest as CellSummary),
    state: "stopped",
    stream: { connection: "none", viewers: 0, lastUpstreamAt: null },
  });
};
const origStart = cells.start.bind(cells);
cells.start = async (id) => {
  await origStart(id);
  setTimeout(() => {
    const c = cells.get(id);
    if (c && c.state === "starting")
      cells.emit({
        ...c,
        state: "ready",
        stream: { connection: "live", viewers: 1, lastUpstreamAt: 1 },
      });
  }, 1500);
};

let keys = SAMPLE_KEYS;
const settingsStore = new SettingsStore(HOME);
settingsStore.put(SETTINGS[settingsMode] ?? {});
const memory = new MemoryStore(HOME);
const ledger = { limit: 5, spent: 4 };
let session: AgentSession | undefined;
let teardown = false;

function attachLive(owned: AgentSession) {
  live.start(
    owned.cellId,
    owned.id,
    (signal) =>
      new Promise<void>((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            owned.stop();
            void owned.toolsSettled().then(() => {
              try {
                owned.append("session.end", { reason: "stopped" });
              } catch {}
              resolve();
            }, resolve);
          },
          { once: true },
        );
      }),
  );
}
function newSession(title: string, task: string): AgentSession {
  const s = new AgentSession(log.createSession(title), cellId, task, log);
  s.beginBrain();
  log.append(s.id, {
    agent: "main",
    type: "session.start",
    data: { screen: { w: 2560, h: 1600, scale: 2 }, os: "linux", title },
  });
  return s;
}

function seedTask(s: AgentSession, finished: boolean) {
  const a = (type: string, data: Record<string, unknown>, step?: string) => {
    skew += type === "step.end" ? 1_100_000 : 320_000;
    s.append(type, data, step);
  };
  let frameNo = 0;
  const observe = (step: string) => {
    const file = join(ASSETS, `frame-${(frameNo++ % 4) + 1}.webp`);
    if (!existsSync(file)) return;
    const frameId = ulid();
    frames.save(s.id, frameId, readFileSync(file));
    a("observe", { frameId, width: 2560, height: 1600 }, step);
  };
  a("message.user", {
    messageId: ulid(),
    kind: "task",
    text: "Summarise the sample sales table, calculate the monthly totals and save a short report.",
  });
  a("agent.state", { state: "thinking" });
  a("thought.delta", { text: "Opening the spreadsheet to read the sample table." });
  a("message.assistant", {
    messageId: ulid(),
    text: "I'll open the spreadsheet, check the totals, then write a short summary file.",
  });
  a("plan.set", {
    items: [
      { id: "open", text: "Open the sample spreadsheet", status: "done" },
      { id: "calc", text: "Calculate monthly totals", status: finished ? "done" : "doing" },
      { id: "write", text: "Write the summary report", status: finished ? "done" : "todo" },
      { id: "send", text: "Email the report to the team", status: "skipped" },
    ],
  });
  const click = ulid();
  a("step.start", { kind: "gui", planItem: "open" }, click);
  a(
    "action.intent",
    { verb: "click", label: "Open monthly-report.ods", risk: "none", point: { x: 1280, y: 420 } },
    click,
  );
  a(
    "action.dispatch",
    {
      input: { kind: "click", button: "left", count: 1, at: { x: 1280, y: 420 } },
      pressT: 2_000_000,
      ringAt: 2_012_000,
      injector: "xtest",
    },
    click,
  );
  a("action.result", { ok: true }, click);
  observe(click);
  a("step.verify", { status: "success", evidence: "The spreadsheet window is open." }, click);
  a("step.end", { status: "ok" }, click);
  a("key.use", {
    secretId: "anthropic-main",
    host: "api.anthropic.com",
    method: "POST",
    path: "/v1/messages",
    decision: "allow",
  });
  const typing = ulid();
  a("step.start", { kind: "gui", planItem: "calc" }, typing);
  a(
    "action.intent",
    { verb: "type", label: "Type =SUM(F2:F13)", risk: "low", point: { x: 1900, y: 1300 } },
    typing,
  );
  a(
    "action.dispatch",
    {
      input: { kind: "type", chars: 12, masked: false },
      pressT: 3_000_000,
      ringAt: 3_006_000,
      injector: "xtest",
    },
    typing,
  );
  a("text.progress", { chunk: "=SUM(F2:F13)", count: 12, masked: false }, typing);
  a("action.result", { ok: true }, typing);
  observe(typing);
  a("step.end", { status: "ok" }, typing);
  const shell = ulid();
  a("step.start", { kind: "shell", planItem: "calc" }, shell);
  a("tool.start", { tool: "shell", title: "Check totals with csvstat" }, shell);
  a(
    "tool.output",
    {
      stream: "stdout",
      chunk:
        "$ csvstat --sum monthly.csv\n  1. Orders: 1,422\n  2. Revenue: 128,694\nTotal: 12,480\n",
    },
    shell,
  );
  a("tool.output", { stream: "stderr", chunk: "warning: column 'Region' is text\n" }, shell);
  a("tool.end", { ok: true, exitCode: 0 }, shell);
  a("step.end", { status: "ok" }, shell);
  const failed = ulid();
  a("step.start", { kind: "shell" }, failed);
  a("tool.start", { tool: "shell", title: "Validate report schema" }, failed);
  a("tool.output", { stream: "stderr", chunk: "schema.json: no such file\n" }, failed);
  a("tool.end", { ok: false, exitCode: 2 }, failed);
  a("step.end", { status: "failed", note: "The command returned exit code 2." }, failed);
  a("key.use", {
    secretId: "weather",
    host: "api.weather.example",
    method: "GET",
    path: "/v1/forecast?city=sample",
    decision: "deny",
  });
  const file = ulid();
  a("step.start", { kind: "file", planItem: "write" }, file);
  a(
    "file.change",
    {
      path: "report/summary.md",
      op: "create",
      patch: "@@ -0,0 +1,3 @@\n+# Monthly report (sample)\n+\n+- Total net: 12,480",
    },
    file,
  );
  a(
    "file.change",
    {
      path: "report/totals.csv",
      op: "modify",
      patch: "@@ -1,3 +1,3 @@\n Month,Net\n-Dec,12000\n+Dec,12311\n Total,12480",
    },
    file,
  );
  a("step.end", { status: "ok" }, file);
  const remembered = memory.apply(s.id, "MEMORY.md", "append", "Reports use Chinese and English.");
  a("memory.change", {
    file: remembered.file,
    patch: remembered.patch,
    changeId: remembered.changeId,
  });
  a("model.usage", {
    role: "main",
    route: "anthropic",
    model: "claude-sonnet-5-5",
    inputTokens: 18_420,
    outputTokens: 2_210,
    reasoningTokens: 640,
  });
  a("model.usage", {
    role: "fast",
    route: "openai",
    model: "gpt-6-luna",
    inputTokens: 4_100,
    outputTokens: 380,
  });
  if (finished) {
    a("message.assistant", {
      messageId: ulid(),
      text: "## Report ready\n\nThe **monthly total** is 12,480. I saved `summary.md` and updated `totals.csv`.",
    });
    mkdirSync(join(HOME, "sessions", s.id, "out"), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(HOME, "sessions", s.id, "out", "summary.md"),
      "# Monthly report (sample)\n\n- Total net: 12,480\n",
      { mode: 0o600 },
    );
    writeFileSync(
      join(HOME, "sessions", s.id, "out", "totals.csv"),
      "Month,Net\nDec,12311\nTotal,12480\n",
      { mode: 0o600 },
    );
    a("task.result", {
      summary:
        "Sample monthly report prepared.\nOne validation command failed; the totals were checked another way.",
      files: [
        { name: "summary.md", path: "summary.md", bytes: 48 },
        { name: "totals.csv", path: "totals.csv", bytes: 32 },
      ],
    });
    s.setStatus("idle");
    a("agent.state", { state: "idle" });
  } else {
    s.setStatus("running");
    a("agent.state", { state: "acting" });
    const liveStep = ulid();
    a("step.start", { kind: "gui", planItem: "calc" }, liveStep);
    a(
      "action.intent",
      {
        verb: "click",
        label: "Select the Net total cell",
        risk: "none",
        point: { x: 1700, y: 1290 },
      },
      liveStep,
    );
  }
}

if (withSession && initial) {
  session = newSession("Sample · monthly report", "Sample task");
  attachLive(session);
  seedTask(session, phase === "finished");
}

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
const record = (key: string): CellRecord =>
  ({
    v: 2,
    kind: "desktop",
    id: key,
    scale: 2,
    createdAt: "2026-10-08T09:00:00Z",
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
  }) as CellRecord;
const effects: string[] = [];
const controlsFor = (key: string): CellControls => ({
  waitedForOperation: false,
  pause: async () => {
    effects.push("pause");
    const cell = cells.get(key);
    if (cell) cells.emit({ ...cell, paused: true });
  },
  stop: async () => {
    effects.push("stop");
    await cells.stop(key);
  },
  start: async () => {
    throw new Error("Unexpected owned start");
  },
  unpause: async () => {
    effects.push("unpause");
    const cell = cells.get(key);
    if (cell) {
      const { paused: _, ...ready } = cell;
      cells.emit(ready as CellSummary);
    }
  },
});
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
    record: (key) => (cells.get(key) ? record(key) : undefined),
    withLifecycle: async (key, run) => run(controlsFor(key)),
  },
});
const catalog = env.QA_CATALOG
  ? normalizeCatalog(JSON.parse(readFileSync(env.QA_CATALOG, "utf8")), new Date().toISOString())
  : normalizeCatalog(MODELS_DEV_FIXTURE, new Date().toISOString());
const installed: InstalledCodex = {
  version: "0.154.0",
  platform: "darwin-arm64",
  binDir: join(HOME, "inert"),
  codexBin: join(HOME, "inert/codex"),
  codeModeHostBin: join(HOME, "inert/code-mode-host"),
} as InstalledCodex;
const installer = {
  status: () =>
    chatgptState === "signed_in" || chatgptState === "signed_out"
      ? { state: "ready", version: "0.154.0" }
      : { state: "not_installed" },
  ensureInstalled: async () => installed,
  verifiedInstallation: async () =>
    chatgptState === "signed_in" || chatgptState === "signed_out" ? installed : undefined,
  cancel: () => {},
} as unknown as CodexInstaller;
const account = {
  status: async () =>
    ({
      available: chatgptState !== "unavailable",
      codexVersion: "0.154.0",
      state:
        chatgptState === "signed_in"
          ? "signed_in"
          : chatgptState === "unavailable"
            ? "unavailable"
            : "signed_out",
      ...(chatgptState === "signed_in"
        ? {
            account: { email: "preview@example.test", plan: "plus" },
            checkedAt: Date.now(),
            models: [
              { id: "sample-plan-model", name: "Sample plan model", isDefault: true },
              { id: "sample-plan-mini", name: "Sample plan mini", isDefault: false },
            ],
            usage: {
              provider: "chatgpt",
              windows: [
                { window: "primary", usedPercent: 23, windowMinutes: 300 },
                { window: "secondary", usedPercent: 61, windowMinutes: 10080 },
              ],
              limitReached: false,
            },
          }
        : {}),
    }) as ChatgptStatus,
  login: async () => ({
    loginId: "owned-1",
    method: "code",
    verificationUrl: "https://auth.openai.com/codex/device",
    userCode: "TEST-ONLY",
    startedAt: Date.now(),
  }),
  cancelLogin: async () => {},
  logout: async () => {
    chatgptState = "signed_out";
  },
  refresh: async () => account.status(),
} as unknown as CodexAccount;
const harness = () =>
  chatgptState && chatgptState !== "unavailable"
    ? { available: true as const }
    : { available: false as const, reason: "Sample fixture has no ChatGPT harness" };
const agent: AgentRoutesDeps = {
  home: HOME,
  settings: settingsStore,
  catalog: { get: () => catalog, refresh: async () => catalog },
  keyd: {
    secrets: async () => keys,
    budget: async () => ({
      perTaskUSD: 2,
      perDayUSD: 20,
      day: { date: "2026-10-08", spentUSD: 1.2 },
    }),
  } as AgentRoutesDeps["keyd"],
  memory,
  skills: () => [
    {
      name: "sample-tables",
      description: "Read the sample table and check totals.",
      source: "builtin",
      dir: HOME,
    },
    {
      name: "report-writer",
      description: "Write a short bilingual summary of a spreadsheet.",
      source: "user",
      dir: HOME,
    },
  ],
  canChangeMemory: () => !session?.controlHeld && !killSwitch.isBusy(cellId),
  taskMutationReady: (owner) =>
    owner === session &&
    cells.get(cellId)?.state === "ready" &&
    !cells.get(cellId)?.paused &&
    !killSwitch.isBusy(cellId),
  runner: {
    get: (key) => (session && key === session.id ? session : undefined),
    start: async (key, task) => {
      if (key !== cellId) throw new Error("unknown cell");
      if (session && !session.stopped && session.status !== "idle") throw new Error("busy");
      session = newSession(task.slice(0, 60), task);
      attachLive(session);
      session.append("message.user", { messageId: ulid(), kind: "task", text: task });
      session.setStatus("running");
      session.append("agent.state", { state: "thinking" });
      const s = session;
      setTimeout(() => {
        if (s.stopped) return;
        s.append("message.assistant", {
          messageId: ulid(),
          text: "Sample reply: I received the task.",
        });
        s.append("plan.set", {
          items: [{ id: "one", text: "Do the sample thing", status: "doing" }],
        });
      }, 800);
      return s;
    },
    selectionOf: () =>
      chatgptState === "signed_in" && settingsMode === "chatgpt"
        ? { kind: "chatgpt", model: "sample-plan-model" }
        : {
            kind: "api",
            roles: [
              { role: "main", provider: "anthropic", model: "claude-sonnet-5-5" },
              { role: "fast", provider: "openai", model: "gpt-6-luna" },
            ],
          },
    pauseTask: (taskId, requestId) => {
      if (!session || taskId !== session.id) throw new Error("no session");
      const pause = session.requestSafetyPause(requestId);
      session.confirmSafetyPause(requestId, pause.revision);
      return session.safetyPause ?? pause;
    },
    resumeSafety: async (taskId, requestId, revision) => {
      if (!session || taskId !== session.id) throw new Error("no session");
      session.beginSafetyResume(requestId, revision);
      session.resumeSafety(requestId, revision);
    },
    raiseBudget: async (taskId, ceiling) => {
      if (!session || taskId !== session.id) throw new Error("no session");
      ledger.limit = ceiling;
      session.post("resume", "");
      session.setStatus("running");
      session.append("agent.state", { state: "thinking" });
    },
  } as AgentRoutesDeps["runner"],
  desktop: () => undefined,
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
    if (!session || taskId !== session.id) throw new Error("Unexpected memory owner");
    session.append(type, data);
  },
  harness,
  ...(chatgptState ? { chatgpt: { account, installer, availability: harness } } : {}),
};
const pair = await webcrypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
  "deriveBits",
]);
const sealKey = toBase64url(
  new Uint8Array(await webcrypto.subtle.exportKey("raw", pair.publicKey)),
);

const recorder = new Recorder({
  home: HOME,
  eventLog: log,
  cells: { get: () => undefined, endpoints: () => undefined } as never,
  clock,
  enabled: false,
});
const index = new SessionIndex(HOME, { isLive: (id) => live.cellOf(id) !== undefined });

let app: ReturnType<typeof createApp>;
const server: Server = createServer(getRequestListener((request) => app.fetch(request)));
const upgraded = new Set<Duplex>();
server.on("upgrade", (_req, peer) => {
  upgraded.add(peer);
  peer.once("close", () => upgraded.delete(peer));
});
attachUpgradeRouter(server, { port: PORT, token: TOKEN }, [
  cellStatusRoute(cells),
  sessionStreamRoute(log),
]);
app = createApp({
  token: TOKEN,
  port: PORT,
  eventLog: log,
  cells: { cells, tickets },
  gateway: { registry, clock, eventLog: log, live, killSwitch, frames },
  agent,
  recorder,
  replay: {
    home: HOME,
    eventLog: log,
    recorder,
    index,
    thumbs: new Thumbnails(HOME, frames),
    live,
  },
  ui: { dir: fileURLToPath(new URL("../../dist", import.meta.url)) },
});
app.get("/api/keyd", (c) =>
  keydMode === "offline"
    ? c.text("owned key layer offline", 503)
    : c.json({
        online: true,
        bootId: "qa",
        sealKey,
        audit: keydMode === "audit" ? { ok: false, error: "audit log unwritable" } : { ok: true },
        hairpin:
          keydMode === "guard"
            ? { state: "unknown", addresses: 0 }
            : { state: "active", source: "router", addresses: 1 },
      }),
);
app.get("/api/cells/:id/quarantine", (c) => c.json({ items: [] }));
app.get("/api/keys", (c) =>
  keydMode === "offline" ? c.text("owned key layer offline", 503) : c.json({ keys }),
);
app.post("/api/keys", async (c) => {
  const { binding } = (await c.req.json()) as { binding: KeydRecord };
  const at = new Date().toISOString();
  const key = { ...binding, createdAt: at, updatedAt: at } as KeydRecord;
  keys = [...keys.filter((k) => k.id !== key.id), key];
  return c.json({ key, restart: false });
});
app.delete("/api/keys/:id", (c) => {
  keys = keys.filter((k) => k.id !== c.req.param("id"));
  return c.body(null, 204);
});
app.get("/cells/:cell/desktop/:ticket/", (c) =>
  tickets.resolve(c.req.param("ticket")) === c.req.param("cell")
    ? c.html(
        '<!doctype html><video id="videoStream" autoplay muted></video><script src="/owned-preview.js"></script>',
      )
    : c.text("unknown ticket", 404),
);
app.get("/owned-preview.js", (c) => c.body(DESKTOP_JS, 200, { "content-type": "text/javascript" }));

// QA control plane (no auth; loopback only, scratch fixture).
const pendingApprovals: AbortController[] = [];
// A keyboard approval as the daemon builds it: a repeated key (?kind=repeat) or a hold (?kind=hold).
const KEY_CARDS: Record<string, [string, string][]> = {
  repeat: [
    ["Tool", "computer"],
    ["Action", "key"],
    ["Keys", "]"],
    ["Repeat", "5 times"],
  ],
  hold: [
    ["Tool", "computer"],
    ["Action", "key"],
    ["Keys", "shift"],
    ["Hold", "1.5 s"],
  ],
};
app.post("/__qa/approval", (c) => {
  if (!session?.generation) return c.text("no brain", 409);
  const risk = (c.req.query("risk") ?? "high") as "medium" | "high";
  const keys = KEY_CARDS[c.req.query("kind") ?? ""];
  const controller = new AbortController();
  pendingApprovals.push(controller);
  void session
    .requestApproval(
      {
        sessionId: session.id,
        cellId,
        generation: session.generation.id,
        callId: ulid(),
        digest: "d".repeat(64),
        targetDigest: "t".repeat(64),
      } as never,
      (keys
        ? { actionClass: "unknown", risk: "medium", title: "Review action", fields: keys }
        : {
            actionClass: "send",
            risk,
            title: "Send the monthly report to team@example.test",
            fields: [
              ["To", "team@example.test"],
              ["Subject", "Monthly report (sample)"],
              ["Attachment", "summary.md"],
            ],
          }) as never,
      { signal: controller.signal, check: () => {}, revalidate: async () => true } as never,
    )
    .then((o) => effects.push(`approval:${JSON.stringify(o)}`))
    .catch((e) => effects.push(`approval-error:${String(e)}`));
  return c.json({ ok: true });
});
// Two keyboard steps with the gateway's own labels: a key pressed five times and a held key.
app.post("/__qa/keys", (c) => {
  if (!session) return c.text("no session", 409);
  for (const [combo, how] of [
    [["]"], { repeat: 5 }],
    [["shift"], { holdMs: 1500 }],
  ] as const) {
    const step = ulid();
    session.append("step.start", { kind: "gui", planItem: "calc" }, step);
    session.append(
      "action.intent",
      { verb: "key", label: keyLabel([...combo], how), risk: "none" },
      step,
    );
    session.append(
      "action.dispatch",
      { input: { kind: "key", combo, ...how }, pressT: 0, ringAt: 0, injector: "xtest" },
      step,
    );
    session.append("action.result", { ok: true }, step);
    session.append("step.end", { status: "ok" }, step);
  }
  return c.json({ ok: true });
});
app.post("/__qa/ask", (c) => {
  if (!session) return c.text("no session", 409);
  void session
    .ask(
      "Which report format should I use?",
      ["Markdown", "Plain text", "PDF"],
      c.req.query("text") !== "0",
      0,
    )
    .then((a) => effects.push(`ask:${JSON.stringify(a)}`))
    .catch((e) => effects.push(`ask-error:${String(e)}`));
  return c.json({ ok: true });
});
app.post("/__qa/takeover", (c) => {
  if (!session) return c.text("no session", 409);
  void session
    .takeover("login", "Please sign in to the sample site, then hand control back.")
    .then((o) => effects.push(`takeover:${JSON.stringify(o)}`))
    .catch((e) => effects.push(`takeover-error:${String(e)}`));
  return c.json({ ok: true });
});
app.post("/__qa/budget", (c) => {
  if (!session) return c.text("no session", 409);
  session.append("budget.exceeded", {
    scope: "task",
    taskId: session.id,
    limitUSD: 5,
    spentUSD: 4,
    needUSD: 2,
  });
  session.setStatus("paused");
  session.append("agent.state", { state: "paused", reason: "budget" });
  return c.json({ ok: true });
});
app.post("/__qa/pause-uncertain", (c) => {
  const pause = session?.safetyPause;
  if (!session || !pause) return c.text("no pause", 409);
  session.uncertainSafetyPause(pause.requestId, pause.revision);
  return c.json({ ok: true });
});
app.post("/__qa/heartbeat", (c) => {
  if (!session) return c.text("no session", 409);
  session.append("heartbeat", { ongoing: true, everyMs: 500 });
  return c.json({ ok: true });
});
app.post("/__qa/finish", (c) => {
  if (!session) return c.text("no session", 409);
  session.append("message.assistant", { messageId: ulid(), text: "Finished the sample task." });
  session.append("task.result", { summary: "Sample task done.", files: [] });
  session.setStatus("idle");
  session.append("agent.state", { state: "idle" });
  return c.json({ ok: true });
});
app.post("/__qa/cell/:kind", (c) => {
  const next = cellFor(c.req.param("kind") as CellKind, cellId);
  if (next) cells.emit(next);
  return c.json({ ok: true });
});
app.post("/__qa/keyd/:mode", (c) => {
  keydMode = c.req.param("mode") as typeof keydMode;
  return c.json({ ok: true });
});
app.get("/__qa/state", (c) =>
  c.json({
    sessionId: session?.id,
    cellId,
    seeded,
    effects,
    status: session?.status,
    cell: cells.get(cellId),
  }),
);

await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(PORT, "127.0.0.1", resolve);
});
console.log(
  JSON.stringify({
    ready: true,
    origin: `http://127.0.0.1:${PORT}`,
    sessionId: session?.id,
    cellId,
    seeded,
  }),
);

const shutdown = async () => {
  teardown = true;
  for (const a of pendingApprovals) a.abort();
  try {
    if (session) {
      live.stop(session.id);
      session.stop();
    }
    registry.dispose();
    index.close();
    log.close();
  } catch {}
  for (const peer of upgraded) peer.destroy();
  server.closeAllConnections();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
