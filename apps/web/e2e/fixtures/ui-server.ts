import { createECDH, webcrypto } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  BannerKind,
  CAREFUL_AUTONOMY,
  CHATGPT_DEVICE_CODE_OFF,
  CLAUDE_CODE_INSTALL,
  CLAUDE_CODE_SIGN_IN,
  CLAUDE_CODE_UPDATE,
  type ClaudeCodeStatus,
  type KeydRecord,
  microsToMs,
  msToMicros,
  type Point,
  type ReviseLink,
  type SessionOrigin,
  type TaskModelSelection,
  type ToolName,
  toBase64url,
  ulid,
} from "@localdot/protocol";
import { normalizeCatalog, providerById } from "@localdot/providers";
import { MODELS_DEV_FIXTURE } from "@localdot/providers/testing";
import {
  CHATGPT_SWITCHED_OFF,
  type CodexInstaller,
  type InstalledCodex,
} from "../../../../harness/codex/src/index.ts";
import { resolveRole, taskSelection } from "../../../daemon/src/agent/bindings.ts";
import {
  AccountError,
  type ChatgptLogin,
  type ChatgptStatus,
  type CodexAccount,
} from "../../../daemon/src/agent/codex/account.ts";
import type { ChatgptSetupControl } from "../../../daemon/src/agent/codex/setup.ts";
import { Conversations } from "../../../daemon/src/agent/conversation.ts";
import { manualStreamRoute } from "../../../daemon/src/agent/manual-stream.ts";
import { MemoryStore } from "../../../daemon/src/agent/memory.ts";
import { PeopleStore } from "../../../daemon/src/agent/people.ts";
import { RecentActivity } from "../../../daemon/src/agent/recent-activity.ts";
import type { AgentRoutesDeps } from "../../../daemon/src/agent/routes.ts";
import { AgentError } from "../../../daemon/src/agent/runner.ts";
import {
  approvalDraft,
  authorizePrepared,
  toolRisk,
} from "../../../daemon/src/agent/safety/authorize.ts";
import { decide } from "../../../daemon/src/agent/safety/autonomy.ts";
import { nativeActionFacts } from "../../../daemon/src/agent/safety/classify.ts";
import { connectionWhy } from "../../../daemon/src/agent/safety/connections.ts";
import { PurposeGate } from "../../../daemon/src/agent/safety/purpose.ts";
import type { RiskFacts } from "../../../daemon/src/agent/safety/risk.ts";
import { RulesStore } from "../../../daemon/src/agent/safety/rules.ts";
import { AgentSession, type AskForm } from "../../../daemon/src/agent/session.ts";
import { type AgentSettings, SettingsStore } from "../../../daemon/src/agent/settings.ts";
import { createApp } from "../../../daemon/src/app.ts";
import { AppEvents, appEventsRoute } from "../../../daemon/src/app-events.ts";
import type { AccountsDeps } from "../../../daemon/src/browser/accounts.ts";
import { ComputerUpdateRefused } from "../../../daemon/src/cells/computer-update.ts";
import type { CellControls } from "../../../daemon/src/cells/orchestrator.ts";
import { TicketRegistry } from "../../../daemon/src/cells/secrets.ts";
import { cellStatusRoute } from "../../../daemon/src/cells/status-stream.ts";
import { desktopStreamRoute } from "../../../daemon/src/cells/stream-proxy.ts";
import { StreamTuning } from "../../../daemon/src/cells/stream-tuning.ts";
import { FakeOrchestrator } from "../../../daemon/src/cells/testing/fake-orchestrator.ts";
import type { CellRecord, CellSummary } from "../../../daemon/src/cells/types.ts";
import { monotonicClock } from "../../../daemon/src/clock.ts";
import { ConnectorHub, type ConnectorLinks } from "../../../daemon/src/connectors/hub.ts";
import { ConnectorSignIn } from "../../../daemon/src/connectors/oauth.ts";
import { ConnectorStore } from "../../../daemon/src/connectors/store.ts";
import { type FakeTool, fakeApp } from "../../../daemon/src/connectors/testing/fake-app.ts";
import {
  deliverableScenarios,
  deliverablesDeps,
} from "../../../daemon/src/deliverables/testing/qa-scenarios.ts";
import { DesktopdClient } from "../../../daemon/src/desktopd/client.ts";
import { DesktopdRegistry } from "../../../daemon/src/desktopd/registry.ts";
import { FakeDesktopd } from "../../../daemon/src/desktopd/testing/fake-desktopd.ts";
import { EventLog } from "../../../daemon/src/event-log.ts";
import { sessionStreamRoute } from "../../../daemon/src/event-stream.ts";
import { ChromeRenderer } from "../../../daemon/src/exports/chrome.ts";
import { ExportJobs } from "../../../daemon/src/exports/jobs.ts";
import { exportsStreamRoute } from "../../../daemon/src/exports/routes.ts";
import { ExportStore } from "../../../daemon/src/exports/store.ts";
import { FakeRenderer } from "../../../daemon/src/exports/testing/fake-renderer.ts";
import { FrameStore } from "../../../daemon/src/gateway/frames.ts";
import type { GuiAction } from "../../../daemon/src/gateway/gateway.ts";
import { KillSwitch } from "../../../daemon/src/gateway/kill-switch.ts";
import { LiveSessions } from "../../../daemon/src/gateway/live.ts";
import { buttonLabel, dragLabel, keyLabel, moveLabel } from "../../../daemon/src/gateway/text.ts";
import { setPublicOrigin } from "../../../daemon/src/guard.ts";
import { createNotify } from "../../../daemon/src/notify/wiring.ts";
import { Recorder } from "../../../daemon/src/recorder/recorder.ts";
import { seedSession } from "../../../daemon/src/recorder/testing/seed-session.ts";
import { nextDue } from "../../../daemon/src/routines/schedule.ts";
import { stopAll } from "../../../daemon/src/routines/stop-all.ts";
import { RoutineStore, scheduleOf, toRoutine } from "../../../daemon/src/routines/store.ts";
import { SearchFeed } from "../../../daemon/src/search/search-feed.ts";
import { SearchIndex } from "../../../daemon/src/search/search-index.ts";
import { SessionIndex } from "../../../daemon/src/sessions/index-store.ts";
import { Thumbnails } from "../../../daemon/src/sessions/thumbs.ts";
import { readStatic } from "../../../daemon/src/static-files.ts";
import { UI_CSP } from "../../../daemon/src/static-ui.ts";
import { attachUpgradeRouter } from "../../../daemon/src/upgrade-router.ts";
import {
  bootStep,
  type CellKind,
  type ScenarioStep,
  UI_SCENARIOS,
  type UiScenario,
  uiScenario,
} from "./ui-scenarios.ts";

const require = createRequire(new URL("../../../daemon/package.json", import.meta.url));
const { getRequestListener } = require("@hono/node-server") as {
  getRequestListener(
    fetch: (request: Request, env: unknown) => Response | Promise<Response>,
  ): Parameters<typeof createServer>[0];
};
const { values: args } = parseArgs({
  options: { port: { type: "string" }, scenario: { type: "string" } },
});
const scenarioName = args.scenario ?? process.env.QA_SCENARIO;
const scenario = scenarioName ? uiScenario(scenarioName) : undefined;
const env: Record<string, string | undefined> = { ...scenario?.boot, ...process.env };

// Session dates, ids and approval deadlines all read the wall clock. Starting it at a fixed
// instant, while it still advances, keeps every date the UI prints the same from run to run.
function startWallClockAt(start: number) {
  const RealDate = Date;
  const offset = start - RealDate.now();
  const now = () => RealDate.now() + offset;
  globalThis.Date = class extends RealDate {
    constructor(...given: unknown[]) {
      super(...((given.length ? given : [now()]) as [number]));
    }
    static now() {
      return now();
    }
  } as DateConstructor;
}

const TOKEN = "a".repeat(43);
// 0 lets the system pick a free port; the ready line names the one it chose.
const REQUESTED_PORT = Number(args.port ?? env.QA_PORT ?? 4786);
const HOME = env.QA_HOME ?? join(tmpdir(), `localdot-ui-fixture-${process.pid}`);
// A home the fixture named itself, or one a launcher made for it, goes when the fixture stops: the
// launcher may die before it can remove it.
const ownsHome = !env.QA_HOME || !!env.QA_PARENT_PID;
const ASSETS = fileURLToPath(new URL("./ui-assets", import.meta.url));
const GALLERY = fileURLToPath(new URL("../../dist-gallery", import.meta.url));
if (env.QA_NOW) startWallClockAt(Date.parse(env.QA_NOW));
setPublicOrigin(env.QA_FRONTS || undefined);
const cellKind = (env.QA_CELL ?? "live") as CellKind;
const withSession = env.QA_SESSION !== "0";
const phase = env.QA_PHASE ?? "running";
const settingsMode = env.QA_SETTINGS ?? "configured";
let chatgptState = (env.QA_CHATGPT || undefined) as
  | "signed_in"
  | "signed_out"
  | "checking"
  | "check_failed"
  | "not_installed"
  | "unavailable"
  | undefined;
let deviceCodeOff = false,
  signingIn: ChatgptLogin | undefined;
// The user's own Claude Code, as its status command would report it.
let claudeCodeState = (env.QA_CLAUDE_CODE || undefined) as
  | "not_installed"
  | "outdated"
  | "signed_out"
  | "signed_in"
  | undefined;
let keydMode = (env.QA_KEYD ?? "online") as "online" | "offline" | "audit" | "guard" | "locked";
const replays = Number(env.QA_REPLAYS ?? 2);
const autonomy = env.QA_AUTONOMY === "careful" ? CAREFUL_AUTONOMY : undefined;

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
if (settingsMode === "plan")
  SAMPLE_KEYS = [
    ...SAMPLE_KEYS,
    {
      id: "token-plan",
      kind: "llm",
      provider: "openai-compatible",
      baseURL: "https://api.minimax.io/v1",
      createdAt: "2026-10-04T09:00:00Z",
      updatedAt: "2026-10-04T09:00:00Z",
    } as KeydRecord,
  ];
const SETTINGS: Record<string, AgentSettings> = {
  configured: {
    main: { provider: "anthropic", model: "claude-sonnet-5-5", key: "anthropic-main" },
    fast: { provider: "openai", model: "gpt-6-luna", key: "openai-fast" },
    taskBudgetUSD: 3,
  } as AgentSettings,
  empty: {},
  chatgpt: { main: { provider: "chatgpt", model: "sample-plan-model" } } as AgentSettings,
  "claude-code": { main: { provider: "claude-code", model: "sonnet" } } as AgentSettings,
  plan: {
    main: { provider: "minimax-coding-plan", model: "MiniMax-M3", key: "token-plan" },
  } as AgentSettings,
};

// The desktop repaints one still frame, so the picture is steady while the stream stays live.
const DESKTOP_JS = `
const canvas=document.createElement('canvas');canvas.width=2560;canvas.height=1600;
const ctx=canvas.getContext('2d');const still=new Image();still.src='/owned-desktop.webp';
setInterval(()=>{if(still.complete)ctx.drawImage(still,0,0)},100);
const video=document.getElementById('videoStream');video.srcObject=canvas.captureStream(10);
video.play().catch(()=>{});
`;

let skew = 0;
// While held, session time moves only by the seed's own steps, so a seeded task lasts the same
// on every run however long the seeding takes.
let heldAt: number | undefined;
const base = monotonicClock();
const clock = { nowMicros: () => (heldAt ?? base.nowMicros()) + skew };
const log = new EventLog(HOME, clock);
const conversations = new Conversations(HOME, log);
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
    case "fresh-start":
      return {
        ...b,
        state: "failed",
        stream: none,
        error: "Your computer's update can't be finished. Start fresh to use it again.",
        needsFreshStart: true,
      };
  }
}
const initial = cellFor(cellKind, cellId);
if (initial) cells.emit(initial);
// QA_DESKTOP=<url>,<password> streams a real desktop container's Selkies to the live cell, for
// measurements (QA_TUNING=0 leaves its quality fixed); the fixture otherwise shows one still frame.
const [realStream, realPassword] = (env.QA_DESKTOP ?? "").split(",");
const realDesktop = realStream
  ? {
      cells,
      tickets,
      vendorDir: fileURLToPath(new URL("../../vendor/selkies", import.meta.url)),
      tuning:
        env.QA_TUNING === "0"
          ? undefined
          : new StreamTuning({
              onApply: (_id, quality) => console.log(JSON.stringify({ at: Date.now(), quality })),
            }),
    }
  : undefined;
if (realStream)
  cells.endpointsById.set(cellId, {
    desktopd: { baseUrl: "http://owned-desktop.invalid", token: "" },
    stream: {
      baseUrl: realStream,
      authorization: `Basic ${Buffer.from(`localdot:${realPassword}`).toString("base64")}`,
    },
  });
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

// Update: the computer stops, comes back on the new version and is ready a moment later.
async function updateCell(id: string): Promise<void> {
  const c = cells.get(id);
  if (!c?.updateAvailable) throw new ComputerUpdateRefused("Your computer is up to date.");
  const { updateAvailable: _available, ...rest } = c;
  const none = { connection: "none" as const, viewers: 0, lastUpstreamAt: null };
  cells.emit({ ...rest, state: "stopping", updating: true, stream: none });
  setTimeout(() => cells.emit({ ...rest, state: "starting", updating: true, stream: none }), 800);
  setTimeout(
    () =>
      cells.emit({
        ...rest,
        state: "ready",
        stream: { connection: "live", viewers: 1, lastUpstreamAt: 1 },
      }),
    Number(process.env.QA_UPDATE_MS ?? 2500),
  );
}

let keys = SAMPLE_KEYS;
const settingsStore = new SettingsStore(HOME);
settingsStore.put(SETTINGS[settingsMode] ?? {});
const memory = new MemoryStore(HOME);
const people = new PeopleStore(HOME);
const recentActivity = new RecentActivity({ log, isLive: (id) => live.cellOf(id) !== undefined });
const searchIndex = new SearchIndex(HOME, { sessions: log });
const searchFeed = new SearchFeed({ index: searchIndex, eventLog: log, notes: memory });
searchFeed.start();
const ledger = { limit: 5, spent: 4 };
let budgetHold: "task" | "day" | undefined;
let raisedDuringPause = false;
let session: AgentSession | undefined;
// The user's own hold on the computer, with no task, while it is the live session.
let holder: AgentSession | undefined;
// The seeded running task's open step, which /__qa/step-end finishes.
let liveStep: string | undefined;
// A plan task resolves through the daemon's own bindings, frozen at start as the runner does.
let selection: TaskModelSelection | undefined;
function planSelection(): TaskModelSelection | undefined {
  const stored = settingsStore.get();
  if (!stored.main || !providerById(stored.main.provider)?.plan) return undefined;
  return taskSelection(
    (["main", "fast", "local"] as const).flatMap((role) => {
      const choice = stored[role];
      return choice ? [resolveRole(role, choice, catalog, keys)] : [];
    }),
  );
}
let teardown = false;
// How the live task ends when its run is cut: Stop records it stopped, a finished task the user
// moved on from records it done, and a daemon that went away records nothing.
const ending = new WeakMap<AgentSession, "done" | "crash">();

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
              const how = ending.get(owned);
              try {
                if (how !== "crash")
                  owned.append("session.end", { reason: how === "done" ? "done" : "stopped" });
              } catch {}
              resolve();
            }, resolve);
          },
          { once: true },
        );
      }),
  );
}
// Ends the live task, as the daemon does, and waits until the computer is free of it.
async function endLive(how?: "done" | "crash") {
  const owned = session;
  if (!owned || owned.stopped) return;
  if (how) ending.set(owned, how);
  live.stop(owned.id);
  await live.settled(owned.id);
}
function newSession(
  title: string,
  task: string,
  continues?: string,
  origin?: SessionOrigin,
  revises?: ReviseLink,
): AgentSession {
  const s = new AgentSession(
    log.createSession(title),
    cellId,
    task,
    log,
    autonomy,
    new RulesStore(HOME),
  );
  s.beginBrain();
  log.append(s.id, {
    agent: "main",
    type: "session.start",
    data: {
      screen: { w: 2560, h: 1600, scale: 2 },
      os: "linux",
      title,
      ...(continues ? { continues } : {}),
      ...(origin ? { origin } : {}),
      ...(revises ? { revises } : {}),
    },
  });
  return s;
}

// An ended task: what the user asked, dot's reply and result. It continues `continues`.
function endedTask(title: string, reply: string, summary: string, continues?: string): string {
  const id = log.createSession(title);
  const append = (type: string, data: Record<string, unknown>) =>
    log.append(id, { agent: "main", type, data } as never);
  append("session.start", {
    screen: { w: 2560, h: 1600, scale: 2 },
    os: "linux",
    title,
    ...(continues ? { continues } : {}),
  });
  append("message.user", { messageId: ulid(), kind: "task", text: title });
  append("message.assistant", { messageId: ulid(), text: reply });
  append("task.result", { summary, files: [] });
  append("session.end", { reason: "done" });
  return id;
}

type Append = (type: string, data: Record<string, unknown>, step?: string) => void;

const planItems = (finished: boolean) => [
  { id: "open", text: "Open the sample spreadsheet", status: "done" },
  { id: "calc", text: "Calculate monthly totals", status: finished ? "done" : "doing" },
  { id: "write", text: "Write the summary report", status: finished ? "done" : "todo" },
  { id: "send", text: "Email the report to the team", status: "skipped" },
];

// done: end as the real runner does, with agent.state done, which raises a Done notification.
// A summary written as dot writes one when it couldn't finish: a heading, a list and bold words.
const MARKDOWN_SUMMARY =
  "## Couldn't print the report\n\nI made **summary.md**, but this computer has no printer, so nothing was printed.\n\n### What I checked\n\n- **Printers:** none are set up on this computer\n- **Drivers:** the `cups` service isn't installed\n- **Your files:** `summary.md` and `totals.csv` are ready to print elsewhere";

function finishTask(s: AgentSession, a: Append, done = false, markdown = false) {
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
    summary: markdown
      ? MARKDOWN_SUMMARY
      : "Sample monthly report prepared.\nOne validation command failed; the totals were checked another way.",
    files: [
      { name: "summary.md", path: "summary.md", bytes: 48 },
      { name: "totals.csv", path: "totals.csv", bytes: 32 },
    ],
  });
  s.setStatus("idle");
  a("agent.state", { state: done ? "done" : "idle" });
}

function seedTask(s: AgentSession, finished: boolean) {
  const a: Append = (type, data, step) => {
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
  a("plan.set", { items: planItems(finished) });
  const click = ulid();
  a(
    "step.start",
    { kind: "gui", planItem: "open", intent: "Opening the monthly report to read the sales table" },
    click,
  );
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
  a(
    "step.start",
    { kind: "gui", planItem: "calc", intent: "Adding up the net total for each month" },
    typing,
  );
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
  a(
    "step.start",
    { kind: "shell", planItem: "calc", intent: "Checking the totals against the raw data" },
    shell,
  );
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
  a("step.start", { kind: "file", planItem: "write", intent: "Writing the short report" }, file);
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
    finishTask(s, a);
  } else {
    s.setStatus("running");
    a("agent.state", { state: "acting" });
    liveStep = ulid();
    a(
      "step.start",
      {
        kind: "gui",
        planItem: "calc",
        intent: "Checking February's net total against revenue minus returns",
      },
      liveStep,
    );
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

// QA_ACTIVITY=long: a long hand-drawing task, so the Activity rail is checked with many steps,
// several plan items, failures, folded key uses and a blocked one. /__qa/steps adds more live.
let fill = 0;
function seedLongTask(s: AgentSession) {
  const a = (type: string, data: Record<string, unknown>, step?: string) => {
    skew += type === "step.end" ? 900_000 : 240_000;
    s.append(type, data, step);
  };
  let frameNo = 0;
  const modelCall = () =>
    a("key.use", {
      secretId: "anthropic-main",
      host: "api.anthropic.com",
      method: "POST",
      path: "/v1/messages",
      decision: "allow",
    });
  const gui = (
    planItem: string,
    verb: string,
    label: string,
    outcome: "ok" | "failed" | "stale" = "ok",
    note?: string,
  ) => {
    const step = ulid();
    const point = { x: 600 + ((frameNo * 173) % 1400), y: 400 + ((frameNo * 97) % 800) };
    a("step.start", { kind: "gui", planItem }, step);
    a("action.intent", { verb, label, risk: "none", point }, step);
    if (outcome === "stale") {
      a("action.cancel", { reason: "stale" }, step);
      a("step.end", { status: "cancelled", note: "The target changed before input." }, step);
    } else {
      a(
        "action.dispatch",
        {
          input:
            verb === "type"
              ? { kind: "type", chars: 6, masked: false }
              : { kind: "click", button: "left", count: 1, at: point },
          pressT: 2_000_000,
          ringAt: 2_010_000,
          injector: "xtest",
        },
        step,
      );
      a("action.result", { ok: outcome === "ok" }, step);
      const file = join(ASSETS, `frame-${(frameNo++ % 4) + 1}.webp`);
      if (existsSync(file)) {
        const frameId = ulid();
        frames.save(s.id, frameId, readFileSync(file));
        a("observe", { frameId, width: 2560, height: 1600 }, step);
      }
      a("step.end", { status: outcome, ...(note ? { note } : {}) }, step);
    }
    modelCall();
  };
  const shell = (planItem: string, title: string, stdout: string, exitCode = 0) => {
    const step = ulid();
    a("step.start", { kind: "shell", planItem }, step);
    a("tool.start", { tool: "shell", title }, step);
    a("tool.output", { stream: exitCode ? "stderr" : "stdout", chunk: stdout }, step);
    a("tool.end", { ok: exitCode === 0, exitCode }, step);
    a(
      "step.end",
      exitCode
        ? { status: "failed", note: `The command returned exit code ${exitCode}.` }
        : { status: "ok" },
      step,
    );
    modelCall();
  };
  a("message.user", {
    messageId: ulid(),
    kind: "task",
    text: "Draw a dog by hand in the paint app, then save it as dog.png in Pictures.",
  });
  a("agent.state", { state: "thinking" });
  a("thought.delta", {
    text: "The paint app is installed. I'll sketch with the brush, then colour.",
  });
  a("message.assistant", {
    messageId: ulid(),
    text: "I'll open the paint app, sketch the dog with the brush, colour it in, then save it.",
  });
  a("plan.set", {
    items: [
      { id: "open", text: "Open the paint app", status: "done" },
      { id: "canvas", text: "Make a 1200 × 900 canvas", status: "done" },
      { id: "sketch", text: "Sketch the dog's outline", status: "done" },
      { id: "colour", text: "Colour the dog in", status: "doing" },
      { id: "save", text: "Save it as dog.png in Pictures", status: "todo" },
      { id: "share", text: "Share it with the family album", status: "skipped" },
    ],
  });
  modelCall();
  shell("open", "Find an installed paint app", "/usr/bin/gimp\n/usr/bin/mypaint\n");
  gui("open", "click", "Opened the Applications menu");
  gui("open", "click", "Opened GIMP");
  gui("open", "wait", "Waited for GIMP to open");
  gui("canvas", "click", "Opened File ▸ New");
  gui("canvas", "type", "Typed 1200 in Width");
  gui("canvas", "type", "Typed 900 in Height");
  gui("canvas", "click", "Clicked OK");
  gui("sketch", "key", "Pressed P for the paintbrush");
  for (const part of ["head", "left ear", "right ear", "body", "front legs", "back legs", "tail"])
    gui("sketch", "drag", `Drew the ${part}`);
  gui("sketch", "click", "Click Undo", "stale");
  gui("sketch", "scroll", "Zoomed in on the face");
  for (const part of ["eyes", "nose", "mouth"]) gui("sketch", "drag", `Drew the ${part}`);
  a("key.use", {
    secretId: "stock-images",
    host: "api.images.example",
    method: "GET",
    path: "/v2/search?q=dog+outline",
    decision: "deny",
  });
  const notes = ulid();
  a("step.start", { kind: "file", planItem: "sketch" }, notes);
  a(
    "file.change",
    {
      path: "Pictures/dog-steps.md",
      op: "create",
      patch:
        "@@ -0,0 +1,4 @@\n+# Dog sketch\n+\n+- Outline: head, ears, body, legs, tail\n+- Face: eyes, nose, mouth",
    },
    notes,
  );
  a("step.end", { status: "ok" }, notes);
  modelCall();
  gui("colour", "click", "Opened the colour picker");
  gui(
    "colour",
    "type",
    "Type 8B5A2B in the hex field",
    "failed",
    "The colour dialog didn't take the typed value.",
  );
  gui("colour", "click", "Picked brown from the palette");
  shell(
    "colour",
    "Check the canvas size",
    "dog.xcf: 1200x900, 3 layers\nBackground: white\nOutline: 1 path\n",
  );
  shell("colour", "Export a preview", "convert: no images defined `preview.png'\n", 1);
  gui("colour", "click", "Filled the body with brown");
  gui("colour", "click", "Filled the ears with dark brown");
  const remembered = memory.apply(s.id, "MEMORY.md", "append", "Likes hand-drawn sketches.");
  a("memory.change", {
    file: remembered.file,
    patch: remembered.patch,
    changeId: remembered.changeId,
  });
  a("model.usage", {
    role: "main",
    route: "anthropic",
    model: "claude-sonnet-5-5",
    inputTokens: 186_420,
    outputTokens: 9_210,
    reasoningTokens: 3_640,
  });
  a("model.usage", {
    role: "fast",
    route: "openai",
    model: "gpt-6-luna",
    inputTokens: 41_100,
    outputTokens: 1_380,
  });
  s.setStatus("running");
  a("agent.state", { state: "acting" });
  liveStep = ulid();
  a("step.start", { kind: "gui", planItem: "colour" }, liveStep);
  a(
    "action.intent",
    { verb: "click", label: "Fill the tail with brown", risk: "none", point: { x: 1700, y: 900 } },
    liveStep,
  );
}

// QA_PAST=1 seeds past conversations, from earlier today back over the last fortnight, each ending
// its own way, for the list of conversations.
function backdated<T>(msAgo: number, make: () => T): T {
  const Before = globalThis.Date;
  const offset = -msAgo;
  globalThis.Date = class extends Before {
    constructor(...given: unknown[]) {
      super(...((given.length ? given : [Before.now() + offset]) as [number]));
    }
    static now() {
      return Before.now() + offset;
    }
  } as DateConstructor;
  try {
    return make();
  } finally {
    globalThis.Date = Before;
  }
}
const HOUR = 3_600_000;
const PAST: { ago: number; asks: string[]; ending: "done" | "stopped" | "error" | null }[] = [
  {
    ago: 2 * HOUR,
    asks: ["Compare flights to Lisbon for the first week of May", "Book the 9:40 one"],
    ending: "done",
  },
  {
    ago: 5 * HOUR,
    asks: ["Rename the holiday photos by the date they were taken"],
    ending: "stopped",
  },
  {
    ago: 26 * HOUR,
    asks: ["Summarise the Q3 board deck into five bullet points"],
    ending: "error",
  },
  { ago: 30 * HOUR, asks: ["Find a plumber near me with good reviews"], ending: "done" },
  { ago: 80 * HOUR, asks: ["Clean up my Downloads folder", "Also empty the bin"], ending: "done" },
  { ago: 220 * HOUR, asks: ["Draft a reply to the landlord about the boiler"], ending: null },
];
if (env.QA_PAST === "1")
  for (const { ago, asks, ending } of PAST) {
    let continues: string | undefined;
    asks.forEach((ask, n) => {
      continues = backdated(ago - n * 600_000, () => {
        const id = log.createSession(asks[0]);
        const append = (type: string, data: Record<string, unknown>) =>
          log.append(id, { agent: "main", type, data } as never);
        append("session.start", {
          screen: { w: 2560, h: 1600, scale: 2 },
          os: "linux",
          title: asks[0],
          ...(continues ? { continues } : {}),
        });
        append("message.user", { messageId: ulid(), kind: "task", text: ask });
        append("message.assistant", { messageId: ulid(), text: "Done. Here is what I found." });
        const last = n === asks.length - 1;
        if (!last || ending) append("session.end", { reason: last ? ending : "done" });
        return id;
      });
    });
  }

// QA_EARLIER earlier tasks of the same conversation come before the seeded one.
let earlier: string | undefined;
for (let n = 0; n < Number(env.QA_EARLIER ?? 0); n++)
  earlier = endedTask(
    n === 0 ? "Find last month's sales table" : `Check the sample figures (${n})`,
    n === 0
      ? "I found **sales.xlsx** in Documents. It has one sheet with daily totals for December."
      : "The figures add up.",
    n === 0 ? "Found sales.xlsx in Documents." : "Checked the figures.",
    earlier,
  );
if (withSession && initial) {
  heldAt = base.nowMicros();
  session = newSession(
    env.QA_ACTIVITY === "long" ? "Sample · dog drawing" : "Sample · monthly report",
    "Sample task",
    earlier,
  );
  attachLive(session);
  if (env.QA_ACTIVITY === "long") seedLongTask(session);
  else seedTask(session, phase === "finished");
  skew -= base.nowMicros() - heldAt;
  heldAt = undefined;
}
const latestTask = session?.id ?? earlier;
if (latestTask) conversations.adopt(latestTask);

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
// The parts of the next Stop that fail, as the kill switch names them: keyd, pause, close, stop.
// keyd-once fails only the first revoke, which the kill switch then retries and confirms.
const stopFails = new Set<string>();
const failing = (step: string) => {
  if (step === "keyd" && stopFails.delete("keyd-once")) throw new Error("keyd failed once");
  if (stopFails.has(step)) throw new Error(`${step} failed`);
};
let revokeAgain = false;
const controlsFor = (key: string): CellControls => ({
  waitedForOperation: revokeAgain,
  pause: async () => {
    failing("pause");
    effects.push("pause");
    const cell = cells.get(key);
    if (cell) cells.emit({ ...cell, paused: true });
  },
  stop: async () => {
    failing("stop");
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
      failing("keyd");
      effects.push("revoke");
      return 0;
    },
    close: async () => {
      failing("close");
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
if (session) selection = planSelection();
const installed: InstalledCodex = {
  version: "0.154.0",
  platform: "darwin-arm64",
  binDir: join(HOME, "inert"),
  codexBin: join(HOME, "inert/codex"),
  codeModeHostBin: join(HOME, "inert/code-mode-host"),
} as InstalledCodex;
let installing: Promise<InstalledCodex> | undefined;
const installedStates = new Set(["signed_in", "signed_out", "checking", "check_failed"]);
const sandboxChecked = () => {
  chatgptState = "checking";
  setTimeout(() => {
    if (chatgptState === "checking") chatgptState = "signed_out";
  }, 1500);
};
const installer = {
  status: () =>
    installedStates.has(chatgptState ?? "")
      ? { state: "ready", version: "0.154.0" }
      : installing
        ? { state: "downloading", receivedBytes: 48 * 1024 * 1024, totalBytes: 116_501_639 }
        : { state: "not_installed" },
  ensureInstalled: () => {
    installing ??= new Promise((resolve) =>
      setTimeout(() => {
        installing = undefined;
        sandboxChecked();
        resolve(installed);
      }, 1500),
    );
    return installing;
  },
  verifiedInstallation: async () =>
    installedStates.has(chatgptState ?? "") ? installed : undefined,
  cancel: () => {},
} as unknown as CodexInstaller;
const setup: ChatgptSetupControl = {
  sandbox: () =>
    chatgptState === "checking"
      ? "checking"
      : chatgptState === "check_failed"
        ? "failed"
        : chatgptState === "signed_in" || chatgptState === "signed_out"
          ? "passed"
          : "unchecked",
  check: async () => {
    if (chatgptState === "check_failed") sandboxChecked();
    return setup.sandbox();
  },
  confirm: async (status) => status,
};
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
            : signingIn
              ? "signing_in"
              : "signed_out",
      ...(signingIn ? { login: signingIn } : {}),
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
  login: async () => {
    if (deviceCodeOff) throw new AccountError(503, CHATGPT_DEVICE_CODE_OFF);
    signingIn = {
      loginId: "owned-1",
      method: "code",
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "TEST-ONLY",
      startedAt: Date.now(),
    };
    return signingIn;
  },
  cancelLogin: async () => {
    signingIn = undefined;
  },
  logout: async () => {
    chatgptState = "signed_out";
  },
  refresh: async () => account.status(),
} as unknown as CodexAccount;
const harness = () =>
  chatgptState && chatgptState !== "unavailable"
    ? { available: true as const }
    : { available: false as const, reason: CHATGPT_SWITCHED_OFF };
const claudeCodeStatus = (): ClaudeCodeStatus => {
  const checkedAt = Date.now();
  switch (claudeCodeState) {
    case "signed_in":
      return {
        state: "signed_in",
        version: "2.1.290",
        plan: "max",
        models: [
          { id: "sonnet", name: "Claude Sonnet" },
          { id: "opus", name: "Claude Opus" },
        ],
        checkedAt,
      };
    case "signed_out":
      return {
        state: "signed_out",
        version: "2.1.290",
        reason: "Sign in to Claude Code, then check again.",
        command: CLAUDE_CODE_SIGN_IN,
        models: [],
        checkedAt,
      };
    case "outdated":
      return {
        state: "outdated",
        version: "2.1.100",
        reason: "Update Claude Code, then check again.",
        command: CLAUDE_CODE_UPDATE,
        models: [],
        checkedAt,
      };
    default:
      return {
        state: "not_installed",
        reason: "Install Claude Code and sign in there.",
        command: CLAUDE_CODE_INSTALL,
        models: [],
        checkedAt,
      };
  }
};
// What the user's direct control delivered to the fake computer, in order, with when it arrived.
const manualInputs: { at: number; input: unknown }[] = [];
const agent: AgentRoutesDeps = {
  home: HOME,
  settings: settingsStore,
  catalog: { get: () => catalog, refresh: async () => catalog },
  keyd: {
    secrets: async () => keys,
    budget: async () => ({
      perTaskUSD: 0,
      perDayUSD: 0,
      day: { date: "2026-10-08", spentUSD: 1.2 },
    }),
  } as AgentRoutesDeps["keyd"],
  memory,
  notesChanged: (file) => searchFeed.reindexNotes(file),
  people,
  recentActivity: () => recentActivity.list(),
  sessionInfo: (ids) => log.sessionInfo(ids),
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
  conversations,
  canChangeMemory: () => !session?.controlHeld && !killSwitch.isBusy(cellId),
  taskMutationReady: (owner) =>
    owner === session &&
    cells.get(cellId)?.state === "ready" &&
    !cells.get(cellId)?.paused &&
    !killSwitch.isBusy(cellId),
  runner: {
    get: (key) => (session && key === session.id ? session : undefined),
    get sessions() {
      return new Map(session ? [[session.id, session]] : []);
    },
    start: async (key, task, _signal, options) => {
      if (key !== cellId) throw new Error("unknown cell");
      if (session && !session.stopped && session.status !== "idle") throw new Error("busy");
      await endLive();
      session = newSession(
        task.slice(0, 60),
        task,
        conversations.current() ?? undefined,
        undefined,
        options?.revises,
      );
      conversations.adopt(session.id);
      budgetHold = undefined;
      raisedDuringPause = false;
      selection = planSelection();
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
    release: async () => {
      if (session && !session.stopped && session.status !== "idle")
        throw new AgentError(409, "Finish or stop the current task first.");
      await endLive("done");
    },
    // As the daemon does: a live task's control, or a hold of the user's own that ends at hand-back.
    hold: async (key) => {
      if (key !== cellId) throw new Error("unknown cell");
      if (session && !session.stopped && (session !== holder || session.controlHeld))
        return { sessionId: session.id, requestId: session.takeControl() };
      await endLive("done");
      const continues = conversations.current() ?? undefined;
      const title = continues ? conversations.title(continues) : undefined;
      const owned = new AgentSession(log.createSession("You used the computer"), cellId, "", log);
      log.append(owned.id, {
        agent: "main",
        type: "session.start",
        data: {
          screen: { w: 2560, h: 1600, scale: 2 },
          os: "linux",
          ...(title ? { title } : {}),
          ...(continues ? { continues } : {}),
        },
      });
      session = owned;
      holder = owned;
      conversations.adopt(owned.id);
      owned.setStatus("idle");
      const requestId = owned.takeControl();
      attachLive(owned);
      void owned.controlReleased(requestId).then(() => {
        if (session === owned && !owned.stopped) void endLive("done");
      });
      return { sessionId: owned.id, requestId };
    },
    holds: (key) => !!holder && key === holder.id,
    selectionOf: () =>
      chatgptState === "signed_in" && settingsMode === "chatgpt"
        ? { kind: "chatgpt", model: "sample-plan-model" }
        : (selection ?? {
            kind: "api",
            roles: [
              { role: "main", provider: "anthropic", model: "claude-sonnet-5-5" },
              { role: "fast", provider: "openai", model: "gpt-6-luna" },
            ],
          }),
    pauseTask: (taskId, requestId) => {
      if (!session || taskId !== session.id) throw new Error("no session");
      const pause = session.requestSafetyPause(requestId);
      // QA_PAUSE=step holds the Pause at pausing until /__qa/step-end, as a step in flight does.
      if (env.QA_PAUSE !== "step") session.confirmSafetyPause(requestId, pause.revision);
      return session.safetyPause ?? pause;
    },
    budgetHoldOf: (taskId) => (session && taskId === session.id ? budgetHold : undefined),
    resumeSafety: async (taskId, requestId, revision) => {
      if (!session || taskId !== session.id) throw new Error("no session");
      session.beginSafetyResume(requestId, revision);
      session.resumeSafety(requestId, revision);
      // The brain takes the Resume a raise posted during the Pause and calls its model again; at
      // the daily limit the daemon's Resume retries the refused call, which finds room here.
      if (raisedDuringPause || budgetHold === "day") {
        raisedDuringPause = false;
        budgetHold = undefined;
        session.setStatus("running");
        session.append("agent.state", { state: "thinking" });
      }
    },
    raiseBudget: async (taskId, ceiling) => {
      if (!session || taskId !== session.id) throw new Error("no session");
      ledger.limit = ceiling;
      budgetHold = undefined;
      session.post("resume", "");
      // A held Pause keeps the task paused until its own Resume.
      raisedDuringPause = !!session.safetyPause;
      if (raisedDuringPause) return;
      session.setStatus("running");
      session.append("agent.state", { state: "thinking" });
    },
  } as AgentRoutesDeps["runner"],
  desktop: () => undefined,
  manual: (owner) =>
    owner === session
      ? {
          screen: { w: 2560, h: 1600 },
          client: {
            input: (request, signal, onPress) => {
              manualInputs.push({ at: Date.now(), input: request.input });
              return client.input(request, signal, onPress);
            },
            type: (request, onProgress, signal) => {
              manualInputs.push({ at: Date.now(), input: { kind: "text", text: request.text } });
              return client.type(request, onProgress, signal);
            },
          },
          prepare: async () => {},
          release: () => {},
          letGo: async () => {
            manualInputs.push({ at: Date.now(), input: { kind: "let-go" } });
            await client.release();
          },
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
  ...(chatgptState ? { chatgpt: { account, installer, availability: harness, setup } } : {}),
  ...(claudeCodeState
    ? {
        claudeCode: {
          status: async () => claudeCodeStatus(),
          check: async () => claudeCodeStatus(),
        },
      }
    : {}),
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
const routineStore = new RoutineStore(HOME, { now: Date.now, zone: () => "Europe/London" });
const appEvents = new AppEvents();
let fixtureLogin: "on" | "off" = "off";
// Nothing runs here; active routines only learn when they would run next.
const planRoutines = () => {
  for (const routine of routineStore.list())
    if (routine.state === "active" && routine.nextDueAt === null)
      routineStore.setNextDue(routine.id, nextDue(scheduleOf(routine), Date.now()));
};
const routineChanged = (routineId: string) => {
  const routine = routineStore.get(routineId);
  if (routine)
    appEvents.publish({
      type: "routine.changed",
      routineId,
      revision: routine.revision,
      state: routine.state,
    });
};

// Notifications with a stand-in keyd and Mac: nothing leaves the fixture; sends are recorded.
// QA_BANNER=desktop|none shows Settings as on a Linux desktop or a machine with no screen.
const pushKey = createECDH("prime256v1");
pushKey.generateKeys();
const notified: { mac: [string, string][]; pushes: number } = { mac: [], pushes: 0 };
const notify = createNotify({
  home: HOME,
  eventLog: log,
  events: appEvents,
  keyd: {
    pushKey: async () => ({ publicKey: pushKey.getPublicKey().toString("base64url") }),
    pushSend: async () => {
      notified.pushes += 1;
      return { status: 201, gone: false };
    },
  },
  mac: {
    available: true,
    show: async (title, body) => {
      notified.mac.push([title, body]);
      return "shown";
    },
  },
  banner: {
    kind: BannerKind.catch("mac").parse(process.env.QA_BANNER ?? "mac"),
    notifier: { available: false, show: async () => "unavailable" },
  },
});

let app: ReturnType<typeof createApp> | undefined;
const deliverablesFixture = {
  home: HOME,
  assets: ASSETS,
  log,
  frames,
  effects,
  session: () => session,
  start: (task: string, revises: ReviseLink) =>
    agent.runner.start(cellId, task, undefined, { revises }),
};
// The node bindings pass through: Open on Mac checks the socket address.
const server: Server = createServer(
  getRequestListener(
    (request, env) => app?.fetch(request, env) ?? new Response("starting", { status: 503 }),
  ),
);
const upgraded = new Set<Duplex>();
server.on("upgrade", (_req, peer) => {
  upgraded.add(peer);
  peer.once("close", () => upgraded.delete(peer));
});
await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(REQUESTED_PORT, "127.0.0.1", resolve);
});
const PORT = (server.address() as AddressInfo).port;
// QA_EXPORTS=fake: videos move only when /__qa/export/* says; chrome: this computer's Chrome makes
// them for real; otherwise the host can't make videos and Export falls back to the page.
const exportsMode = env.QA_EXPORTS ?? "none";
const fakeRenderer = new FakeRenderer();
if (exportsMode !== "fake") fakeRenderer.able = null;
const exportJobs = new ExportJobs({
  store: new ExportStore(HOME),
  renderer:
    exportsMode === "chrome"
      ? new ChromeRenderer({ origin: `http://127.0.0.1:${PORT}`, token: TOKEN })
      : fakeRenderer,
});
attachUpgradeRouter(server, { port: PORT, token: TOKEN }, [
  exportsStreamRoute(exportJobs),
  cellStatusRoute(cells),
  sessionStreamRoute(log),
  manualStreamRoute({ session: (id) => agent.runner.get(id), manual: agent.manual }),
  appEventsRoute(appEvents, notify.presence),
  ...(realDesktop ? [desktopStreamRoute(realDesktop)] : []),
]);
// Settings > Accounts against the daemon's own routes: the web browser's cookie domains.
let cookieDomains = [
  { domain: ".google.com", count: 14 },
  { domain: "accounts.google.com", count: 6 },
  { domain: "mail.google.com", count: 3 },
  { domain: "web.telegram.org", count: 2 },
  { domain: ".github.com", count: 5 },
  { domain: "www.bbc.co.uk", count: 4 },
];
const accounts: AccountsDeps = {
  cells,
  browser: {
    start: async () => ({}) as Awaited<ReturnType<AccountsDeps["browser"]["start"]>>,
    endpoints: () => ({}) as ReturnType<AccountsDeps["browser"]["endpoints"]>,
    clearAccounts: async () => {
      cookieDomains = [];
    },
  },
  client: () => ({
    cookieDomains: async () => cookieDomains,
    signOut: async (site) => {
      const before = cookieDomains.length;
      cookieDomains = cookieDomains.filter(
        ({ domain }) => !`.${domain.replace(/^\./u, "")}`.endsWith(`.${site}`),
      );
      return before - cookieDomains.length;
    },
    close: () => {},
  }),
};
// Connected apps: each answers in memory with its own tools. POST /__qa/connectors adds GitHub
// (ready, its key saved), Linear (waiting for a sign-in) and Brave Search (needing its key).
const CONNECTOR_TOOLS: Record<string, FakeTool[]> = {
  github: [
    {
      name: "list_issues",
      description: "List issues in a repository, newest first.",
      annotations: { readOnlyHint: true },
    },
    {
      name: "search_code",
      description: "Search code across your repositories.",
      annotations: { readOnlyHint: true },
    },
    {
      name: "get_pull_request",
      description: "Get a pull request's details, checks and reviews.",
      annotations: { readOnlyHint: true },
    },
    { name: "create_issue", description: "Create an issue in a repository." },
    { name: "add_issue_comment", description: "Comment on an issue or pull request." },
    { name: "merge_pull_request", description: "Merge a pull request." },
    {
      name: "delete_branch",
      description: "Delete a branch.",
      annotations: { destructiveHint: true },
    },
  ],
};
const connectorLinks: ConnectorLinks = {
  open: (config, signal) => fakeApp(CONNECTOR_TOOLS[config.id] ?? []).links.open(config, signal),
};
const connectorHub = new ConnectorHub({
  store: new ConnectorStore(HOME),
  links: connectorLinks,
  keys: async () => keys,
});
const connectorSignIn = new ConnectorSignIn({
  hub: connectorHub,
  keyd: { status: async () => ({ sealKey }) as never, putSecret: async () => ({}) as never },
  fetchFor: async () => ({
    fetch: async () => new Response("", { status: 404 }),
    close: async () => {},
  }),
});
const routes = createApp({
  token: TOKEN,
  port: PORT,
  eventLog: log,
  connectors: {
    hub: connectorHub,
    keyd: {
      secrets: async () => keys,
      deleteSecret: async (id) => {
        keys = keys.filter((k) => k.id !== id);
        return true;
      },
    },
    signIn: connectorSignIn,
  },
  cells: { cells, tickets, update: updateCell },
  desktop: realDesktop,
  accounts,
  gateway: { registry, clock, eventLog: log, live, killSwitch, frames },
  agent,
  search: { index: searchIndex, feed: searchFeed },
  recorder,
  exports: exportJobs,
  replay: {
    home: HOME,
    eventLog: log,
    recorder,
    index,
    thumbs: new Thumbnails(HOME, frames),
    live,
  },
  deliverables: deliverablesDeps(deliverablesFixture),
  ui: { dir: fileURLToPath(new URL("../../dist", import.meta.url)) },
  notify: notify.routes,
  routines: {
    store: routineStore,
    scheduler: { replan: planRoutines },
    launcher: { runNow: () => ulid() },
    publish: (event) => appEvents.publish(event),
    redact: (text) => text,
    zone: () => "Europe/London",
    now: Date.now,
    startAtLogin: {
      status: async () => fixtureLogin,
      set: async (on) => {
        fixtureLogin = on ? "on" : "off";
        return fixtureLogin;
      },
    },
    stopAll: (by) =>
      stopAll(
        {
          cells,
          live,
          killSwitch,
          store: routineStore,
          launcher: { cancelAll: () => 0 },
          scheduler: { replan: () => {} },
          audit: { append: () => {} },
          publish: (event) => appEvents.publish(event),
          now: Date.now,
        },
        by,
      ),
  },
});
deliverableScenarios(routes, deliverablesFixture);
// QA_SLOW_KEYS=<ms> answers the key layer that much later, as a key layer still waking up does.
const slowKeys = Number(env.QA_SLOW_KEYS ?? 0);
if (slowKeys > 0)
  for (const path of ["/api/keyd", "/api/keys"])
    routes.use(path, async (_c, next) => {
      await new Promise((resolve) => setTimeout(resolve, slowKeys));
      await next();
    });
routes.get("/api/keyd", (c) =>
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
        reenter: keys.filter((k) => k.reenter).length,
        rebound: keys.filter((k) => k.rebound).length,
        ...(keydMode === "locked"
          ? { vault: { backend: "file", state: "locked", key: "passphrase" } }
          : {}),
      }),
);
routes.get("/api/cells/:id/quarantine", (c) => c.json({ items: [] }));
routes.get("/api/keys", (c) =>
  keydMode === "offline" ? c.text("owned key layer offline", 503) : c.json({ keys }),
);
routes.post("/api/keys", async (c) => {
  if (keydMode === "locked")
    return c.json(
      {
        error: "vault-locked",
        message: "Saved keys are locked. On that computer, run: localdot unlock",
      },
      423,
    );
  const { binding } = (await c.req.json()) as { binding: KeydRecord };
  const at = new Date().toISOString();
  const key = { ...binding, createdAt: at, updatedAt: at } as KeydRecord;
  keys = [...keys.filter((k) => k.id !== key.id), key];
  return c.json({ key, restart: false });
});
routes.delete("/api/keys/:id", (c) => {
  keys = keys.filter((k) => k.id !== c.req.param("id"));
  return c.body(null, 204);
});
routes.get("/cells/:cell/desktop/:ticket/", (c) =>
  tickets.resolve(c.req.param("ticket")) === c.req.param("cell")
    ? c.html(
        '<!doctype html><video id="videoStream" autoplay muted></video><script src="/owned-preview.js"></script>',
      )
    : c.text("unknown ticket", 404),
);
routes.get("/owned-preview.js", (c) =>
  c.body(DESKTOP_JS, 200, { "content-type": "text/javascript" }),
);
routes.get("/owned-desktop.webp", (c) =>
  c.body(readFileSync(join(ASSETS, "frame-1.webp")), 200, { "content-type": "image/webp" }),
);

// QA control plane (no auth; loopback only, scratch fixture). A step returns why it can't run.
const pendingApprovals: AbortController[] = [];
interface ToolCall {
  tool: ToolName;
  input: unknown;
}
// Keyboard and pointer cards as the daemon builds them (?kind=): a held modifier (hold), a held
// key that repeats (hold-repeat), a file dragged from the file manager onto a web page (drag), and
// the release of a button held down since the file (held).
function computerCard(kind: string): (ToolCall & { facts: RiskFacts }) | undefined {
  const file = {
    point: { x: 428, y: 360 },
    source: "ax" as const,
    role: "list item",
    name: "report.txt",
    app: "Files",
  };
  const attach = {
    point: { x: 2360, y: 1280 },
    source: "dom" as const,
    role: "button",
    name: "Attach files",
    url: "https://mail.example.test/compose",
  };
  const from = { x: 214, y: 180 };
  const to = { x: 1180, y: 640 };
  const actions: Record<string, [GuiAction, Record<string, unknown>]> = {
    hold: [
      { verb: "key", combo: ["shift"], holdMs: 1500, speed: "auto" },
      { action: "hold_key", keys: ["shift"], ms: 1500 },
    ],
    "hold-repeat": [
      { verb: "key", combo: ["Delete"], holdMs: 3000, speed: "auto" },
      { action: "hold_key", keys: ["Delete"], ms: 3000 },
    ],
    drag: [
      {
        verb: "drag",
        path: [from, { x: 400, y: 260 }, { x: 700, y: 420 }, { x: 960, y: 560 }, to],
        button: "left",
        mods: ["shift"],
        speed: "auto",
      },
      { action: "drag", path: [from, to], mods: ["shift"] },
    ],
    held: [
      { verb: "up", button: "left", speed: "auto", drag: { from, to } },
      { action: "mouse_up" },
    ],
  };
  const known = actions[kind];
  if (!known) return undefined;
  const [action, toolInput] = known;
  const pointer = action.verb !== "key";
  return {
    tool: "computer",
    input: { toolInput, action },
    facts: nativeActionFacts(action, pointer ? file : null, pointer ? attach : undefined),
  };
}
// With a tool call, the card is the one the daemon builds for that call.
// `always` and `repeat` go through the real authorization instead, for the card the daemon builds.
function requestApproval(
  risk: "medium" | "high",
  call?: ToolCall,
  { always = false, repeat = 1, kind = "" } = {},
): string | undefined {
  if (!session?.generation) return "no brain";
  if (kind === "port") {
    // An app's connection beyond the web, as the daemon asks about one keyd holds.
    void session.connections
      .request({
        app: "WeChat",
        host: "long.weixin.qq.com",
        port: 8080,
        why: async () => connectionWhy("WeChat", undefined, []),
      })
      .then((decision) => effects.push(`connection:${decision.allow ? "allow" : "deny"}`));
    return;
  }
  const card = computerCard(kind);
  const facts = card?.facts ?? (call && toolRisk(call.tool, call.input));
  call = card ?? call;
  const controller = new AbortController();
  pendingApprovals.push(controller);
  const ctx = {
    session,
    generation: session.generation,
    check() {},
    callId: ulid(),
    step: ulid(),
    redact: (value: string) => value,
    signal: controller.signal,
  } as never;
  if (always) {
    // A Send button on a mail page in the browser screen's own target shape, through the real
    // authorization, so the card carries the daemon's options: this task and the mail site.
    const target = {
      point: { x: 1180, y: 96 },
      source: "ax" as const,
      role: "button",
      name: "Send",
      app: "Chromium",
      url: "https://mail.example.test/compose",
    };
    const action = { verb: "click" as const, find: { name: "Send" }, speed: "auto" as const };
    const onBrowser = {
      ...(ctx as object),
      screen: { selection: { screen: "browser" }, finish() {} },
    } as never;
    void authorizePrepared(onBrowser, {
      tool: "computer",
      input: { toolInput: { action: "click", target: "Send" }, action },
      target: { target, window: null, point: target.point },
      facts: nativeActionFacts(action, target),
      revalidate: async () => true,
    })
      .then((permit) =>
        effects.push(`approval:${permit ? (permit.approved ? "approve" : "act") : "refused"}`),
      )
      .catch((e) => effects.push(`approval-error:${String(e)}`));
    return;
  }
  if (kind === "purpose") {
    // A tainted task opening an unrelated site with data in its address, through the real purpose
    // check, its judge finding the site unrelated.
    session.taint.add("screen", "mail.example.test");
    session.purpose = new PurposeGate({
      taint: session.taint,
      purpose: () => session?.currentPurpose ?? { request: [], plan: [] },
      judge: () => ({ name: "jev", destinations: async () => [], fits: async () => 0.04 }),
      trusted: () => false,
    });
    const input = { url: "https://paste.example.net/new?text=quarterly%20numbers" };
    const navigate = toolRisk("browser_navigate", input);
    if (!navigate) return "no facts";
    void authorizePrepared(ctx, {
      tool: "browser_navigate",
      input,
      target: null,
      facts: navigate,
      revalidate: async () => true,
    })
      .then((permit) => effects.push(`approval:${permit ? "approve" : "refused"}`))
      .catch((e) => effects.push(`approval-error:${String(e)}`));
    return;
  }
  if (repeat > 1) {
    // The card a repeated key press gets under QA_AUTONOMY=careful, from the real authorization.
    const keys = ["bracketright"];
    const action = { verb: "key" as const, combo: keys, repeat, speed: "auto" as const };
    void authorizePrepared(ctx, {
      tool: "computer",
      input: { toolInput: { action: "key", keys, repeat }, action },
      target: { target: null, window: 9, point: null },
      facts: nativeActionFacts(action, null),
      revalidate: async () => true,
    })
      .then((permit) => effects.push(`approval:${permit ? "approve" : "refused"}`))
      .catch((e) => effects.push(`approval-error:${String(e)}`));
    return;
  }
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
      call && facts
        ? approvalDraft(
            call.tool,
            call.input,
            facts,
            decide(facts, session.autonomy),
            (text) => text,
          )
        : ({
            actionClass: "send",
            risk,
            title: "Send this email?",
            fields: [
              ["From", "henry.liao@example.test (you)"],
              ["To", "team@example.test · 4 people"],
              ["Subject", "Monthly report (sample)"],
              ["Attached", "summary.md · 2 KB"],
            ],
            always: [
              { scope: "task", label: "For this task" },
              { scope: "site", label: "On mail.example.test", site: "https://mail.example.test" },
            ],
          } as never),
      { signal: controller.signal, check: () => {}, revalidate: async () => true } as never,
    )
    .then((o) => effects.push(`approval:${JSON.stringify(o)}`))
    .catch((e) => effects.push(`approval-error:${String(e)}`));
}
// Keyboard steps with the gateway's own labels: a key pressed five times, a held key, and a held
// key stopped part-way (delivered, then failed).
function keySteps(): string | undefined {
  if (!session) return "no session";
  for (const [combo, how, error] of [
    [["]"], { repeat: 5 }, undefined],
    [["shift"], { holdMs: 1500 }, undefined],
    [["Delete"], { holdMs: 10_000 }, "Stopped after holding for 3.1 s of 10 s: stopped"],
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
    session.append("action.result", error ? { ok: false, error } : { ok: true }, step);
    session.append("step.end", { status: error ? "failed" : "ok" }, step);
  }
}
// Pointer steps with the gateway's own labels (model pixels): a file dragged onto Trash, a hover,
// a button held down and released, a drag stopped by you and one whose drop window changed (both
// delivered, then cancelled before the drop), and a held button let go of when the task stopped.
function pointerSteps(): string | undefined {
  if (!session) return "no session";
  const report = { point: { x: 428, y: 360 }, source: "ax" as const, name: "report.txt" };
  const trash = { point: { x: 2360, y: 1280 }, source: "ax" as const, name: "Trash" };
  const at = (x: number, y: number) => ({ x, y });
  const model = (p: { x: number; y: number }) => at(p.x / 2, p.y / 2);
  for (const [verb, label, input, cancel] of [
    [
      "drag",
      dragLabel(
        { target: report, point: model(report.point) },
        { target: trash, point: model(trash.point) },
      ),
      { kind: "drag", from: report.point, to: trash.point, button: "left", durationMs: 600 },
      undefined,
    ],
    ["move", moveLabel(null, at(640, 320)), { kind: "move", to: at(1280, 640) }, undefined],
    [
      "click",
      buttonLabel("down", "left", null, at(640, 320)),
      { kind: "down", button: "left", at: at(1280, 640) },
      undefined,
    ],
    [
      "click",
      buttonLabel("up", "left", null, at(900, 420)),
      { kind: "up", button: "left", at: at(1800, 840) },
      undefined,
    ],
    [
      "drag",
      dragLabel({ target: null, point: at(150, 450) }, { target: null, point: at(950, 150) }),
      { kind: "drag", from: at(300, 900), to: at(1900, 300), button: "left", durationMs: 900 },
      "user",
    ],
    [
      "drag",
      dragLabel(
        { target: report, point: model(report.point) },
        { target: null, point: at(950, 150) },
      ),
      { kind: "drag", from: report.point, to: at(1900, 300), button: "left", durationMs: 900 },
      "stale",
    ],
  ] as const) {
    const step = ulid();
    session.append("step.start", { kind: "gui", planItem: "calc" }, step);
    session.append("action.intent", { verb, label, risk: "none" }, step);
    session.append("action.dispatch", { input, pressT: 0, ringAt: 0, injector: "xtest" }, step);
    if (cancel) session.append("action.cancel", { reason: cancel }, step);
    else session.append("action.result", { ok: true }, step);
    session.append(
      "step.end",
      { status: cancel === "user" ? "cancelled" : cancel ? "failed" : "ok" },
      step,
    );
  }
  session.append("action.intent", {
    verb: "click",
    label: "Release the left button, cancelling the drag",
    point: at(1800, 840),
    risk: "none",
  });
  session.append("action.dispatch", {
    input: { kind: "up", button: "left", at: at(1800, 840) },
    pressT: 0,
    ringAt: 0,
    injector: "xtest",
  });
  session.append("action.result", { ok: true });
}
// A drag played live with the gateway's own events, so the stage draws its path as it goes: a
// stroke through four points, or (held) a button held down through eight moves around a loop.
function liveDrag(held: boolean): string | undefined {
  if (!session) return "no session";
  const owned = session;
  const now = () => Math.round(microsToMs(log.toSessionT(owned.id, clock.nowMicros())));
  const model = (p: Point) => ({ x: Math.round(p.x / 2), y: Math.round(p.y / 2) });
  const travel = (from: Point, to: Point, durationMs: number) => ({
    from,
    to,
    startsAt: now() + 50,
    durationMs,
    seed: 7,
    curve: "minjerk-bow-v1" as const,
  });
  const later = (ms: number, act: () => void) => setTimeout(act, ms).unref();
  const run = (
    at: number,
    verb: "drag" | "move" | "click",
    label: string,
    from: Point,
    to: Point,
    input: Record<string, unknown>,
    motionMs: number,
  ) =>
    later(at, () => {
      const step = ulid();
      owned.append("step.start", { kind: "gui", planItem: "calc" }, step);
      owned.append(
        "action.intent",
        { verb, label, point: to, risk: "none", pointer: travel(from, to, motionMs) },
        step,
      );
      const press = () => {
        const pressT = msToMicros(now());
        owned.append("action.dispatch", { input, pressT, ringAt: pressT, injector: "xtest" }, step);
      };
      // A drag's press comes after its travel and its motion after the press; a held move's
      // dispatch comes once its glide is over.
      later(verb === "drag" ? motionMs + 100 : motionMs, press);
      later(motionMs + 100 + (verb === "drag" ? Number(input.durationMs) + 200 : 0), () => {
        owned.append("action.result", { ok: true }, step);
        owned.append("step.end", { status: "ok" }, step);
      });
    });
  const centre = { x: 1280, y: 800 };
  if (!held) {
    const way = [
      { x: 700, y: 1000 },
      { x: 1100, y: 600 },
      { x: 1500, y: 1000 },
      { x: 1900, y: 600 },
    ];
    const [from, to] = [way[0] as Point, way.at(-1) as Point];
    run(
      0,
      "drag",
      dragLabel({ target: null, point: model(from) }, { target: null, point: model(to) }),
      centre,
      from,
      { kind: "drag", from, to, path: way.slice(1, -1), button: "left", durationMs: 3000 },
      400,
    );
    return;
  }
  const loop = Array.from({ length: 8 }, (_, i) => ({
    x: Math.round(1280 + 420 * Math.cos((2 * Math.PI * (i + 1)) / 8)),
    y: Math.round(800 + 300 * Math.sin((2 * Math.PI * (i + 1)) / 8)),
  }));
  const start = { x: 1700, y: 800 };
  run(
    0,
    "click",
    buttonLabel("down", "left", null, model(start)),
    centre,
    start,
    { kind: "down", button: "left", at: start },
    400,
  );
  loop.forEach((to, i) => {
    const from = i === 0 ? start : (loop[i - 1] as Point);
    run(
      700 + i * 650,
      "move",
      moveLabel(null, model(to)),
      from,
      to,
      {
        kind: "move",
        to,
        durationMs: 500,
      },
      500,
    );
  });
  const end = loop.at(-1) as Point;
  run(
    700 + loop.length * 650,
    "click",
    buttonLabel("up", "left", null, model(end)),
    end,
    end,
    { kind: "up", button: "left", at: end },
    0,
  );
}
// Clicks, a scroll, typing and a key combo played live, each with its travel and its element, so
// the stage draws the full action vocabulary: a click on a known cell, a right click, a double
// click, three wheel notches, a formula typed into a field and Ctrl+S.
function liveActions(): string | undefined {
  if (!session) return "no session";
  const owned = session;
  const now = () => Math.round(microsToMs(log.toSessionT(owned.id, clock.nowMicros())));
  const later = (ms: number, act: () => void) => setTimeout(act, ms).unref();
  const cell = (row: number) => ({ x: 1900, y: 424 + row * 64, w: 320, h: 64 });
  const centre = (r: { x: number; y: number; w: number; h: number }) => ({
    x: Math.round(r.x + r.w * 0.62),
    y: Math.round(r.y + r.h * 0.64),
  });
  let cursor: Point = { x: 1280, y: 800 };
  const act = (
    at: number,
    verb: "click" | "scroll" | "type" | "key",
    label: string,
    input: Record<string, unknown>,
    box?: { x: number; y: number; w: number; h: number },
    progress?: string,
  ) => {
    const point = box ? centre(box) : undefined;
    later(at, () => {
      const step = ulid();
      const from = cursor;
      owned.append("step.start", { kind: "gui", planItem: "calc" }, step);
      owned.append(
        "action.intent",
        {
          verb,
          label,
          risk: "none",
          ...(point && verb !== "type"
            ? {
                point,
                pointer: {
                  from,
                  to: point,
                  startsAt: now() + 120,
                  durationMs: 420,
                  seed: 5,
                  curve: "minjerk-bow-v1",
                },
              }
            : point
              ? { point }
              : {}),
        },
        step,
      );
      if (point && verb !== "type") cursor = point;
      if (box)
        later(60, () =>
          owned.append(
            "action.target",
            { target: { point: point as Point, bbox: box, source: "ax", role: "cell" } },
            step,
          ),
        );
      later(verb === "type" || verb === "key" ? 150 : 650, () => {
        const pressT = msToMicros(now());
        owned.append(
          "action.dispatch",
          { input, pressT, ringAt: pressT + 20_000, injector: "xtest" },
          step,
        );
        const chars = [...(progress ?? "")];
        for (const [i, chunk] of chars.entries())
          later(35 * (i + 1), () =>
            owned.append("text.progress", { chunk, count: i + 1, masked: false }, step),
          );
        later(400 + 35 * chars.length, () => {
          owned.append("action.result", { ok: true }, step);
          owned.append("step.end", { status: "ok" }, step);
        });
      });
    });
  };
  const click = (button: "left" | "right", count: 1 | 2, box: ReturnType<typeof cell>) => ({
    kind: "click",
    button,
    count,
    at: centre(box),
  });
  act(0, "click", "Select February's net total", click("left", 1, cell(1)), cell(1));
  act(1800, "click", "Open the menu on March's net total", click("right", 1, cell(2)), cell(2));
  act(3600, "click", "Edit April's net total", click("left", 2, cell(3)), cell(3));
  const wheel = cell(7);
  act(5400, "scroll", "Scroll down", { kind: "scroll", at: centre(wheel), dx: 0, dy: 3 }, wheel);
  const total = { x: 1900, y: 1256, w: 320, h: 64 };
  act(
    7000,
    "type",
    "Type =SUM(F2:F13)",
    { kind: "type", chars: 12, masked: false },
    total,
    "=SUM(F2:F13)",
  );
  act(9000, "key", "Save the report", { kind: "key", combo: ["ctrl", "s"] });
}
function ask(allowText: boolean): string | undefined {
  if (!session) return "no session";
  void session
    .ask("Which report format should I use?", ["Markdown", "Plain text", "PDF"], allowText, 0)
    .then((a) => effects.push(`ask:${JSON.stringify(a)}`))
    .catch((e) => effects.push(`ask-error:${String(e)}`));
}
// Questions with typed fields (design-v2/HITL.md §3), answered through the real answer route.
// The secret fields' targets are in the screen's pixels (2560x1600).
const ASK_FORMS: Record<string, AskForm> = {
  login: {
    question: "Sign in to your mail so I can read the latest message.",
    fields: [
      { id: "username", kind: "text", label: "Username" },
      {
        id: "password",
        kind: "secret",
        label: "Password",
        target: {
          screen: "desktop",
          point: { x: 1280, y: 760 },
          bbox: { x: 1040, y: 732, w: 480, h: 56 },
          site: "mail.example.test",
        },
      },
    ],
    submit: "Sign in",
    decline: "Not now",
  },
  pin: {
    question: "The bank app wants your PIN.",
    fields: [
      {
        id: "pin",
        kind: "secret",
        label: "PIN",
        hint: "Typed into the PIN box for you. dot never sees it.",
        target: { screen: "desktop", point: { x: 1280, y: 800 } },
      },
    ],
    submit: "Enter PIN",
  },
  code: {
    question: "Enter the code the site sent to your phone.",
    fields: [{ id: "code", kind: "code", label: "Code", length: 6 }],
    submit: "Send code",
    decline: "Not now",
  },
  choice: {
    question: "Which report format should I use?",
    fields: [
      { id: "format", kind: "choice", label: "Format", options: ["Markdown", "Plain text", "PDF"] },
    ],
    submit: "Use this",
  },
  multichoice: {
    question: "What should the summary include?",
    fields: [
      {
        id: "parts",
        kind: "multichoice",
        label: "Include",
        options: ["Totals", "Charts", "Notes from the team"],
      },
    ],
    submit: "Write it",
  },
  longtext: {
    question: "What should the reply to Sam say?",
    fields: [
      {
        id: "reply",
        kind: "longtext",
        label: "Reply",
        hint: "A few lines is enough; I will tidy the wording.",
      },
    ],
    submit: "Draft reply",
  },
  confirm: {
    question: "Delete the 12 old drafts in your mail?",
    fields: [{ id: "sure", kind: "confirm", label: "Delete 12 drafts" }],
    submit: "Delete",
    decline: "Keep them",
  },
  details: {
    question: "A few details for the booking form.",
    fields: [
      { id: "guests", kind: "number", label: "Guests" },
      { id: "arrival", kind: "date", label: "Arrival" },
      { id: "phone", kind: "phone", label: "Phone" },
      { id: "site", kind: "url", label: "Hotel website", hint: "The hotel's own page" },
    ],
    submit: "Fill in the form",
  },
  file: {
    question: "Which photo should go on the profile?",
    fields: [{ id: "photo", kind: "file", label: "Photo" }],
    submit: "Use this photo",
  },
  qr: {
    question: "Scan this with your phone to link the account.",
    fields: [
      {
        id: "pair",
        kind: "qr",
        label: "Link your phone",
        value: "https://pair.example.test/a1b2c3",
        hint: "Code: A1B2-C3",
      },
    ],
    submit: "Done",
  },
  pair: {
    question: "Show this to the TV to link it.",
    fields: [{ id: "pair", kind: "qr", label: "Pair the TV", value: "TV-PAIR-4K7Q-82LM" }],
    submit: "Done",
  },
};
function askForm(name: string): string | undefined {
  const form = ASK_FORMS[name];
  if (!form) return `no question named ${name}; try ${Object.keys(ASK_FORMS).join(", ")}`;
  if (!session) return "no session";
  void session
    .askFields(form, 0)
    .then((a) =>
      effects.push(
        `ask:${JSON.stringify(a)}`,
        ...(a.secrets?.size ? [`ask-secrets:${a.secrets.size}`] : []),
      ),
    )
    .catch((e) => effects.push(`ask-error:${String(e)}`));
}
// A field name, or a known localDot key, types into it through the real authorization.
function takeover(field?: string, known = false): string | undefined {
  if (!session) return "no session";
  if ((field || known) && session.generation) {
    // Typing into a secret field, or a localDot key into a plain one, through the real
    // authorization, so the hand-off carries the daemon's own reason and copy.
    const key = "fixture-private-key-0123";
    const text = known ? `token ${key}` : "sample";
    const target = {
      point: { x: 640, y: 320 },
      source: "dom" as const,
      role: "textbox",
      name: field ?? "Notes",
      url: "https://account.example.test/sign-in",
      secret: !known,
    };
    const action = { verb: "type" as const, text, speed: "auto" as const };
    void authorizePrepared(
      {
        session,
        generation: session.generation,
        check() {},
        callId: ulid(),
        step: ulid(),
        redact: (value: string) => value.replaceAll(key, "[key]"),
        signal: new AbortController().signal,
      } as never,
      {
        tool: "computer",
        input: { toolInput: { action: "type", text }, action },
        target: { target, window: null, point: target.point },
        facts: nativeActionFacts(action, target),
        revalidate: async () => true,
      },
    )
      .then((permit) => effects.push(`takeover:${permit ? "permitted" : "handed-off"}`))
      .catch((e) => effects.push(`takeover-error:${String(e)}`));
    return;
  }
  void session
    .takeover("login", "Please sign in to the sample site, then hand control back.")
    .then((o) => effects.push(`takeover:${JSON.stringify(o)}`))
    .catch((e) => effects.push(`takeover-error:${String(e)}`));
}
function budget(scope: "task" | "day" = "task"): string | undefined {
  if (!session) return "no session";
  session.append(
    "budget.exceeded",
    scope === "task"
      ? { scope, taskId: session.id, limitUSD: 5, spentUSD: 4, needUSD: 2 }
      : { scope, limitUSD: 20, spentUSD: 20 },
  );
  budgetHold = scope;
  session.setStatus("paused");
  session.append("agent.state", { state: "paused", reason: "budget" });
}
// The ways a task stalls that the app must never leave silent.
function stall(kind: string): string | undefined {
  if (!session) return "no session";
  if (kind === "model-busy") {
    session.append("model.retry", {
      role: "main",
      attempt: 3,
      waitMs: 20_000,
      status: 529,
      message: "Overloaded",
    });
    session.setStatus("paused");
    session.append("agent.state", { state: "paused", reason: "model busy" });
  } else if (kind === "model-refused") {
    session.setStatus("paused");
    session.append("agent.state", {
      state: "paused",
      reason: "model refused",
      detail: "400: image input is not supported by this model",
    });
  } else if (kind === "key-reenter" || kind === "key-rebound") {
    session.setStatus("paused");
    session.append("agent.state", {
      state: "paused",
      reason: kind === "key-rebound" ? "key changed outside localDot" : "key needs re-entering",
      detail: "anthropic-main",
    });
  } else if (kind === "action-limit") {
    endLiveStep();
    session.setStatus("idle");
    session.append("agent.state", { state: "idle", reason: "action limit" });
  } else return "unknown stall";
}
// What the task's model calls cost, as keyd reports them: one billed, the rest estimated.
function spend(): string | undefined {
  if (!session) return "no session";
  let task = 0;
  for (const [costUSD, basis] of [
    [0.0842, "billed"],
    [0.0611, "estimated"],
    [0.0647, "estimated"],
  ] as const) {
    task += costUSD;
    session.append("model.usage", {
      role: "main",
      route: "anthropic",
      model: "claude-sonnet-5-5",
      inputTokens: 8200,
      outputTokens: 310,
    });
    session.append("model.spend", {
      route: "anthropic",
      model: "claude-sonnet-5-5",
      costUSD,
      basis,
      taskSpentUSD: task,
      daySpentUSD: 1.18 + task,
    });
  }
}
function endLiveStep() {
  if (!session || !liveStep) return;
  session.append("action.result", { ok: true }, liveStep);
  session.append("step.end", { status: "ok" }, liveStep);
  liveStep = undefined;
}
function finish(done = false, markdown = false): string | undefined {
  const owned = session;
  if (!owned) return "no session";
  const append: Append = (type, data, step) => owned.append(type, data, step);
  endLiveStep();
  append("plan.set", { items: planItems(true) });
  finishTask(owned, append, done, markdown);
}
function setCell(kind: CellKind): undefined {
  const next = cellFor(kind, cellId);
  if (next) cells.emit(next);
}
const STEPS: Record<ScenarioStep, () => string | undefined | Promise<string | undefined>> = {
  approval: () => requestApproval("high"),
  ask: () => ask(true),
  takeover: () => takeover(),
  budget: () => budget(),
  finish,
  "cell/starting": () => setCell("starting"),
  "cell/connecting": () => setCell("connecting"),
  "cell/live": () => setCell("live"),
  "cell/reconnecting": () => setCell("reconnecting"),
  "cell/paused": () => setCell("paused"),
  // A computer turned off ends the task it ran, as the daemon does.
  "cell/stopped": async () => {
    await endLive(session?.status === "idle" ? "done" : undefined);
    return setCell("stopped");
  },
  "cell/failed": () => setCell("failed"),
  "cell/fenced": () => setCell("fenced"),
  "cell/fresh-start": () => setCell("fresh-start"),
};
const reply = (problem: string | undefined) =>
  problem ? new Response(problem, { status: 409 }) : Response.json({ ok: true });

// A new version of the computer becomes ready.
routes.post("/__qa/update", () => {
  const c = cells.get(cellId);
  if (!c) return reply("no computer");
  cells.emit({ ...c, updateAvailable: true });
  return reply(undefined);
});
routes.post("/__qa/approval", async (c) => {
  const call = c.req.header("content-type")?.startsWith("application/json")
    ? ((await c.req.json()) as ToolCall)
    : undefined;
  return reply(
    requestApproval((c.req.query("risk") ?? "high") as "medium" | "high", call, {
      always: c.req.query("always") === "1",
      repeat: Number(c.req.query("repeat") ?? 1),
      kind: c.req.query("kind") ?? "",
    }),
  );
});
// The video the fake renderer is making: counts it to ?done of ?total, finishes it, or fails it.
routes.post("/__qa/export/:step", async (c) => {
  if (exportsMode !== "fake") return reply("start the fixture with QA_EXPORTS=fake");
  const rendering = fakeRenderer.renders.find((entry) => !entry.settled);
  if (!rendering) return reply("no video is being made");
  const step = c.req.param("step");
  if (step === "progress") {
    rendering.io.progress(Number(c.req.query("done") ?? 0), Number(c.req.query("total") ?? 0));
    return reply(undefined);
  }
  if (step === "finish") {
    await rendering.io.write(0, new Uint8Array(Number(c.req.query("bytes") ?? 1024)));
    rendering.finish(Number(c.req.query("frames") ?? 1800));
    return reply(undefined);
  }
  if (step === "fail") {
    rendering.fail(c.req.query("message") ?? undefined);
    return reply(undefined);
  }
  return reply("unknown step");
});
routes.post("/__qa/keys", () => reply(keySteps()));
routes.post("/__qa/connectors", async (c) => {
  const at = new Date().toISOString();
  keys = [
    ...keys.filter((k) => k.id !== "connector-github"),
    {
      id: "connector-github",
      kind: "http",
      hosts: ["api.githubcopilot.com"],
      header: "authorization",
      format: "bearer",
      createdAt: at,
      updatedAt: at,
    },
  ];
  for (const id of connectorHub.configs().map((config) => config.id)) await connectorHub.remove(id);
  const github = connectorHub.add({
    id: "github",
    name: "GitHub",
    catalog: "github",
    server: {
      kind: "remote",
      url: "https://api.githubcopilot.com/mcp/",
      transport: "http",
      auth: { kind: "key", secret: "connector-github" },
    },
  });
  await connectorHub.refresh(github.id);
  await connectorHub.update(github.id, { tools: { delete_branch: { enabled: false } } });
  connectorHub.add({
    id: "linear",
    name: "Linear",
    catalog: "linear",
    server: {
      kind: "remote",
      url: "https://mcp.linear.app/mcp",
      transport: "http",
      auth: { kind: "oauth" },
    },
  });
  connectorHub.add({
    id: "brave",
    name: "Brave Search",
    catalog: "brave",
    server: {
      kind: "local",
      command: "npx",
      args: ["-y", "@brave/brave-search-mcp-server"],
      env: [{ name: "BRAVE_API_KEY", secret: "connector-brave" }],
    },
  });
  return c.json({ connectors: await connectorHub.views() });
});
routes.post("/__qa/pointer", () => reply(pointerSteps()));
routes.post("/__qa/drag", (c) => reply(liveDrag(c.req.query("held") === "1")));
routes.post("/__qa/actions", () => reply(liveActions()));
routes.post("/__qa/ask", (c) => {
  const form = c.req.query("fields");
  return reply(form ? askForm(form) : ask(c.req.query("text") !== "0"));
});
routes.post("/__qa/takeover", (c) =>
  reply(takeover(c.req.query("field"), c.req.query("known") === "1")),
);
routes.post("/__qa/budget", (c) => reply(budget(c.req.query("scope") === "day" ? "day" : "task")));
routes.post("/__qa/stall/:kind", (c) => reply(stall(c.req.param("kind"))));
// keyd lists a key whose stored value has to be entered again (?id=, the main model's by default).
routes.post("/__qa/reenter", (c) => {
  const id = c.req.query("id") ?? "anthropic-main";
  if (!keys.some((k) => k.id === id)) return c.text(`no key named ${id}`, 404);
  keys = keys.map((k) => (k.id === id ? { ...k, reenter: true } : k));
  return c.body(null, 204);
});
// keyd lists a key whose destination was changed outside localDot (?id=, as above).
routes.post("/__qa/rebound", (c) => {
  const id = c.req.query("id") ?? "anthropic-main";
  if (!keys.some((k) => k.id === id)) return c.text(`no key named ${id}`, 404);
  keys = keys.map((k) => (k.id === id ? { ...k, rebound: true } : k));
  return c.body(null, 204);
});
routes.post("/__qa/spend", () => reply(spend()));
// ?steps=pause leaves the computer off; pause,stop leaves the Stop unconfirmed; keyd-once pauses
// it with a cleanup note.
routes.post("/__qa/stop-fails", (c) => {
  stopFails.clear();
  for (const step of (c.req.query("steps") ?? "").split(",").filter(Boolean)) stopFails.add(step);
  revokeAgain = stopFails.has("keyd-once");
  return c.json({ ok: true });
});
routes.post("/__qa/pause-uncertain", (c) => {
  const pause = session?.safetyPause;
  if (!session || !pause) return c.text("no pause", 409);
  session.uncertainSafetyPause(pause.requestId, pause.revision);
  return c.json({ ok: true });
});
let screenRevision = 0;
// dot selects the desktop again, as a new task, a screen switch and a hand-back each do.
routes.post("/__qa/screen", (c) => {
  if (!session) return c.text("no session", 409);
  session.append("screen.switch", {
    screen: "desktop",
    cellId,
    geometry: { w: 2560, h: 1600, scale: 2 },
    by: "daemon",
    revision: ++screenRevision,
  });
  return c.json({ ok: true });
});
routes.post("/__qa/step-end", (c) => {
  if (!session || !liveStep) return c.text("no open step", 409);
  endLiveStep();
  const pause = session.safetyPause;
  if (pause?.phase === "pausing") session.confirmSafetyPause(pause.requestId, pause.revision);
  return c.json({ ok: true });
});
// Finishes the open step and starts the next, after a model call, as a live task does.
function nextStep(owned: AgentSession, planItem: string) {
  if (liveStep) {
    owned.append("action.result", { ok: true }, liveStep);
    owned.append("step.end", { status: "ok" }, liveStep);
  }
  owned.append("key.use", {
    secretId: "anthropic-main",
    host: "api.anthropic.com",
    method: "POST",
    path: "/v1/messages",
    decision: "allow",
  });
  liveStep = ulid();
  fill++;
  owned.append("step.start", { kind: "gui", planItem }, liveStep);
  owned.append(
    "action.intent",
    {
      verb: "click",
      label: `Fill area ${fill} with brown`,
      risk: "none",
      point: { x: 1200, y: 700 },
    },
    liveStep,
  );
}
routes.post("/__qa/steps", (c) => {
  if (!session) return c.text("no session", 409);
  for (let n = Number(c.req.query("n") ?? 1); n > 0; n--)
    nextStep(session, c.req.query("item") ?? "colour");
  return c.json({ ok: true });
});
// A busy task for `ms`: dot says a word every 40 ms, a new message every 60 words and takes a
// step every 600 ms.
routes.post("/__qa/stream", (c) => {
  if (!session) return c.text("no session", 409);
  const owned = session;
  const until = Date.now() + Number(c.req.query("ms") ?? 10_000);
  let messageId = ulid();
  let words: string[] = [];
  let tick = 0;
  const said = () => owned.append("message.assistant", { messageId, text: words.join(" ") });
  const timer = setInterval(() => {
    if (teardown || session !== owned) return clearInterval(timer);
    if (Date.now() > until) {
      clearInterval(timer);
      if (words.length) said();
      return;
    }
    const word = `cell${++tick}`;
    owned.append("message.delta", { messageId, text: `${words.length ? " " : ""}${word}` });
    words.push(word);
    if (words.length === 60) {
      said();
      messageId = ulid();
      words = [];
    }
    if (tick % 15 === 0) nextStep(owned, "colour");
  }, 40);
  return c.json({ ok: true });
});
// dot thinks: its thoughts are never the band's line, which holds dot's last line for the user.
routes.post("/__qa/think", (c) => {
  if (!session) return c.text("no session", 409);
  session.append("thought.delta", {
    text:
      c.req.query("text") ?? "The Net column must be revenue minus returns. Let me check row 3.",
  });
  return c.json({ ok: true });
});
// dot says something in the thread: n messages at once, or one sent word by word (stream=1).
routes.post("/__qa/say", (c) => {
  if (!session) return c.text("no session", 409);
  const owned = session;
  const text = c.req.query("text") ?? "Checking the next part of the sheet.";
  if (c.req.query("stream") === "1") {
    const messageId = ulid();
    const words = text.split(" ");
    let sent = 0;
    const timer = setInterval(() => {
      if (sent < words.length)
        owned.append("message.delta", { messageId, text: `${sent ? " " : ""}${words[sent++]}` });
      else {
        clearInterval(timer);
        owned.append("message.assistant", { messageId, text });
      }
    }, 120);
    return c.json({ ok: true });
  }
  const n = Number(c.req.query("n") ?? 1);
  for (let k = 1; k <= n; k++)
    owned.append("message.assistant", { messageId: ulid(), text: n > 1 ? `${text} (${k})` : text });
  return c.json({ ok: true });
});
routes.post("/__qa/heartbeat", (c) => {
  if (!session) return c.text("no session", 409);
  session.append("heartbeat", { ongoing: true, everyMs: 500 });
  return c.json({ ok: true });
});
routes.post("/__qa/finish", (c) =>
  reply(finish(c.req.query("done") === "1", c.req.query("markdown") === "1")),
);
// The daemon goes away under the live task (no end is recorded) and comes back without it.
routes.post("/__qa/crash", async (c) => {
  if (!session || session.stopped) return c.text("no live task", 409);
  await endLive("crash");
  return c.json({ ok: true });
});
// A task of another conversation, ended, to continue from Replay.
routes.post("/__qa/older-task", (c) =>
  c.json({
    sessionId: endedTask(
      "Plan the team offsite",
      "I drafted a two-day plan in **offsite.md**: Lisbon, 14–15 November.",
      "Drafted the offsite plan in offsite.md.",
    ),
  }),
);
// What dot knows: facts you and dot added, people dot reached, a daily note, and recent tasks.
routes.post("/__qa/knows", (c) => {
  const insurance = endedTask(
    "Renew the car insurance before it lapses",
    "I compared three quotes and renewed with the cheapest.",
    "Renewed the car insurance with the cheaper quote.",
  );
  const henry = endedTask(
    "Send Henry the quarterly report on WeChat",
    "Sent the report to Henry on WeChat.",
    "Sent the quarterly report to Henry.",
  );
  memory.addEntry("USER.md", "Allergic to penicillin", true);
  memory.addEntry("USER.md", "Prefers aisle seats on long flights");
  memory.apply(insurance, "USER.md", "append", "- Car insurance renews every September");
  memory.apply(insurance, "MEMORY.md", "append", "- Insurer prefers email over phone calls");
  const note = memory.appendNote(insurance, "Insurer reference is WINDSCREEN-42");
  log.append(insurance, {
    type: "memory.change",
    agent: "main",
    data: { file: note.file, patch: note.patch, changeId: note.changeId },
  } as never);
  people.record(henry, { name: "Henry Liu", app: "WeChat", handle: "henry_l" });
  people.record(insurance, {
    name: "Ana Souza",
    app: "Email",
    handle: "ana@example.com",
    note: "Insurance broker",
  });
  people.add({ name: "Mum", app: "Phone", handle: "+44 7700 900123" });
  return c.json({ ok: true });
});
routes.get("/__qa/boot-memory", (c) => c.json(memory.bootMemory()));

// Routines: dot proposes one in the live thread; a routine's own run; a run history to browse.
const MORNING_BILLS = {
  name: "Morning bills",
  instruction:
    "Check my utility and bank sites for new statements, save the PDFs to Bills and tell me what's due.",
  when: { kind: "weekdays", time: "08:30" },
} as const;
routes.post("/__qa/routine/propose", (c) => {
  if (!session) return c.text("no session", 409);
  const routine = routineStore.create(MORNING_BILLS, {
    state: "proposed",
    createdFromSession: session.id,
  });
  const view = toRoutine(routine, undefined);
  session.append("routine.proposed", {
    routineId: routine.id,
    revision: routine.revision,
    name: routine.name,
    summary: view.summary,
    instruction: routine.instruction,
    profile: routine.profile,
    notify: routine.notify,
    budgetUSD: routine.budgetUSD,
    approvalWindowMinutes: routine.approvalWindowMinutes,
    missedPolicy: routine.missedPolicy,
  });
  routineChanged(routine.id);
  return c.json({ routineId: routine.id });
});
routes.post("/__qa/routine/session", async (c) => {
  await endLive("done");
  const routine = routineStore.create(MORNING_BILLS, { state: "active" });
  session = newSession(MORNING_BILLS.name, MORNING_BILLS.instruction, undefined, {
    kind: "routine",
    routineId: routine.id,
    runId: ulid(),
    name: MORNING_BILLS.name,
    dueAt: new Date().toISOString(),
  });
  attachLive(session);
  seedTask(session, false);
  return c.json({ sessionId: session.id, routineId: routine.id });
});
routes.post("/__qa/routine/history", (c) => {
  const at = (iso: string) => Date.parse(iso);
  const add = (draft: typeof MORNING_BILLS | Parameters<typeof routineStore.create>[0]) =>
    routineStore.create(draft, { state: "active" });
  const bills = add(MORNING_BILLS);
  const runs = [
    ["2026-10-06T07:30:00Z", "done", "3 new statements saved to Bills", seeded[0] ?? null],
    ["2026-10-07T07:30:00Z", "done", "2 new statements saved to Bills", seeded[0] ?? null],
    ["2026-10-08T07:30:00Z", "missed", "", null],
    ["2026-10-09T07:30:00Z", "done", "Nothing new", seeded[1] ?? null],
    [
      "2026-10-12T07:30:00Z",
      "needs_you_expired",
      "Checked two sites; the bank needs you to sign in.",
      null,
    ],
  ] as const;
  for (const [due, outcome, note, sessionId] of runs)
    routineStore.recordRun({
      routineId: bills.id,
      dueAt: at(due),
      startedAt: outcome === "missed" ? null : at(due) + 2000,
      endedAt: at(due) + 240_000,
      sessionId,
      outcome,
      note,
    });
  const inbox = add({
    name: "Inbox sweep",
    instruction: "Check my inbox, archive newsletters and tell me what needs a reply.",
    when: { kind: "daily", time: "07:45" },
    profile: "act_within_rules",
  });
  routineStore.recordRun({
    routineId: inbox.id,
    dueAt: at("2026-10-09T06:45:00Z"),
    startedAt: at("2026-10-09T06:45:01Z"),
    endedAt: at("2026-10-09T06:52:00Z"),
    sessionId: null,
    outcome: "done",
    note: "Archived 14 newsletters; 2 emails need a reply.",
  });
  const prices = add({
    name: "Flight prices",
    instruction: "Check fares from London to Lisbon for 14 November and tell me if any drop.",
    when: { kind: "hours", every: 4, from: "08:00" },
    profile: "read_only",
    missedPolicy: "skip",
  });
  routineStore.update(prices.id, { revision: 1, state: "paused" });
  add({
    name: "Weekly report",
    instruction: "Collect this week's numbers into report.xlsx in Documents.",
    when: { kind: "weekly", days: [5], time: "16:00" },
    notify: "always",
  });
  planRoutines();
  for (const routine of routineStore.list()) routineChanged(routine.id);
  return c.json({ routineId: bills.id });
});
routes.post("/__qa/routine/keep", (c) => {
  const routine = routineStore.list()[0];
  if (!routine) return c.text("no routine", 409);
  routineStore.setAbsenceAsked(routine.id, Date.now());
  routineChanged(routine.id);
  return c.json({ routineId: routine.id });
});
routes.post("/__qa/cell/:kind", (c) => reply(setCell(c.req.param("kind") as CellKind)));
routes.post("/__qa/chatgpt/:state", (c) => {
  const state = c.req.param("state");
  if (!chatgptState) return c.text("start the fixture with QA_CHATGPT", 409);
  if (
    ![
      "signed_in",
      "signed_out",
      "checking",
      "check_failed",
      "not_installed",
      "unavailable",
    ].includes(state)
  )
    return c.text("unknown ChatGPT state", 400);
  chatgptState = state as NonNullable<typeof chatgptState>;
  signingIn = undefined;
  return c.json({ ok: true });
});
routes.post("/__qa/claude-code/:state", (c) => {
  const state = c.req.param("state");
  if (!claudeCodeState) return c.text("start the fixture with QA_CLAUDE_CODE", 409);
  if (!["not_installed", "outdated", "signed_out", "signed_in"].includes(state))
    return c.text("unknown Claude Code state", 400);
  claudeCodeState = state as NonNullable<typeof claudeCodeState>;
  return c.json({ ok: true });
});
routes.post("/__qa/chatgpt/device-code/:mode", (c) => {
  const mode = c.req.param("mode");
  if (mode !== "on" && mode !== "off") return c.text("device code is on or off", 400);
  deviceCodeOff = mode === "off";
  return c.json({ ok: true });
});
routes.post("/__qa/keyd/:mode", (c) => {
  keydMode = c.req.param("mode") as typeof keydMode;
  return c.json({ ok: true });
});
routes.get("/__qa/scenarios", (c) =>
  c.json(
    Object.entries(UI_SCENARIOS as Record<string, UiScenario>).map(([name, s]) => ({
      name,
      about: s.about,
      boot: s.boot ?? {},
      live: s.step !== undefined,
    })),
  ),
);
routes.post("/__qa/scenario/:name", async (c) => {
  const name = c.req.param("name");
  const wanted = (UI_SCENARIOS as Record<string, UiScenario>)[name];
  if (!wanted) return c.text("unknown scenario", 404);
  if (!wanted.step) return c.text(`start the fixture with --scenario ${name}`, 409);
  return reply(await STEPS[wanted.step]());
});
routes.get("/__qa/manual-inputs", (c) => c.json(manualInputs));
routes.get("/__qa/notify", (c) => c.json(notified));
routes.get("/__qa/state", (c) =>
  c.json({
    sessionId: session?.id,
    cellId,
    seeded,
    effects,
    status: session?.status,
    cell: cells.get(cellId),
  }),
);
// The gallery build, with the page policy the app itself is served with.
routes.get("/gallery/*", (c) => {
  const rel = c.req.path.slice("/gallery".length);
  const file = readStatic(GALLERY, rel === "/" ? "/gallery.html" : rel);
  if (!file) return c.text("Gallery not built: pnpm --filter @localdot/web build:gallery", 404);
  return c.body(file.body, 200, {
    ...UI_CSP,
    "content-type": file.type,
    "cache-control": "no-store",
  });
});

const atBoot = bootStep(scenario);
if (atBoot) {
  const problem = await STEPS[atBoot]();
  if (problem) throw new Error(`${scenarioName}: ${problem}`);
}
app = routes;
console.log(
  JSON.stringify({
    ready: true,
    origin: `http://127.0.0.1:${PORT}`,
    port: PORT,
    scenario: scenarioName,
    sessionId: session?.id,
    cellId,
    seeded,
  }),
);

const shutdown = async () => {
  teardown = true;
  for (const a of pendingApprovals) a.abort();
  try {
    exportJobs.close();
    if (session) {
      live.stop(session.id);
      session.stop();
    }
    registry.dispose();
    notify.close();
    index.close();
    routineStore.close();
    log.close();
  } catch {}
  for (const peer of upgraded) peer.destroy();
  server.closeAllConnections();
  const exit = () => {
    if (ownsHome) rmSync(HOME, { recursive: true, force: true });
    process.exit(0);
  };
  server.close(exit);
  setTimeout(exit, 2000).unref();
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
// A launcher that dies without stopping its fixture would leave it running; it stops itself.
const launcher = Number(env.QA_PARENT_PID);
if (launcher) {
  const watch = setInterval(() => {
    if (process.ppid === launcher) return;
    clearInterval(watch);
    void shutdown();
  }, 1000);
  watch.unref();
}
